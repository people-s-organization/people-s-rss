import { NextResponse } from "next/server";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { sanitizeHtml, stripHtml } from "@/app/lib/rss";
import { assignHeadingIds, mergeIcons } from "@/app/lib/articleHtml";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const JINA_READER_PREFIX = "https://r.jina.ai/http://";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get("url");
  if (!url) {
    return NextResponse.json({ error: "Missing url" }, { status: 400 });
  }
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return NextResponse.json({ error: "Invalid url" }, { status: 400 });
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return NextResponse.json({ error: "Unsupported protocol" }, { status: 400 });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(target.toString(), {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; PeoplesRSS/1.0; +https://people-s-rss.vercel.app)",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    const extracted = await extractContent(res, target);
    if (!extracted) {
      return NextResponse.json(
        { error: "Could not extract article body" },
        { status: 422 },
      );
    }

    const cleanHtml = sanitizeHtml(extracted.contentHtml);
    const text = stripHtml(extracted.contentHtml);
    return NextResponse.json(
      {
        title: extracted.title,
        byline: extracted.byline,
        siteName: extracted.siteName,
        excerpt: extracted.excerpt,
        length: extracted.length ?? text.length,
        contentHtml: cleanHtml,
        contentText: text,
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
        },
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Extract failed";
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    clearTimeout(timer);
  }
}

type Extracted = {
  title?: string;
  byline?: string;
  siteName?: string;
  excerpt?: string;
  length?: number;
  contentHtml: string;
};

async function extractContent(res: Response, target: URL): Promise<Extracted | null> {
  if (res.ok) {
    const parsed = await parseArticleFromHtml(res, target);
    if (parsed) return parsed;
  }
  // Some websites block server-side fetches (often with 403/anti-bot). For
  // those cases, fall back to a text extraction mirror so users can still read.
  return extractViaJina(target);
}

async function parseArticleFromHtml(res: Response, target: URL): Promise<Extracted | null> {
  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  if (contentType && !contentType.includes("html") && !contentType.includes("xml")) {
    return null;
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) {
    return null;
  }
  const html = new TextDecoder("utf-8").decode(buf);
  const dom = new JSDOM(html, { url: target.toString() });
  const article = new Readability(dom.window.document).parse();
  if (!article || !article.content) {
    return null;
  }

  const absHtml = resolveUrls(article.content, target.toString());
  return {
    title: article.title ?? undefined,
    byline: article.byline ?? undefined,
    siteName: article.siteName ?? undefined,
    excerpt: article.excerpt ?? undefined,
    length: article.length ?? undefined,
    contentHtml: absHtml,
  };
}

async function extractViaJina(target: URL): Promise<Extracted | null> {
  const mirrorUrl = `${JINA_READER_PREFIX}${target.toString()}`;
  const res = await fetch(mirrorUrl, {
    headers: {
      Accept: "text/plain,text/markdown;q=0.9,*/*;q=0.1",
    },
  });
  if (!res.ok) return null;
  const text = (await res.text()).trim();
  if (!text) return null;
  // If the mirror itself fails, it can return an HTML error page. Do not
  // surface that as article content.
  if (/^<!doctype html/i.test(text) || /^<html[\s>]/i.test(text)) return null;
  if (/^(error|{"error")/i.test(text.slice(0, 64))) return null;
  const safe = markdownToBasicHtml(text);
  return {
    contentHtml: `<article>${safe}</article>`,
    length: text.length,
  };
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function markdownToBasicHtml(source: string): string {
  const lines = source.split(/\r?\n/);
  const chunks: string[] = [];
  let para: string[] = [];
  let list: string[] = [];

  const flushPara = () => {
    if (!para.length) return;
    chunks.push(`<p>${escapeHtml(para.join(" "))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (!list.length) return;
    chunks.push(`<ul>${list.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`);
    list = [];
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flushPara();
      flushList();
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushPara();
      flushList();
      const level = heading[1].length;
      chunks.push(`<h${level}>${escapeHtml(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      flushPara();
      list.push(bullet[1]);
      continue;
    }
    flushList();
    para.push(line);
  }

  flushPara();
  flushList();
  return chunks.join("");
}

function proxyImg(absUrl: string): string {
  return `/api/image?url=${encodeURIComponent(absUrl)}`;
}

function isImageElement(tag: string): boolean {
  return tag === "img" || tag === "source";
}

function resolveUrls(html: string, baseUrl: string): string {
  const wrap = new JSDOM(`<body>${html}</body>`, { url: baseUrl });
  const doc = wrap.window.document;
  mergeIcons(doc);
  assignHeadingIds(doc);
  doc.querySelectorAll("[src]").forEach((el) => {
    const v = el.getAttribute("src");
    if (!v) return;
    try {
      const abs = new URL(v, baseUrl).href;
      const tag = el.tagName.toLowerCase();
      el.setAttribute("src", isImageElement(tag) ? proxyImg(abs) : abs);
    } catch {}
  });
  doc.querySelectorAll("[href]").forEach((el) => {
    const v = el.getAttribute("href");
    if (!v) return;
    try {
      el.setAttribute("href", new URL(v, baseUrl).href);
    } catch {}
  });
  doc.querySelectorAll("[srcset]").forEach((el) => {
    const v = el.getAttribute("srcset");
    if (!v) return;
    const tag = el.tagName.toLowerCase();
    const proxy = isImageElement(tag);
    const rewritten = v
      .split(",")
      .map((part) => {
        const trimmed = part.trim();
        if (!trimmed) return "";
        const [u, ...rest] = trimmed.split(/\s+/);
        try {
          const abs = new URL(u, baseUrl).href;
          return [proxy ? proxyImg(abs) : abs, ...rest].join(" ");
        } catch {
          return trimmed;
        }
      })
      .filter(Boolean)
      .join(", ");
    el.setAttribute("srcset", rewritten);
  });
  return doc.body.innerHTML;
}
