import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getRedis, userKey } from "@/app/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BLOB_BYTES = 256 * 1024;

type SyncBlob = {
  feeds?: unknown;
  read?: unknown;
  ai?: unknown;
  updatedAt: number;
};

export async function GET() {
  const session = await auth();
  const githubId = session?.user?.githubId;
  if (!githubId) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  try {
    const redis = getRedis();
    const raw = await redis.get(userKey(githubId));
    if (raw == null) {
      return NextResponse.json({ blob: null });
    }
    const blob = JSON.parse(raw) as SyncBlob;
    return NextResponse.json({ blob });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Sync read failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const session = await auth();
  const githubId = session?.user?.githubId;
  if (!githubId) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid blob" }, { status: 400 });
  }
  const blob: SyncBlob = {
    feeds: (body as Record<string, unknown>).feeds,
    read: (body as Record<string, unknown>).read,
    ai: (body as Record<string, unknown>).ai,
    updatedAt: Date.now(),
  };

  const serialized = JSON.stringify(blob);
  if (serialized.length > MAX_BLOB_BYTES) {
    return NextResponse.json(
      { error: `Blob too large (${serialized.length}B > ${MAX_BLOB_BYTES}B)` },
      { status: 413 },
    );
  }

  try {
    const redis = getRedis();
    await redis.set(userKey(githubId), serialized);
    return NextResponse.json({ ok: true, updatedAt: blob.updatedAt });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Sync write failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
