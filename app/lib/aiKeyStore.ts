import crypto from "node:crypto";
import { getRssSupabase } from "./supabase";
import { getOrCreateAppUserId } from "./userStore";

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_KEY_BYTES = 4096;

type AIKeyRow = {
  encrypted_api_key: string | null;
};

function loadSecret(): Buffer {
  const raw = process.env.AI_KEY_ENC_SECRET;
  if (!raw) {
    throw new Error(
      "AI_KEY_ENC_SECRET is not set; refusing to handle AI keys without at-rest encryption",
    );
  }
  let buf: Buffer;
  if (/^[A-Za-z0-9+/=]+$/.test(raw) && raw.length >= 44) {
    buf = Buffer.from(raw, "base64");
  } else if (/^[0-9a-fA-F]+$/.test(raw) && raw.length === 64) {
    buf = Buffer.from(raw, "hex");
  } else {
    buf = Buffer.from(raw, "utf8");
  }
  if (buf.length !== 32) {
    throw new Error(
      `AI_KEY_ENC_SECRET must decode to 32 bytes (got ${buf.length})`,
    );
  }
  return buf;
}

function encrypt(plaintext: string): string {
  const key = loadSecret();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

function decrypt(encoded: string): string {
  const key = loadSecret();
  const buf = Buffer.from(encoded, "base64");
  if (buf.length < IV_BYTES + TAG_BYTES + 1) {
    throw new Error("Encrypted apiKey payload too short");
  }
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const enc = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString("utf8");
}

export async function setAIKey(githubId: string, apiKey: string): Promise<void> {
  if (!apiKey) throw new Error("apiKey is empty");
  if (Buffer.byteLength(apiKey, "utf8") > MAX_KEY_BYTES) {
    throw new Error("apiKey too large");
  }
  const userId = await getOrCreateAppUserId("github", githubId);
  const { error } = await getRssSupabase().from("user_ai_settings").upsert(
    {
      user_id: userId,
      encrypted_api_key: encrypt(apiKey),
      api_key_updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (error) throw new Error(error.message);
}

export async function getAIKey(githubId: string): Promise<string | null> {
  const userId = await getOrCreateAppUserId("github", githubId);
  const { data, error } = await getRssSupabase()
    .from("user_ai_settings")
    .select("encrypted_api_key")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);

  const row = data as AIKeyRow | null;
  if (!row?.encrypted_api_key) return null;
  return decrypt(row.encrypted_api_key);
}

export async function clearAIKey(githubId: string): Promise<void> {
  const userId = await getOrCreateAppUserId("github", githubId);
  const { error } = await getRssSupabase()
    .from("user_ai_settings")
    .update({
      encrypted_api_key: null,
      api_key_updated_at: null,
    })
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
}

export async function hasAIKey(githubId: string): Promise<boolean> {
  const userId = await getOrCreateAppUserId("github", githubId);
  const { data, error } = await getRssSupabase()
    .from("user_ai_settings")
    .select("encrypted_api_key")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const row = data as AIKeyRow | null;
  return Boolean(row?.encrypted_api_key);
}
