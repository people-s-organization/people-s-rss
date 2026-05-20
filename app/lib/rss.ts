import { XMLParser } from "fast-xml-parser";
import type { ParsedFeed, ParsedItem } from "./types";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
  textNodeName: "#text",
  parseTagValue: false,
  parseAttributeValue: false,
});

function pickText(node: unknown): string | undefined {
  if (node == null) return undefined;
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) {
    for (const child of node) {
      const v = pickText(child);
      if (v) return v;
    }
    return undefined;
  }
  if (typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (typeof obj["#text"] === "string") return obj["#text"] as string;
    if (typeof obj["@_href"] === "string") return obj["@_href"] as string;
  }
  return undefined;
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDate(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
}

function findAtomLink(links: unknown): string | undefined {
  const arr = asArray(links);
  let alt: string | undefined;
  for (const l of arr) {
    if (typeof l === "object" && l) {
      const o = l as Record<string, unknown>;
      const rel = o["@_rel"];
      const href = o["@_href"];
      if (typeof href === "string") {
        if (rel === "alternate" || rel == null) alt ??= href;
      }
    } else if (typeof l === "string") {
      alt ??= l;
    }
  }
  return alt;
}

export function parseFeedXml(xml: string): ParsedFeed {
  const parsed = parser.parse(xml) as Record<string, unknown>;

  const rss = parsed.rss as Record<string, unknown> | undefined;
  if (rss && typeof rss === "object") {
    const channel = rss.channel as Record<string, unknown> | undefined;
    if (channel) return parseRssChannel(channel);
  }
  const rdf = parsed["rdf:RDF"] as Record<string, unknown> | undefined;
  if (rdf) {
    const channel = rdf.channel as Record<string, unknown> | undefined;
    const items = asArray(rdf.item as unknown);
    const title = pickText(channel?.title) ?? "Untitled";
    return {
      title,
      items: items.map((it) => parseRssItem(it as Record<string, unknown>)),
    };
  }
  const feed = parsed.feed as Record<string, unknown> | undefined;
  if (feed) return parseAtomFeed(feed);

  throw new Error("Unrecognized feed format");
}

function parseRssChannel(channel: Record<string, unknown>): ParsedFeed {
  const title = pickText(channel.title) ?? "Untitled";
  const items = asArray(channel.item as unknown).map((it) =>
    parseRssItem(it as Record<string, unknown>),
  );
  return { title, items };
}

function parseRssItem(item: Record<string, unknown>): ParsedItem {
  const title = pickText(item.title) ?? "(untitled)";
  const link = pickText(item.link) ?? pickText(item.guid) ?? "";
  const author =
    pickText(item.author) ??
    pickText(item["dc:creator"]) ??
    undefined;
  const publishedAt =
    parseDate(pickText(item.pubDate)) ??
    parseDate(pickText(item["dc:date"]));
  const rawHtml =
    pickText(item["content:encoded"]) ??
    pickText(item.description) ??
    undefined;
  const contentHtml = rawHtml ? sanitizeHtml(rawHtml) : undefined;
  const contentText = rawHtml ? stripHtml(rawHtml) : undefined;
  const guid = pickText(item.guid);
  return { title, link, author, publishedAt, contentHtml, contentText, guid };
}

function parseAtomFeed(feed: Record<string, unknown>): ParsedFeed {
  const title = pickText(feed.title) ?? "Untitled";
  const entries = asArray(feed.entry as unknown).map((e) =>
    parseAtomEntry(e as Record<string, unknown>),
  );
  return { title, items: entries };
}

function parseAtomEntry(entry: Record<string, unknown>): ParsedItem {
  const title = pickText(entry.title) ?? "(untitled)";
  const link = findAtomLink(entry.link) ?? "";
  const authorNode = entry.author as Record<string, unknown> | undefined;
  const author = authorNode ? pickText(authorNode.name ?? authorNode) : undefined;
  const publishedAt =
    parseDate(pickText(entry.published)) ??
    parseDate(pickText(entry.updated));
  const rawHtml =
    pickText(entry.content) ??
    pickText(entry.summary) ??
    undefined;
  const contentHtml = rawHtml ? sanitizeHtml(rawHtml) : undefined;
  const contentText = rawHtml ? stripHtml(rawHtml) : undefined;
  const guid = pickText(entry.id);
  return { title, link, author, publishedAt, contentHtml, contentText, guid };
}

export { stripHtml };

const ALLOWED_TAGS = new Set([
  "a", "p", "br", "hr",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "b", "strong", "i", "em", "u", "s", "small", "sub", "sup", "mark",
  "ul", "ol", "li", "dl", "dt", "dd",
  "blockquote", "pre", "code", "kbd", "samp",
  "img", "figure", "figcaption",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
  "div", "span",
]);

const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "title", "rel", "target"]),
  img: new Set(["src", "alt", "title", "width", "height"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan", "scope"]),
};

const URL_ATTRS = new Set(["href", "src"]);

function isSafeUrl(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith("javascript:") || trimmed.startsWith("data:")) {
    if (trimmed.startsWith("data:image/")) return true;
    return false;
  }
  return true;
}

export function sanitizeHtml(input: string): string {
  let html = input;
  html = html.replace(/<!--[\s\S]*?-->/g, "");
  html = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  html = html.replace(/<style[\s\S]*?<\/style>/gi, "");
  html = html.replace(/<iframe[\s\S]*?<\/iframe>/gi, "");
  html = html.replace(/<object[\s\S]*?<\/object>/gi, "");
  html = html.replace(/<embed[\s\S]*?>/gi, "");

  html = html.replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g, (match, rawTag: string, rawAttrs: string) => {
    const tag = rawTag.toLowerCase();
    const isClosing = match.startsWith("</");
    if (!ALLOWED_TAGS.has(tag)) return "";
    if (isClosing) return `</${tag}>`;

    const attrAllow = ALLOWED_ATTRS[tag];
    const sanitizedAttrs: string[] = [];
    if (attrAllow) {
      const attrRegex = /([a-zA-Z_:][a-zA-Z0-9_.:-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
      let attrMatch: RegExpExecArray | null;
      while ((attrMatch = attrRegex.exec(rawAttrs)) !== null) {
        const name = attrMatch[1].toLowerCase();
        if (!attrAllow.has(name)) continue;
        const value = attrMatch[3] ?? attrMatch[4] ?? attrMatch[5] ?? "";
        if (URL_ATTRS.has(name) && !isSafeUrl(value)) continue;
        const safeValue = value
          .replace(/&/g, "&amp;")
          .replace(/"/g, "&quot;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        sanitizedAttrs.push(`${name}="${safeValue}"`);
      }
    }
    if (tag === "a") {
      const hasHref = sanitizedAttrs.some((a) => a.startsWith("href="));
      if (hasHref) {
        sanitizedAttrs.push('target="_blank"');
        sanitizedAttrs.push('rel="noopener noreferrer"');
      }
    }
    if (tag === "img") {
      sanitizedAttrs.push('loading="lazy"');
      sanitizedAttrs.push('referrerpolicy="no-referrer"');
    }
    return `<${tag}${sanitizedAttrs.length ? " " + sanitizedAttrs.join(" ") : ""}>`;
  });

  return html;
}
