# url-shortener

A high-performance URL shortener built on Fastify 5, PostgreSQL, Drizzle ORM, and Redis.

Redirects are served entirely from cache; the primary database is never on the hot
path. Click tracking is buffered in Redis and flushed in batches. Users authenticate
with API keys, and rate limiting is plan-aware so billing can be added later without
touching routes or schema.

The full design and its reasoning live in **[ARCHITECTURE.md](./ARCHITECTURE.md)**.
Read that first — it explains *why*, and most of the surprising decisions here look
wrong without the context.

## Prerequisites

- Node >= 22
- A container runtime (Docker or [OrbStack](https://orbstack.dev))

## Setup

```bash
npm install
cp .env.example .env      # then edit APP_SECRET
docker compose up -d --wait
npm run db:migrate
npm run dev
```

Generate a real secret before doing anything that isn't local:

```bash
openssl rand -base64 48
```

The app validates its environment at boot and exits non-zero on anything missing, so a
bad config is an immediate crash rather than a surprise at runtime. In `production` it
additionally refuses to start with the placeholder `APP_SECRET` or with
`LOG_LEVEL=debug`/`trace`.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Watch mode |
| `npm run build` / `npm start` | Compile to `dist/` and run |
| `npm test` | Unit + integration tests |
| `npm run test:watch` | Vitest in watch mode |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` / `lint:fix` | ESLint |
| `npm run format` | Prettier |
| `npm run db:generate` | Generate a migration from the Drizzle schema |
| `npm run db:migrate` | Apply migrations |
| `npm run db:reset` | Truncate all tables (keeps schema and migration history) |
| `npm run db:reset:full` | Drop everything, then re-apply migrations from scratch |
| `npm run db:studio` | Browse data in a GUI |
| `npm run load:redirect` | autocannon against the redirect path |

## Testing

Unit tests need nothing. Integration tests use the real Postgres and Redis from
`docker compose`, against a **separate `shortener_test` database** so they can never
touch development data.

```bash
docker compose up -d --wait
npm test
```

Integration tests are not skipped when the datastores are unreachable — they fail.
That is deliberate: a silently skipped integration suite is worse than no suite.

## Load testing

The "sub-millisecond" redirect claim is not credible without a measurement, and the
honest target is a percentile, not a bare number. Expect p99 in the 1–5ms range
in-region once TLS, network hops, and Node overhead are included.

```bash
npm run dev
npm run load:redirect
```

## Status

| Phase | Scope | State |
| --- | --- | --- |
| 1 | Foundation: TS/ESM, config, app/server split, graceful shutdown, health, lint + test harness | done |
| 2 | Drizzle schema and initial migration | done |
| 3 | Auth: register, login, API keys, guards | done |
| 4 | Link creation | next |
| 5 | Redirect path and caching | |
| 6 | Click metrics | |
| 7 | Hardening, observability, docs | |
