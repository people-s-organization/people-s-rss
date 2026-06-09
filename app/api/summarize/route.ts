import { NextResponse } from "next/server";
import { joinPath } from "@/app/lib/aiProviders";
import { getAIKey } from "@/app/lib/aiKeyStore";
import { readAIConfig } from "@/app/lib/syncStore";
import { auth } from "@/auth";
import { assertPublicHttpUrl, safeFetch, SSRFError } from "@/app/lib/ssrfGuard";
import { rateLimit, rateLimitedResponse } from "@/app/lib/rateLimit";
import type { SummaryLanguage } from "@/app/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  title?: string;
  content?: string;
  url?: string;
  locale?: string;
};

const MAX_CONTENT = 60_000;
const FETCH_TIMEOUT_MS = 60_000;

export async function POST(request: Request) {
  const session = await auth();
  const githubId = session?.user?.githubId;
  if (!githubId) {
    return NextResponse.json(
      { error: "Sign in to use AI summary" },
      { status: 401 },
    );
  }

  const rl = await rateLimit("summarize", githubId, 20, 60);
  if (!rl.ok) return rateLimitedResponse(rl);

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  let apiKey: string | null;
  let aiConfig: Awaited<ReturnType<typeof readAIConfig>>;
  try {
    [apiKey, aiConfig] = await Promise.all([
      getAIKey(githubId),
      readAIConfig(githubId),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : "AI config lookup failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
  if (!apiKey) {
    return NextResponse.json(
      { error: "AI key not set; open Settings to add one" },
      { status: 412 },
    );
  }
  if (!aiConfig) {
    return NextResponse.json(
      { error: "AI settings not configured; open Settings to choose a model" },
      { status: 412 },
    );
  }

  try {
    await assertPublicHttpUrl(aiConfig.endpoint, { forceHttps: true });
  } catch (err) {
    if (err instanceof SSRFError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "Invalid endpoint" }, { status: 400 });
  }

  const content = (body.content ?? "").slice(0, MAX_CONTENT);
  if (!content) {
    return NextResponse.json({ error: "Empty content" }, { status: 400 });
  }
  const targetLanguage = targetLanguageFromSetting(
    aiConfig.summaryLanguage,
    body.locale,
    request.headers.get("accept-language"),
  );
  const languageInstruction = targetLanguage
    ? [
        `Reply only in ${targetLanguage}, regardless of the article's original language.`,
        targetLanguage === "Simplified Chinese"
          ? "Use natural Simplified Chinese."
          : null,
        "Keep names of people, companies, products, papers, code identifiers, and technical terms in their original form when useful.",
        "Add a brief translated explanation in parentheses only when it improves clarity.",
      ]
        .filter(Boolean)
        .join(" ")
    : "Reply in the same language as the article.";
  const systemPrompt = [
    "You summarize RSS articles.",
    languageInstruction,
    "Produce 3-6 concise bullet points capturing key facts, conclusions, and any numbers.",
    "No preamble.",
  ].join(" ");
  const userPrompt = [
    body.title ? `Title: ${body.title}` : null,
    body.url ? `URL: ${body.url}` : null,
    "",
    "Article:",
    content,
  ]
    .filter(Boolean)
    .join("\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const { url, headers, payload, parseSummary } =
      aiConfig.style === "anthropic"
        ? anthropicRequest(
            aiConfig.endpoint,
            apiKey,
            aiConfig.model,
            systemPrompt,
            userPrompt,
          )
        : openaiRequest(
            aiConfig.endpoint,
            apiKey,
            aiConfig.model,
            systemPrompt,
            userPrompt,
          );

    const res = await safeFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
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
    const summary = parseSummary(json);
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

function openaiRequest(
  endpoint: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
) {
  const url = /\/chat\/completions\/?$/.test(endpoint)
    ? endpoint
    : joinPath(endpoint, "/chat/completions");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  const payload = {
    model,
    stream: false,
    temperature: 0.3,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  };
  return { url, headers, payload, parseSummary: parseOpenAI };
}

function anthropicRequest(
  endpoint: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
) {
  const url = /\/messages\/?$/.test(endpoint)
    ? endpoint
    : joinPath(endpoint, "/messages");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  };
  const payload = {
    model,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  };
  return { url, headers, payload, parseSummary: parseAnthropic };
}

function targetLanguageFromSetting(
  mode: SummaryLanguage,
  locale: string | undefined,
  acceptLanguage: string | null,
): "Simplified Chinese" | "English" | null {
  if (mode === "source") return null;
  if (mode === "zh") return "Simplified Chinese";
  if (mode === "en") return "English";
  const value = `${locale ?? ""},${acceptLanguage ?? ""}`.trim().toLowerCase();
  return value.startsWith("zh") || value.includes(",zh")
    ? "Simplified Chinese"
    : "English";
}

function parseOpenAI(json: unknown): string | undefined {
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

function parseAnthropic(json: unknown): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const obj = json as Record<string, unknown>;
  const content = obj.content;
  if (Array.isArray(content)) {
    const joined = content
      .map((p) => {
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
  return undefined;
}
