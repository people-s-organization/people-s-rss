# People's RSS

A minimal RSS / Atom reader that runs on Vercel. Bring your own AI key to
summarize any article in one click; sign in with GitHub to sync feeds and
read state across devices.

- **Custom feeds** — add any RSS or Atom URL; localized UI in 中文 and English.
- **AI summary, BYO key** — configure any OpenAI- or Anthropic-compatible
  endpoint + key. The key is encrypted at rest on the server and never
  returned to the browser.
- **Multi-device sync** — sign in with GitHub; feeds, read state, and the
  public part of your AI config sync via Redis. Anonymous mode works too,
  with everything kept in `localStorage`.
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
| `REDIS_URL` *(or `*_REDIS_URL`)* | Per-user sync blob + rate limit | Vercel Marketplace → Upstash Redis, or any Redis URL |
| `AI_KEY_ENC_SECRET`      | Encrypting stored AI API keys      | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |

Set all five for both Production and Preview on Vercel. **Don't lose
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
| Feed list, read state, AI config (public) | `localStorage` (prefix `prss:`) ↔ `GET/PUT /api/sync`  |
| AI key (private)             | Server-only, AES-256-GCM in Redis at `prss:user:${ghId}:aiKey`     |
| RSS fetch + parse            | `GET /api/feed?url=…` — sanitized + base-URL rewritten             |
| Article extraction           | `GET /api/extract?url=…` — Readability via linkedom + Jina fallback|
| AI summarization             | `POST /api/summarize` — reads stored key, calls upstream           |
| Image proxy                  | `GET /api/image?url=…` — re-encodes via sharp                      |

The AI key is paste-once: you enter it in Settings, the server encrypts it
with `AI_KEY_ENC_SECRET`, stores the ciphertext keyed by your GitHub id, and
from that point on the browser never sees the key again. `/api/summarize`
reads it server-side and forwards to your configured upstream.

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

- AI keys are AES-256-GCM encrypted with `AI_KEY_ENC_SECRET` before hitting Redis
  and are never returned to the client; the server is the only thing that ever
  sees plaintext after the first POST.
- All routes that fetch user-supplied URLs (`/api/feed`, `/api/extract`,
  `/api/image`, `/api/summarize`, `/api/models`) run an SSRF guard that blocks
  private / reserved / link-local / loopback / CGNAT / multicast IPs both by
  hostname and after DNS resolution.
- Per-user (or per-IP for anonymous) sliding-window rate limits backed by Redis:
  feed 60/min, extract 30/min, image 120/min, models 10/min, summarize 20/min.
- Feed HTML is sanitized with a strict tag/attribute allowlist (no scripts,
  iframes, event handlers, or `javascript:`/`data:` URLs except inline images).
- Response sizes and timeouts are capped on every fetch path (feed 5 MB / 15 s,
  extract 8 MB / 20 s, image 25 MB / 20 s, summarize content 60 KB / 60 s).
