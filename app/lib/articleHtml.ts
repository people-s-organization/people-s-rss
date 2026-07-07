import { parseDocument } from "./dom";
import { normalizeHttpUrl } from "./url";

const EMOJI_ONLY = /^[\s‍️\p{Extended_Pictographic}]+$/u;
const MERGE_TARGET_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6"]);
const ICON_WIDTH_THRESHOLD = 96;

function isEmojiOnlyParagraph(p: Element): boolean {
  if (p.children.length > 0) return false;
  const trimmed = (p.textContent ?? "").trim();
  if (!trimmed || trimmed.length > 4) return false;
  return EMOJI_ONLY.test(trimmed);
}

function isImageOnlyParagraph(p: Element): Element | null {
  const text = (p.textContent ?? "").trim();
  if (text) return null;
  const imgs = p.querySelectorAll("img");
  if (imgs.length !== 1) return null;
  return imgs[0];
}

function getIconCandidate(el: Element): Element | null {
  const tag = el.tagName.toLowerCase();
  if (tag === "img") return el;
  if (tag === "p" || tag === "div" || tag === "section") {
    return isImageOnlyParagraph(el);
  }
  return null;
}

function looksLikeIconImg(img: Element): boolean {
  const alt = (img.getAttribute("alt") ?? "").trim();
  // Single-emoji alt → icon
  if (alt && alt.length <= 2 && /\p{Extended_Pictographic}/u.test(alt)) {
    return true;
  }
  // Known emoji CDN
  const src = img.getAttribute("src") ?? "";
  if (/\/emoji\//i.test(src)) return true;
  // Explicit width is the most reliable signal: a hero photo is almost
  // always emitted with a large width attribute, while sticker-style icons
  // are at most a couple hundred pixels.
  const widthStr = img.getAttribute("width");
  if (widthStr) {
    const w = parseInt(widthStr, 10);
    if (Number.isFinite(w) && w > 0) {
      return w <= ICON_WIDTH_THRESHOLD;
    }
  }
  // No width attribute: fall back to a short label-style alt
  // (e.g. iFanr's "重磅", "大公司" section markers).
  if (alt && alt.length <= 4) {
    return true;
  }
  return false;
}

// Descend through single-block wrappers (e.g. <div><p>text</p></div>) to find
// the actual text-bearing target paragraph.
function resolveMergeTarget(next: Element): Element | null {
  const tag = next.tagName.toLowerCase();
  if (MERGE_TARGET_TAGS.has(tag)) {
    return (next.textContent ?? "").trim() ? next : null;
  }
  if (tag === "div") {
    const children = Array.from(next.children);
    if (children.length === 1) {
      return resolveMergeTarget(children[0]);
    }
  }
  return null;
}

function unwrapPureDivs(doc: Document): void {
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 20) {
    changed = false;
    for (const div of Array.from(doc.body.querySelectorAll("div"))) {
      if (div === doc.body) continue;
      const children = Array.from(div.children);
      if (children.length !== 1) continue;
      // No bare text inside the div besides whitespace
      const hasNonWhitespaceText = Array.from(div.childNodes).some(
        (n) => n.nodeType === 3 && ((n.textContent ?? "").trim().length > 0),
      );
      if (hasNonWhitespaceText) continue;
      div.replaceWith(children[0]);
      changed = true;
    }
  }
}

export function mergeIcons(doc: Document): void {
  // Pass 1: collapse text-emoji <p> into the following block
  Array.from(doc.body.querySelectorAll("p")).forEach((p) => {
    if (!isEmojiOnlyParagraph(p)) return;
    const next = p.nextElementSibling;
    if (!next) return;
    const target = resolveMergeTarget(next);
    if (!target) return;
    const prefix = doc.createTextNode(`${(p.textContent ?? "").trim()} `);
    target.insertBefore(prefix, target.firstChild);
    p.remove();
  });

  // Pass 2: collapse image-icon blocks into the following text/heading
  // block. Only merge when the image looks icon-sized — hero photos that
  // happen to sit before a paragraph or heading stay as their own block.
  Array.from(doc.body.querySelectorAll("*")).forEach((el) => {
    if (!el.parentNode) return;
    const icon = getIconCandidate(el);
    if (!icon) return;
    if (!looksLikeIconImg(icon)) return;
    const next = el.nextElementSibling;
    if (!next) return;
    const target = resolveMergeTarget(next);
    if (!target) return;
    const clone = icon.cloneNode(true) as Element;
    clone.classList.add("prss-icon");
    target.insertBefore(doc.createTextNode(" "), target.firstChild);
    target.insertBefore(clone, target.firstChild);
    el.remove();
  });

  // Pass 3: flatten leftover single-child <div> wrappers so the layout
  // collapses cleanly (iFanr-style nested divs)
  unwrapPureDivs(doc);
}

export function assignHeadingIds(doc: Document): void {
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

const IMAGE_SRCSET_WIDTHS = [400, 800, 1200, 1600];
const IMAGE_DEFAULT_WIDTH = 1200;
const IMAGE_SIZES = "(min-width: 768px) 768px, 100vw";

function proxiedImageUrl(absUrl: string, width?: number): string {
  const w = width ? `&w=${width}` : "";
  return `/api/image?url=${encodeURIComponent(absUrl)}${w}`;
}

function buildSrcset(absUrl: string): string {
  return IMAGE_SRCSET_WIDTHS.map(
    (w) => `${proxiedImageUrl(absUrl, w)} ${w}w`,
  ).join(", ");
}

function absolutize(value: string, baseUrl: string | undefined): string | null {
  if (!value) return null;
  if (/^data:/i.test(value)) return null;
  if (/^\/api\/image\?/i.test(value)) return null;
  try {
    return baseUrl ? new URL(value, baseUrl).href : new URL(value).href;
  } catch {
    return null;
  }
}

export function proxyImagesInDoc(
  doc: Document,
  baseUrl: string | undefined,
  options: { srcset?: boolean } = {},
): void {
  const includeSrcset = options.srcset ?? true;
  doc.querySelectorAll("img").forEach((img) => {
    const rawSrc = img.getAttribute("src");
    const abs = rawSrc ? absolutize(rawSrc, baseUrl) : null;
    if (abs) {
      img.setAttribute("src", proxiedImageUrl(abs, IMAGE_DEFAULT_WIDTH));
      if (includeSrcset) {
        img.setAttribute("srcset", buildSrcset(abs));
        if (!img.hasAttribute("sizes")) img.setAttribute("sizes", IMAGE_SIZES);
      } else {
        img.removeAttribute("srcset");
        img.removeAttribute("sizes");
      }
    }
    img.setAttribute("decoding", "async");
    if (!img.hasAttribute("loading")) img.setAttribute("loading", "lazy");
  });

  if (!includeSrcset) {
    doc.querySelectorAll("source[srcset]").forEach((src) => src.remove());
    return;
  }

  doc.querySelectorAll("source[srcset]").forEach((src) => {
    const v = src.getAttribute("srcset");
    if (!v) return;
    const parts = v
      .split(",")
      .map((part) => {
        const trimmed = part.trim();
        if (!trimmed) return "";
        const [u, ...descriptor] = trimmed.split(/\s+/);
        const abs = absolutize(u, baseUrl);
        return abs
          ? [proxiedImageUrl(abs, IMAGE_DEFAULT_WIDTH), ...descriptor].join(" ")
          : trimmed;
      })
      .filter(Boolean);
    src.setAttribute("srcset", parts.join(", "));
  });
}

function normalizeLinksInDoc(doc: Document, baseUrl: string | undefined): void {
  doc.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href");
    if (!href) return;
    const normalized = normalizeHttpUrl(href, baseUrl);
    if (!normalized) {
      a.removeAttribute("href");
      a.removeAttribute("target");
      a.removeAttribute("rel");
      return;
    }
    a.setAttribute("href", normalized);
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
  });
}

export function normalizeArticleHtml(
  html: string,
  baseUrl?: string,
  options?: { imageSrcset?: boolean },
): string {
  const doc = parseDocument(html, baseUrl);
  mergeIcons(doc as unknown as Document);
  assignHeadingIds(doc as unknown as Document);
  proxyImagesInDoc(doc as unknown as Document, baseUrl, {
    srcset: options?.imageSrcset,
  });
  normalizeLinksInDoc(doc as unknown as Document, baseUrl);
  return doc.body?.innerHTML ?? "";
}
