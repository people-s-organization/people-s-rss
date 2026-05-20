import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  endpoint?: string;
  apiKey?: string;
  model?: string;
  title?: string;
  content?: string;
  url?: string;
  language?: string;
};

const MAX_CONTENT = 60_000;
const FETCH_TIMEOUT_MS = 60_000;

export async function POST(request: Request) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const endpoint = body.endpoint?.trim();
  const apiKey = body.apiKey?.trim();
  const model = body.model?.trim();
  if (!endpoint || !apiKey || !model) {
    return NextResponse.json(
      { error: "endpoint, apiKey, and model are required" },
      { status: 400 },
    );
  }

  let endpointUrl: URL;
  try {
    endpointUrl = new URL(endpoint);
  } catch {
    return NextResponse.json({ error: "Invalid endpoint" }, { status: 400 });
  }
  if (endpointUrl.protocol !== "http:" && endpointUrl.protocol !== "https:") {
    return NextResponse.json(
      { error: "Unsupported endpoint protocol" },
      { status: 400 },
    );
  }

  const content = (body.content ?? "").slice(0, MAX_CONTENT);
  if (!content) {
    return NextResponse.json({ error: "Empty content" }, { status: 400 });
  }
  const language = body.language || "the same language as the article";

  const userPrompt = [
    body.title ? `Title: ${body.title}` : null,
    body.url ? `URL: ${body.url}` : null,
    "",
    "Article:",
    content,
  ]
    .filter(Boolean)
    .join("\n");

  const completionsUrl = buildCompletionsUrl(endpointUrl);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(completionsUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          {
            role: "system",
            content: `You summarize RSS articles. Reply in ${language}. Produce 3-6 concise bullet points capturing key facts, conclusions, and any numbers. No preamble.`,
          },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
      }),
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      return NextResponse.json(
        { error: `Upstream ${res.status}: ${text.slice(0, 500)}` },
        { status: 502 },
      );
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return NextResponse.json(
        { error: "Upstream returned non-JSON response" },
        { status: 502 },
      );
    }
    const summary = extractSummary(json);
    if (!summary) {
      return NextResponse.json(
        { error: "No summary in response" },
        { status: 502 },
      );
    }
    return NextResponse.json({ summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Summarize failed";
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    clearTimeout(timer);
  }
}

function buildCompletionsUrl(endpoint: URL): string {
  const s = endpoint.toString();
  if (/\/chat\/completions\/?$/.test(s)) return s;
  const trimmed = s.replace(/\/+$/, "");
  return `${trimmed}/chat/completions`;
}

function extractSummary(json: unknown): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const obj = json as Record<string, unknown>;
  const choices = obj.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as Record<string, unknown>;
    const message = first.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (typeof content === "string") return content.trim();
    if (Array.isArray(content)) {
      const joined = content
        .map((p) => {
          if (typeof p === "string") return p;
          if (p && typeof p === "object" && "text" in p) {
            const t = (p as { text?: unknown }).text;
            return typeof t === "string" ? t : "";
          }
          return "";
        })
        .join("")
        .trim();
      if (joined) return joined;
    }
    const text = first.text;
    if (typeof text === "string") return text.trim();
  }
  return undefined;
}
