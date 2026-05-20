# People's RSS

A minimal, self-hosted RSS / Atom reader that runs on Vercel. Bring your own AI key
to summarize any article in one click.

- **Custom feeds** — add any RSS or Atom URL; data lives in your browser (localStorage).
- **AI summary, BYO key** — configure any OpenAI-compatible endpoint + key. Requests
  are proxied through the app server only (no third party, no logging).
- **Zero database** — feed list, read state, and AI config are stored client-side.
  Nothing to provision.
- **Built on Next.js 16 + Tailwind 4**, deploys to Vercel with one click.

## Local development

```bash
npm install
npm run dev
```

Open <http://localhost:3000>.

## Deploy to Vercel

The easiest path is `vercel deploy` from this directory after running
`npm i -g vercel && vercel login`. Or push to GitHub and import the repo in the
Vercel dashboard — no environment variables are required for the default
configuration.

```bash
npm i -g vercel
vercel deploy            # preview
vercel deploy --prod     # production
```

## How it works

| Surface           | Where                                                          |
| ----------------- | -------------------------------------------------------------- |
| Feed list, read state, AI config | Browser `localStorage` (key prefix `prss:`)     |
| RSS fetch + parse | `GET /api/feed?url=…` — server-side, sanitizes HTML            |
| AI summarization  | `POST /api/summarize` — forwards to your endpoint + key        |
| UI                | `app/components/Reader.tsx` (client component)                 |

The server **never** stores your AI key. You paste it once in Settings and it
lives only in your browser; the `/api/summarize` route just forwards it to the
upstream endpoint you configured for that single request.

## AI provider compatibility

Any OpenAI-compatible chat-completions endpoint works. Tested shapes:

- OpenAI (`https://api.openai.com/v1`)
- OpenRouter, Groq, Together, DeepInfra, Fireworks, etc.
- Self-hosted: Ollama (`http://localhost:11434/v1`), vLLM, LM Studio, llama.cpp server

Set the **base URL** (we append `/chat/completions`), the **model id**, and your
**API key**. Pass an empty key for endpoints that don't require auth.

## Security notes

- Feed HTML is sanitized on the server with a strict allowlist (no scripts,
  iframes, inline event handlers, or `javascript:`/`data:` URLs except images).
- The `/api/feed` route caps response size at 5 MB and has a 15s timeout.
- The `/api/summarize` route caps article content at 60k characters and has a
  60s timeout.
