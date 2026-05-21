import crypto from "node:crypto";
import { getRedis } from "./redis";

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_KEY_BYTES = 4096;

export function aiKeyRedisKey(githubId: string): string {
  return `prss:user:${githubId}:aiKey`;
}

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
  const redis = getRedis();
  await redis.set(aiKeyRedisKey(githubId), encrypt(apiKey));
}

export async function getAIKey(githubId: string): Promise<string | null> {
  const redis = getRedis();
  const stored = await redis.get(aiKeyRedisKey(githubId));
  if (!stored) return null;
  return decrypt(stored);
}

export async function clearAIKey(githubId: string): Promise<void> {
  const redis = getRedis();
  await redis.del(aiKeyRedisKey(githubId));
}

export async function hasAIKey(githubId: string): Promise<boolean> {
  const redis = getRedis();
  const exists = await redis.exists(aiKeyRedisKey(githubId));
  return exists === 1;
}
