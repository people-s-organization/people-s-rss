import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

const ALLOWED_TYPES = /^image\//;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const raw = searchParams.get("url");
  if (!raw) return new NextResponse("Missing url", { status: 400 });
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return new NextResponse("Invalid url", { status: 400 });
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return new NextResponse("Unsupported protocol", { status: 400 });
  }

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
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) {
      return new NextResponse("Too large", { status: 413 });
    }
    return new NextResponse(buf, {
      status: 200,
      headers: {
        "Content-Type": type,
        "Content-Length": String(buf.byteLength),
        "Cache-Control": "public, max-age=86400, s-maxage=604800, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Image proxy failed";
    return new NextResponse(message, { status: 500 });
  } finally {
    clearTimeout(timer);
  }
}
