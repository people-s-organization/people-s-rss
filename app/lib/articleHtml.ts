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

  // Pass 2: collapse image-icon blocks into the following text block
  Array.from(doc.body.querySelectorAll("*")).forEach((el) => {
    if (!el.parentNode) return; // already removed above
    const icon = getIconFromElement(el);
    if (!icon) return;
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

export function normalizeArticleHtml(html: string, baseUrl?: string): string {
  const wrap = new JSDOM(`<body>${html}</body>`, baseUrl ? { url: baseUrl } : undefined);
  const doc = wrap.window.document;
  mergeIcons(doc);
  assignHeadingIds(doc);
  return doc.body.innerHTML;
}
