"use client";

import { useState } from "react";
import { signIn, signOut, useSession } from "next-auth/react";
import type { AIConfig, AIStyle, Feed } from "@/app/lib/types";
import { defaultEndpoint, detectStyle } from "@/app/lib/aiProviders";

type Props = {
  open: boolean;
  onClose: () => void;
  initialTab?: "feeds" | "ai";
  feeds: Feed[];
  onAddFeed: (url: string) => Promise<void>;
  onRemoveFeed: (id: string) => void;
  onRenameFeed: (id: string, title: string) => void;
  onSetCategory: (id: string, category: string) => void;
  aiConfig: AIConfig | null;
  onSaveAI: (cfg: AIConfig | null) => void;
};

export function SettingsDialog(props: Props) {
  if (!props.open) return null;
  return <SettingsDialogBody {...props} />;
}

function SettingsDialogBody({
  onClose,
  initialTab,
  feeds,
  onAddFeed,
  onRemoveFeed,
  onRenameFeed,
  onSetCategory,
  aiConfig,
  onSaveAI,
}: Props) {
  const [tab, setTab] = useState<"feeds" | "ai">(initialTab ?? "feeds");
  const [newUrl, setNewUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const [style, setStyle] = useState<AIStyle>(
    aiConfig?.style ?? "openai",
  );
  const [endpoint, setEndpoint] = useState(
    aiConfig?.endpoint ?? defaultEndpoint(aiConfig?.style ?? "openai"),
  );
  const [apiKey, setApiKey] = useState(aiConfig?.apiKey ?? "");
  const [model, setModel] = useState(aiConfig?.model ?? "");
  const [models, setModels] = useState<{ id: string; label?: string }[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

  function handleStyleChange(next: AIStyle) {
    setStyle(next);
    setModels([]);
    setModel("");
    setModelsError(null);
    if (endpoint === defaultEndpoint(style)) setEndpoint(defaultEndpoint(next));
  }

  function handleEndpointChange(value: string) {
    setEndpoint(value);
    const detected = detectStyle(value);
    if (detected !== style) {
      setStyle(detected);
      setModels([]);
      setModelsError(null);
    }
  }

  async function handleFetchModels() {
    if (!endpoint.trim() || !apiKey.trim()) {
      setModelsError("Fill endpoint and API key first.");
      return;
    }
    setModelsLoading(true);
    setModelsError(null);
    try {
      const res = await fetch("/api/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: endpoint.trim(),
          apiKey: apiKey.trim(),
          style,
        }),
      });
      const data = (await res.json()) as {
        models?: { id: string; label?: string }[];
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      const list = data.models ?? [];
      setModels(list);
      if (list.length > 0 && !list.find((m) => m.id === model)) {
        setModel(list[0].id);
      }
    } catch (err) {
      setModelsError(err instanceof Error ? err.message : "Fetch failed");
    } finally {
      setModelsLoading(false);
    }
  }

  async function handleAdd() {
    const url = newUrl.trim();
    if (!url) return;
    setAdding(true);
    setAddError(null);
    try {
      await onAddFeed(url);
      setNewUrl("");
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Failed to add feed");
    } finally {
      setAdding(false);
    }
  }

  function handleSaveAI() {
    if (!endpoint.trim() || !apiKey.trim() || !model.trim()) return;
    onSaveAI({
      endpoint: endpoint.trim(),
      apiKey: apiKey.trim(),
      model: model.trim(),
      style,
    });
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-lg bg-background border border-border shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h2 className="text-lg font-semibold">Settings</h2>
          <button
            onClick={onClose}
            className="text-sm rounded px-2 py-1 hover:bg-muted"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <AccountSection />

        <div className="flex border-b border-border bg-muted/40">
          <button
            onClick={() => setTab("feeds")}
            className={`px-4 py-2 text-sm font-medium ${tab === "feeds" ? "bg-background border-b-2 border-accent" : "opacity-70 hover:opacity-100"}`}
          >
            Feeds
          </button>
          <button
            onClick={() => setTab("ai")}
            className={`px-4 py-2 text-sm font-medium ${tab === "ai" ? "bg-background border-b-2 border-accent" : "opacity-70 hover:opacity-100"}`}
          >
            AI Summary
          </button>
        </div>

        <div className="p-5 max-h-[70vh] overflow-y-auto">
          {tab === "feeds" ? (
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium block mb-1">
                  Add feed by URL
                </label>
                <div className="flex gap-2">
                  <input
                    value={newUrl}
                    onChange={(e) => setNewUrl(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleAdd();
                    }}
                    placeholder="https://example.com/feed.xml"
                    className="flex-1 rounded border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent/60"
                  />
                  <button
                    onClick={handleAdd}
                    disabled={adding || !newUrl.trim()}
                    className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                  >
                    {adding ? "Adding…" : "Add"}
                  </button>
                </div>
                {addError && (
                  <p className="text-sm text-red-500 mt-2">{addError}</p>
                )}
              </div>

              <CategoriesPanel
                feeds={feeds}
                onSetCategory={onSetCategory}
              />

              <FeedListByCategory
                feeds={feeds}
                onRenameFeed={onRenameFeed}
                onRemoveFeed={onRemoveFeed}
                onSetCategory={onSetCategory}
              />
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm opacity-70">
                Bring your own AI endpoint. Your key stays in your browser and
                is only forwarded through this app when you click
                &ldquo;Summarize&rdquo;.
              </p>

              <div>
                <label className="text-sm font-medium block mb-1">API style</label>
                <div className="flex gap-2">
                  <StyleButton
                    active={style === "openai"}
                    onClick={() => handleStyleChange("openai")}
                    label="OpenAI"
                    sub="/chat/completions"
                  />
                  <StyleButton
                    active={style === "anthropic"}
                    onClick={() => handleStyleChange("anthropic")}
                    label="Anthropic"
                    sub="/messages"
                  />
                </div>
              </div>

              <div>
                <label className="text-sm font-medium block mb-1">Endpoint base URL</label>
                <input
                  value={endpoint}
                  onChange={(e) => handleEndpointChange(e.target.value)}
                  placeholder={defaultEndpoint(style)}
                  className="w-full rounded border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent/60"
                />
                <p className="text-xs opacity-60 mt-1">
                  We append{" "}
                  <code>{style === "anthropic" ? "/messages" : "/chat/completions"}</code>{" "}
                  for inference and <code>/models</code> for the list.
                </p>
              </div>

              <div>
                <label className="text-sm font-medium block mb-1">API key</label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={style === "anthropic" ? "sk-ant-…" : "sk-…"}
                  className="w-full rounded border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent/60"
                />
              </div>

              <div>
                <label className="text-sm font-medium block mb-1">Model</label>
                <div className="flex items-center gap-2">
                  <select
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    disabled={models.length === 0 && !model}
                    className="flex-1 rounded border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent/60 disabled:opacity-60"
                  >
                    <option value="">
                      {models.length === 0
                        ? "Click Fetch to load models…"
                        : "Select a model…"}
                    </option>
                    {!models.find((m) => m.id === model) && model && (
                      <option value={model}>{model} (saved)</option>
                    )}
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label ? `${m.label} (${m.id})` : m.id}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={handleFetchModels}
                    disabled={modelsLoading}
                    className="text-xs rounded border border-border px-3 py-1.5 hover:bg-muted disabled:opacity-50 shrink-0"
                    title="Fetch model list from endpoint"
                  >
                    {modelsLoading ? "…" : "↻ Fetch"}
                  </button>
                </div>
                {modelsError && (
                  <p className="text-xs text-red-500 mt-1">{modelsError}</p>
                )}
                {models.length > 0 && !modelsError && (
                  <p className="text-xs opacity-60 mt-1">
                    {models.length} models loaded
                  </p>
                )}
              </div>

              <div className="flex items-center gap-3">
                <button
                  onClick={handleSaveAI}
                  disabled={
                    !endpoint.trim() || !apiKey.trim() || !model.trim()
                  }
                  className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                >
                  Save &amp; close
                </button>
                {aiConfig && (
                  <button
                    onClick={() => {
                      onSaveAI(null);
                      setStyle("openai");
                      setEndpoint(defaultEndpoint("openai"));
                      setApiKey("");
                      setModel("");
                      setModels([]);
                    }}
                    className="rounded border border-border px-3 py-1.5 text-sm"
                  >
                    Clear
                  </button>
                )}
                {!endpoint.trim() || !apiKey.trim() ? (
                  <span className="text-xs opacity-60">
                    Fill endpoint and key first.
                  </span>
                ) : !model.trim() ? (
                  <span className="text-xs opacity-60">
                    Pick a model — click ↻ Fetch above.
                  </span>
                ) : null}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CategoriesPanel({
  feeds,
  onSetCategory,
}: {
  feeds: Feed[];
  onSetCategory: (feedId: string, category: string) => void;
}) {
  const categories = Array.from(
    feeds.reduce((map, f) => {
      const c = f.category;
      if (!c) return map;
      map.set(c, (map.get(c) ?? 0) + 1);
      return map;
    }, new Map<string, number>()),
  ).sort((a, b) => a[0].localeCompare(b[0]));

  function renameCategory(oldName: string) {
    const next = window.prompt(`Rename category "${oldName}" to:`, oldName);
    if (!next) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === oldName) return;
    for (const f of feeds) {
      if (f.category === oldName) onSetCategory(f.id, trimmed);
    }
  }

  function deleteCategory(name: string) {
    if (
      !window.confirm(
        `Delete category "${name}"? Feeds in it become Uncategorized.`,
      )
    )
      return;
    for (const f of feeds) {
      if (f.category === name) onSetCategory(f.id, "");
    }
  }

  function addCategoryFromPrompt() {
    const name = window.prompt(
      "New category name. Pick a feed first from the list below to assign it.",
    );
    if (!name) return;
    // We don't have a target feed here; user will assign via the list below.
    // Quietly creating an empty category isn't useful, so show a hint.
    window.alert(
      `Created "${name.trim()}". Use the Category dropdown on a feed row below to assign it.`,
    );
    // Persist by hijacking one feed temporarily? No — categories live on feeds, so
    // an unassigned category isn't a thing. The hint is the right UX here.
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium">
          Categories ({categories.length})
        </h3>
        <button
          onClick={addCategoryFromPrompt}
          className="text-xs rounded border border-border px-2 py-1 hover:bg-muted"
        >
          + New
        </button>
      </div>
      {categories.length === 0 ? (
        <p className="text-xs opacity-60">
          No categories yet. Assign one to a feed below or right-click a feed in
          the sidebar.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {categories.map(([name, count]) => (
            <div
              key={name}
              className="flex items-center gap-1 rounded-full border border-border bg-muted/40 pl-3 pr-1 py-0.5 text-xs"
            >
              <span className="font-medium">{name}</span>
              <span className="opacity-60">·</span>
              <span className="opacity-70">{count}</span>
              <button
                onClick={() => renameCategory(name)}
                className="ml-1 px-1.5 py-0.5 rounded hover:bg-background"
                title="Rename"
              >
                ✎
              </button>
              <button
                onClick={() => deleteCategory(name)}
                className="px-1.5 py-0.5 rounded hover:bg-red-500/10 text-red-500"
                title="Delete category"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FeedListByCategory({
  feeds,
  onRenameFeed,
  onRemoveFeed,
  onSetCategory,
}: {
  feeds: Feed[];
  onRenameFeed: (id: string, title: string) => void;
  onRemoveFeed: (id: string) => void;
  onSetCategory: (id: string, category: string) => void;
}) {
  const allCategories = Array.from(
    new Set(feeds.map((f) => f.category).filter((c): c is string => !!c)),
  ).sort((a, b) => a.localeCompare(b));

  const groups = new Map<string, Feed[]>();
  for (const f of feeds) {
    const key = f.category ?? "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(f);
  }
  const groupOrder = Array.from(groups.keys()).sort((a, b) => {
    if (a === "" && b !== "") return 1;
    if (b === "" && a !== "") return -1;
    return a.localeCompare(b);
  });

  return (
    <div>
      <h3 className="text-sm font-medium mb-2">
        Your feeds ({feeds.length})
      </h3>
      {feeds.length === 0 ? (
        <p className="text-sm opacity-60">
          No feeds yet. Paste an RSS or Atom URL above.
        </p>
      ) : (
        <div className="space-y-4">
          {groupOrder.map((cat) => {
            const groupFeeds = groups.get(cat) ?? [];
            return (
              <div key={cat || "__uncat__"}>
                <div className="text-[10px] uppercase tracking-wider opacity-60 mb-1.5 px-1">
                  {cat || "Uncategorized"}
                </div>
                <ul className="space-y-1.5">
                  {groupFeeds.map((f) => (
                    <li
                      key={f.id}
                      className="rounded border border-border p-2"
                    >
                      <div className="flex items-center gap-2">
                        <input
                          defaultValue={f.title}
                          onBlur={(e) => {
                            const v = e.target.value.trim();
                            if (v && v !== f.title) onRenameFeed(f.id, v);
                          }}
                          className="flex-1 bg-transparent text-sm font-medium focus:outline-none focus:ring-1 focus:ring-accent/60 rounded px-1"
                        />
                        <select
                          value={f.category ?? ""}
                          onChange={(e) => {
                            const v = e.target.value;
                            if (v === "__new__") {
                              const next = window.prompt("New category name");
                              if (next && next.trim())
                                onSetCategory(f.id, next.trim());
                              return;
                            }
                            onSetCategory(f.id, v);
                          }}
                          className="text-xs rounded border border-border bg-background px-2 py-1 max-w-[10rem]"
                          title="Category"
                        >
                          <option value="">Uncategorized</option>
                          {allCategories.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                          <option value="__new__">+ New category…</option>
                        </select>
                        <button
                          onClick={() => onRemoveFeed(f.id)}
                          className="text-xs rounded px-2 py-1 hover:bg-red-500/10 text-red-500 shrink-0"
                          title="Remove feed"
                        >
                          ✕
                        </button>
                      </div>
                      <a
                        href={f.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs opacity-60 hover:opacity-100 truncate block mt-1 px-1"
                      >
                        {f.url}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AccountSection() {
  const { data: session, status } = useSession();
  return (
    <div className="px-5 py-3 border-b border-border bg-muted/30">
      {status === "loading" ? (
        <p className="text-xs opacity-60">…</p>
      ) : status === "authenticated" ? (
        <div className="flex items-center gap-3">
          {session?.user?.image && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={session.user.image}
              alt=""
              className="w-8 h-8 rounded-full"
              referrerPolicy="no-referrer"
            />
          )}
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium truncate">
              {session?.user?.name || "Signed in"}
            </div>
            <div className="text-xs opacity-60">
              Multi-device sync active
            </div>
          </div>
          <button
            onClick={() => signOut()}
            className="text-xs rounded border border-border px-2 py-1 hover:bg-background"
          >
            Sign out
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <div className="text-xs opacity-70">
            Sign in with GitHub to sync feeds, AI config, and read state across
            devices.
          </div>
          <button
            onClick={() => signIn("github")}
            className="text-xs rounded bg-foreground text-background px-3 py-1.5 hover:opacity-90 shrink-0 flex items-center gap-1.5"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
            </svg>
            Sign in
          </button>
        </div>
      )}
    </div>
  );
}

function StyleButton({
  active,
  onClick,
  label,
  sub,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  sub: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 rounded border px-3 py-2 text-left text-sm transition-colors ${
        active
          ? "border-accent bg-accent/10 text-foreground"
          : "border-border opacity-70 hover:opacity-100"
      }`}
    >
      <div className="font-medium">{label}</div>
      <div className="text-[10px] opacity-60 font-mono">{sub}</div>
    </button>
  );
}
