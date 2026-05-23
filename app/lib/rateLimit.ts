import { getRedis } from "./redis";

export type RateLimitResult = {
  ok: boolean;
  remaining: number;
  resetIn: number;
};

export async function rateLimit(
  scope: string,
  identity: string,
  max: number,
  windowSec: number,
): Promise<RateLimitResult> {
  const redis = getRedis();
  const key = `prss:rl:${scope}:${identity}`;
  const now = Date.now();
  const windowStart = now - windowSec * 1000;
  const member = `${now}-${Math.random().toString(36).slice(2, 8)}`;

  const multi = redis.multi();
  multi.zremrangebyscore(key, 0, windowStart);
  multi.zadd(key, now, member);
  multi.zcard(key);
  multi.pexpire(key, windowSec * 1000 + 1000);
  const replies = (await multi.exec()) ?? [];
  const cardReply = replies[2];
  const count =
    Array.isArray(cardReply) && typeof cardReply[1] === "number"
      ? (cardReply[1] as number)
      : 0;

  if (count > max) {
    // Immediately remove the member to prevent the sorted set from inflating under spam
    await redis.zrem(key, member).catch(() => {});
    return { ok: false, remaining: 0, resetIn: windowSec };
  }
  return { ok: true, remaining: Math.max(0, max - count), resetIn: windowSec };
}

export function rateLimitedResponse(result: RateLimitResult) {
  return new Response(
    JSON.stringify({
      error: "Too many requests; slow down",
      retryAfter: result.resetIn,
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": String(result.resetIn),
      },
    },
  );
}
