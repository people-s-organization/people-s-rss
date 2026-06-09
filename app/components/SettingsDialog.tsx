"use client";

import { useState } from "react";
import { signIn, signOut, useSession } from "next-auth/react";
import { useTranslations, useLocale } from "next-intl";
import { useRouter, usePathname } from "next/navigation";
import type { AIConfig, AIStyle, Feed, SummaryLanguage } from "@/app/lib/types";
import { defaultEndpoint, detectStyle } from "@/app/lib/aiProviders";
import { normalizeHttpUrl } from "@/app/lib/url";

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
  hasAIKey: boolean;
  isSignedIn: boolean;
  onSaveAI: (cfg: AIConfig | null) => Promise<void>;
  onSetAIKey: (apiKey: string) => Promise<void>;
  onClearAIKey: () => Promise<void>;
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
  hasAIKey,
  isSignedIn,
  onSaveAI,
  onSetAIKey,
  onClearAIKey,
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
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [model, setModel] = useState(aiConfig?.model ?? "");
  const [summaryLanguage, setSummaryLanguage] = useState<SummaryLanguage>(
    aiConfig?.summaryLanguage ?? "ui",
  );
  const [models, setModels] = useState<{ id: string; label?: string }[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const keyAvailable = hasAIKey || apiKeyDraft.trim().length > 0;
  const t = useTranslations("Settings");
  const tReader = useTranslations("Reader");
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();

  function switchLocale(next: string) {
    if (next === locale) return;
    const stripped = pathname.replace(/^\/(zh|en)(?=\/|$)/, "") || "/";
    router.push(`/${next}${stripped === "/" ? "" : stripped}`);
  }

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
    if (!endpoint.trim()) {
      setModelsError(t("fillEndpointFirst"));
      return;
    }
    if (!keyAvailable) {
      setModelsError(t("enterApiKeyFirst"));
      return;
    }
    setModelsLoading(true);
    setModelsError(null);
    try {
      const draft = apiKeyDraft.trim();
      const res = await fetch("/api/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: endpoint.trim(),
          style,
          ...(draft ? { apiKey: draft } : {}),
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
      setModelsError(err instanceof Error ? err.message : t("saveFailedDefault"));
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
      setAddError(err instanceof Error ? err.message : tReader("loadFailed", { error: "" }));
    } finally {
      setAdding(false);
    }
  }

  async function handleSaveAI() {
    if (!endpoint.trim() || !model.trim()) return;
    if (!keyAvailable) {
      setSaveError(t("enterApiKeyFirst"));
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const draft = apiKeyDraft.trim();
      if (draft) {
        await onSetAIKey(draft);
      }
      await onSaveAI({
        endpoint: endpoint.trim(),
        model: model.trim(),
        style,
        summaryLanguage,
      });
      setApiKeyDraft("");
      onClose();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t("saveFailedDefault"));
    } finally {
      setSaving(false);
    }
  }

  async function handleClearAI() {
    setSaving(true);
    setSaveError(null);
    try {
      await onClearAIKey();
      await onSaveAI(null);
      setStyle("openai");
      setEndpoint(defaultEndpoint("openai"));
      setApiKeyDraft("");
      setModel("");
      setSummaryLanguage("ui");
      setModels([]);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t("clearFailedDefault"));
    } finally {
      setSaving(false);
    }
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
          <h2 className="text-lg font-semibold">{t("title")}</h2>
          <div className="flex items-center gap-2">
            <div className="flex items-center rounded border border-border overflow-hidden text-[11px]">
              <button
                onClick={() => switchLocale("zh")}
                className={`px-2 py-1 ${locale === "zh" ? "bg-foreground text-background" : "hover:bg-muted"}`}
                aria-label="中文"
              >
                中
              </button>
              <button
                onClick={() => switchLocale("en")}
                className={`px-2 py-1 ${locale === "en" ? "bg-foreground text-background" : "hover:bg-muted"}`}
                aria-label="English"
              >
                EN
              </button>
            </div>
            <button
              onClick={onClose}
              className="text-sm rounded px-2 py-1 hover:bg-muted"
              aria-label={t("close")}
            >
              ✕
            </button>
          </div>
        </div>

        <AccountSection />

        <div className="flex border-b border-border bg-muted/40">
          <button
            onClick={() => setTab("feeds")}
            className={`px-4 py-2 text-sm font-medium ${tab === "feeds" ? "bg-background border-b-2 border-accent" : "opacity-70 hover:opacity-100"}`}
          >
            {t("feeds")}
          </button>
          <button
            onClick={() => setTab("ai")}
            className={`px-4 py-2 text-sm font-medium ${tab === "ai" ? "bg-background border-b-2 border-accent" : "opacity-70 hover:opacity-100"}`}
          >
            {t("ai")}
          </button>
        </div>

        <div className="p-5 max-h-[70vh] overflow-y-auto">
          {tab === "feeds" ? (
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium block mb-1">
                  {t("addFeedLabel")}
                </label>
                <div className="flex gap-2">
                  <input
                    value={newUrl}
                    onChange={(e) => setNewUrl(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleAdd();
                    }}
                    placeholder={t("addFeedPlaceholder")}
                    className="flex-1 rounded border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent/60"
                  />
                  <button
                    onClick={handleAdd}
                    disabled={adding || !newUrl.trim()}
                    className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                  >
                    {adding ? t("adding") : t("add")}
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
          ) : !isSignedIn ? (
            <div className="space-y-3">
              <p className="text-sm opacity-80">{t("signInToConfigureAI")}</p>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm opacity-70">{t("aiHelpText")}</p>

              <div>
                <label className="text-sm font-medium block mb-1">{t("apiStyle")}</label>
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
                <label className="text-sm font-medium block mb-1">{t("endpointLabel")}</label>
                <input
                  value={endpoint}
                  onChange={(e) => handleEndpointChange(e.target.value)}
                  placeholder={defaultEndpoint(style)}
                  className="w-full rounded border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent/60"
                />
                <p className="text-xs opacity-60 mt-1">
                  {style === "anthropic" ? t("endpointHelpAnthropic") : t("endpointHelpOpenAI")}
                </p>
              </div>

              <div>
                <label className="text-sm font-medium block mb-1">
                  {t("apiKeyLabel")}
                  {hasAIKey && (
                    <span className="ml-2 text-xs opacity-70 font-normal">
                      {t("apiKeyStored")}
                    </span>
                  )}
                </label>
                <input
                  type="password"
                  value={apiKeyDraft}
                  onChange={(e) => setApiKeyDraft(e.target.value)}
                  placeholder={
                    hasAIKey
                      ? t("apiKeyPlaceholderStored")
                      : style === "anthropic"
                        ? "sk-ant-…"
                        : "sk-…"
                  }
                  autoComplete="off"
                  className="w-full rounded border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent/60"
                />
                <p className="text-xs opacity-60 mt-1">{t("apiKeyHelp")}</p>
              </div>

              <div>
                <label className="text-sm font-medium block mb-1">{t("model")}</label>
                <div className="flex items-center gap-2">
                  <select
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    disabled={models.length === 0 && !model}
                    className="flex-1 rounded border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent/60 disabled:opacity-60"
                  >
                    <option value="">
                      {models.length === 0 ? t("fetchToLoadModels") : t("selectModel")}
                    </option>
                    {!models.find((m) => m.id === model) && model && (
                      <option value={model}>{t("modelSaved", { id: model })}</option>
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
                    title={t("fetchModels")}
                  >
                    {modelsLoading ? "…" : t("fetchModels")}
                  </button>
                </div>
                {modelsError && (
                  <p className="text-xs text-red-500 mt-1">{modelsError}</p>
                )}
                {models.length > 0 && !modelsError && (
                  <p className="text-xs opacity-60 mt-1">
                    {t("modelsLoaded", { n: models.length })}
                  </p>
                )}
              </div>

              <div>
                <label className="text-sm font-medium block mb-1">
                  {t("summaryLanguageLabel")}
                </label>
                <select
                  value={summaryLanguage}
                  onChange={(e) =>
                    setSummaryLanguage(e.target.value as SummaryLanguage)
                  }
                  className="w-full rounded border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent/60"
                >
                  <option value="ui">{t("summaryLanguageUi")}</option>
                  <option value="zh">{t("summaryLanguageZh")}</option>
                  <option value="en">{t("summaryLanguageEn")}</option>
                  <option value="source">{t("summaryLanguageSource")}</option>
                </select>
                <p className="text-xs opacity-60 mt-1">
                  {t("summaryLanguageHelp")}
                </p>
              </div>

              <div className="flex items-center gap-3 flex-wrap">
                <button
                  onClick={handleSaveAI}
                  disabled={
                    saving ||
                    !endpoint.trim() ||
                    !model.trim() ||
                    !keyAvailable
                  }
                  className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                >
                  {saving ? t("saving") : t("saveAndClose")}
                </button>
                {(aiConfig || hasAIKey) && (
                  <button
                    onClick={handleClearAI}
                    disabled={saving}
                    className="rounded border border-border px-3 py-1.5 text-sm disabled:opacity-50"
                  >
                    {t("clear")}
                  </button>
                )}
                {saveError && (
                  <span className="text-xs text-red-500">{saveError}</span>
                )}
                {!saveError && !endpoint.trim() ? (
                  <span className="text-xs opacity-60">{t("fillEndpointFirst")}</span>
                ) : !saveError && !keyAvailable ? (
                  <span className="text-xs opacity-60">{t("enterApiKeyFirst")}</span>
                ) : !saveError && !model.trim() ? (
                  <span className="text-xs opacity-60">{t("pickAModel")}</span>
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
  const t = useTranslations("Settings");
  const categories = Array.from(
    feeds.reduce((map, f) => {
      const c = f.category;
      if (!c) return map;
      map.set(c, (map.get(c) ?? 0) + 1);
      return map;
    }, new Map<string, number>()),
  ).sort((a, b) => a[0].localeCompare(b[0]));

  function renameCategory(oldName: string) {
    const next = window.prompt(t("renameCategoryPrompt", { name: oldName }), oldName);
    if (!next) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === oldName) return;
    for (const f of feeds) {
      if (f.category === oldName) onSetCategory(f.id, trimmed);
    }
  }

  function deleteCategory(name: string) {
    if (!window.confirm(t("deleteCategoryConfirm", { name }))) return;
    for (const f of feeds) {
      if (f.category === name) onSetCategory(f.id, "");
    }
  }

  function addCategoryFromPrompt() {
    const name = window.prompt(t("newCategoryPrompt"));
    if (!name) return;
    window.alert(t("createdHint", { name: name.trim() }));
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium">
          {t("categoriesHeading", { n: categories.length })}
        </h3>
        <button
          onClick={addCategoryFromPrompt}
          className="text-xs rounded border border-border px-2 py-1 hover:bg-muted"
        >
          {t("addCategoryButton")}
        </button>
      </div>
      {categories.length === 0 ? (
        <p className="text-xs opacity-60">{t("noCategories")}</p>
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
                title={t("renameTitle")}
              >
                ✎
              </button>
              <button
                onClick={() => deleteCategory(name)}
                className="px-1.5 py-0.5 rounded hover:bg-red-500/10 text-red-500"
                title={t("deleteCategoryTitle")}
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
  const t = useTranslations("Settings");

  return (
    <div>
      <h3 className="text-sm font-medium mb-2">
        {t("yourFeedsHeading", { n: feeds.length })}
      </h3>
      {feeds.length === 0 ? (
        <p className="text-sm opacity-60">{t("noFeedsYet")}</p>
      ) : (
        <div className="space-y-4">
          {groupOrder.map((cat) => {
            const groupFeeds = groups.get(cat) ?? [];
            return (
              <div key={cat || "__uncat__"}>
                <div className="text-[10px] uppercase tracking-wider opacity-60 mb-1.5 px-1">
                  {cat || t("uncategorized")}
                </div>
                <ul className="space-y-1.5">
                  {groupFeeds.map((f) => {
                    const feedUrl = normalizeHttpUrl(f.url);
                    return (
                      <li key={f.id} className="rounded border border-border p-2">
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
                                const next = window.prompt(t("newCategoryInline"));
                                if (next && next.trim())
                                  onSetCategory(f.id, next.trim());
                                return;
                              }
                              onSetCategory(f.id, v);
                            }}
                            className="text-xs rounded border border-border bg-background px-2 py-1 max-w-[10rem]"
                            title={t("categoryDropdownTitle")}
                          >
                            <option value="">{t("uncategorized")}</option>
                            {allCategories.map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                            <option value="__new__">{t("newCategoryOption")}</option>
                          </select>
                          <button
                            onClick={() => onRemoveFeed(f.id)}
                            className="text-xs rounded px-2 py-1 hover:bg-red-500/10 text-red-500 shrink-0"
                            title={t("removeFeedTitle")}
                          >
                            ✕
                          </button>
                        </div>
                        {feedUrl ? (
                          <a
                            href={feedUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs opacity-60 hover:opacity-100 truncate block mt-1 px-1"
                          >
                            {f.url}
                          </a>
                        ) : (
                          <div className="text-xs opacity-60 truncate mt-1 px-1">
                            {f.url}
                          </div>
                        )}
                      </li>
                    );
                  })}
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
  const t = useTranslations("Settings");
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
              {session?.user?.name || t("signIn")}
            </div>
            <div className="text-xs opacity-60">{t("multiDeviceSyncActive")}</div>
          </div>
          <button
            onClick={() => signOut()}
            className="text-xs rounded border border-border px-2 py-1 hover:bg-background"
          >
            {t("signOut")}
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <div className="text-xs opacity-70">{t("signInSyncDesc")}</div>
          <button
            onClick={() => signIn("github")}
            className="text-xs rounded bg-foreground text-background px-3 py-1.5 hover:opacity-90 shrink-0 flex items-center gap-1.5"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
            </svg>
            {t("signIn")}
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
