"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { signIn, signOut, useSession } from "next-auth/react";
import { useTranslations } from "next-intl";
import type { AIConfig, Article, Feed, ParsedFeed } from "@/app/lib/types";
import { usePullGestures } from "@/app/lib/usePullToRefresh";
import {
  isInitialized,
  loadAIConfig,
  loadFeedCache,
  loadFeeds,
  loadFilterMode,
  loadRead,
  loadSummaries,
  markInitialized,
  randomId,
  saveAIConfig,
  saveFeedCache,
  saveFeeds,
  saveFilterMode,
  saveRead,
  saveSummaries,
} from "@/app/lib/storage";

const DEFAULT_FEEDS: { url: string; title: string; category?: string }[] = [
  { url: "https://xueqiu.com/hots/topic/rss", title: "雪球热门", category: "投资" },
  { url: "https://sspai.com/feed", title: "少数派", category: "科技" },
  { url: "https://www.ifanr.com/feed", title: "爱范儿", category: "科技" },
];
import { SettingsDialog } from "./SettingsDialog";

const FEED_FULL_THRESHOLD = 1500;

type FeedState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; articles: Article[]; fetchedAt: number };

type SyncBlob = {
  feeds?: Feed[];
  read?: string[];
  ai?: AIConfig | null;
  updatedAt: number;
};

type SyncStatus =
  | { state: "off" }
  | { state: "pulling" }
  | { state: "idle"; updatedAt: number | null }
  | { state: "syncing" }
  | { state: "error"; error: string };


export function Reader() {
  const { data: session, status: authStatus } = useSession();
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [aiConfig, setAIConfig] = useState<AIConfig | null>(null);
  const [readSet, setReadSet] = useState<Set<string>>(new Set());
  const [feedStates, setFeedStates] = useState<Record<string, FeedState>>({});
  const [selectedFeedId, setSelectedFeedId] = useState<string | "all">("all");
  const [selectedArticleId, setSelectedArticleId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<
    "feeds" | "ai"
  >("feeds");
  const [summaries, setSummaries] = useState<Record<string, string>>({});
  const [summarizing, setSummarizing] = useState<string | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [fullContent, setFullContent] = useState<Record<string, string>>({});
  const [fullContentText, setFullContentText] = useState<Record<string, string>>({});
  const [extracting, setExtracting] = useState<string | null>(null);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(
    new Set(),
  );
  const [filterMode, setFilterModeState] = useState<"unread" | "all">("unread");
  const setFilterMode = (m: "unread" | "all") => {
    setFilterModeState(m);
    saveFilterMode(m);
  };
  const [openFeedMenuId, setOpenFeedMenuId] = useState<string | null>(null);
  const [mobileFeedPickerOpen, setMobileFeedPickerOpen] = useState(false);
  const [feedsPanelCollapsed, setFeedsPanelCollapsed] = useState(false);
  const [articlesPanelCollapsed, setArticlesPanelCollapsed] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({ state: "off" });
  const [hasAIKey, setHasAIKey] = useState(false);
  const t = useTranslations("Reader");
  const syncReady = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let initialFeeds = loadFeeds();
    if (initialFeeds.length === 0 && !isInitialized()) {
      const now = Date.now();
      initialFeeds = DEFAULT_FEEDS.map((d, i) => ({
        id: randomId(),
        url: d.url,
        title: d.title,
        category: d.category,
        addedAt: now + i,
      }));
      saveFeeds(initialFeeds);
    }
    markInitialized();
    // Hydrate feedStates from localStorage cache so the first paint shows
    // articles immediately without a network roundtrip.
    const cache = loadFeedCache();
    const hydratedStates: Record<string, FeedState> = {};
    for (const f of initialFeeds) {
      const entry = cache[f.id];
      if (entry && Array.isArray(entry.articles)) {
        hydratedStates[f.id] = {
          status: "ready",
          articles: entry.articles,
          fetchedAt: entry.fetchedAt,
        };
      }
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage hydration after mount
    setFeeds(initialFeeds);
    setFeedStates(hydratedStates);
    setAIConfig(loadAIConfig());
    setReadSet(loadRead());
    setSummaries(loadSummaries());
    setFilterModeState(loadFilterMode());
    setHydrated(true);
  }, []);

  async function refreshFeed(feed: Feed, options?: { silent?: boolean }) {
    const silent = options?.silent ?? false;
    setFeedStates((prev) => {
      const existing = prev[feed.id];
      if (silent && existing?.status === "ready") return prev;
      return { ...prev, [feed.id]: { status: "loading" } };
    });
    try {
      const url = `/api/feed?url=${encodeURIComponent(feed.url)}${
        silent ? "" : `&_t=${Date.now()}`
      }`;
      const res = await fetch(url, {
        cache: silent ? "default" : "no-store",
      });
      const data = await readApiJson<{ feed?: ParsedFeed }>(res);
      if (!res.ok || !data.feed) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const fresh: Article[] = data.feed.items.map((item) => ({
        id: stableId(feed.id, item.guid || item.link || item.title),
        feedId: feed.id,
        feedTitle: feed.title,
        title: item.title,
        link: item.link,
        author: item.author,
        publishedAt: item.publishedAt,
        contentHtml: item.contentHtml,
        contentText: item.contentText,
        hasFullContent: item.hasFullContent,
      }));
      const fetchedAt = Date.now();
      setFeedStates((prev) => {
        const previous = prev[feed.id];
        const previousArticles =
          previous?.status === "ready" ? previous.articles : [];
        const articles = mergeArticleLists(previousArticles, fresh);
        const cache = loadFeedCache();
        cache[feed.id] = { articles, fetchedAt };
        saveFeedCache(cache);
        return {
          ...prev,
          [feed.id]: { status: "ready", articles, fetchedAt },
        };
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load";
      setFeedStates((prev) => {
        const existing = prev[feed.id];
        if (silent && existing?.status === "ready") {
          // Keep showing cached articles on background refresh failure
          return prev;
        }
        return {
          ...prev,
          [feed.id]: { status: "error", error: message },
        };
      });
    }
  }

  async function pushBlob(
    nextFeeds: Feed[],
    nextRead: Set<string>,
    nextAI: AIConfig | null,
  ) {
    setSyncStatus({ state: "syncing" });
    try {
      const res = await fetch("/api/sync", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          feeds: nextFeeds,
          read: Array.from(nextRead),
          ai: nextAI,
        }),
      });
      const data = await readApiJson<{ updatedAt?: number }>(res);
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setSyncStatus({
        state: "idle",
        updatedAt: data.updatedAt ?? Date.now(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Sync failed";
      setSyncStatus({ state: "error", error: message });
    }
  }

  // Pull from server on sign-in, merge with local
  useEffect(() => {
    if (!hydrated) return;
    if (authStatus !== "authenticated") {
      syncReady.current = false;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset sync state on sign-out
      setSyncStatus({ state: "off" });
      return;
    }
    let cancelled = false;
    setSyncStatus({ state: "pulling" });
    (async () => {
      try {
        const res = await fetch("/api/sync");
        const data = await readApiJson<{ blob?: SyncBlob | null }>(res);
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        if (cancelled) return;
        const remote = data.blob;
        const localFeeds = loadFeeds();
        const localRead = loadRead();
        const localAI = loadAIConfig();
        const mergedFeeds = mergeFeeds(localFeeds, remote?.feeds ?? []);
        const mergedRead = new Set<string>([
          ...localRead,
          ...(remote?.read ?? []),
        ]);
        const mergedAI = remote?.ai ?? localAI;
        setFeeds(mergedFeeds);
        setReadSet(mergedRead);
        setAIConfig(mergedAI);
        saveFeeds(mergedFeeds);
        saveRead(mergedRead);
        saveAIConfig(mergedAI);
        syncReady.current = true;
        setSyncStatus({ state: "idle", updatedAt: remote?.updatedAt ?? null });
        void pushBlob(mergedFeeds, mergedRead, mergedAI);
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "Sync failed";
        setSyncStatus({ state: "error", error: message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authStatus, hydrated]);

  // Debounced push on any change after initial sync
  useEffect(() => {
    if (!syncReady.current) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void pushBlob(feeds, readSet, aiConfig);
    }, 1500);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [feeds, readSet, aiConfig]);

  // Track whether the server has a stored AI key for this user
  useEffect(() => {
    if (authStatus !== "authenticated") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on sign-out
      setHasAIKey(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/ai-key");
        if (!res.ok) return;
        const data = (await res.json()) as { hasKey?: boolean };
        if (!cancelled) setHasAIKey(!!data.hasKey);
      } catch {
        // silently ignore — the user will get a clearer error if they try to summarize
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authStatus]);

  async function handleSetAIKey(apiKey: string) {
    const res = await fetch("/api/ai-key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
    };
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    setHasAIKey(true);
  }

  async function handleClearAIKey() {
    const res = await fetch("/api/ai-key", { method: "DELETE" });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
    };
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    setHasAIKey(false);
  }

  const autoRefreshedRef = useRef<Set<string>>(new Set());
  const articleListRef = useRef<HTMLOListElement>(null);
  const [displayLimit, setDisplayLimit] = useState(50);
  const [showBackToTop, setShowBackToTop] = useState(false);
  const [pagination, setPagination] = useState<
    Record<string, { page: number; exhausted: boolean }>
  >({});
  useEffect(() => {
    if (!hydrated) return;
    for (const feed of feeds) {
      if (autoRefreshedRef.current.has(feed.id)) continue;
      autoRefreshedRef.current.add(feed.id);
      void refreshFeed(feed, { silent: true });
    }
  }, [feeds, hydrated]);

  const allArticles = useMemo(() => {
    const list: Article[] = [];
    for (const f of feeds) {
      const s = feedStates[f.id];
      if (s?.status === "ready") list.push(...s.articles);
    }
    list.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
    return list;
  }, [feeds, feedStates]);

  const scopedArticles = useMemo(() => {
    if (typeof selectedFeedId === "string" && selectedFeedId.startsWith("cat:")) {
      const cat = selectedFeedId.slice(4);
      const feedIds = new Set(
        feeds.filter((f) => (f.category ?? "") === cat).map((f) => f.id),
      );
      return allArticles.filter((a) => feedIds.has(a.feedId));
    }
    if (selectedFeedId !== "all") {
      return allArticles.filter((a) => a.feedId === selectedFeedId);
    }
    return allArticles;
  }, [allArticles, selectedFeedId, feeds]);

  const totalInScope = scopedArticles.length;
  const unreadInScope = useMemo(
    () => scopedArticles.reduce((n, a) => (readSet.has(a.id) ? n : n + 1), 0),
    [scopedArticles, readSet],
  );

  const fullVisibleArticles = useMemo(() => {
    if (filterMode === "all") return scopedArticles;
    return scopedArticles.filter(
      (a) => !readSet.has(a.id) || a.id === selectedArticleId,
    );
  }, [scopedArticles, filterMode, readSet, selectedArticleId]);

  const visibleArticles = useMemo(
    () => fullVisibleArticles.slice(0, displayLimit),
    [fullVisibleArticles, displayLimit],
  );

  // Reset display window when scope or filter changes
  const scopeKeyRef = useRef<string>("");
  const nextScopeKey = `${selectedFeedId}|${filterMode}`;
  if (scopeKeyRef.current !== nextScopeKey) {
    scopeKeyRef.current = nextScopeKey;
    if (displayLimit !== 50) {
      setDisplayLimit(50);
    }
  }

  async function refreshAllFeeds() {
    await Promise.all(feeds.map((f) => refreshFeed(f)));
  }

  function feedsInScope(): Feed[] {
    if (
      typeof selectedFeedId === "string" &&
      selectedFeedId.startsWith("cat:")
    ) {
      const cat = selectedFeedId.slice(4);
      return feeds.filter((f) => (f.category ?? "") === cat);
    }
    if (selectedFeedId !== "all") {
      return feeds.filter((f) => f.id === selectedFeedId);
    }
    return feeds;
  }

  async function tryFetchOlderPage(feed: Feed): Promise<number> {
    const p = pagination[feed.id] ?? { page: 1, exhausted: false };
    if (p.exhausted) return 0;
    const nextPage = p.page + 1;
    const sep = feed.url.includes("?") ? "&" : "?";
    const pagedUrl = `${feed.url}${sep}paged=${nextPage}`;
    try {
      const res = await fetch(
        `/api/feed?url=${encodeURIComponent(pagedUrl)}`,
      );
      const data = await readApiJson<{ feed?: ParsedFeed }>(res);
      if (!res.ok || !data.feed) {
        setPagination((prev) => ({
          ...prev,
          [feed.id]: { page: p.page, exhausted: true },
        }));
        return 0;
      }
      const fresh: Article[] = data.feed.items.map((item) => ({
        id: stableId(feed.id, item.guid || item.link || item.title),
        feedId: feed.id,
        feedTitle: feed.title,
        title: item.title,
        link: item.link,
        author: item.author,
        publishedAt: item.publishedAt,
        contentHtml: item.contentHtml,
        contentText: item.contentText,
        hasFullContent: item.hasFullContent,
      }));
      let addedCount = 0;
      setFeedStates((prev) => {
        const previous = prev[feed.id];
        const previousArticles =
          previous?.status === "ready" ? previous.articles : [];
        const existingIds = new Set(previousArticles.map((a) => a.id));
        addedCount = fresh.filter((a) => !existingIds.has(a.id)).length;
        if (addedCount === 0) return prev;
        const articles = mergeArticleLists(previousArticles, fresh);
        const fetchedAt = Date.now();
        const cache = loadFeedCache();
        cache[feed.id] = { articles, fetchedAt };
        saveFeedCache(cache);
        return {
          ...prev,
          [feed.id]: { status: "ready", articles, fetchedAt },
        };
      });
      if (addedCount === 0) {
        setPagination((prev) => ({
          ...prev,
          [feed.id]: { page: p.page, exhausted: true },
        }));
      } else {
        setPagination((prev) => ({
          ...prev,
          [feed.id]: { page: nextPage, exhausted: false },
        }));
      }
      return addedCount;
    } catch {
      setPagination((prev) => ({
        ...prev,
        [feed.id]: { page: p.page, exhausted: true },
      }));
      return 0;
    }
  }

  const hasMoreCached = displayLimit < fullVisibleArticles.length;
  const scopeFeedsRef = useRef<Feed[]>([]);
  scopeFeedsRef.current = feedsInScope();
  const allExhausted = scopeFeedsRef.current.every(
    (f) => pagination[f.id]?.exhausted,
  );

  async function loadOlder() {
    if (hasMoreCached) {
      setDisplayLimit((n) => Math.min(n + 50, fullVisibleArticles.length));
      return;
    }
    // Try pulling older items from the source RSS via ?paged= pagination
    const results = await Promise.all(
      scopeFeedsRef.current.map((f) => tryFetchOlderPage(f)),
    );
    const added = results.reduce((a, b) => a + b, 0);
    if (added > 0) {
      setDisplayLimit((n) => n + Math.min(50, added));
    }
  }

  const pull = usePullGestures(articleListRef, {
    onPullDown: refreshAllFeeds,
    onPullUp: hasMoreCached || !allExhausted ? loadOlder : undefined,
  });

  const allCategoryNames = useMemo(() => {
    const set = new Set<string>();
    for (const f of feeds) {
      if (f.category) set.add(f.category);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [feeds]);

  const feedGroups = useMemo(() => {
    const byCat = new Map<string, Feed[]>();
    for (const f of feeds) {
      const k = f.category ?? "";
      const arr = byCat.get(k);
      if (arr) arr.push(f);
      else byCat.set(k, [f]);
    }
    return Array.from(byCat.entries())
      .map(([key, list]) => ({ key, feeds: list }))
      .sort((a, b) => {
        if (a.key === "" && b.key !== "") return 1;
        if (b.key === "" && a.key !== "") return -1;
        return a.key.localeCompare(b.key);
      });
  }, [feeds]);

  const selectedArticle = useMemo(
    () => visibleArticles.find((a) => a.id === selectedArticleId) ?? null,
    [visibleArticles, selectedArticleId],
  );

  useEffect(() => {
    if (!selectedArticle) return;
    if (!selectedArticle.link) return;
    if (fullContent[selectedArticle.id]) return;
    if (extracting === selectedArticle.id) return;
    if (selectedArticle.hasFullContent) {
      // Feed item already shipped a content:encoded / atom <content> body.
      return;
    }
    if ((selectedArticle.contentText?.length ?? 0) >= FEED_FULL_THRESHOLD) {
      // Fallback: long enough text in description/summary — treat as full.
      return;
    }
    void handleExtractFull(selectedArticle);
    // handleExtractFull is stable enough; only react to article change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedArticle?.id]);

  function selectArticle(id: string) {
    setSelectedArticleId(id);
    if (!readSet.has(id)) {
      const next = new Set(readSet);
      next.add(id);
      setReadSet(next);
      saveRead(next);
    }
  }

  const unreadCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    const feedToCat = new Map<string, string>();
    for (const f of feeds) feedToCat.set(f.id, f.category ?? "");
    let all = 0;
    for (const a of allArticles) {
      if (!readSet.has(a.id)) {
        counts[a.feedId] = (counts[a.feedId] ?? 0) + 1;
        const cat = feedToCat.get(a.feedId) ?? "";
        const key = `cat:${cat}`;
        counts[key] = (counts[key] ?? 0) + 1;
        all += 1;
      }
    }
    counts.__all = all;
    return counts;
  }, [allArticles, readSet, feeds]);

  async function handleAddFeed(url: string) {
    const res = await fetch(`/api/feed?url=${encodeURIComponent(url)}`);
    const data = await readApiJson<{ feed?: ParsedFeed }>(res);
    if (!res.ok || !data.feed) {
      throw new Error(data.error ?? `HTTP ${res.status}`);
    }
    const feed: Feed = {
      id: randomId(),
      url,
      title: data.feed.title || url,
      addedAt: Date.now(),
    };
    const next = [...feeds, feed];
    setFeeds(next);
    saveFeeds(next);
    const articles: Article[] = data.feed.items.map((item) => ({
      id: stableId(feed.id, item.guid || item.link || item.title),
      feedId: feed.id,
      feedTitle: feed.title,
      title: item.title,
      link: item.link,
      author: item.author,
      publishedAt: item.publishedAt,
      contentHtml: item.contentHtml,
      contentText: item.contentText,
    }));
    setFeedStates((prev) => ({
      ...prev,
      [feed.id]: { status: "ready", articles, fetchedAt: Date.now() },
    }));
  }

  function handleRemoveFeed(id: string) {
    const next = feeds.filter((f) => f.id !== id);
    setFeeds(next);
    saveFeeds(next);
    setFeedStates((prev) => {
      const rest = { ...prev };
      delete rest[id];
      return rest;
    });
    if (selectedFeedId === id) setSelectedFeedId("all");
  }

  function handleRenameFeed(id: string, title: string) {
    const next = feeds.map((f) => (f.id === id ? { ...f, title } : f));
    setFeeds(next);
    saveFeeds(next);
    setFeedStates((prev) => {
      const s = prev[id];
      if (!s || s.status !== "ready") return prev;
      return {
        ...prev,
        [id]: {
          ...s,
          articles: s.articles.map((a) => ({ ...a, feedTitle: title })),
        },
      };
    });
  }

  function handleSetCategory(id: string, category: string) {
    const value = category.trim();
    const next = feeds.map((f) =>
      f.id === id ? { ...f, category: value || undefined } : f,
    );
    setFeeds(next);
    saveFeeds(next);
  }

  function handleSaveAI(cfg: AIConfig | null) {
    setAIConfig(cfg);
    saveAIConfig(cfg);
  }

  function markAllRead() {
    const next = new Set(readSet);
    for (const a of visibleArticles) next.add(a.id);
    setReadSet(next);
    saveRead(next);
  }

  async function handleExtractFull(article: Article) {
    if (!article.link) return;
    setExtracting(article.id);
    setExtractError(null);
    try {
      const res = await fetch(
        `/api/extract?url=${encodeURIComponent(article.link)}`,
      );
      const data = await readApiJson<{
        contentHtml?: string;
        contentText?: string;
      }>(res);
      if (!res.ok || !data.contentHtml) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setFullContent((prev) => ({ ...prev, [article.id]: data.contentHtml! }));
      if (data.contentText) {
        setFullContentText((prev) => ({
          ...prev,
          [article.id]: data.contentText!,
        }));
      }
    } catch (err) {
      setExtractError(err instanceof Error ? err.message : "Extract failed");
    } finally {
      setExtracting(null);
    }
  }

  async function handleSummarize(article: Article) {
    if (authStatus !== "authenticated" || !aiConfig || !hasAIKey) {
      setSummaryError(null);
      setSettingsInitialTab("ai");
      setSettingsOpen(true);
      return;
    }
    setSummarizing(article.id);
    setSummaryError(null);
    try {
      // Prefer extracted full text — if the feed only had a snippet but the
      // article needs full text, we wait briefly for the auto-extract to
      // resolve so summarize works on the real article body.
      let body = fullContentText[article.id] ?? "";
      if (!body && !article.hasFullContent && article.link) {
        try {
          const res = await fetch(
            `/api/extract?url=${encodeURIComponent(article.link)}`,
          );
          if (res.ok) {
            const data = await readApiJson<{
              contentHtml?: string;
              contentText?: string;
            }>(res);
            if (data.contentText) {
              body = data.contentText;
              setFullContentText((prev) => ({
                ...prev,
                [article.id]: data.contentText!,
              }));
              if (data.contentHtml) {
                setFullContent((prev) => ({
                  ...prev,
                  [article.id]: data.contentHtml!,
                }));
              }
            }
          }
        } catch {}
      }
      if (!body) body = article.contentText || article.title;
      const MAX_SUMMARY_INPUT = 50_000;
      if (body.length > MAX_SUMMARY_INPUT) {
        setSummaryError(
          `Article is too long; only the first ${MAX_SUMMARY_INPUT.toLocaleString()} characters were used for summary.`,
        );
        body = body.slice(0, MAX_SUMMARY_INPUT);
      }
      const res = await fetch("/api/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: aiConfig.endpoint,
          model: aiConfig.model,
          style: aiConfig.style,
          title: article.title,
          url: article.link,
          content: body,
        }),
      });
      const data = await readApiJson<{ summary?: string }>(res);
      if (!res.ok || !data.summary) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setSummaries((prev) => {
        const next = { ...prev, [article.id]: data.summary! };
        saveSummaries(next);
        return next;
      });
    } catch (err) {
      setSummaryError(err instanceof Error ? err.message : "Summarize failed");
    } finally {
      setSummarizing(null);
    }
  }

  const refreshingAll = Object.values(feedStates).some(
    (s) => s.status === "loading",
  );

  async function readApiJson<T>(res: Response): Promise<T & { error?: string }> {
    const text = await res.text();
    try {
      return JSON.parse(text) as T & { error?: string };
    } catch {
      const isHtml = /<\s*(!doctype\s+html|html)\b/i.test(text);
      if (isHtml) {
        throw new Error("Server returned an HTML error page instead of JSON.");
      }
      const preview = text.slice(0, 120).replace(/\s+/g, " ").trim();
      throw new Error(
        preview ? `Invalid server response: ${preview}` : "Invalid server response",
      );
    }
  }

  return (
    <div className="flex h-[100dvh] w-full">
      <aside
        className={`hidden md:flex shrink-0 flex-col border-r border-border bg-muted/40 transition-all ${
          feedsPanelCollapsed ? "w-0 overflow-hidden border-r-0" : "w-64"
        }`}
      >
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <h1 className="font-semibold tracking-tight">{t("appName")}</h1>
          <button
            aria-label={t("settings")}
            onClick={() => setSettingsOpen(true)}
            className="text-sm rounded px-2 py-1 hover:bg-background"
          >
            ⚙
          </button>
        </div>
        <AccountBar
          authStatus={authStatus}
          user={session?.user}
          syncStatus={syncStatus}
        />
        <nav className="flex-1 overflow-y-auto px-2 pb-4 pt-3">
          <button
            onClick={() => {
              setSelectedFeedId("all");
              setSelectedArticleId(null);
            }}
            className={`w-full text-left rounded px-3 py-1.5 text-sm flex items-center justify-between ${
              selectedFeedId === "all"
                ? "bg-background font-medium"
                : "hover:bg-background/60"
            }`}
          >
            <span>{t("allArticles")}</span>
            {unreadCounts.__all > 0 && (
              <span className="text-xs opacity-70">{unreadCounts.__all}</span>
            )}
          </button>
          <div className="mt-2 space-y-2">
            {feedGroups.map((group) => (
              <FeedGroup
                key={group.key}
                groupKey={group.key}
                title={group.key === "" ? t("uncategorized") : group.key}
                showHeading={group.key !== "" || feedGroups.length > 1}
                collapsed={collapsedCategories.has(group.key)}
                onToggle={() =>
                  setCollapsedCategories((prev) => {
                    const next = new Set(prev);
                    if (next.has(group.key)) next.delete(group.key);
                    else next.add(group.key);
                    return next;
                  })
                }
                feeds={group.feeds}
                feedStates={feedStates}
                selectedFeedId={selectedFeedId}
                unreadCounts={unreadCounts}
                onSelect={(id) => {
                  setSelectedFeedId(id);
                  setSelectedArticleId(null);
                }}
                allCategories={allCategoryNames}
                openMenuFeedId={openFeedMenuId}
                onOpenMenu={setOpenFeedMenuId}
                onCloseMenu={() => setOpenFeedMenuId(null)}
                onSetCategory={handleSetCategory}
                onRenameFeed={handleRenameFeed}
                onRemoveFeed={handleRemoveFeed}
                onRefreshFeed={(id) => {
                  const target = feeds.find((f) => f.id === id);
                  if (target) void refreshFeed(target);
                }}
              />
            ))}
          </div>
          {feeds.length === 0 && hydrated && (
            <p className="text-xs opacity-60 px-3 mt-4">
              {t("noFeeds")}
            </p>
          )}
        </nav>
      </aside>
      <button
        onClick={() => setFeedsPanelCollapsed((v) => !v)}
        className="hidden md:flex shrink-0 self-center h-20 w-3 items-center justify-center rounded-r border border-l-0 border-border bg-background text-[10px] hover:bg-muted"
        aria-label={feedsPanelCollapsed ? t("expandSubscriptions") : t("collapseSubscriptions")}
        title={feedsPanelCollapsed ? t("expandSubscriptions") : t("collapseSubscriptions")}
      >
        {feedsPanelCollapsed ? "⟩" : "⟨"}
      </button>

      <section
        className={`relative w-full shrink-0 border-r border-border flex flex-col min-w-0 transition-[width,border-color] duration-200 ${
          articlesPanelCollapsed ? "md:w-0 md:overflow-hidden md:border-r-0" : "md:w-80"
        }`}
      >
        <div className="px-3 sm:px-4 py-3 border-b border-border flex items-center gap-2 flex-nowrap min-w-0">
          <button
            aria-label={t("settings")}
            onClick={() => setSettingsOpen(true)}
            className="md:hidden text-sm rounded px-2 py-1 hover:bg-muted shrink-0"
          >
            ⚙
          </button>
          <button
            onClick={() => setMobileFeedPickerOpen(true)}
            className="text-sm font-semibold truncate flex-1 min-w-0 flex items-center gap-1 md:cursor-default md:hover:bg-transparent rounded px-1 hover:bg-muted md:pointer-events-none"
            aria-label={t("switchFeed")}
          >
            <span className="truncate">
              {selectedFeedId === "all"
                ? t("all")
                : typeof selectedFeedId === "string" &&
                    selectedFeedId.startsWith("cat:")
                  ? selectedFeedId.slice(4) || t("uncategorized")
                  : feeds.find((f) => f.id === selectedFeedId)?.title ??
                    t("allArticles")}
            </span>
            <span className="md:hidden text-[10px] opacity-60 shrink-0">▾</span>
          </button>
          <div className="flex items-center rounded border border-border overflow-hidden shrink-0">
            <button
              onClick={() => setFilterMode("unread")}
              className={`text-xs px-2 py-1 flex items-center gap-1 ${
                filterMode === "unread"
                  ? "bg-foreground text-background"
                  : "hover:bg-muted"
              }`}
            >
              <span>{t("unread")}</span>
              {unreadInScope > 0 && (
                <span
                  className={`text-[10px] px-1 rounded ${
                    filterMode === "unread"
                      ? "bg-background/20"
                      : "bg-muted text-foreground"
                  }`}
                >
                  {unreadInScope}
                </span>
              )}
            </button>
            <button
              onClick={() => setFilterMode("all")}
              className={`text-xs px-2 py-1 flex items-center gap-1 ${
                filterMode === "all"
                  ? "bg-foreground text-background"
                  : "hover:bg-muted"
              }`}
            >
              <span>{t("all")}</span>
              {totalInScope > 0 && (
                <span
                  className={`text-[10px] px-1 rounded ${
                    filterMode === "all"
                      ? "bg-background/20"
                      : "bg-muted text-foreground"
                  }`}
                >
                  {totalInScope}
                </span>
              )}
            </button>
          </div>
          <button
            onClick={markAllRead}
            disabled={visibleArticles.length === 0}
            className="text-xs rounded border border-border px-2 py-1 disabled:opacity-50 hover:bg-muted shrink-0"
            title={t("markAll")}
          >
            {t("markAll")}
          </button>
        </div>
        <ScrollWatcher
          listRef={articleListRef}
          onChange={setShowBackToTop}
        />
        {pull.direction === "down" && (
          <PullIndicator
            distance={pull.distance}
            releasing={pull.releasing}
            busy={pull.busy}
            label={
              pull.busy
                ? t("refreshing")
                : pull.releasing
                  ? t("releaseToRefresh")
                  : t("pullToRefresh")
            }
            arrow="↓"
            position="top"
          />
        )}
        <ol
          ref={articleListRef}
          className="flex-1 overflow-y-auto divide-y divide-border overscroll-y-contain"
          style={{
            transform:
              pull.direction === "down" && (pull.distance > 0 || pull.busy)
                ? `translateY(${pull.distance}px)`
                : undefined,
            transition:
              pull.busy && pull.direction === "down"
                ? "transform 0.2s"
                : pull.distance > 0
                  ? "none"
                  : "transform 0.2s",
          }}
        >
          {visibleArticles.length === 0 ? (
            <li className="p-4 text-sm opacity-60">
              {feeds.length === 0
                ? t("addFeedHint")
                : refreshingAll
                  ? t("loadingArticles")
                  : t("noArticles")}
            </li>
          ) : (
            visibleArticles.map((a) => {
              const isRead = readSet.has(a.id);
              const isSelected = selectedArticleId === a.id;
              return (
                <li key={a.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => selectArticle(a.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        selectArticle(a.id);
                      }
                    }}
                    className={`block w-full text-left p-3 cursor-pointer select-none ${
                      isSelected ? "bg-muted" : "hover:bg-muted/60"
                    } ${isRead ? "opacity-70" : ""}`}
                  >
                    <div className="flex items-center gap-2 text-xs opacity-70 mb-1">
                      {isRead ? (
                        <span
                          className="text-[10px] opacity-60 shrink-0"
                          aria-label={t("unread")}
                          title={t("unread")}
                        >
                          ✓
                        </span>
                      ) : (
                        <span
                          className="inline-block w-1.5 h-1.5 rounded-full bg-accent shrink-0"
                          aria-label={t("unread")}
                        />
                      )}
                      <span className="truncate">{a.feedTitle}</span>
                      {a.publishedAt && (
                        <span className="ml-auto shrink-0">
                          {formatDate(a.publishedAt, t)}
                        </span>
                      )}
                    </div>
                    <h3
                      className={`text-sm leading-snug break-words ${isRead ? "" : "font-medium"}`}
                    >
                      {a.title}
                    </h3>
                    {a.contentText && (
                      <p className="text-xs opacity-60 mt-1 break-words overflow-hidden max-h-[2.8em] leading-snug">
                        {a.contentText}
                      </p>
                    )}
                  </div>
                </li>
              );
            })
          )}
        </ol>
        {pull.direction === "up" && (
          <PullIndicator
            distance={pull.distance}
            releasing={pull.releasing}
            busy={pull.busy}
            label={
              pull.busy
                ? hasMoreCached
                  ? t("loadingOlder")
                  : t("fetchingOlder")
                : pull.releasing
                  ? hasMoreCached
                    ? t("releaseToLoadOlder")
                    : t("releaseToFetchOlder")
                  : hasMoreCached
                    ? t("pullToLoadOlder")
                    : t("pullToFetchOlder")
            }
            arrow="↑"
            position="bottom"
          />
        )}
        {!hasMoreCached && allExhausted && visibleArticles.length > 0 && (
          <div className="px-4 py-5 border-t border-border bg-muted/30 text-center">
            <div className="text-xs opacity-60 mb-1">{t("endOfList")}</div>
            <div className="text-[11px] opacity-50">
              {scopeFeedsRef.current.length === 1
                ? t("noOlderInFeed")
                : t("noOlderInFeeds")}
            </div>
          </div>
        )}
        {showBackToTop && (
          <button
            onClick={() => {
              articleListRef.current?.scrollTo({
                top: 0,
                behavior: "smooth",
              });
            }}
            className="absolute bottom-5 right-5 z-20 w-10 h-10 rounded-full bg-foreground text-background shadow-lg flex items-center justify-center hover:opacity-90 transition-opacity"
            aria-label={t("backToTop")}
            title={t("backToTop")}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
              <path d="M8 3l-5 5h3v5h4V8h3L8 3z"/>
            </svg>
          </button>
        )}
      </section>
      <button
        onClick={() => setArticlesPanelCollapsed((v) => !v)}
        className="hidden md:flex shrink-0 self-center h-20 w-3 items-center justify-center rounded-r border border-l-0 border-border bg-background text-[10px] hover:bg-muted"
        aria-label={articlesPanelCollapsed ? t("expandArticles") : t("collapseArticles")}
        title={articlesPanelCollapsed ? t("expandArticles") : t("collapseArticles")}
      >
        {articlesPanelCollapsed ? "⟩" : "⟨"}
      </button>

      <main className="hidden md:flex flex-1 min-w-0 flex-col overflow-hidden">
        {selectedArticle ? (
          <article
            key={selectedArticle.id}
            className="flex-1 overflow-y-auto"
          >
            <header className="border-b border-border">
              <div className="w-full max-w-3xl mx-auto px-6 sm:px-10 pt-10 pb-6">
                <div className="text-xs opacity-60 mb-2 flex items-center gap-2">
                  <span>{selectedArticle.feedTitle}</span>
                  {selectedArticle.author && (
                    <>
                      <span>·</span>
                      <span>{selectedArticle.author}</span>
                    </>
                  )}
                  {selectedArticle.publishedAt && (
                    <>
                      <span>·</span>
                      <span>{formatDate(selectedArticle.publishedAt, t)}</span>
                    </>
                  )}
                </div>
                <h1 className="text-3xl font-semibold leading-tight tracking-tight">
                  {selectedArticle.title}
                </h1>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <a
                    href={selectedArticle.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm rounded border border-border px-3 py-1 hover:bg-muted"
                  >
                    {t("openOriginal")} ↗
                  </a>
                  <button
                    onClick={() => handleSummarize(selectedArticle)}
                    disabled={summarizing === selectedArticle.id}
                    className="text-sm rounded bg-accent px-3 py-1 text-white disabled:opacity-50"
                  >
                    {summarizing === selectedArticle.id
                      ? t("summarizing")
                      : summaries[selectedArticle.id]
                        ? t("resummarize")
                        : t("summarizeAction")}
                  </button>
                  <button
                    onClick={() => handleExtractFull(selectedArticle)}
                    disabled={
                      extracting === selectedArticle.id || !selectedArticle.link
                    }
                    className="ml-auto text-xs rounded px-2 py-1 opacity-40 hover:opacity-100 hover:bg-muted disabled:opacity-20"
                    title={
                      extracting === selectedArticle.id
                        ? t("loadingFullArticleTitle")
                        : fullContent[selectedArticle.id]
                          ? t("reFetchFullArticle")
                          : t("loadFullArticleTitle")
                    }
                    aria-label={t("loadFullArticle")}
                  >
                    {extracting === selectedArticle.id ? "…" : "📖"}
                  </button>
                </div>
                {summaryError && (
                  <p className="text-sm text-red-500 mt-2">{summaryError}</p>
                )}
                {extractError && (
                  <p className="text-sm text-red-500 mt-2">{extractError}</p>
                )}
                {summaries[selectedArticle.id] && (
                  <SummaryCard text={summaries[selectedArticle.id]!} />
                )}
              </div>
            </header>
            {extracting === selectedArticle.id &&
              !fullContent[selectedArticle.id] && (
                <div className="w-full max-w-3xl mx-auto px-6 sm:px-10 pt-4">
                  <div className="flex items-center gap-2 text-sm rounded-md border border-border bg-muted/50 px-3 py-2">
                    <Spinner />
                    <span className="opacity-80">
                      {t("loadingFullArticleInline")}
                    </span>
                  </div>
                </div>
              )}
            <ArticleBody
              article={selectedArticle}
              html={
                fullContent[selectedArticle.id] ??
                selectedArticle.contentHtml ??
                undefined
              }
            />
          </article>
        ) : (
          <div className="flex-1 grid place-items-center text-sm opacity-60">
            {t("selectArticle")}
          </div>
        )}
      </main>

      <SettingsDialog
        open={settingsOpen}
        onClose={() => {
          setSettingsOpen(false);
          setSettingsInitialTab("feeds");
        }}
        initialTab={settingsInitialTab}
        feeds={feeds}
        onAddFeed={handleAddFeed}
        onRemoveFeed={handleRemoveFeed}
        onRenameFeed={handleRenameFeed}
        onSetCategory={handleSetCategory}
        aiConfig={aiConfig}
        hasAIKey={hasAIKey}
        isSignedIn={authStatus === "authenticated"}
        onSaveAI={handleSaveAI}
        onSetAIKey={handleSetAIKey}
        onClearAIKey={handleClearAIKey}
      />

      {mobileFeedPickerOpen && (
        <MobileFeedPicker
          feeds={feeds}
          feedGroups={feedGroups}
          feedStates={feedStates}
          selectedFeedId={selectedFeedId}
          unreadCounts={unreadCounts}
          onSelect={(id) => {
            setSelectedFeedId(id);
            setSelectedArticleId(null);
            setMobileFeedPickerOpen(false);
          }}
          onClose={() => setMobileFeedPickerOpen(false)}
        />
      )}

      {selectedArticle && (
        <MobileReader
          article={selectedArticle}
          onClose={() => setSelectedArticleId(null)}
          summary={summaries[selectedArticle.id]}
          summarizing={summarizing === selectedArticle.id}
          summaryError={summaryError}
          onSummarize={() => handleSummarize(selectedArticle)}
          fullHtml={fullContent[selectedArticle.id]}
          extracting={extracting === selectedArticle.id}
          extractError={extractError}
          onExtract={() => handleExtractFull(selectedArticle)}
        />
      )}
    </div>
  );
}

function ArticleBody({
  article,
  html,
}: {
  article: Article;
  html?: string;
}) {
  const t = useTranslations("Reader");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [toc, setToc] = useState<{ id: string; text: string; level: number }[]>(
    [],
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const tocContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const root = containerRef.current;
    if (!root || !html) {
      setToc([]);
      setActiveId(null);
      return;
    }
    const headingNodes = Array.from(
      root.querySelectorAll<HTMLHeadingElement>(
        "h1[id], h2[id], h3[id], h4[id]",
      ),
    ).filter((h) => (h.textContent ?? "").trim().length > 0);
    setToc(
      headingNodes.map((h) => ({
        id: h.id,
        text: (h.textContent ?? "").trim(),
        level: parseInt(h.tagName.slice(1), 10),
      })),
    );
    if (headingNodes.length === 0) {
      setActiveId(null);
      return;
    }

    const scroller = root.closest("article");
    const getScrollTop = () => (scroller ? scroller.scrollTop : window.scrollY);
    let rafId = 0;
    let lastId: string | null = null;
    const compute = () => {
      rafId = 0;
      const marker = getScrollTop() + 180;
      let current = headingNodes[0].id;
      for (const h of headingNodes) {
        // Read offsetTop live — survives layout shifts when lazy images
        // load in after initial mount.
        if (h.offsetTop <= marker) current = h.id;
        else break;
      }
      if (current !== lastId) {
        lastId = current;
        setActiveId(current);
      }
    };
    const schedule = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(compute);
    };

    compute();
    const target = scroller ?? window;
    target.addEventListener("scroll", schedule, { passive: true });
    return () => {
      target.removeEventListener("scroll", schedule);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [html, article.id]);

  useEffect(() => {
    if (!activeId) return;
    const tocRoot = tocContainerRef.current;
    if (!tocRoot) return;
    const btn = tocRoot.querySelector<HTMLButtonElement>(
      `button[data-toc-id="${CSS.escape(activeId)}"]`,
    );
    if (!btn) return;
    // Scroll the TOC list manually instead of using btn.scrollIntoView —
    // the latter walks up to the nearest scroll container, which on this
    // layout is the <article>, and a synchronous scrollIntoView there
    // cancels any in-flight smooth scroll triggered by jumpTo (so the
    // second / third TOC click would never finish navigating).
    const tocRect = tocRoot.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    if (btnRect.top < tocRect.top) {
      tocRoot.scrollTop += btnRect.top - tocRect.top;
    } else if (btnRect.bottom > tocRect.bottom) {
      tocRoot.scrollTop += btnRect.bottom - tocRect.bottom;
    }
  }, [activeId]);

  function jumpTo(id: string) {
    const root = containerRef.current;
    if (!root) return;
    const target = root.querySelector(`#${CSS.escape(id)}`);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveId(id);
  }

  const hasToc = toc.length >= 2;
  return (
    <div className="mx-auto w-full max-w-[1400px] px-6 sm:px-10">
      <div className="xl:grid xl:grid-cols-[13rem_minmax(0,1fr)_13rem] xl:gap-6">
        <div className="hidden xl:block" aria-hidden />
        <div
          className="prose-content w-full max-w-3xl min-w-0 py-8 xl:mx-auto"
          ref={containerRef}
        >
        {html ? (
          <div dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <p className="opacity-60 text-sm">
            {t("noContent")}{" "}
            <a href={article.link} target="_blank" rel="noopener noreferrer">
              {t("readOnSource")}
            </a>
          </p>
        )}
        </div>
        <aside className="hidden xl:block w-52 shrink-0 py-8">
          {hasToc ? (
            <div
              ref={tocContainerRef}
              className="sticky top-24 max-h-[calc(100dvh-7rem)] overflow-y-auto"
            >
              <div className="text-[10px] font-semibold uppercase tracking-wider opacity-60 mb-2">
                {t("onThisPage")}
              </div>
              <ul className="space-y-0.5 text-xs">
                {toc.map((it) => (
                  <li
                    key={it.id}
                    style={{ paddingLeft: `${(it.level - 1) * 0.5}rem` }}
                  >
                    <button
                      onClick={() => jumpTo(it.id)}
                      data-toc-id={it.id}
                      className={`text-left w-full truncate rounded px-2 py-1 hover:bg-muted ${
                        activeId === it.id
                          ? "text-accent font-medium bg-muted"
                          : "opacity-70 hover:opacity-100"
                      }`}
                      title={it.text}
                    >
                      {it.text || t("untitled")}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

function MobileFeedPicker({
  feeds,
  feedGroups,
  feedStates,
  selectedFeedId,
  unreadCounts,
  onSelect,
  onClose,
}: {
  feeds: Feed[];
  feedGroups: { key: string; feeds: Feed[] }[];
  feedStates: Record<string, FeedState>;
  selectedFeedId: string | "all";
  unreadCounts: Record<string, number>;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations("Reader");
  return (
    <div className="md:hidden fixed inset-0 z-40 bg-background flex flex-col">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <button
          onClick={onClose}
          className="text-sm rounded px-2 py-1 hover:bg-muted"
          aria-label={t("back")}
        >
          ← {t("back")}
        </button>
        <h2 className="text-sm font-semibold flex-1">{t("subscriptions")}</h2>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 py-3">
        <button
          onClick={() => onSelect("all")}
          className={`w-full text-left rounded px-3 py-2 text-sm flex items-center justify-between ${
            selectedFeedId === "all"
              ? "bg-muted font-medium"
              : "hover:bg-muted/60"
          }`}
        >
          <span>{t("allArticles")}</span>
          {unreadCounts.__all > 0 && (
            <span className="text-xs opacity-70">{unreadCounts.__all}</span>
          )}
        </button>
        <div className="mt-3 space-y-3">
          {feedGroups.map((group) => {
            const label = group.key === "" ? t("uncategorized") : group.key;
            const catKey = `cat:${group.key}`;
            return (
              <div key={group.key || "__uncat__"}>
                {(group.key !== "" || feedGroups.length > 1) && (
                  <button
                    onClick={() => onSelect(catKey)}
                    className={`w-full text-left px-3 py-1 text-[11px] uppercase tracking-wider flex items-center justify-between ${
                      selectedFeedId === catKey
                        ? "text-accent font-semibold"
                        : "opacity-60 hover:opacity-100"
                    }`}
                  >
                    <span>{label}</span>
                    {unreadCounts[catKey] ? (
                      <span className="text-[10px]">
                        {unreadCounts[catKey]}
                      </span>
                    ) : null}
                  </button>
                )}
                <div className="space-y-0.5 mt-1">
                  {group.feeds.map((f) => {
                    const s = feedStates[f.id];
                    return (
                      <button
                        key={f.id}
                        onClick={() => onSelect(f.id)}
                        className={`w-full text-left rounded px-3 py-2 text-sm flex items-center justify-between gap-2 ${
                          selectedFeedId === f.id
                            ? "bg-muted font-medium"
                            : "hover:bg-muted/60"
                        }`}
                      >
                        <span className="truncate">{f.title}</span>
                        <span
                          className="text-xs opacity-70 shrink-0"
                          title={
                            s?.status === "error"
                              ? t("loadFailed", { error: s.error })
                              : undefined
                          }
                        >
                          {s?.status === "loading"
                            ? "…"
                            : s?.status === "error"
                              ? "!"
                              : unreadCounts[f.id] || ""}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        {feeds.length === 0 && (
          <p className="text-xs opacity-60 px-3 mt-4">
            {t("noFeeds")}
          </p>
        )}
      </nav>
    </div>
  );
}

type SummaryNode = {
  kind: "ul" | "ol" | "p";
  items: { content: string; lvl?: number }[];
};

function parseSummary(raw: string): SummaryNode[] {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const blocks: SummaryNode[] = [];
  let current: SummaryNode | null = null;
  for (const lineRaw of lines) {
    const line = lineRaw.trimEnd();
    if (!line.trim()) {
      current = null;
      continue;
    }
    const ulMatch = line.match(/^(\s*)[-*•·]\s+(.*)$/);
    const olMatch = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (ulMatch) {
      const lvl = Math.min(Math.floor(ulMatch[1].length / 2), 3);
      if (!current || current.kind !== "ul") {
        current = { kind: "ul", items: [] };
        blocks.push(current);
      }
      current.items.push({ content: ulMatch[2], lvl });
    } else if (olMatch) {
      const lvl = Math.min(Math.floor(olMatch[1].length / 2), 3);
      if (!current || current.kind !== "ol") {
        current = { kind: "ol", items: [] };
        blocks.push(current);
      }
      current.items.push({ content: olMatch[3], lvl });
    } else {
      if (!current || current.kind !== "p") {
        current = { kind: "p", items: [] };
        blocks.push(current);
      }
      current.items.push({ content: line });
    }
  }
  return blocks;
}

function renderInline(text: string): React.ReactNode {
  // **bold** and `code` only — keep it minimal
  const parts: React.ReactNode[] = [];
  const regex = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const token = m[0];
    if (token.startsWith("**")) {
      parts.push(
        <strong key={i++} className="font-semibold">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith("`")) {
      parts.push(
        <code
          key={i++}
          className="bg-foreground/10 rounded px-1 py-0.5 text-[0.85em] font-mono"
        >
          {token.slice(1, -1)}
        </code>,
      );
    }
    last = m.index + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length === 0 ? text : parts;
}

function SummaryCard({ text }: { text: string }) {
  const blocks = useMemo(() => parseSummary(text), [text]);
  const t = useTranslations("Reader");
  return (
    <div className="mt-4 relative overflow-hidden rounded-xl border border-accent/30 bg-gradient-to-br from-accent/10 via-accent/5 to-transparent">
      <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_top_right,var(--accent),transparent_40%)] opacity-10" />
      <div className="relative px-5 py-4">
        <div className="flex items-center gap-2 mb-3">
          <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-accent/15 text-accent">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M12 2l1.84 5.66h5.95l-4.81 3.5 1.84 5.66L12 13.31 7.18 16.82 9.02 11.16 4.21 7.66h5.95L12 2z"/>
            </svg>
          </span>
          <div className="text-xs font-semibold uppercase tracking-wider text-accent">
            {t("aiSummaryLabel")}
          </div>
        </div>
        <div className="text-sm leading-relaxed space-y-2.5">
          {blocks.map((block, bi) => {
            if (block.kind === "p") {
              return block.items.map((it, ii) => (
                <p key={`${bi}-${ii}`} className="m-0">
                  {renderInline(it.content)}
                </p>
              ));
            }
            const ListTag = block.kind === "ol" ? "ol" : "ul";
            return (
              <ListTag
                key={bi}
                className={`m-0 pl-0 space-y-1.5 ${
                  block.kind === "ol" ? "list-decimal" : ""
                }`}
              >
                {block.items.map((it, ii) => (
                  <li
                    key={ii}
                    className="flex items-start gap-2"
                    style={{ paddingLeft: `${(it.lvl ?? 0) * 1}rem` }}
                  >
                    {block.kind === "ul" && (
                      <span
                        className="mt-2 inline-block w-1 h-1 rounded-full bg-accent/80 shrink-0"
                        aria-hidden
                      />
                    )}
                    <span className="flex-1">{renderInline(it.content)}</span>
                  </li>
                ))}
              </ListTag>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ScrollWatcher({
  listRef,
  onChange,
}: {
  listRef: React.RefObject<HTMLOListElement | null>;
  onChange: (visible: boolean) => void;
}) {
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    let lastVisible = false;
    function check() {
      const node = listRef.current;
      if (!node) return;
      const next = node.scrollTop > 300;
      if (next !== lastVisible) {
        lastVisible = next;
        onChange(next);
      }
    }
    el.addEventListener("scroll", check, { passive: true });
    check();
    return () => {
      el.removeEventListener("scroll", check);
    };
  }, [listRef, onChange]);
  return null;
}

function PullIndicator({
  distance,
  releasing,
  busy,
  label,
  arrow,
  position,
}: {
  distance: number;
  releasing: boolean;
  busy: boolean;
  label: string;
  arrow: "↑" | "↓";
  position: "top" | "bottom";
}) {
  if (distance === 0 && !busy) return null;
  const height = busy ? 44 : Math.min(60, distance);
  const flippedRotation =
    arrow === "↓" ? (releasing ? 180 : 0) : releasing ? 0 : 180;
  return (
    <div
      className={`flex items-center justify-center gap-2 text-xs opacity-70 overflow-hidden ${
        position === "top" ? "" : "border-t border-border"
      }`}
      style={{ height }}
    >
      <span
        className={`inline-block w-4 h-4 text-center leading-4 ${
          busy
            ? "animate-spin border-2 border-current border-r-transparent rounded-full"
            : ""
        }`}
        style={
          !busy
            ? {
                transform: `rotate(${flippedRotation}deg)`,
                transition: "transform 0.15s",
              }
            : undefined
        }
        aria-hidden
      >
        {!busy ? arrow : ""}
      </span>
      <span>{label}</span>
    </div>
  );
}

function Spinner() {
  return (
    <span
      aria-label="loading"
      className="inline-block w-4 h-4 rounded-full border-2 border-current border-r-transparent animate-spin opacity-70"
    />
  );
}

function FeedGroup({
  groupKey,
  title,
  showHeading,
  collapsed,
  onToggle,
  feeds,
  feedStates,
  selectedFeedId,
  unreadCounts,
  onSelect,
  allCategories,
  openMenuFeedId,
  onOpenMenu,
  onCloseMenu,
  onSetCategory,
  onRenameFeed,
  onRemoveFeed,
  onRefreshFeed,
}: {
  groupKey: string;
  title: string;
  showHeading: boolean;
  collapsed: boolean;
  onToggle: () => void;
  feeds: Feed[];
  feedStates: Record<string, FeedState>;
  selectedFeedId: string | "all";
  unreadCounts: Record<string, number>;
  onSelect: (id: string) => void;
  allCategories: string[];
  openMenuFeedId: string | null;
  onOpenMenu: (id: string) => void;
  onCloseMenu: () => void;
  onSetCategory: (id: string, category: string) => void;
  onRenameFeed: (id: string, title: string) => void;
  onRemoveFeed: (id: string) => void;
  onRefreshFeed: (id: string) => void;
}) {
  const catKey = `cat:${groupKey}`;
  return (
    <div>
      {showHeading && (
        <button
          onClick={onToggle}
          className="w-full text-left px-3 py-1.5 text-[10px] uppercase tracking-wider bg-muted/40 border-y border-border/60 text-foreground/80 hover:bg-muted/70 flex items-center gap-1.5"
        >
          <span className="inline-block w-3">{collapsed ? "▸" : "▾"}</span>
          <span className="flex-1 truncate">{title}</span>
          {unreadCounts[catKey] ? (
            <span className="text-[10px] opacity-70">
              {unreadCounts[catKey]}
            </span>
          ) : null}
        </button>
      )}
      {!collapsed && (
        <div className="space-y-0.5">
          {feeds.map((f) => {
            const s = feedStates[f.id];
            const isSelected = selectedFeedId === f.id;
            return (
              <FeedRow
                key={f.id}
                feed={f}
                state={s}
                isSelected={isSelected}
                unreadCount={unreadCounts[f.id] ?? 0}
                onSelect={() => onSelect(f.id)}
                menuOpen={openMenuFeedId === f.id}
                onOpenMenu={() => onOpenMenu(f.id)}
                onCloseMenu={onCloseMenu}
                allCategories={allCategories}
                onSetCategory={onSetCategory}
                onRenameFeed={onRenameFeed}
                onRemoveFeed={onRemoveFeed}
                onRefreshFeed={onRefreshFeed}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function FeedRow({
  feed,
  state,
  isSelected,
  unreadCount,
  onSelect,
  menuOpen,
  onOpenMenu,
  onCloseMenu,
  allCategories,
  onSetCategory,
  onRenameFeed,
  onRemoveFeed,
  onRefreshFeed,
}: {
  feed: Feed;
  state: FeedState | undefined;
  isSelected: boolean;
  unreadCount: number;
  onSelect: () => void;
  menuOpen: boolean;
  onOpenMenu: () => void;
  onCloseMenu: () => void;
  allCategories: string[];
  onSetCategory: (id: string, category: string) => void;
  onRenameFeed: (id: string, title: string) => void;
  onRemoveFeed: (id: string) => void;
  onRefreshFeed: (id: string) => void;
}) {
  const errorMessage = state?.status === "error" ? state.error : null;
  const t = useTranslations("Reader");
  return (
    <div
      className={`group relative rounded ${
        isSelected ? "bg-background font-medium" : "hover:bg-background/60"
      }`}
    >
      <button
        onClick={onSelect}
        onContextMenu={(e) => {
          e.preventDefault();
          onOpenMenu();
        }}
        className="w-full text-left px-3 py-1.5 text-sm flex items-center justify-between gap-2 pr-12"
        title={feed.url}
      >
        <span className="truncate">{feed.title}</span>
        <span
          className="text-xs opacity-70 shrink-0"
          title={errorMessage ? t("loadFailed", { error: errorMessage }) : undefined}
        >
          {state?.status === "loading"
            ? "…"
            : state?.status === "error"
              ? "!"
              : unreadCount || ""}
        </span>
      </button>
      {state?.status !== "error" && (
        <button
        onClick={(e) => {
          e.stopPropagation();
          onRefreshFeed(feed.id);
        }}
        className="absolute right-7 top-1/2 -translate-y-1/2 px-1.5 py-0.5 text-xs rounded hover:bg-muted opacity-0 group-hover:opacity-100 focus:opacity-100"
        aria-label={t("refreshFeed", { title: feed.title })}
        title={t("refreshFeed", { title: feed.title })}
      >
        ↻
        </button>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation();
          if (menuOpen) onCloseMenu();
          else onOpenMenu();
        }}
        className={`absolute right-1 top-1/2 -translate-y-1/2 px-1.5 py-0.5 text-xs rounded hover:bg-muted ${
          menuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus:opacity-100"
        }`}
        aria-label={t("feedOptions")}
        title={t("feedOptions")}
      >
        ⋯
      </button>
      {menuOpen && (
        <FeedMenu
          feed={feed}
          allCategories={allCategories}
          onClose={onCloseMenu}
          onSetCategory={(c) => {
            onSetCategory(feed.id, c);
            onCloseMenu();
          }}
          onRenameFeed={(title) => {
            onRenameFeed(feed.id, title);
            onCloseMenu();
          }}
          onRemoveFeed={() => {
            onRemoveFeed(feed.id);
            onCloseMenu();
          }}
        />
      )}
    </div>
  );
}

function FeedMenu({
  feed,
  allCategories,
  onClose,
  onSetCategory,
  onRenameFeed,
  onRemoveFeed,
}: {
  feed: Feed;
  allCategories: string[];
  onClose: () => void;
  onSetCategory: (category: string) => void;
  onRenameFeed: (title: string) => void;
  onRemoveFeed: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const t = useTranslations("Reader");

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute right-1 top-[100%] z-30 mt-1 w-56 rounded border border-border bg-background shadow-lg p-1 text-sm"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="px-2 pt-1 pb-0.5 text-[10px] uppercase tracking-wider opacity-60">
        {t("categoryLabel")}
      </div>
      <button
        onClick={() => onSetCategory("")}
        className={`w-full text-left px-2 py-1 rounded text-xs hover:bg-muted flex items-center justify-between ${
          !feed.category ? "font-medium" : ""
        }`}
      >
        <span>{t("uncategorized")}</span>
        {!feed.category && <span>✓</span>}
      </button>
      {allCategories.map((c) => (
        <button
          key={c}
          onClick={() => onSetCategory(c)}
          className={`w-full text-left px-2 py-1 rounded text-xs hover:bg-muted flex items-center justify-between ${
            feed.category === c ? "font-medium" : ""
          }`}
        >
          <span className="truncate">{c}</span>
          {feed.category === c && <span className="shrink-0">✓</span>}
        </button>
      ))}
      <button
        onClick={() => {
          const next = window.prompt(t("newCategoryPrompt"));
          if (next && next.trim()) onSetCategory(next.trim());
        }}
        className="w-full text-left px-2 py-1 rounded text-xs hover:bg-muted opacity-70"
      >
        {t("newCategory")}
      </button>
      <div className="my-1 border-t border-border" />
      <button
        onClick={() => {
          const next = window.prompt(t("renameFeedPrompt"), feed.title);
          if (next && next.trim()) onRenameFeed(next.trim());
        }}
        className="w-full text-left px-2 py-1 rounded text-xs hover:bg-muted"
      >
        {t("renameFeed")}
      </button>
      <button
        onClick={() => {
          if (window.confirm(t("removeFeedConfirm", { title: feed.title }))) onRemoveFeed();
        }}
        className="w-full text-left px-2 py-1 rounded text-xs text-red-500 hover:bg-red-500/10"
      >
        {t("removeFeed")}
      </button>
    </div>
  );
}

function AccountBar({
  authStatus,
  user,
  syncStatus,
}: {
  authStatus: "loading" | "authenticated" | "unauthenticated";
  user: { name?: string | null; image?: string | null } | undefined;
  syncStatus: SyncStatus;
}) {
  const t = useTranslations("Reader");
  return (
    <div className="px-4 py-2 border-b border-border flex items-center gap-2 min-h-[3rem]">
      {authStatus === "authenticated" ? (
        <>
          {user?.image && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={user.image}
              alt=""
              className="w-6 h-6 rounded-full"
              referrerPolicy="no-referrer"
            />
          )}
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium truncate">
              {user?.name || t("signedIn")}
            </div>
            <div className="text-[10px] opacity-60 truncate">
              {syncLabel(syncStatus, t)}
            </div>
          </div>
          <button
            onClick={() => signOut()}
            className="text-xs rounded px-2 py-1 hover:bg-background"
            title={t("signOut")}
          >
            ⎋
          </button>
        </>
      ) : authStatus === "loading" ? (
        <span className="text-xs opacity-60">…</span>
      ) : (
        <button
          onClick={() => signIn("github")}
          className="w-full text-xs rounded border border-border px-2 py-1.5 hover:bg-background flex items-center justify-center gap-2"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
          </svg>
          {t("signInWithGitHub")}
        </button>
      )}
    </div>
  );
}

type ReaderT = ReturnType<typeof useTranslations<"Reader">>;

function syncLabel(s: SyncStatus, t: ReaderT): string {
  switch (s.state) {
    case "off":
      return t("syncLocal");
    case "pulling":
      return t("syncPulling");
    case "syncing":
      return t("syncSyncing");
    case "idle":
      return s.updatedAt
        ? t("syncIdleAt", { time: formatRelative(s.updatedAt, t) })
        : t("syncIdle");
    case "error":
      return t("syncError", { error: s.error });
  }
}

function formatRelative(ts: number, t: ReaderT): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return t("justNow");
  if (diff < 3_600_000) return t("minutesAgo", { n: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t("hoursAgo", { n: Math.floor(diff / 3_600_000) });
  return new Date(ts).toLocaleDateString();
}

function mergeFeeds(local: Feed[], remote: Feed[]): Feed[] {
  const byUrl = new Map<string, Feed>();
  for (const f of local) byUrl.set(f.url, f);
  for (const f of remote) {
    const existing = byUrl.get(f.url);
    if (existing) {
      byUrl.set(f.url, {
        ...existing,
        ...f,
        addedAt: Math.min(existing.addedAt, f.addedAt),
      });
    } else {
      byUrl.set(f.url, f);
    }
  }
  return Array.from(byUrl.values()).sort((a, b) => a.addedAt - b.addedAt);
}

function MobileReader({
  article,
  onClose,
  summary,
  summarizing,
  summaryError,
  onSummarize,
  fullHtml,
  extracting,
  extractError,
  onExtract,
}: {
  article: Article;
  onClose: () => void;
  summary?: string;
  summarizing: boolean;
  summaryError: string | null;
  onSummarize: () => void;
  fullHtml?: string;
  extracting: boolean;
  extractError: string | null;
  onExtract: () => void;
}) {
  const t = useTranslations("Reader");
  return (
    <div className="md:hidden fixed inset-0 z-40 bg-background flex flex-col">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border">
        <button
          onClick={onClose}
          className="text-sm rounded px-2 py-1 hover:bg-muted"
          aria-label={t("back")}
        >
          ← {t("back")}
        </button>
        <a
          href={article.link}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto text-xs rounded border border-border px-2 py-1"
        >
          {t("open")} ↗
        </a>
        <button
          onClick={onExtract}
          disabled={extracting || !article.link}
          className="text-xs rounded px-2 py-1 opacity-50 hover:opacity-100 disabled:opacity-30"
          title={fullHtml ? t("reloadFullArticle") : t("loadFullArticle")}
        >
          {extracting ? "…" : "📖"}
        </button>
        <button
          onClick={onSummarize}
          disabled={summarizing}
          className="text-xs rounded bg-accent px-2 py-1 text-white disabled:opacity-50"
        >
          {summarizing ? "…" : "✨"}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <h1 className="text-xl font-semibold leading-tight mb-2">
          {article.title}
        </h1>
        <div className="text-xs opacity-60 mb-3 flex items-center gap-2">
          <span>{article.feedTitle}</span>
          {article.publishedAt && (
            <>
              <span>·</span>
              <span>{formatDate(article.publishedAt, t)}</span>
            </>
          )}
        </div>
        {summaryError && (
          <p className="text-sm text-red-500 mb-3">{summaryError}</p>
        )}
        {extractError && (
          <p className="text-sm text-red-500 mb-3">{extractError}</p>
        )}
        {extracting && !fullHtml && (
          <div className="mb-3 flex items-center gap-2 text-sm rounded-md border border-border bg-muted/50 px-3 py-2">
            <Spinner />
            <span className="opacity-80">{t("loadingFullArticleTitle")}</span>
          </div>
        )}
        {summary && (
          <div className="mb-4">
            <SummaryCard text={summary} />
          </div>
        )}
        <div className="prose-content">
          {fullHtml ? (
            <div dangerouslySetInnerHTML={{ __html: fullHtml }} />
          ) : article.contentHtml ? (
            <div dangerouslySetInnerHTML={{ __html: article.contentHtml }} />
          ) : (
            <p className="opacity-60 text-sm">{t("noContentMobile")}</p>
          )}
        </div>
      </div>
    </div>
  );
}

function formatDate(ts: number, t: ReaderT): string {
  const now = Date.now();
  const diff = now - ts;
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  const week = 7 * day;
  if (diff < min) return t("justNow");
  if (diff < hour) return t("minutesAgo", { n: Math.floor(diff / min) });
  if (diff < day) return t("hoursAgo", { n: Math.floor(diff / hour) });
  if (diff < week) return t("daysAgo", { n: Math.floor(diff / day) });
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  });
}

const ARTICLE_CACHE_LIMIT = 500;

function mergeArticleLists(prev: Article[], next: Article[]): Article[] {
  const byId = new Map<string, Article>();
  for (const a of prev) byId.set(a.id, a);
  for (const a of next) byId.set(a.id, a); // newer wins for shared ids
  const merged = Array.from(byId.values()).sort(
    (a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0),
  );
  return merged.slice(0, ARTICLE_CACHE_LIMIT);
}

function stableId(feedId: string, key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = (h * 31 + key.charCodeAt(i)) | 0;
  }
  return `${feedId}:${(h >>> 0).toString(36)}`;
}
