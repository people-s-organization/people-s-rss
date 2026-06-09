import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  readSyncBlob,
  SyncConflictError,
  SyncValidationError,
  writeSyncPatch,
} from "@/app/lib/syncStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  const githubId = session?.user?.githubId;
  if (!githubId) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  try {
    const blob = await readSyncBlob(githubId);
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

  try {
    const src = body as Record<string, unknown>;
    const patch: Record<string, unknown> = {
      baseUpdatedAt: src.baseUpdatedAt,
    };
    if (Object.hasOwn(src, "feeds")) patch.feeds = src.feeds;
    if (Object.hasOwn(src, "ai")) patch.ai = src.ai;
    const blob = await writeSyncPatch(githubId, patch);
    return NextResponse.json({ ok: true, blob, updatedAt: blob.updatedAt });
  } catch (err) {
    if (err instanceof SyncConflictError) {
      const blob = await readSyncBlob(githubId);
      return NextResponse.json(
        { error: err.message, blob },
        { status: err.status },
      );
    }
    if (err instanceof SyncValidationError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : "Sync write failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
