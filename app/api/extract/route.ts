import { NextResponse } from "next/server";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { sanitizeHtml, stripHtml } from "@/app/lib/rss";
import { assignHeadingIds, mergeIcons } from "@/app/lib/articleHtml";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

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
    if (!res.ok) {
      return NextResponse.json(
        { error: `Upstream ${res.status}` },
        { status: 502 },
      );
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) {
      return NextResponse.json({ error: "Page too large" }, { status: 413 });
    }
    const html = new TextDecoder("utf-8").decode(buf);

    const dom = new JSDOM(html, { url: target.toString() });
    const article = new Readability(dom.window.document).parse();
    if (!article || !article.content) {
      return NextResponse.json(
        { error: "Could not extract article body" },
        { status: 422 },
      );
    }

    const absHtml = resolveUrls(article.content, target.toString());
    const cleanHtml = sanitizeHtml(absHtml);
    const text = stripHtml(absHtml);
    return NextResponse.json(
      {
        title: article.title ?? undefined,
        byline: article.byline ?? undefined,
        siteName: article.siteName ?? undefined,
        excerpt: article.excerpt ?? undefined,
        length: article.length ?? text.length,
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
