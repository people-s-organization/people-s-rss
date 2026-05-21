import { NextResponse } from "next/server";
import sharp from "sharp";
import { assertPublicHttpUrl, SSRFError } from "@/app/lib/ssrfGuard";
import { rateLimit, rateLimitedResponse } from "@/app/lib/rateLimit";
import { auth } from "@/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_WIDTH = 1600;
const ABS_MAX_WIDTH = 2400;

const ALLOWED_TYPES = /^image\//;
const PASS_THROUGH_TYPES = /^image\/(svg\+xml|gif|x-icon|vnd\.microsoft\.icon)/;

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
    const res = await fetch(target.toString(), {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        Referer: `${target.origin}/`,
      },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) {
      return new NextResponse(`Upstream ${res.status}`, { status: 502 });
    }
    const type = res.headers.get("content-type") ?? "application/octet-stream";
    if (!ALLOWED_TYPES.test(type)) {
      return new NextResponse(`Unsupported type ${type}`, { status: 415 });
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_BYTES) {
      return new NextResponse("Too large", { status: 413 });
    }

    if (PASS_THROUGH_TYPES.test(type)) {
      return raw200(buf, type);
    }

    try {
      const out = await sharp(buf, { failOn: "none" })
        .rotate()
        .resize({ width: targetWidth, withoutEnlargement: true })
        .webp({ quality: 82, effort: 4 })
        .toBuffer();
      return raw200(out, "image/webp");
    } catch {
      return raw200(buf, type);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Image proxy failed";
    return new NextResponse(message, { status: 500 });
  } finally {
    clearTimeout(timer);
  }
}

function raw200(body: Buffer, type: string): NextResponse {
  return new NextResponse(new Uint8Array(body), {
    status: 200,
    headers: {
      "Content-Type": type,
      "Content-Length": String(body.byteLength),
      "Cache-Control": "public, max-age=86400, s-maxage=604800, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
