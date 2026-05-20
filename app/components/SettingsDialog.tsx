"use client";

import { useState } from "react";
import type { AIConfig, AIStyle, Feed } from "@/app/lib/types";
import { defaultEndpoint, defaultModel, detectStyle } from "@/app/lib/aiProviders";

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

  const [style, setStyle] = useState<AIStyle>(
    aiConfig?.style ?? "openai",
  );
  const [endpoint, setEndpoint] = useState(
    aiConfig?.endpoint ?? defaultEndpoint(aiConfig?.style ?? "openai"),
  );
  const [apiKey, setApiKey] = useState(aiConfig?.apiKey ?? "");
  const [model, setModel] = useState(
    aiConfig?.model ?? defaultModel(aiConfig?.style ?? "openai"),
  );
  const [models, setModels] = useState<{ id: string; label?: string }[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [aiSaved, setAiSaved] = useState(false);

  function handleStyleChange(next: AIStyle) {
    setStyle(next);
    setModels([]);
    setModelsError(null);
    // Switch defaults if user hasn't customized
    if (endpoint === defaultEndpoint(style)) setEndpoint(defaultEndpoint(next));
    if (model === defaultModel(style)) setModel(defaultModel(next));
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
    if (!endpoint.trim() || !apiKey.trim() || !model.trim()) {
      onSaveAI(null);
    } else {
      onSaveAI({
        endpoint: endpoint.trim(),
        apiKey: apiKey.trim(),
        model: model.trim(),
        style,
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
                    className="flex-1 rounded border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent/60"
                  >
                    {!models.find((m) => m.id === model) && model && (
                      <option value={model}>{model}</option>
                    )}
                    {models.length === 0 && !model && (
                      <option value="">Fetch models to pick one…</option>
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
                  className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white"
                >
                  Save
                </button>
                {aiConfig && (
                  <button
                    onClick={() => {
                      onSaveAI(null);
                      setStyle("openai");
                      setEndpoint(defaultEndpoint("openai"));
                      setApiKey("");
                      setModel(defaultModel("openai"));
                      setModels([]);
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
