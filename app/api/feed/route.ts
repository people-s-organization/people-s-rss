import { NextResponse } from "next/server";
import { parseFeedXml } from "@/app/lib/rss";
import { normalizeArticleHtml } from "@/app/lib/articleHtml";
import { assertPublicHttpUrl, safeFetch, SSRFError } from "@/app/lib/ssrfGuard";
import { rateLimit, rateLimitedResponse } from "@/app/lib/rateLimit";
import { normalizeHttpUrl, normalizeMaybeEncodedHttpUrl } from "@/app/lib/url";
import { auth } from "@/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

function callerIdentity(request: Request, githubId?: string): string {
  if (githubId) return `u:${githubId}`;
  const fwd = request.headers.get("x-forwarded-for") ?? "";
  const ip = fwd.split(",")[0].trim() || "anon";
  return `ip:${ip}`;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get("url");
  if (!url) {
    return NextResponse.json({ error: "Missing url" }, { status: 400 });
  }

  const session = await auth().catch(() => null);
  const identity = callerIdentity(request, session?.user?.githubId);
  const rl = await rateLimit("feed", identity, 60, 60);
  if (!rl.ok) return rateLimitedResponse(rl);

  const normalizedUrl = normalizeMaybeEncodedHttpUrl(url);
  if (!normalizedUrl) {
    return NextResponse.json({ error: "Invalid url" }, { status: 400 });
  }

  let target: URL;
  try {
    target = await assertPublicHttpUrl(normalizedUrl);
  } catch (err) {
    if (err instanceof SSRFError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "Invalid url" }, { status: 400 });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await safeFetch(target.toString(), {
      headers: {
        "User-Agent": "PeoplesRSS/1.0 (+https://rss.baomi.app)",
        Accept:
          "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: `Upstream ${res.status}` },
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
      item.link = normalizeHttpUrl(item.link, target.toString()) ?? "";
      if (item.contentHtml) {
        try {
          item.contentHtml = normalizeArticleHtml(
            item.contentHtml,
            item.link || target.toString(),
          );
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
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    clearTimeout(timer);
  }
}
