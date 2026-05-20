import { NextResponse } from "next/server";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { sanitizeHtml, stripHtml } from "@/app/lib/rss";

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

const EMOJI_ONLY = /^[\s‍️\p{Extended_Pictographic}]+$/u;

function isEmojiOnlyParagraph(p: Element): boolean {
  // Only emoji text, nothing else
  if (p.children.length > 0) return false;
  const trimmed = (p.textContent ?? "").trim();
  if (!trimmed || trimmed.length > 4) return false;
  return EMOJI_ONLY.test(trimmed);
}

function isImageOnlyParagraph(p: Element): Element | null {
  // Returns the single <img> if the <p> is essentially just one image
  const text = (p.textContent ?? "").trim();
  if (text) return null;
  const imgs = p.querySelectorAll("img");
  if (imgs.length !== 1) return null;
  return imgs[0];
}

const MERGE_TARGET_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6"]);

function getIconFromElement(el: Element): Element | null {
  const tag = el.tagName.toLowerCase();
  if (tag === "img") return el;
  if (tag === "p" || tag === "div") return isImageOnlyParagraph(el);
  return null;
}

function mergeEmojiHeadings(doc: Document): void {
  // Pass 1: merge text-emoji-only <p> into the following <p>
  Array.from(doc.querySelectorAll("p")).forEach((p) => {
    if (!isEmojiOnlyParagraph(p)) return;
    const next = p.nextElementSibling;
    if (!next || !MERGE_TARGET_TAGS.has(next.tagName.toLowerCase())) return;
    if (!(next.textContent ?? "").trim()) return;
    const prefix = doc.createTextNode(`${(p.textContent ?? "").trim()} `);
    next.insertBefore(prefix, next.firstChild);
    p.remove();
  });

  // Pass 2: merge an image (bare <img> or img-only <p>/<div>) sitting right
  // before a <p> or heading.
  Array.from(doc.body.querySelectorAll("*")).forEach((el) => {
    const icon = getIconFromElement(el);
    if (!icon) return;
    const next = el.nextElementSibling;
    if (!next || !MERGE_TARGET_TAGS.has(next.tagName.toLowerCase())) return;
    if (!(next.textContent ?? "").trim()) return;
    const clone = icon.cloneNode(true) as Element;
    clone.classList.add("prss-icon");
    next.insertBefore(doc.createTextNode(" "), next.firstChild);
    next.insertBefore(clone, next.firstChild);
    el.remove();
  });
}

function assignHeadingIds(doc: Document): void {
  const used = new Set<string>();
  doc.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((h) => {
    if (h.id) {
      used.add(h.id);
      return;
    }
    const text = (h.textContent ?? "").trim();
    if (!text) return;
    const base = slugify(text);
    let id = base || "section";
    let i = 2;
    while (used.has(id)) {
      id = `${base}-${i++}`;
    }
    used.add(id);
    h.setAttribute("id", id);
  });
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60);
}

function resolveUrls(html: string, baseUrl: string): string {
  const wrap = new JSDOM(`<body>${html}</body>`, { url: baseUrl });
  const doc = wrap.window.document;
  mergeEmojiHeadings(doc);
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
