import { parseHTML } from "linkedom";

type DocLike = ReturnType<typeof parseHTML>["document"];

export function parseDocument(html: string, baseUrl?: string): DocLike {
  const wrapped = /<html[\s>]/i.test(html)
    ? html
    : `<!DOCTYPE html><html><head></head><body>${html}</body></html>`;
  const { document } = parseHTML(wrapped);
  if (baseUrl && document.head) {
    const base = document.createElement("base");
    base.setAttribute("href", baseUrl);
    document.head.appendChild(base);
  }
  return document;
}
