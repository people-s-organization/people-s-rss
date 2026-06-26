import { NextResponse } from "next/server";
import {
  assertPublicHttpUrl,
  safeFetch,
  type SafeFetchInit,
  SSRFError,
} from "@/app/lib/ssrfGuard";
import { rateLimit, rateLimitedResponse } from "@/app/lib/rateLimit";
import { auth } from "@/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FETCH_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_WIDTH = 1600;
const ABS_MAX_WIDTH = 2400;

const ALLOWED_TYPES = /^image\//;

type CloudflareImageInit = SafeFetchInit & {
  cf?: {
    image?: {
      fit?: "scale-down";
      format?: "avif" | "webp";
      quality?: number;
      width?: number;
    };
  };
};

function callerIdentity(request: Request, githubId?: string): string {
  if (githubId) return `u:${githubId}`;
  const fwd = request.headers.get("x-forwarded-for") ?? "";
  const ip = fwd.split(",")[0].trim() || "anon";
  return `ip:${ip}`;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const raw = searchParams.get("url");
  if (!raw) return new NextResponse("Missing url", { status: 400 });

  const session = await auth().catch(() => null);
  const identity = callerIdentity(request, session?.user?.githubId);
  const rl = await rateLimit("image", identity, 120, 60);
  if (!rl.ok) return rateLimitedResponse(rl);

  let target: URL;
  try {
    target = await assertPublicHttpUrl(raw);
  } catch (err) {
    if (err instanceof SSRFError) {
      return new NextResponse(err.message, { status: err.status });
    }
    return new NextResponse("Invalid url", { status: 400 });
  }

  const widthParam = parseInt(searchParams.get("w") ?? "", 10);
  const targetWidth = Math.min(
    ABS_MAX_WIDTH,
    Number.isFinite(widthParam) && widthParam > 0
      ? widthParam
      : DEFAULT_MAX_WIDTH,
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const fetchInit: CloudflareImageInit = {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        Referer: `${target.origin}/`,
      },
      signal: controller.signal,
      redirect: "follow",
      cf: {
        image: {
          fit: "scale-down",
          format: request.headers.get("accept")?.includes("image/avif")
            ? "avif"
            : "webp",
          quality: 82,
          width: targetWidth,
        },
      },
    };
    const res = await safeFetch(target.toString(), fetchInit);
    if (!res.ok) {
      return new NextResponse(`Upstream ${res.status}`, { status: 502 });
    }
    const type = res.headers.get("content-type") ?? "application/octet-stream";
    if (!ALLOWED_TYPES.test(type)) {
      return new NextResponse(`Unsupported type ${type}`, { status: 415 });
    }
    return raw200(res.body, type);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Image proxy failed";
    return new NextResponse(message, { status: 500 });
  } finally {
    clearTimeout(timer);
  }
}

function raw200(body: BodyInit | null, type: string): NextResponse {
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": type,
      "Cache-Control": "public, max-age=86400, s-maxage=604800, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
