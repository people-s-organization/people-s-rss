import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { clearAIKey, hasAIKey, setAIKey } from "@/app/lib/aiKeyStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_KEY_LEN = 4096;

export async function GET() {
  const session = await auth();
  const githubId = session?.user?.githubId;
  if (!githubId) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  try {
    const present = await hasAIKey(githubId);
    return NextResponse.json({ hasKey: present });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Lookup failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
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
  const apiKey =
    body && typeof body === "object" && "apiKey" in body
      ? String((body as { apiKey?: unknown }).apiKey ?? "").trim()
      : "";
  if (!apiKey) {
    return NextResponse.json({ error: "apiKey is required" }, { status: 400 });
  }
  if (apiKey.length > MAX_KEY_LEN) {
    return NextResponse.json({ error: "apiKey too large" }, { status: 413 });
  }
  try {
    await setAIKey(githubId, apiKey);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Write failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE() {
  const session = await auth();
  const githubId = session?.user?.githubId;
  if (!githubId) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  try {
    await clearAIKey(githubId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Clear failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
