"use client";

import { useState } from "react";
import type { AIConfig, Feed } from "@/app/lib/types";

type Props = {
  open: boolean;
  onClose: () => void;
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
  feeds,
  onAddFeed,
  onRemoveFeed,
  onRenameFeed,
  onSetCategory,
  aiConfig,
  onSaveAI,
}: Props) {
  const [tab, setTab] = useState<"feeds" | "ai">("feeds");
  const [newUrl, setNewUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const [endpoint, setEndpoint] = useState(aiConfig?.endpoint ?? "https://api.openai.com/v1");
  const [apiKey, setApiKey] = useState(aiConfig?.apiKey ?? "");
  const [model, setModel] = useState(aiConfig?.model ?? "gpt-4o-mini");
  const [aiSaved, setAiSaved] = useState(false);

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
    if (!endpoint.trim() || !apiKey.trim() || !model.trim()) {
      onSaveAI(null);
    } else {
      onSaveAI({
        endpoint: endpoint.trim(),
        apiKey: apiKey.trim(),
        model: model.trim(),
      });
    }
    setAiSaved(true);
    setTimeout(() => setAiSaved(false), 1500);
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

              <div>
                <h3 className="text-sm font-medium mb-2">
                  Your feeds ({feeds.length})
                </h3>
                {feeds.length === 0 ? (
                  <p className="text-sm opacity-60">
                    No feeds yet. Paste an RSS or Atom URL above.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {feeds.map((f) => {
                      const datalistId = `prss-cats-${f.id}`;
                      return (
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
                            <button
                              onClick={() => onRemoveFeed(f.id)}
                              className="text-xs rounded px-2 py-1 hover:bg-red-500/10 text-red-500 shrink-0"
                            >
                              Remove
                            </button>
                          </div>
                          <div className="flex items-center gap-2 mt-1.5">
                            <input
                              defaultValue={f.category ?? ""}
                              placeholder="Category (e.g. Tech, News)"
                              list={datalistId}
                              onBlur={(e) => {
                                const v = e.target.value.trim();
                                if (v !== (f.category ?? "")) onSetCategory(f.id, v);
                              }}
                              className="w-40 shrink-0 bg-transparent text-xs rounded border border-border px-2 py-1 focus:outline-none focus:ring-1 focus:ring-accent/60"
                            />
                            <datalist id={datalistId}>
                              {Array.from(
                                new Set(
                                  feeds
                                    .map((x) => x.category)
                                    .filter((c): c is string => !!c),
                                ),
                              ).map((c) => (
                                <option key={c} value={c} />
                              ))}
                            </datalist>
                            <a
                              href={f.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs opacity-60 hover:opacity-100 truncate flex-1"
                            >
                              {f.url}
                            </a>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm opacity-70">
                Configure your own OpenAI-compatible endpoint. Your key is
                stored locally in your browser and forwarded through this app
                only when you click &ldquo;Summarize&rdquo;.
              </p>

              <div>
                <label className="text-sm font-medium block mb-1">Endpoint base URL</label>
                <input
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  placeholder="https://api.openai.com/v1"
                  className="w-full rounded border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent/60"
                />
                <p className="text-xs opacity-60 mt-1">
                  We append <code>/chat/completions</code> automatically.
                </p>
              </div>

              <div>
                <label className="text-sm font-medium block mb-1">API key</label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-…"
                  className="w-full rounded border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent/60"
                />
              </div>

              <div>
                <label className="text-sm font-medium block mb-1">Model</label>
                <input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="gpt-4o-mini"
                  className="w-full rounded border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent/60"
                />
              </div>

              <div className="flex items-center gap-3">
                <button
                  onClick={handleSaveAI}
                  className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white"
                >
                  Save
                </button>
                {aiConfig && (
                  <button
                    onClick={() => {
                      onSaveAI(null);
                      setEndpoint("https://api.openai.com/v1");
                      setApiKey("");
                      setModel("gpt-4o-mini");
                    }}
                    className="rounded border border-border px-3 py-1.5 text-sm"
                  >
                    Clear
                  </button>
                )}
                {aiSaved && (
                  <span className="text-sm text-green-600">Saved</span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
