import type { AIStyle } from "./types";

export function detectStyle(endpoint: string): AIStyle {
  const lower = endpoint.toLowerCase();
  if (lower.includes("anthropic.com")) return "anthropic";
  return "openai";
}

export function defaultEndpoint(style: AIStyle): string {
  return style === "anthropic"
    ? "https://api.anthropic.com/v1"
    : "https://api.openai.com/v1";
}

export function defaultModel(style: AIStyle): string {
  return style === "anthropic" ? "claude-haiku-4-5" : "gpt-4o-mini";
}

export function joinPath(endpoint: string, path: string): string {
  const trimmed = endpoint.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${trimmed}${p}`;
}
