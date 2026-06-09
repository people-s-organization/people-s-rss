# People's RSS

A minimal RSS / Atom reader that runs on Vercel. Bring your own AI key to
summarize any article in one click; sign in with GitHub to sync feeds and
public AI settings across devices.

- **Custom feeds** — add any RSS or Atom URL; localized UI in 中文 and English.
- **AI summary, BYO key** — configure any OpenAI- or Anthropic-compatible
  endpoint + key. The key is encrypted at rest on the server and never
  returned to the browser.
- **Multi-device sync** — sign in with GitHub; feeds and the public part of
  your AI config sync via Supabase. Read state and summaries stay in the
  browser. Anonymous mode works too, with everything kept in `localStorage`.
- **Full-text fallback** — if a feed only ships a summary, the reader
  extracts the full article via Readability + a Jina fallback.
- **Built on Next.js 16 + Tailwind 4**, deploys to Vercel.

## Local development

```bash
npm install
cp .env.example .env.local   # fill in values, see below
npm run dev
```

Open <http://localhost:3000>. The proxy redirects to `/zh` or `/en` based on
your `Accept-Language` header.

## Environment variables

| Variable                 | Required for                       | How to get it                                           |
| ------------------------ | ---------------------------------- | ------------------------------------------------------- |
| `AUTH_SECRET`            | NextAuth JWT signing               | `openssl rand -base64 32`                               |
| `AUTH_GITHUB_ID`         | GitHub OAuth (sign-in + sync)      | <https://github.com/settings/developers> → New OAuth App|
| `AUTH_GITHUB_SECRET`     | GitHub OAuth                       | Same OAuth app                                          |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | Rate limit counters | Provider-direct Upstash Redis |
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` + `SUPABASE_DATABASE_URL` | Signed-in users, feeds, categories, public AI settings, encrypted AI API keys | Provider-direct Supabase project |
| `AI_KEY_ENC_SECRET`      | Encrypting stored AI API keys      | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |

Set auth/encryption/storage variables for both Production and Preview. External
storage should be provisioned directly with the provider, not through Vercel
storage integrations. **Don't lose
`AI_KEY_ENC_SECRET`** — if it changes, every user has to re-enter their
AI key in Settings.

The GitHub OAuth callback URL must be `https://<your-domain>/api/auth/callback/github`.

## Deploy to Vercel

```bash
npm i -g vercel && vercel login
vercel link
vercel env pull .env.local   # after configuring env vars in the dashboard
vercel deploy --prod
```

## How it works

| Surface                      | Where                                                              |
| ---------------------------- | ------------------------------------------------------------------ |
| UI                           | `app/[locale]/`, `app/components/Reader.tsx`, `SettingsDialog.tsx` |
| i18n                         | `i18n/routing.ts`, `messages/{zh,en}.json` (next-intl)             |
| Locale routing               | `proxy.ts` (Next 16 proxy / middleware)                            |
| Feed list, categories, AI config (public) | `localStorage` (prefix `prss:`) ↔ Supabase tables via `GET/PUT /api/sync` |
| Read state                     | Browser `localStorage` only, prefix `prss:read`                         |
| AI key (private)             | Server-only, AES-256-GCM in Supabase table `rss.user_ai_settings`  |
| AI summaries                 | Browser `localStorage` only, prefix `prss:summaries`               |
| RSS fetch + parse            | `GET /api/feed?url=…` — sanitized + base-URL rewritten             |
| Article extraction           | `GET /api/extract?url=…` — Readability via linkedom + Jina fallback|
| AI summarization             | `POST /api/summarize` — reads stored AI settings/key, calls upstream |
| Image proxy                  | `GET /api/image?url=…` — re-encodes via sharp                      |

The AI key is paste-once: you enter it in Settings, the server encrypts it
with `AI_KEY_ENC_SECRET`, stores the ciphertext keyed by your GitHub id, and
from that point on the browser never sees the key again. `/api/summarize`
reads it server-side from Supabase and forwards to your configured upstream.
Generated summaries are cached only in the browser.

Create the Supabase schema by running `supabase/rss_schema.sql` in the SQL
Editor of the provider-direct Supabase project. When using Supabase's Data API,
add `rss` to the project's exposed schemas; access is still service-role only.
Set `SUPABASE_DATABASE_URL` to Supabase's Postgres pooler connection string so
the server can commit multi-table sync writes in one transaction.

## AI provider compatibility

Set **API style** to OpenAI (`/chat/completions`) or Anthropic (`/messages`),
the **base URL**, and the **API key**. We append the path automatically.

Tested shapes:

- OpenAI (`https://api.openai.com/v1`)
- Anthropic (`https://api.anthropic.com/v1`)
- OpenRouter, Groq, Together, DeepInfra, Fireworks
- Self-hosted: Ollama (`http://localhost:11434/v1`), vLLM, LM Studio, llama.cpp server

For SSRF safety, **upstream endpoints must use `https://`** in production
(localhost is allowed during development). The endpoint hostname is DNS-resolved
and rejected if it points at a private / loopback / link-local / CGNAT / multicast IP.

## Security

- AI keys are AES-256-GCM encrypted with `AI_KEY_ENC_SECRET` before hitting Supabase
  and are never returned to the client; the server is the only thing that ever
  sees plaintext after the first POST.
- All routes that fetch user-supplied URLs (`/api/feed`, `/api/extract`,
  `/api/image`, `/api/summarize`, `/api/models`) run an SSRF guard that blocks
  private / reserved / link-local / loopback / CGNAT / multicast IPs both by
  hostname and after DNS resolution.
- Per-user (or per-IP for anonymous) sliding-window rate limits backed by Upstash Redis:
  feed 60/min, extract 30/min, image 120/min, models 10/min, summarize 20/min.
- Feed HTML is sanitized with a strict tag/attribute allowlist (no scripts,
  iframes, event handlers, or `javascript:`/`data:` URLs except inline images).
- Response sizes and timeouts are capped on every fetch path (feed 5 MB / 15 s,
  extract 8 MB / 20 s, image 25 MB / 20 s, summarize content 60 KB / 60 s).
