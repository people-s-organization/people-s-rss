import postgres, { type Sql } from "postgres";

let client: Sql | null = null;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

export function getPostgres(): Sql {
  if (client) return client;
  client = postgres(requiredEnv("SUPABASE_DATABASE_URL"), {
    connect_timeout: 10,
    idle_timeout: 20,
    max: 3,
    prepare: false,
    ssl: "require",
  });
  return client;
}
