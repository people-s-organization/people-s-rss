<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## External storage

Use provider-direct external storage credentials. Do not depend on Vercel-provisioned storage integrations or Vercel-specific storage environment variables.
Supabase application tables belong in the `rss` schema, not `public`.

## Deployment

This app targets Cloudflare Workers through the OpenNext Cloudflare adapter.
Keep deployment configuration in `wrangler.jsonc` and `open-next.config.ts`.
