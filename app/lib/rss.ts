import { XMLParser } from "fast-xml-parser";
import { parseHTML } from "linkedom";
import type { ParsedFeed, ParsedItem } from "./types";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
  textNodeName: "#text",
  parseTagValue: false,
  parseAttributeValue: false,
});

// Some feeds (notably xueqiu) double-encode their HTML payload as
// &lt;![CDATA[...]]&gt; — once the XML parser decodes entities, we end up
// with literal <![CDATA[...]]> markers in what is supposed to be HTML.
// Browsers and linkedom treat <![ as a bogus comment opener and consume
// the entire body as a comment, which makes the article render blank.
// Strip the literal markers before anything else touches the string.
function stripLiteralCdata(html: string): string {
  let out = html;
  // Strip a wrapping <![CDATA[ ... ]]>, then any leftover stray markers.
  out = out.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/g, "$1");
  out = out.replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "");
  return out;
}

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

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  copy: "©",
  reg: "®",
  trade: "™",
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith("#")) {
      const isHex = body[1] === "x" || body[1] === "X";
      const num = parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (Number.isFinite(num) && num > 0 && num <= 0x10ffff) {
        try {
          return String.fromCodePoint(num);
        } catch {
          return match;
        }
      }
      return match;
    }
    const lower = body.toLowerCase();
    return NAMED_ENTITIES[lower] ?? match;
  });
}

function cleanText(s: string | undefined): string | undefined {
  if (!s) return undefined;
  return decodeEntities(s).replace(/\s+/g, " ").trim() || undefined;
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
  const title = cleanText(pickText(item.title)) ?? "(untitled)";
  const link = pickText(item.link) ?? pickText(item.guid) ?? "";
  const author =
    cleanText(pickText(item.author)) ??
    cleanText(pickText(item["dc:creator"])) ??
    undefined;
  const publishedAt =
    parseDate(pickText(item.pubDate)) ??
    parseDate(pickText(item["dc:date"]));
  const encoded = pickText(item["content:encoded"]);
  const rawHtml = encoded ?? pickText(item.description) ?? undefined;
  const unwrapped = rawHtml ? stripLiteralCdata(rawHtml) : undefined;
  const contentHtml = unwrapped ? sanitizeHtml(unwrapped) : undefined;
  const contentText = unwrapped ? stripHtml(unwrapped) : undefined;
  const hasFullContent = Boolean(encoded);
  const guid = pickText(item.guid);
  return {
    title,
    link,
    author,
    publishedAt,
    contentHtml,
    contentText,
    hasFullContent,
    guid,
  };
}

function parseAtomFeed(feed: Record<string, unknown>): ParsedFeed {
  const title = pickText(feed.title) ?? "Untitled";
  const entries = asArray(feed.entry as unknown).map((e) =>
    parseAtomEntry(e as Record<string, unknown>),
  );
  return { title, items: entries };
}

function parseAtomEntry(entry: Record<string, unknown>): ParsedItem {
  const title = cleanText(pickText(entry.title)) ?? "(untitled)";
  const link = findAtomLink(entry.link) ?? "";
  const authorNode = entry.author as Record<string, unknown> | undefined;
  const author = authorNode
    ? cleanText(pickText(authorNode.name ?? authorNode))
    : undefined;
  const publishedAt =
    parseDate(pickText(entry.published)) ??
    parseDate(pickText(entry.updated));
  const content = pickText(entry.content);
  const rawHtml = content ?? pickText(entry.summary) ?? undefined;
  const unwrapped = rawHtml ? stripLiteralCdata(rawHtml) : undefined;
  const contentHtml = unwrapped ? sanitizeHtml(unwrapped) : undefined;
  const contentText = unwrapped ? stripHtml(unwrapped) : undefined;
  const hasFullContent = Boolean(content);
  const guid = pickText(entry.id);
  return {
    title,
    link,
    author,
    publishedAt,
    contentHtml,
    contentText,
    hasFullContent,
    guid,
  };
}

export { stripHtml };

const ALLOWED_TAGS = new Set([
  "a", "p", "br", "hr",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "b", "strong", "i", "em", "u", "s", "small", "sub", "sup", "mark",
  "ul", "ol", "li", "dl", "dt", "dd",
  "blockquote", "pre", "code", "kbd", "samp",
  "img", "picture", "source", "figure", "figcaption",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
  "div", "span",
]);

const HEADING_ATTRS = new Set(["id"]);

const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "title", "rel", "target"]),
  img: new Set([
    "src",
    "srcset",
    "sizes",
    "alt",
    "title",
    "width",
    "height",
    "class",
  ]),
  source: new Set(["src", "srcset", "sizes", "media", "type"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan", "scope"]),
  h1: HEADING_ATTRS,
  h2: HEADING_ATTRS,
  h3: HEADING_ATTRS,
  h4: HEADING_ATTRS,
  h5: HEADING_ATTRS,
  h6: HEADING_ATTRS,
};

const CLASS_ALLOWLIST: Record<string, Set<string>> = {
  img: new Set(["prss-icon"]),
};

const URL_ATTRS = new Set(["href", "src"]);

function isSafeUrl(value: string): boolean {
  const cleaned = value.replace(/[\x00-\x1F\x7F-\x9F\s]/g, "").toLowerCase();
  if (cleaned.startsWith("javascript:") || cleaned.startsWith("data:")) {
    if (cleaned.startsWith("data:image/")) return true;
    return false;
  }
  return true;
}

export function sanitizeHtml(input: string): string {
  let html = input;
  html = html.replace(/<!--[\s\S]*?-->/g, "");
  // Pre-strip dangerous elements with regex BEFORE DOM parsing.
  // These tags are not in ALLOWED_TAGS so the DOM pass would remove them too,
  // but DOM unwrapping preserves child nodes — meaning <script>alert(1)</script>
  // would leak "alert(1)" as visible text and <style> blocks would leak raw CSS.
  // Regex removal eliminates the entire element including its content.
  html = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  html = html.replace(/<style[\s\S]*?<\/style>/gi, "");
  html = html.replace(/<iframe[\s\S]*?<\/iframe>/gi, "");
  html = html.replace(/<object[\s\S]*?<\/object>/gi, "");
  html = html.replace(/<embed[\s\S]*?>/gi, "");

  const wrapped = `<!DOCTYPE html><html><body>${html}</body></html>`;
  const { document } = parseHTML(wrapped);
  const body = document.body;

  // Strip any attributes that linkedom may have parsed onto <body> itself
  // (e.g. from malformed HTML like `<body onload="...">` embedded in input).
  for (const attr of Array.from(body.attributes)) {
    body.removeAttribute(attr.name);
  }

  const cleanElement = (el: Element) => {
    const children = Array.from(el.children);
    for (const child of children) {
      cleanElement(child);
    }

    const tag = el.tagName.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) {
      const parent = el.parentNode;
      if (parent) {
        while (el.firstChild) {
          parent.insertBefore(el.firstChild, el);
        }
        parent.removeChild(el);
      }
      return;
    }

    const attrAllow = ALLOWED_ATTRS[tag];
    const attributes = Array.from(el.attributes);
    for (const attr of attributes) {
      const name = attr.name.toLowerCase();
      if (!attrAllow || !attrAllow.has(name)) {
        el.removeAttribute(attr.name);
        continue;
      }
      const value = attr.value;
      if (URL_ATTRS.has(name)) {
        if (!isSafeUrl(value)) {
          el.removeAttribute(attr.name);
          continue;
        }
      }
      if (name === "class") {
        const allowedClasses = CLASS_ALLOWLIST[tag];
        if (!allowedClasses) {
          el.removeAttribute(attr.name);
          continue;
        }
        const kept = value
          .split(/\s+/)
          .filter((c) => allowedClasses.has(c));
        if (kept.length === 0) {
          el.removeAttribute(attr.name);
        } else {
          el.setAttribute(attr.name, kept.join(" "));
        }
      }
    }

    if (tag === "a") {
      if (el.hasAttribute("href")) {
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener noreferrer");
      }
    } else if (tag === "img") {
      el.setAttribute("loading", "lazy");
      el.setAttribute("decoding", "async");
      el.setAttribute("referrerpolicy", "no-referrer");
    }
  };

  const bodyChildren = Array.from(body.children);
  for (const child of bodyChildren) {
    cleanElement(child);
  }

  return body.innerHTML;
}
