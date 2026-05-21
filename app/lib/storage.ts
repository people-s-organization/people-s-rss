"use client";

import type { AIConfig, Article, Feed } from "./types";

const FEEDS_KEY = "prss:feeds";
const AI_KEY = "prss:ai";
const READ_KEY = "prss:read";
const SUMMARIES_KEY = "prss:summaries";
const INITIALIZED_KEY = "prss:initialized";
const FILTER_KEY = "prss:filterMode";
const FEED_CACHE_KEY = "prss:feedCache";

type FeedCacheEntry = {
  articles: Article[];
  fetchedAt: number;
};

export function loadFeedCache(): Record<string, FeedCacheEntry> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(FEED_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, FeedCacheEntry>;
    }
    return {};
  } catch {
    return {};
  }
}

export function saveFeedCache(cache: Record<string, FeedCacheEntry>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(FEED_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // QuotaExceeded — drop oldest entries until fits
    const entries = Object.entries(cache).sort(
      (a, b) => a[1].fetchedAt - b[1].fetchedAt,
    );
    while (entries.length > 0) {
      entries.shift();
      try {
        window.localStorage.setItem(
          FEED_CACHE_KEY,
          JSON.stringify(Object.fromEntries(entries)),
        );
        return;
      } catch {}
    }
  }
}

export function loadFilterMode(): "unread" | "all" {
  if (typeof window === "undefined") return "unread";
  const raw = window.localStorage.getItem(FILTER_KEY);
  return raw === "all" ? "all" : "unread";
}

export function saveFilterMode(mode: "unread" | "all") {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(FILTER_KEY, mode);
}

export function isInitialized(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(INITIALIZED_KEY) === "1";
}

export function markInitialized() {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(INITIALIZED_KEY, "1");
}

export function loadFeeds(): Feed[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(FEEDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Feed[]) : [];
  } catch {
    return [];
  }
}

export function saveFeeds(feeds: Feed[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(FEEDS_KEY, JSON.stringify(feeds));
}

export function loadAIConfig(): AIConfig | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(AI_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.endpoint === "string" &&
      typeof parsed.model === "string"
    ) {
      const style =
        parsed.style === "anthropic" || parsed.style === "openai"
          ? parsed.style
          : "openai";
      const cfg: AIConfig = {
        endpoint: parsed.endpoint,
        model: parsed.model,
        style,
      };
      // Scrub any legacy apiKey field left in localStorage from older builds.
      if (typeof parsed.apiKey === "string") {
        window.localStorage.setItem(AI_KEY, JSON.stringify(cfg));
      }
      return cfg;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveAIConfig(cfg: AIConfig | null) {
  if (typeof window === "undefined") return;
  if (!cfg) {
    window.localStorage.removeItem(AI_KEY);
    return;
  }
  const stripped: AIConfig = {
    endpoint: cfg.endpoint,
    model: cfg.model,
    style: cfg.style,
  };
  window.localStorage.setItem(AI_KEY, JSON.stringify(stripped));
}

export function loadRead(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(READ_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? (parsed as string[]) : []);
  } catch {
    return new Set();
  }
}

export function saveRead(read: Set<string>) {
  if (typeof window === "undefined") return;
  const arr = Array.from(read);
  const trimmed = arr.length > 5000 ? arr.slice(-5000) : arr;
  window.localStorage.setItem(READ_KEY, JSON.stringify(trimmed));
}

export function loadSummaries(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(SUMMARIES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    }
    return {};
  } catch {
    return {};
  }
}

export function saveSummaries(map: Record<string, string>) {
  if (typeof window === "undefined") return;
  const entries = Object.entries(map);
  // Keep only the most recent 1000 to bound localStorage usage.
  const trimmed =
    entries.length > 1000
      ? Object.fromEntries(entries.slice(entries.length - 1000))
      : map;
  window.localStorage.setItem(SUMMARIES_KEY, JSON.stringify(trimmed));
}

export function randomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
