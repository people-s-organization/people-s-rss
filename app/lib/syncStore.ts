import crypto from "node:crypto";
import type { AIConfig, AIStyle, Feed, SummaryLanguage } from "./types";
import { getPostgres } from "./postgres";
import { getRssSupabase } from "./supabase";
import { normalizeHttpUrl } from "./url";
import { getOrCreateAppUserId } from "./userStore";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_FEEDS = 500;

export type SyncBlob = {
  feeds: Feed[];
  ai: AIConfig | null;
  updatedAt: number;
};

export type SyncPatchInput = {
  feeds?: unknown;
  ai?: unknown;
  baseUpdatedAt?: unknown;
};

type PreparedSyncPatch = {
  writeFeeds: boolean;
  feeds: Feed[];
  writeAI: boolean;
  ai: AIConfig | null;
  baseUpdatedAt: number | null;
};

type CategoryRow = {
  id: string;
  name: string;
  position: number;
  updated_at: string;
};

type FeedRow = {
  id: string;
  category_id: string | null;
  url: string;
  title: string;
  position: number;
  created_at: string;
  updated_at: string;
};

type AISettingsRow = {
  endpoint: string | null;
  model: string | null;
  style: string;
  summary_language: string;
  updated_at: string;
};

type SyncStateRow = {
  initialized: boolean;
  updated_at: string;
};

type CategoryWriteRow = {
  id: string;
  user_id: string;
  name: string;
  position: number;
};

type FeedWriteRow = {
  id: string;
  user_id: string;
  category_id: string | null;
  url: string;
  title: string;
  position: number;
};

export class SyncValidationError extends Error {
  status = 400;
}

export class SyncConflictError extends Error {
  status = 409;
}

function parseTime(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isAIStyle(value: unknown): value is AIStyle {
  return value === "openai" || value === "anthropic";
}

function isSummaryLanguage(value: unknown): value is SummaryLanguage {
  return value === "ui" || value === "zh" || value === "en" || value === "source";
}

function normalizeFeedId(value: unknown): string {
  return typeof value === "string" && UUID_RE.test(value)
    ? value
    : crypto.randomUUID();
}

function normalizeFeed(input: unknown): Feed {
  if (!input || typeof input !== "object") {
    throw new SyncValidationError("Invalid feed");
  }
  const src = input as Record<string, unknown>;
  const urlRaw = typeof src.url === "string" ? src.url : "";
  const url = normalizeHttpUrl(urlRaw);
  if (!url) throw new SyncValidationError("Invalid feed url");

  const titleRaw = typeof src.title === "string" ? src.title.trim() : "";
  const categoryRaw =
    typeof src.category === "string" ? src.category.trim() : "";
  const addedAtRaw = typeof src.addedAt === "number" ? src.addedAt : Date.now();

  return {
    id: normalizeFeedId(src.id),
    url,
    title: titleRaw || url,
    category: categoryRaw || undefined,
    addedAt: Number.isFinite(addedAtRaw) ? addedAtRaw : Date.now(),
  };
}

function normalizeFeeds(input: unknown): Feed[] {
  if (!Array.isArray(input)) {
    throw new SyncValidationError("Invalid feeds");
  }
  if (input.length > MAX_FEEDS) {
    throw new SyncValidationError(`Too many feeds (${input.length} > ${MAX_FEEDS})`);
  }

  const seenUrls = new Set<string>();
  const feeds: Feed[] = [];
  for (const item of input) {
    const feed = normalizeFeed(item);
    if (seenUrls.has(feed.url)) continue;
    seenUrls.add(feed.url);
    feeds.push(feed);
  }
  return feeds;
}

function normalizeAIConfig(input: unknown): AIConfig | null {
  if (input == null) return null;
  if (!input || typeof input !== "object") {
    throw new SyncValidationError("Invalid AI settings");
  }
  const src = input as Record<string, unknown>;
  const endpoint = typeof src.endpoint === "string" ? src.endpoint.trim() : "";
  const model = typeof src.model === "string" ? src.model.trim() : "";
  if (!endpoint || !model) return null;

  return {
    endpoint,
    model,
    style: isAIStyle(src.style) ? src.style : "openai",
    summaryLanguage: isSummaryLanguage(src.summaryLanguage)
      ? src.summaryLanguage
      : "ui",
  };
}

function normalizeBaseUpdatedAt(input: unknown): number | null {
  if (input == null) return null;
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0) {
    throw new SyncValidationError("Invalid baseUpdatedAt");
  }
  return input;
}

function dateLikeToMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") return parseTime(value);
  return 0;
}

function aiConfigFromRow(row: AISettingsRow | null): AIConfig | null {
  if (!row?.endpoint || !row.model) return null;
  return {
    endpoint: row.endpoint,
    model: row.model,
    style: isAIStyle(row.style) ? row.style : "openai",
    summaryLanguage: isSummaryLanguage(row.summary_language)
      ? row.summary_language
      : "ui",
  };
}

function buildUpdatedAt(
  state: SyncStateRow,
  categories: CategoryRow[],
  feeds: FeedRow[],
  ai: AISettingsRow | null,
): number {
  return Math.max(
    parseTime(state.updated_at),
    ...categories.map((row) => parseTime(row.updated_at)),
    ...feeds.map((row) => parseTime(row.updated_at)),
    parseTime(ai?.updated_at),
  );
}

async function getSyncState(userId: string): Promise<SyncStateRow | null> {
  const { data, error } = await getRssSupabase()
    .from("user_sync_state")
    .select("initialized, updated_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as SyncStateRow | null;
}

async function readSyncBlobByUserId(userId: string): Promise<SyncBlob | null> {
  const state = await getSyncState(userId);
  if (!state?.initialized) return null;

  const supabase = getRssSupabase();
  const [categoriesResult, feedsResult, aiResult] = await Promise.all([
    supabase
      .from("feed_categories")
      .select("id, name, position, updated_at")
      .eq("user_id", userId)
      .order("position", { ascending: true }),
    supabase
      .from("user_feeds")
      .select("id, category_id, url, title, position, created_at, updated_at")
      .eq("user_id", userId)
      .order("position", { ascending: true }),
    supabase
      .from("user_ai_settings")
      .select("endpoint, model, style, summary_language, updated_at")
      .eq("user_id", userId)
      .maybeSingle(),
  ]);

  if (categoriesResult.error) throw new Error(categoriesResult.error.message);
  if (feedsResult.error) throw new Error(feedsResult.error.message);
  if (aiResult.error) throw new Error(aiResult.error.message);

  const categories = (categoriesResult.data ?? []) as CategoryRow[];
  const feeds = (feedsResult.data ?? []) as FeedRow[];
  const ai = (aiResult.data ?? null) as AISettingsRow | null;
  const categoryNames = new Map(categories.map((row) => [row.id, row.name]));

  return {
    feeds: feeds.map((row) => ({
      id: row.id,
      url: row.url,
      title: row.title,
      category: row.category_id
        ? categoryNames.get(row.category_id) || undefined
        : undefined,
      addedAt: parseTime(row.created_at),
    })),
    ai: aiConfigFromRow(ai),
    updatedAt: buildUpdatedAt(state, categories, feeds, ai),
  };
}

export async function readSyncBlob(githubId: string): Promise<SyncBlob | null> {
  const userId = await getOrCreateAppUserId("github", githubId);
  return readSyncBlobByUserId(userId);
}

function prepareSyncPatch(input: SyncPatchInput): PreparedSyncPatch {
  const hasFeeds = Object.hasOwn(input, "feeds");
  const hasAI = Object.hasOwn(input, "ai");
  if (!hasFeeds && !hasAI) {
    throw new SyncValidationError("Nothing to sync");
  }
  return {
    writeFeeds: hasFeeds,
    feeds: hasFeeds ? normalizeFeeds(input.feeds) : [],
    writeAI: hasAI,
    ai: hasAI ? normalizeAIConfig(input.ai) : null,
    baseUpdatedAt: normalizeBaseUpdatedAt(input.baseUpdatedAt),
  };
}

function buildFeedRows(userId: string, feeds: Feed[]) {
  const categoryRows: CategoryWriteRow[] = [];
  const categoryByName = new Map<string, string>();
  for (const feed of feeds) {
    if (!feed.category) continue;
    const key = feed.category.toLowerCase();
    if (categoryByName.has(key)) continue;
    const id = crypto.randomUUID();
    categoryByName.set(key, id);
    categoryRows.push({
      id,
      user_id: userId,
      name: feed.category,
      position: categoryRows.length,
    });
  }

  return {
    categoryRows,
    feedRows: feeds.map((feed, position) => ({
      id: feed.id,
      user_id: userId,
      category_id: feed.category
        ? categoryByName.get(feed.category.toLowerCase()) ?? null
        : null,
      url: feed.url,
      title: feed.title,
      position,
    })) satisfies FeedWriteRow[],
  };
}

export async function writeSyncPatch(
  githubId: string,
  input: SyncPatchInput,
): Promise<SyncBlob> {
  const userId = await getOrCreateAppUserId("github", githubId);
  const patch = prepareSyncPatch(input);
  const { categoryRows, feedRows } = buildFeedRows(userId, patch.feeds);
  const sql = getPostgres();
  await sql.begin(async (tx) => {
    await tx`
      insert into rss.user_sync_state (user_id, initialized, updated_at)
      values (${userId}, false, to_timestamp(0))
      on conflict (user_id) do nothing
    `;

    const stateRows = await tx`
      select updated_at
        from rss.user_sync_state
       where user_id = ${userId}
       for update
    `;
    const currentUpdatedAt = dateLikeToMs(stateRows[0]?.updated_at);
    if (patch.baseUpdatedAt !== null && currentUpdatedAt > patch.baseUpdatedAt) {
      throw new SyncConflictError("Sync conflict");
    }

    if (patch.writeFeeds) {
      await tx`delete from rss.user_feeds where user_id = ${userId}`;
      await tx`delete from rss.feed_categories where user_id = ${userId}`;

      if (categoryRows.length > 0) {
        await tx`
          insert into rss.feed_categories
          ${tx(categoryRows, "id", "user_id", "name", "position")}
        `;
      }

      if (feedRows.length > 0) {
        await tx`
          insert into rss.user_feeds
          ${tx(feedRows, "id", "user_id", "category_id", "url", "title", "position")}
        `;
      }
    }

    if (patch.writeAI) {
      if (patch.ai) {
        await tx`
          insert into rss.user_ai_settings (
            user_id,
            endpoint,
            model,
            style,
            summary_language
          )
          values (
            ${userId},
            ${patch.ai.endpoint},
            ${patch.ai.model},
            ${patch.ai.style},
            ${patch.ai.summaryLanguage ?? "ui"}
          )
          on conflict (user_id) do update
            set endpoint = excluded.endpoint,
                model = excluded.model,
                style = excluded.style,
                summary_language = excluded.summary_language,
                updated_at = clock_timestamp()
        `;
      } else {
        await tx`
          update rss.user_ai_settings
             set endpoint = null,
                 model = null,
                 style = 'openai',
                 summary_language = 'ui',
                 updated_at = clock_timestamp()
           where user_id = ${userId}
        `;
      }
    }

    await tx`
      update rss.user_sync_state
         set initialized = true,
             updated_at = clock_timestamp()
       where user_id = ${userId}
    `;
  });

  const blob = await readSyncBlobByUserId(userId);
  if (!blob) throw new Error("Sync write did not initialize user state");
  return blob;
}

export async function readAIConfig(githubId: string): Promise<AIConfig | null> {
  const userId = await getOrCreateAppUserId("github", githubId);
  const { data, error } = await getRssSupabase()
    .from("user_ai_settings")
    .select("endpoint, model, style, summary_language, updated_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return aiConfigFromRow((data ?? null) as AISettingsRow | null);
}
