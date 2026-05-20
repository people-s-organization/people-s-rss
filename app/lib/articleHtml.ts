import { JSDOM } from "jsdom";

const EMOJI_ONLY = /^[\s‍️\p{Extended_Pictographic}]+$/u;
const MERGE_TARGET_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6"]);

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

function getIconFromElement(el: Element): Element | null {
  const tag = el.tagName.toLowerCase();
  if (tag === "img") return el;
  if (tag === "p" || tag === "div") return isImageOnlyParagraph(el);
  return null;
}

export function mergeIcons(doc: Document): void {
  Array.from(doc.querySelectorAll("p")).forEach((p) => {
    if (!isEmojiOnlyParagraph(p)) return;
    const next = p.nextElementSibling;
    if (!next || !MERGE_TARGET_TAGS.has(next.tagName.toLowerCase())) return;
    if (!(next.textContent ?? "").trim()) return;
    const prefix = doc.createTextNode(`${(p.textContent ?? "").trim()} `);
    next.insertBefore(prefix, next.firstChild);
    p.remove();
  });

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

export function normalizeArticleHtml(html: string, baseUrl?: string): string {
  const wrap = new JSDOM(`<body>${html}</body>`, baseUrl ? { url: baseUrl } : undefined);
  const doc = wrap.window.document;
  mergeIcons(doc);
  assignHeadingIds(doc);
  return doc.body.innerHTML;
}
