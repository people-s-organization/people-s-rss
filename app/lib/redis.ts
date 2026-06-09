import { Redis } from "@upstash/redis";

let client: Redis | null = null;

function assertUpstashEnv() {
  const hasUpstash =
    process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!hasUpstash) {
    throw new Error(
      "Upstash Redis is not configured (set UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN)",
    );
  }
}

export function getRedis(): Redis {
  if (client) return client;
  assertUpstashEnv();
  client = Redis.fromEnv({
    automaticDeserialization: false,
  });
  return client;
}
