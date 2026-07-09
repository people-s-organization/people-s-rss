function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function decodeHtmlEntities(input: string): string {
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
    switch (body.toLowerCase()) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
      case "#39":
        return "'";
      case "nbsp":
        return " ";
      default:
        return match;
    }
  });
}

function htmlToMarkdownText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\s*h([1-6])\b[^>]*>/gi, (_match, level: string) => {
        return `\n\n${"#".repeat(Number(level))} `;
      })
      .replace(/<\s*li\b[^>]*>/gi, "\n- ")
      .replace(/<\s*\/(p|div|section|article|h[1-6]|li|blockquote|pre|tr)\s*>/gi, "\n\n")
      .replace(/<[^>]+>/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
}

export function stripJinaMetadata(source: string): string {
  const lines = source.split(/\r?\n/);
  const markerIndex = lines.findIndex((line) =>
    /^Markdown Content:\s*/i.test(line.trim()),
  );
  if (markerIndex === -1) return source;
  const marker = lines[markerIndex].match(/^Markdown Content:\s*(.*)$/i);
  const firstContentLine = marker?.[1] ?? "";
  return [firstContentLine, ...lines.slice(markerIndex + 1)].join("\n").trim();
}

export function looksLikeMarkdown(source: string): boolean {
  const text = stripJinaMetadata(source).trim();
  if (!text) return false;
  if (/^Markdown Content:\s*/im.test(source)) return true;
  if (/<\/?[a-z][\s\S]*>/i.test(text)) return false;
  return /(^|\n)\s{0,3}#{1,6}\s+\S|(^|\n)\s*[-*+]\s+\S|(^|\n)\s*\d+[.)]\s+\S|!\[[^\]\n]*\]\([^)]+\)|\[[^\]\n]+\]\([^)]+\)/m.test(
    text,
  );
}

export function markdownToHtmlIfNeeded(source: string): string | null {
  const hasHtmlTags = /<\/?[a-z][\s\S]*>/i.test(source);
  const candidate = hasHtmlTags ? htmlToMarkdownText(source) : source;
  if (hasHtmlTags && !/^Markdown Content:\s*/im.test(candidate)) {
    return null;
  }
  if (!looksLikeMarkdown(candidate)) return null;
  return markdownToBasicHtml(stripJinaMetadata(candidate));
}

function isUnsafeMarkdownUrl(url: string): boolean {
  const cleaned = url.replace(/[\x00-\x1F\x7F-\x9F\s]/g, "").toLowerCase();
  return cleaned.startsWith("javascript:") || cleaned.startsWith("data:");
}

function parseMarkdownDestination(raw: string): { url: string; title?: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { url: "" };
  const angle = trimmed.match(/^<([^>]+)>(?:\s+(.+))?$/);
  const body = angle ? angle[1].trim() : trimmed;
  const titleSource = angle ? (angle[2] ?? "").trim() : "";
  if (angle) {
    return { url: body, title: unquoteMarkdownTitle(titleSource) };
  }
  const match = body.match(/^(\S+)(?:\s+(.+))?$/);
  return {
    url: match?.[1] ?? "",
    title: unquoteMarkdownTitle(match?.[2] ?? ""),
  };
}

function unquoteMarkdownTitle(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const quoted = trimmed.match(/^["'](.+)["']$/);
  return quoted ? quoted[1] : trimmed;
}

function renderInlineFormatting(escaped: string): string {
  return escaped
    .replace(/~~([^~]+)~~/g, "<s>$1</s>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^\w])\*([^*\s][^*]*?)\*/g, "$1<em>$2</em>");
}

function renderInlineMarkdown(source: string): string {
  let html = "";
  let plain = "";
  let i = 0;

  const flushPlain = () => {
    if (!plain) return;
    html += renderInlineFormatting(escapeHtml(plain));
    plain = "";
  };

  while (i < source.length) {
    if (source[i] === "`") {
      const end = source.indexOf("`", i + 1);
      if (end !== -1) {
        flushPlain();
        html += `<code>${escapeHtml(source.slice(i + 1, end))}</code>`;
        i = end + 1;
        continue;
      }
    }

    const isImage = source.startsWith("![", i);
    const linkStartOffset = isImage ? 2 : 1;
    if (isImage || source[i] === "[") {
      const labelStart = i + linkStartOffset;
      const labelEnd = source.indexOf("]", labelStart);
      if (labelEnd !== -1 && source[labelEnd + 1] === "(") {
        const destEnd = source.indexOf(")", labelEnd + 2);
        if (destEnd !== -1) {
          const label = source.slice(labelStart, labelEnd);
          const dest = parseMarkdownDestination(source.slice(labelEnd + 2, destEnd));
          if (dest.url && !isUnsafeMarkdownUrl(dest.url)) {
            flushPlain();
            const titleAttr = dest.title
              ? ` title="${escapeHtml(dest.title)}"`
              : "";
            if (isImage) {
              html += `<img src="${escapeHtml(dest.url)}" alt="${escapeHtml(label)}"${titleAttr} />`;
            } else {
              html += `<a href="${escapeHtml(dest.url)}"${titleAttr}>${renderInlineMarkdown(label)}</a>`;
            }
            i = destEnd + 1;
            continue;
          }
        }
      }
    }

    plain += source[i];
    i += 1;
  }

  flushPlain();
  return html;
}

export function markdownToBasicHtml(source: string): string {
  const lines = source.split(/\r?\n/);
  const chunks: string[] = [];
  let para: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | null = null;
  let codeFence: string[] | null = null;

  const flushPara = () => {
    if (!para.length) return;
    chunks.push(`<p>${renderInlineMarkdown(para.join(" "))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    chunks.push(
      `<${list.tag}>${list.items
        .map((item) => `<li>${renderInlineMarkdown(item)}</li>`)
        .join("")}</${list.tag}>`,
    );
    list = null;
  };

  for (const raw of lines) {
    if (/^```/.test(raw.trim())) {
      if (codeFence) {
        chunks.push(`<pre><code>${escapeHtml(codeFence.join("\n"))}</code></pre>`);
        codeFence = null;
      } else {
        flushPara();
        flushList();
        codeFence = [];
      }
      continue;
    }
    if (codeFence) {
      codeFence.push(raw);
      continue;
    }

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
      chunks.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    if (/^([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      flushPara();
      flushList();
      chunks.push("<hr>");
      continue;
    }
    const bullet = line.match(/^[-*+]\s+(.+)$/);
    if (bullet) {
      flushPara();
      if (!list || list.tag !== "ul") {
        flushList();
        list = { tag: "ul", items: [] };
      }
      list.items.push(bullet[1]);
      continue;
    }
    const ordered = line.match(/^\d+[.)]\s+(.+)$/);
    if (ordered) {
      flushPara();
      if (!list || list.tag !== "ol") {
        flushList();
        list = { tag: "ol", items: [] };
      }
      list.items.push(ordered[1]);
      continue;
    }
    const quote = line.match(/^>\s?(.+)$/);
    if (quote) {
      flushPara();
      flushList();
      chunks.push(`<blockquote><p>${renderInlineMarkdown(quote[1])}</p></blockquote>`);
      continue;
    }
    flushList();
    para.push(line);
  }

  if (codeFence) {
    chunks.push(`<pre><code>${escapeHtml(codeFence.join("\n"))}</code></pre>`);
  }
  flushPara();
  flushList();
  return chunks.join("");
}
