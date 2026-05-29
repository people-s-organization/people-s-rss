import { NextResponse } from "next/server";
import { Readability } from "@mozilla/readability";
import { sanitizeHtml, stripHtml } from "@/app/lib/rss";
import {
  assignHeadingIds,
  mergeIcons,
  proxyImagesInDoc,
} from "@/app/lib/articleHtml";
import { parseDocument } from "@/app/lib/dom";
import { assertPublicHttpUrl, safeFetch, SSRFError } from "@/app/lib/ssrfGuard";
import { rateLimit, rateLimitedResponse } from "@/app/lib/rateLimit";
import { auth } from "@/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const JINA_TIMEOUT_MS = 20_000;
const JINA_READER_HOST = "https://r.jina.ai/";

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || /abort/i.test(err.message))
  );
}

async function fetchWithTimeout(
  url: string,
  init: Parameters<typeof safeFetch>[1],
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await safeFetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function callerIdentity(request: Request, githubId?: string): string {
  if (githubId) return `u:${githubId}`;
  const fwd = request.headers.get("x-forwarded-for") ?? "";
  const ip = fwd.split(",")[0].trim() || "anon";
  return `ip:${ip}`;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get("url");
  if (!url) {
    return NextResponse.json({ error: "Missing url" }, { status: 400 });
  }

  const session = await auth().catch(() => null);
  const identity = callerIdentity(request, session?.user?.githubId);
  const rl = await rateLimit("extract", identity, 30, 60);
  if (!rl.ok) return rateLimitedResponse(rl);

  const normalizedUrl = normalizeTargetUrl(url);
  if (!normalizedUrl) {
    return NextResponse.json({ error: "Invalid url" }, { status: 400 });
  }

  let target: URL;
  try {
    target = await assertPublicHttpUrl(normalizedUrl);
  } catch (err) {
    if (err instanceof SSRFError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "Invalid url" }, { status: 400 });
  }

  let extracted: Extracted | null = null;
  let timedOut = false;

  // 1) Try fetching the page directly and running Readability on it.
  try {
    const res = await fetchWithTimeout(
      target.toString(),
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; PeoplesRSS/1.0; +https://rss.baomi.app)",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        redirect: "follow",
      },
      FETCH_TIMEOUT_MS,
    );
    if (res.ok) {
      extracted = await parseArticleFromHtml(res, target);
    }
  } catch (err) {
    if (err instanceof SSRFError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    // A timeout/network failure here is not fatal: fall through to the mirror.
    timedOut = isAbortError(err);
  }

  // 2) Fallback: the site blocked us, served non-article HTML, failed to parse,
  // or the direct fetch errored/timed out. Try the text-extraction mirror.
  if (!extracted) {
    extracted = await extractViaJina(target).catch(() => null);
  }

  if (!extracted) {
    if (timedOut) {
      return NextResponse.json(
        { error: "Timed out fetching the article. Please try again." },
        { status: 504 },
      );
    }
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
}

type Extracted = {
  title?: string;
  byline?: string;
  siteName?: string;
  excerpt?: string;
  length?: number;
  contentHtml: string;
};

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
  const doc = parseDocument(html, target.toString());
  const article = new Readability(doc as unknown as Document).parse();
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
  const mirrorUrl = `${JINA_READER_HOST}${target.protocol}//${target.host}${target.pathname}${target.search}${target.hash}`;
  const res = await fetchWithTimeout(
    mirrorUrl,
    {
      headers: {
        Accept: "text/plain,text/markdown;q=0.9,*/*;q=0.1",
      },
    },
    JINA_TIMEOUT_MS,
  );
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

function resolveUrls(html: string, baseUrl: string): string {
  const doc = parseDocument(html, baseUrl);
  mergeIcons(doc);
  assignHeadingIds(doc);
  proxyImagesInDoc(doc, baseUrl);
  doc.querySelectorAll("a[href]").forEach((el) => {
    const v = el.getAttribute("href");
    if (!v) return;
    try {
      el.setAttribute("href", new URL(v, baseUrl).href);
    } catch {}
  });
  return doc.body.innerHTML;
}


function normalizeTargetUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;

  const candidates = [value];
  try {
    const decoded = decodeURIComponent(value);
    if (decoded !== value) candidates.push(decoded);
  } catch {}
  try {
    const decodedTwice = decodeURIComponent(candidates[candidates.length - 1]);
    if (decodedTwice !== candidates[candidates.length - 1]) candidates.push(decodedTwice);
  } catch {}

  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return parsed.toString();
      }
    } catch {}
  }
  return null;
}
