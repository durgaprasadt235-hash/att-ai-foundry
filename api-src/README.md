# api-src — serverless handler sources

The TypeScript sources of the Vercel serverless handlers live here.
Vercel kept returning `FUNCTION_INVOCATION_FAILED` for handlers that
imported the shared `src/lib/*` modules as `.ts` files, so the handlers
are **pre-bundled with esbuild into self-contained `api/*.js`** before
deploy — Vercel runs the plain JS, no TS import chain involved.

Regenerate after any change: `npm run build:api`
(or `npm run build`, which runs it first).
