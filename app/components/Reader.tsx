"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { signIn, signOut, useSession } from "next-auth/react";
import type { AIConfig, Article, Feed, ParsedFeed } from "@/app/lib/types";
import {
  loadAIConfig,
  loadFeeds,
  loadRead,
  randomId,
  saveAIConfig,
  saveFeeds,
  saveRead,
} from "@/app/lib/storage";
import { SettingsDialog } from "./SettingsDialog";

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
  const [summaries, setSummaries] = useState<Record<string, string>>({});
  const [summarizing, setSummarizing] = useState<string | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({ state: "off" });
  const syncReady = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage hydration after mount
    setFeeds(loadFeeds());
    setAIConfig(loadAIConfig());
    setReadSet(loadRead());
    setHydrated(true);
  }, []);

  async function refreshFeed(feed: Feed) {
    setFeedStates((prev) => ({ ...prev, [feed.id]: { status: "loading" } }));
    try {
      const res = await fetch(`/api/feed?url=${encodeURIComponent(feed.url)}`);
      const data = (await res.json()) as { feed?: ParsedFeed; error?: string };
      if (!res.ok || !data.feed) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
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
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load";
      setFeedStates((prev) => ({
        ...prev,
        [feed.id]: { status: "error", error: message },
      }));
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
      const data = (await res.json()) as {
        updatedAt?: number;
        error?: string;
      };
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
        const data = (await res.json()) as {
          blob?: SyncBlob | null;
          error?: string;
        };
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

  useEffect(() => {
    if (!hydrated) return;
    for (const feed of feeds) {
      if (!feedStates[feed.id]) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- triggers async fetch that sets state
        void refreshFeed(feed);
      }
    }
  }, [feeds, hydrated, feedStates]);

  const allArticles = useMemo(() => {
    const list: Article[] = [];
    for (const f of feeds) {
      const s = feedStates[f.id];
      if (s?.status === "ready") list.push(...s.articles);
    }
    list.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
    return list;
  }, [feeds, feedStates]);

  const visibleArticles = useMemo(() => {
    if (selectedFeedId === "all") return allArticles;
    return allArticles.filter((a) => a.feedId === selectedFeedId);
  }, [allArticles, selectedFeedId]);

  const selectedArticle = useMemo(
    () => visibleArticles.find((a) => a.id === selectedArticleId) ?? null,
    [visibleArticles, selectedArticleId],
  );

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
    let all = 0;
    for (const a of allArticles) {
      if (!readSet.has(a.id)) {
        counts[a.feedId] = (counts[a.feedId] ?? 0) + 1;
        all += 1;
      }
    }
    counts.__all = all;
    return counts;
  }, [allArticles, readSet]);

  async function handleAddFeed(url: string) {
    const res = await fetch(`/api/feed?url=${encodeURIComponent(url)}`);
    const data = (await res.json()) as { feed?: ParsedFeed; error?: string };
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

  async function handleSummarize(article: Article) {
    if (!aiConfig) {
      setSummaryError("Configure your AI endpoint in Settings first.");
      return;
    }
    setSummarizing(article.id);
    setSummaryError(null);
    try {
      const res = await fetch("/api/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: aiConfig.endpoint,
          apiKey: aiConfig.apiKey,
          model: aiConfig.model,
          title: article.title,
          url: article.link,
          content: article.contentText || article.title,
        }),
      });
      const data = (await res.json()) as { summary?: string; error?: string };
      if (!res.ok || !data.summary) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setSummaries((prev) => ({ ...prev, [article.id]: data.summary! }));
    } catch (err) {
      setSummaryError(err instanceof Error ? err.message : "Summarize failed");
    } finally {
      setSummarizing(null);
    }
  }

  const refreshingAll = Object.values(feedStates).some(
    (s) => s.status === "loading",
  );

  return (
    <div className="flex h-[100dvh] w-full">
      <aside className="hidden md:flex w-64 shrink-0 flex-col border-r border-border bg-muted/40">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <h1 className="font-semibold tracking-tight">People&apos;s RSS</h1>
          <button
            aria-label="Settings"
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
        <div className="px-4 py-2 flex items-center gap-2">
          <button
            onClick={() => {
              for (const f of feeds) void refreshFeed(f);
            }}
            disabled={refreshingAll || feeds.length === 0}
            className="text-xs rounded border border-border px-2 py-1 disabled:opacity-50 hover:bg-background"
          >
            {refreshingAll ? "Refreshing…" : "Refresh all"}
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto px-2 pb-4">
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
            <span>All articles</span>
            {unreadCounts.__all > 0 && (
              <span className="text-xs opacity-70">{unreadCounts.__all}</span>
            )}
          </button>
          <div className="mt-2 space-y-0.5">
            {feeds.map((f) => {
              const s = feedStates[f.id];
              return (
                <button
                  key={f.id}
                  onClick={() => {
                    setSelectedFeedId(f.id);
                    setSelectedArticleId(null);
                  }}
                  className={`w-full text-left rounded px-3 py-1.5 text-sm flex items-center justify-between gap-2 ${
                    selectedFeedId === f.id
                      ? "bg-background font-medium"
                      : "hover:bg-background/60"
                  }`}
                >
                  <span className="truncate">{f.title}</span>
                  <span className="text-xs opacity-70 shrink-0">
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
          {feeds.length === 0 && hydrated && (
            <p className="text-xs opacity-60 px-3 mt-4">
              No feeds yet. Open settings to add one.
            </p>
          )}
        </nav>
      </aside>

      <section className="w-full md:w-96 shrink-0 border-r border-border flex flex-col">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-2">
          <div className="md:hidden">
            <button
              aria-label="Settings"
              onClick={() => setSettingsOpen(true)}
              className="text-sm rounded px-2 py-1 hover:bg-muted"
            >
              ⚙
            </button>
          </div>
          <h2 className="text-sm font-semibold truncate">
            {selectedFeedId === "all"
              ? "All articles"
              : feeds.find((f) => f.id === selectedFeedId)?.title ?? "Articles"}
          </h2>
          <button
            onClick={markAllRead}
            disabled={visibleArticles.length === 0}
            className="text-xs rounded border border-border px-2 py-1 disabled:opacity-50 hover:bg-muted"
          >
            Mark all read
          </button>
        </div>
        <ol className="flex-1 overflow-y-auto divide-y divide-border">
          {visibleArticles.length === 0 ? (
            <li className="p-4 text-sm opacity-60">
              {feeds.length === 0
                ? "Add a feed in settings to get started."
                : refreshingAll
                  ? "Loading…"
                  : "No articles."}
            </li>
          ) : (
            visibleArticles.map((a) => {
              const isRead = readSet.has(a.id);
              const isSelected = selectedArticleId === a.id;
              return (
                <li key={a.id}>
                  <button
                    onClick={() => selectArticle(a.id)}
                    className={`w-full text-left p-3 ${
                      isSelected
                        ? "bg-muted"
                        : "hover:bg-muted/60"
                    }`}
                  >
                    <div className="flex items-center gap-2 text-xs opacity-70 mb-1">
                      {!isRead && (
                        <span
                          className="inline-block w-1.5 h-1.5 rounded-full bg-accent shrink-0"
                          aria-label="unread"
                        />
                      )}
                      <span className="truncate">{a.feedTitle}</span>
                      {a.publishedAt && (
                        <span className="ml-auto shrink-0">
                          {formatDate(a.publishedAt)}
                        </span>
                      )}
                    </div>
                    <h3
                      className={`text-sm leading-snug ${isRead ? "opacity-70" : "font-medium"}`}
                    >
                      {a.title}
                    </h3>
                    {a.contentText && (
                      <p className="text-xs opacity-60 mt-1 line-clamp-2">
                        {a.contentText}
                      </p>
                    )}
                  </button>
                </li>
              );
            })
          )}
        </ol>
      </section>

      <main className="hidden md:flex flex-1 flex-col overflow-hidden">
        {selectedArticle ? (
          <article className="flex-1 overflow-y-auto">
            <header className="px-8 pt-8 pb-4 border-b border-border">
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
                    <span>{formatDate(selectedArticle.publishedAt)}</span>
                  </>
                )}
              </div>
              <h1 className="text-2xl font-semibold leading-tight tracking-tight">
                {selectedArticle.title}
              </h1>
              <div className="mt-3 flex items-center gap-2">
                <a
                  href={selectedArticle.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm rounded border border-border px-3 py-1 hover:bg-muted"
                >
                  Open original ↗
                </a>
                <button
                  onClick={() => handleSummarize(selectedArticle)}
                  disabled={summarizing === selectedArticle.id}
                  className="text-sm rounded bg-accent px-3 py-1 text-white disabled:opacity-50"
                >
                  {summarizing === selectedArticle.id
                    ? "Summarizing…"
                    : summaries[selectedArticle.id]
                      ? "Re-summarize"
                      : "✨ AI summarize"}
                </button>
              </div>
              {summaryError && (
                <p className="text-sm text-red-500 mt-2">{summaryError}</p>
              )}
              {summaries[selectedArticle.id] && (
                <div className="mt-4 rounded border border-border bg-muted/50 p-4">
                  <div className="text-xs font-semibold uppercase tracking-wide opacity-70 mb-2">
                    Summary
                  </div>
                  <div className="text-sm whitespace-pre-wrap leading-relaxed">
                    {summaries[selectedArticle.id]}
                  </div>
                </div>
              )}
            </header>
            <div className="px-8 py-6 max-w-2xl prose-content">
              {selectedArticle.contentHtml ? (
                <div
                  dangerouslySetInnerHTML={{
                    __html: selectedArticle.contentHtml,
                  }}
                />
              ) : (
                <p className="opacity-60 text-sm">
                  No content provided in the feed.{" "}
                  <a
                    href={selectedArticle.link}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Read on the source site.
                  </a>
                </p>
              )}
            </div>
          </article>
        ) : (
          <div className="flex-1 grid place-items-center text-sm opacity-60">
            Select an article to read.
          </div>
        )}
      </main>

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        feeds={feeds}
        onAddFeed={handleAddFeed}
        onRemoveFeed={handleRemoveFeed}
        onRenameFeed={handleRenameFeed}
        aiConfig={aiConfig}
        onSaveAI={handleSaveAI}
      />

      {selectedArticle && (
        <MobileReader
          article={selectedArticle}
          onClose={() => setSelectedArticleId(null)}
          summary={summaries[selectedArticle.id]}
          summarizing={summarizing === selectedArticle.id}
          summaryError={summaryError}
          onSummarize={() => handleSummarize(selectedArticle)}
        />
      )}
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
              {user?.name || "Signed in"}
            </div>
            <div className="text-[10px] opacity-60 truncate">
              {syncLabel(syncStatus)}
            </div>
          </div>
          <button
            onClick={() => signOut()}
            className="text-xs rounded px-2 py-1 hover:bg-background"
            title="Sign out"
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
          Sign in with GitHub to sync
        </button>
      )}
    </div>
  );
}

function syncLabel(s: SyncStatus): string {
  switch (s.state) {
    case "off":
      return "Local only";
    case "pulling":
      return "Pulling…";
    case "syncing":
      return "Syncing…";
    case "idle":
      return s.updatedAt
        ? `Synced ${formatRelative(s.updatedAt)}`
        : "Synced";
    case "error":
      return `Sync error: ${s.error}`;
  }
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
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
}: {
  article: Article;
  onClose: () => void;
  summary?: string;
  summarizing: boolean;
  summaryError: string | null;
  onSummarize: () => void;
}) {
  return (
    <div className="md:hidden fixed inset-0 z-40 bg-background flex flex-col">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border">
        <button
          onClick={onClose}
          className="text-sm rounded px-2 py-1 hover:bg-muted"
          aria-label="Back"
        >
          ← Back
        </button>
        <a
          href={article.link}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto text-xs rounded border border-border px-2 py-1"
        >
          Open ↗
        </a>
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
              <span>{formatDate(article.publishedAt)}</span>
            </>
          )}
        </div>
        {summaryError && (
          <p className="text-sm text-red-500 mb-3">{summaryError}</p>
        )}
        {summary && (
          <div className="mb-4 rounded border border-border bg-muted/50 p-3">
            <div className="text-xs font-semibold uppercase tracking-wide opacity-70 mb-1">
              Summary
            </div>
            <div className="text-sm whitespace-pre-wrap leading-relaxed">
              {summary}
            </div>
          </div>
        )}
        <div className="prose-content">
          {article.contentHtml ? (
            <div dangerouslySetInnerHTML={{ __html: article.contentHtml }} />
          ) : (
            <p className="opacity-60 text-sm">No content provided.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  const now = Date.now();
  const diff = now - ts;
  const day = 24 * 60 * 60 * 1000;
  if (diff < day) {
    return d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  if (diff < 7 * day) {
    return d.toLocaleDateString(undefined, { weekday: "short" });
  }
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: d.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
  });
}

function stableId(feedId: string, key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = (h * 31 + key.charCodeAt(i)) | 0;
  }
  return `${feedId}:${(h >>> 0).toString(36)}`;
}
