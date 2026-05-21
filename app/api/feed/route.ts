import { NextResponse } from "next/server";
import { parseFeedXml } from "@/app/lib/rss";
import { normalizeArticleHtml } from "@/app/lib/articleHtml";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get("url");
  if (!url) {
    return NextResponse.json({ error: "Missing url" }, { status: 400 });
  }

  const normalizedUrl = normalizeTargetUrl(url);
  if (!normalizedUrl) {
    return NextResponse.json({ error: "Invalid url" }, { status: 400 });
  }

  let target: URL;
  try {
    target = new URL(normalizedUrl);
  } catch {
    return NextResponse.json({ error: "Invalid url" }, { status: 400 });
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return NextResponse.json({ error: "Unsupported protocol" }, { status: 400 });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(target.toString(), {
      headers: {
        "User-Agent": "PeoplesRSS/1.0 (+https://vercel.com)",
        Accept:
          "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5",
      },
      cache: "no-store",
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) {
      const preview = await safePreview(res);
      return NextResponse.json(
        {
          error: `Upstream ${res.status}`,
          stage: "upstream_non_ok",
          upstreamStatus: res.status,
          upstreamContentType: res.headers.get("content-type") ?? undefined,
          preview,
        },
        { status: 502 },
      );
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) {
      return NextResponse.json({ error: "Feed too large" }, { status: 413 });
    }
    const xml = new TextDecoder("utf-8").decode(buf);
    const feed = parseFeedXml(xml);
    for (const item of feed.items) {
      if (item.contentHtml) {
        try {
          item.contentHtml = normalizeArticleHtml(item.contentHtml, item.link);
        } catch {}
      }
    }
    return NextResponse.json(
      { feed },
      {
        headers: {
          "Cache-Control":
            "public, s-maxage=300, stale-while-revalidate=600",
        },
      },
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to fetch feed";
    return NextResponse.json(
      { error: message, stage: "feed_exception" },
      { status: 500 },
    );
  } finally {
    clearTimeout(timer);
  }
}

async function safePreview(res: Response): Promise<string | undefined> {
  try {
    const text = await res.text();
    const preview = text.slice(0, 200).replace(/\s+/g, " ").trim();
    return preview || undefined;
  } catch {
    return undefined;
  }

function normalizeTargetUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;

  const candidates = [value];
  try {
    const decoded = decodeURIComponent(value);
    if (decoded !== value) candidates.push(decoded);
  } catch {}
  try {
    const decodedTwice = decodeURIComponent(candidates[candidates.length - 1]);
    if (decodedTwice !== candidates[candidates.length - 1]) candidates.push(decodedTwice);
  } catch {}

  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return parsed.toString();
      }
    } catch {}
  }
  return null;
}
