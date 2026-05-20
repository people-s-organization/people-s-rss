import { NextResponse } from "next/server";
import { joinPath } from "@/app/lib/aiProviders";
import type { AIStyle } from "@/app/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  endpoint?: string;
  apiKey?: string;
  style?: AIStyle;
};

const FETCH_TIMEOUT_MS = 20_000;

export async function POST(request: Request) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const endpoint = body.endpoint?.trim();
  const apiKey = body.apiKey?.trim();
  const style: AIStyle = body.style === "anthropic" ? "anthropic" : "openai";
  if (!endpoint || !apiKey) {
    return NextResponse.json(
      { error: "endpoint and apiKey are required" },
      { status: 400 },
    );
  }

  let url: string;
  try {
    new URL(endpoint);
    url = joinPath(endpoint, "/models");
  } catch {
    return NextResponse.json({ error: "Invalid endpoint" }, { status: 400 });
  }

  const headers: Record<string, string> =
    style === "anthropic"
      ? {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        }
      : {
          Authorization: `Bearer ${apiKey}`,
        };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      return NextResponse.json(
        { error: `Upstream ${res.status}: ${text.slice(0, 300)}` },
        { status: 502 },
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return NextResponse.json(
        { error: "Upstream returned non-JSON" },
        { status: 502 },
      );
    }
    const models = extractModels(json, style);
    return NextResponse.json({ models });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Models fetch failed";
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    clearTimeout(timer);
  }
}

type ModelInfo = { id: string; label?: string };

function extractModels(json: unknown, style: AIStyle): ModelInfo[] {
  if (!json || typeof json !== "object") return [];
  const obj = json as Record<string, unknown>;
  const data = obj.data ?? obj.models ?? obj;
  if (!Array.isArray(data)) return [];
  const out: ModelInfo[] = [];
  for (const item of data) {
    if (typeof item === "string") {
      out.push({ id: item });
      continue;
    }
    if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      const id =
        (typeof o.id === "string" && o.id) ||
        (typeof o.name === "string" && o.name) ||
        undefined;
      if (!id) continue;
      const label =
        (typeof o.display_name === "string" && o.display_name) ||
        (typeof o.name === "string" && o.name !== id ? o.name : undefined) ||
        undefined;
      out.push({ id, label });
    }
  }
  if (style === "openai") {
    out.sort((a, b) => a.id.localeCompare(b.id));
  }
  return out;
}
