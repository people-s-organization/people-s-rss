import Redis from "ioredis";

let client: Redis | null = null;

function resolveUrl(): string {
  const direct = process.env.REDIS_URL;
  if (direct) return direct;
  for (const key of Object.keys(process.env)) {
    if (key.endsWith("_REDIS_URL")) {
      const v = process.env[key];
      if (v) return v;
    }
  }
  throw new Error("Redis URL not configured (set REDIS_URL or *_REDIS_URL)");
}

export function getRedis(): Redis {
  if (client) return client;
  client = new Redis(resolveUrl(), {
    lazyConnect: false,
    maxRetriesPerRequest: 2,
    enableAutoPipelining: true,
  });
  return client;
}

export function userKey(githubId: string): string {
  return `prss:user:${githubId}`;
}
