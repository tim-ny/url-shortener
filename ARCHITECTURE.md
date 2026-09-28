# URL Shortener — Architecture

**Status:** Draft for review. No code written yet. **Revision 2 — auth and per-user metrics added.**

## 1. Goals and non-goals

**Goals**
- Redirect latency served entirely from cache; the primary DB is never on the redirect hot path.
- Link creation is fast, validated, and safe under concurrent writers.
- Traffic spikes (viral links) degrade gracefully instead of stampeding Postgres.
- Click tracking never blocks or fails a redirect.
- Users can register, authenticate, and see click metrics for their own links.
- Quota and rate-limit enforcement is plan-aware from day one, so adding billing is a
  configuration change rather than a refactor.

**Non-goals (explicitly deferred)**
- Payments, subscriptions, invoices, and the paywall UI. The *enforcement hooks* are built now; the billing that drives them is not.
- A web dashboard or HTML UI. The API is the interface.
- Unique-visitor analytics, referrer/geo/user-agent breakdowns.
- Link editing/rotation after creation (links are immutable once created).
- Multi-region writes, CDN in front of redirects.

## 2. Key decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Form factor | Modular monolith, domain-first folders | Avoids a premature microservice split; keeps the cache logic private to the hot path |
| Language | TypeScript (strict), ESM | Drizzle is TS-first; Fastify 5 is ESM-clean |
| Short codes | Random lowercase base36, 7 chars | Non-enumerable; case-sensitivity bugs designed out |
| Custom aliases | Supported, reserved-word blocklist | Needed for `/go/acme` ergonomics |
| Destination policy | `http`/`https` only, no credentials, ≤2048 chars | Blocks open-redirect abuse without a domain list |
| Auth transport | API keys (`Authorization: Bearer`) | Correct fit for a programmatic API; a session/JWT layer can be added later without a schema change |
| Password hashing | argon2id via `@node-rs/argon2` | Prebuilt native binary; avoids `node-gyp` build failures that the `argon2` package can hit |
| API key storage | HMAC-SHA-256 with a server-side pepper, indexed | See §8 — this is a case where bcrypt would be wrong |
| Identity on links | `owner_id` nullable | Anonymous creation stays possible; ownership is additive |
| Authorization | 404, never 403, for unowned links | Prevents existence leaks through the API |
| Click tracking | Redis INCR buffer → batch flush to Postgres | Redirect never awaits a write |
| Click storage | Aggregated per code per hour bucket | A row per redirect is a write-amplification trap |
| Cache | Cache-aside, read-through on create, explicit invalidation on mutate | Bounded staleness without a message bus |
| Migrations | Drizzle Kit, committed, applied at deploy | Never auto-migrate on app boot in production |
| Metrics export | `prom-client` directly | `@fastify/metrics` does not exist as a package |
| Test infra | Docker Compose, not Testcontainers | `@testcontainers/postgres` does not exist; compose also serves local dev |

## 3. Why the click path cannot touch Postgres

The naive design — increment a counter in Postgres on every redirect — makes the
database a write-hot resource on the exact path we are trying to make fast. A viral
link produces a write storm that exhausts connection pool capacity, which then stalls
*link creation* as well. The two requirements are in direct conflict.

Instead:

1. Redirect fires a Redis `INCR` and does not await it.
2. A flush worker drains buffers into an aggregated `clicks` table in batches.
3. The worker is a separate concern; losing counts on crash is acceptable for analytics.

**Acceptable loss:** clicks in flight when the process dies are dropped. Accepted
deliberately — click analytics do not justify a synchronous write on the hot path.

Note that this decision holds *now that clicks are user-visible*. Aggregated counters
are the right call precisely because the per-user metrics API only needs time series,
which is exactly what hourly buckets answer efficiently.

## 4. Code generation

- Alphabet: `a-z0-9` (36 chars). **Lowercase only** — see §10.
- Length: 7 → 36^7 ≈ 78.4 billion codes.
- Collision pressure (birthday bound): ~50% at roughly 440 million codes. Far beyond
  expected lifetime volume, but collisions are still handled rather than assumed away.
- Insert always uses `ON CONFLICT DO NOTHING`.
  - Random code conflict → generate a new code, retry, max 5 attempts.
  - Custom alias conflict → **409 Conflict**. This is a different outcome, not a retry.
    Distinct semantics; do not conflate them.
- Custom aliases are normalized to lowercase and validated against the reserved list.

## 5. Data model

```sql
users
  id             uuid        primary key default gen_random_uuid()
  email          citext      not null unique
  password_hash  text        not null          -- argon2id encoded string
  plan           user_plan   not null default 'free'   -- 'free' | 'pro'
  created_at     timestamptz not null default now()
  updated_at     timestamptz not null default now()

api_keys
  id           uuid        primary key default gen_random_uuid()
  user_id      uuid        not null references users(id) on delete cascade
  name         varchar(64) not null          -- user-supplied label
  key_prefix   varchar(20) not null          -- e.g. 'usk_live_3f2a' for display only
  key_hash     char(64)    not null unique   -- HMAC-SHA-256 hex of the full key
  revoked_at   timestamptz null
  last_used_at timestamptz null
  created_at   timestamptz not null default now()
  -- unique index on key_hash: the per-request auth lookup

links
  code        varchar(7)   primary key       -- lowercase base36
  owner_id    uuid         null references users(id) on delete set null
                                     -- null = anonymous
  target_url  text         not null
  state       link_state   not null default 'active'  -- 'active' | 'disabled'
  is_custom   boolean      not null default false
  expires_at  timestamptz  null
  created_at  timestamptz  not null default now()
  -- index (owner_id, created_at desc)  for "list my links"
  -- index (expires_at) where expires_at is not null, for the expiry sweep

clicks
  code    varchar(7)   not null references links(code) on delete cascade
  bucket  timestamptz  not null              -- date_trunc('hour', created_at)
  count   bigint       not null default 0
  primary key (code, bucket)
  -- rows are upserted: count = clicks.count + excluded.count
```

### Notes on these choices

- **`owner_id` is nullable and set to `null` on user deletion.** Links should not be
  destroyed because an account was deleted. The links outlive the account; they just
  become anonymous. A test asserts this, because `CASCADE` here would silently delete
  a user's live links.
- **`clicks` has no `owner_id`.** Ownership is reachable by joining `links` on `code`.
  Denormalizing it into the high-write table would be a real cost for no query benefit,
  since `code` is already the primary key.
- **`clicks.bucket` is a real `timestamptz`,** not a string, so range queries and
  rollups work. The per-user stats endpoint is a straightforward range scan.
- **`email` is `citext`, not `text`.** Email comparison is case-insensitive by RFC 5321,
  and the unique index enforces that in the database. Doing it in application code
  means a check-then-insert with a race, and the race produces a duplicate account that
  is very hard to notice later. `citext` is verified to be load-bearing: downgrading the
  column to `varchar` fails the test, and then leaves behind a real duplicate row.
- **`links.code` is the primary key,** not a surrogate id. A code is meaningless without
  its lookup being a direct PK hit, and no query traverses links by anything else.
- **`links.owner_id` is in the initial migration.** This migration has to land before
  any link exists — adding the column to a populated table cannot recover which rows
  were originally anonymous.

### Migration layout

Two migrations, deliberately separated:

- `0000_extensions.sql` — `CREATE EXTENSION citext`, hand-written. Kept ahead of the
  schema so a table migration never depends on an extension created in the same file.
- `0001_init.sql` — generated from `db/schema.ts`, and never hand-edited.

`pgcrypto` is deliberately absent: `gen_random_uuid()` is core Postgres from 13 on, and
this targets 17.

### A migration failure mode worth knowing

Dropping the `public` schema leaves Drizzle's ledger in the `drizzle` schema intact. The
ledger still records both migrations as applied, so `npm run db:migrate` reports
**success and creates nothing**. `db:reset` detects this state and points at
`db:reset:full`, which drops both schemas.

## 6. Cache design

### Keys

| Key | Type | Contents | TTL |
| --- | --- | --- | --- |
| `u:{code}` | string | `A\|{target_url}` active, `D` disabled, `X` not-found | 24h / 24h / 30s |
| `c:{code}:{bucket}` | string | integer click count | 48h |
| `clickbuf` | sorted set | members `{code}\|{bucket}`, score = flush-due time | — |
| `q:{userId}:{YYYYMM}` | string | monthly quota counters | to month end |

`u:{code}` is a compact positional format rather than JSON — the redirect path should
not pay a JSON parse. `X` is the negative cache entry that protects Postgres from
scanners enumerating codes.

### Read path (`GET /{code}`)

```
1. GET u:{code}
2.   A|url -> (record click, do not await) -> 302
     D    -> 410 Gone
     X    -> 404
     miss -> single-flight coalescing
3. Single-flight: an in-process map of code -> in-flight promise. Concurrent misses for
   the same code await one DB query rather than issuing N.
4. DB hit    -> SET u:{code} (24h)   -> respond
   DB miss   -> SET u:{code} X (30s) -> 404
5. If Redis is unavailable, skip to the DB directly. Slower, still correct.
```

**Unauthenticated and identical on every path.** Auth is a header check against a
`u:` lookup — it must never touch the redirect flow, or the hot path stops being hot.

**Stampede note.** Single-flight dedupes concurrent misses *within one process*. It does
not help across processes, so a multi-instance deployment can still produce a burst of
identical DB reads. Probabilistic early refresh (an `X-Fetch-Time` header, refreshed
slightly before TTL expiry) or proactive warming of hot keys is the next step up.
Flagged, not built.

### Invalidation

TTL is a backstop, not the mechanism. Any mutation — disable, delete, expiry — must
`DEL u:{code}` explicitly. A 24h TTL on its own would make "disable this link" appear
to do nothing for up to a day.

### Click recording

```ts
// Fire and forget. The catch is mandatory: an unhandled rejection is fatal in Node.
void cache.incrClick(code).catch((err) => log.warn({ err, code }, 'click record failed'))
```

Do not await this before sending the response. The redirect's latency budget is one
Redis `GET`; the `INCR` must sit outside it.

### Flush worker

A sorted set (`clickbuf`) is used as an explicit work queue rather than `SCAN`ping the
keyspace, which degrades as the instance grows.

```
every 5s:
  ZRANGEBYSCORE clickbuf -inf now LIMIT 0 500
  batch upsert into clicks (additive count)
  DEL the corresponding c:* keys
  ZREM the processed members
```

Bounded to 500 members per tick so a backlog is drained over several ticks rather than
in one long-running query. Runs in-process as a Fastify plugin for v1; splitting it
into its own process later is a deployment change, not a code change.

## 7. API surface

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/v1/auth/register` | — | Create account, returns one API key |
| POST | `/v1/auth/login` | — | Exchange credentials for a fresh API key |
| GET | `/v1/auth/me` | required | Current user and plan |
| GET | `/v1/auth/keys` | required | List key prefixes and usage, never secrets |
| DELETE | `/v1/auth/keys/:id` | required | Revoke an API key |
| POST | `/v1/links` | optional | Create a link. Auth grants higher quota |
| GET | `/v1/links` | required | List the caller's links with summary counts |
| GET | `/v1/links/:code` | optional | Link metadata. Does not increment clicks |
| GET | `/v1/links/:code/stats` | required + owner | Click time series for one link |
| DELETE | `/v1/links/:code` | required + owner | Disable a link (soft delete) |
| GET | `/:code` | — | Redirect. 302, 404, or 410 |
| — | `/livez` | — | Liveness: process running. No dependency checks |
| — | `/readyz` | — | Readiness: Postgres and Redis reachable, with timeout |
| — | `/metrics` | — | Prometheus metrics |

Liveness and readiness are deliberately distinct, and the distinction is finer than it
first appears:

- **`/livez` checks nothing.** Not Postgres, not Redis. If it did, a Redis blip would
  fail the liveness probe, the orchestrator would restart every instance, and a
  momentary cache outage would become a cold-start outage.
- **`/readyz` fails readiness on Postgres only.** Redis being down reports `degraded`
  with a **200**, not a 503 — the resolver falls back to Postgres, so the instance can
  still serve, just slower. Returning 503 would pull every instance out of rotation at
  once and turn a degradation into an outage. Postgres down means redirects cannot be
  served at all, so that is a genuine 503.

This is why the ioredis client in `plugins/cache.ts` sets `enableOfflineQueue: false`
and `maxRetriesPerRequest: 1`. With the defaults, a command issued while Redis is
unreachable sits in a retry queue with the request waiting behind it, and the fallback
above is never reached — the redirect hangs instead of degrading.

`POST /v1/links` is **optional auth by design** — see §9.

### Create request

```json
{
  "url": "https://example.com/a/very/long/path",
  "customCode": "acme",                 // optional
  "expiresAt": "2026-12-31T23:59:59Z"  // optional
}
```

Validation lives in the route's JSON Schema, not a hand-written layer — one source of
truth, and Fastify validates and coerces before the handler runs. Business rules that
JSON Schema cannot express (reserved words, availability) live in the service layer.

### Create flow

```
1. rate limit (plan-aware, §9)
2. JSON Schema validation
3. destination policy check (§11)
4. reserved-word + availability check (custom only)
5. INSERT ... ON CONFLICT DO NOTHING
     random conflict -> retry, max 5
     custom conflict -> 409
6. write-through: SET u:{code}
7. 201 with the short URL
```

## 8. Authentication and authorization

### Transport

API keys, presented as `Authorization: Bearer usk_live_<random>`. Deliberately chosen
over JWT/session because the client is expected to be a program:

- No refresh-token lifecycle, no cookie rotation, no CSRF surface.
- Revocable instantly and individually, which is what a paywall needs when someone
  disputes a charge.
- Zero cost to the redirect hot path, since it is never checked there.

If a dashboard is ever added, a JWT session layer bolts on beside this using the same
`users` row. Nothing in the schema changes — this is the reason the choice is safe.

### Key generation and storage

- 32 bytes from a CSPRNG, base62-encoded, prefixed with `usk_live_` / `usk_test_` so
  keys are identifiable in logs and separable per environment.
- The **raw key is returned exactly once**, at register/login, and never again.
- Stored as `key_hash = HMAC-SHA-256(rawKey, APP_SECRET)`, hex-encoded.

**Why HMAC-SHA-256 and not bcrypt/argon2.** This is the decision most likely to be got
wrong, and it is deliberate in both directions:

- Argon2's purpose is to make *brute force expensive*, which is only necessary for
  low-entropy secrets — human passwords. An API key here has 256 bits of entropy; there
  is no dictionary to slow down, so a slow KDF buys nothing and costs latency.
- More decisively, **bcrypt and argon2 cannot be indexed.** Verifying a key requires
  computing the hash over every candidate row. An indexed `key_hash` turns auth into a
  single index seek. Argon2 on the auth path would mean a full table scan per request.

The HMAC pepper (rather than a bare SHA-256) is defence in depth: a stolen database
dump alone does not yield usable keys, because the pepper lives in the environment
config, not the database.

### Password storage

Argon2id via `@node-rs/argon2`, prebuilt N-API binaries. The `argon2` package requires
a node-gyp toolchain and is a common source of first-run build failures; this variant
ships prebuilt.

Parameters: argon2id, m=19456 KiB, t=2, p=1 (the OWASP baseline), configurable via
`ARGON2_*` for a memory-constrained host. **Production refuses to boot below the
baseline**, while development is free to weaken it: a copy-pasted development `.env` is
the realistic way to get this wrong, and a weakened cost parameter is invisible right up
until the table is exfiltrated.

The password field has both a minimum and a maximum in the route's JSON Schema. The
maximum is a control, not a style choice — argon2's cost scales with input length, so an
unbounded password field is a free way to make the login route burn arbitrary CPU.

#### Login timing

A `SELECT` that matches no row returns in about a millisecond, while a real verification
spends tens or hundreds in argon2. Left alone, that gap is a reliable
account-enumeration oracle, and it is invisible to functional tests — the response is
correct either way. So `password.ts` holds a precomputed hash of a value nobody knows
and spends the same work against it when the email is unknown. `verifyPasswordOrDummy`
exists so the two paths cannot drift apart, and a test asserts the ratio is inside a
narrow band.

### The guard

A single `onRequest` hook, applied per route rather than globally so that the
redirect path is untouched by default.

```
extract bearer token
  missing/invalid shape      -> 401
  HMAC and look up key_hash  -> no match or revoked -> 401
  load user                  -> missing -> 401 (deleted account, stale key)
  touch last_used_at         -> fire and forget, never awaited
  decorate request.user      -> { id, plan }
```

Every authenticated route uses one of three decorators: `authenticate` (any valid
key), `optionalAuth` (attaches a user if a valid key is present, never fails), and
`requireOwner` (404 unless `links.owner_id` matches).

The key lookup resolves the key **and** its owner in one query, with `revoked_at IS
NULL` as part of the same statement rather than a second round trip — a revoked key then
costs the same single index seek as a live one, and there is no window between "fetch
the key" and "check if revoked" for a concurrent revoke to slip through.

`optionalAuth` exists only for `POST /v1/links`. A decorator that swallows a failure is
exactly the bug that turns an authenticated route into a public one, so it is named for
what it does and used in exactly one place.

### One error shape, and what a 4xx is allowed to say

Every error is `{ error: { code, message } }`. `code` is stable for clients to branch on;
`message` is for humans. `src/plugins/errors.ts` decides how anything thrown becomes that
shape, and the interesting cases are the ones that are easy to get wrong:

- **An `AppError` uses its own status and code.** Services throw; they never build
  responses, so business rules stay free of Fastify and can be called from a worker.
- **A 4xx from a plugin is relayed, not swallowed.** `@fastify/rate-limit`'s 429 and the
  router's own errors are deliberate client-facing messages. The first version funnelled
  everything unrecognised to 500, which made a rate-limited register return 500 — telling
  a legitimate client to retry immediately and registering as a server fault in metrics.
  The auth tests caught it.
- **Everything else is a bare 500.** Fastify's default handler serialises the error's own
  `message`, and for a database driver that is the failing SQL with bound values inline.
  An unhandled error here is a data leak, not just an ugly response. The detail goes to
  the log and nowhere else.

### Fastify's ajv defaults quietly delete unknown fields

Fastify sets `removeAdditional: true`, so `additionalProperties: false` in a route schema
does **not** reject an unknown property — it removes it and lets the request succeed. On a
credential endpoint that is a real trap: a client that misspells `passwrod` gets "invalid
credentials" forever with nothing pointing at the typo. `buildApp` overrides it so the
schemas mean what they appear to mean. The other defaults are kept deliberately —
`allErrors: false` is a DoS mitigation, and `coerceTypes: 'array'` is what the
link-create endpoint will rely on.

### Authorization returns 404, never 403

When a caller requests a link they do not own, the response is `404` — identical to
the response for a code that never existed. A `403` would confirm the code is real and
turn the API into an oracle for enumerating other users' links, defeating the
non-enumerable property that §4 pays for.

The same rule governs `DELETE /v1/auth/keys/:id`: revoking a key id that belongs to
someone else is a 404, not a 403, and a test asserts the other user's key still works
afterwards. A 404 that quietly revoked it would be a denial-of-service against their
account.

This is easy to get wrong, so `notFound()` in `src/lib/errors.ts` is the only thing
that produces it, and `tests/integration/ownership.test.ts` asserts the two responses
are byte-identical — including the anonymous-link case, where `owner_id` is a SQL NULL
and a guard written as `if (row.ownerId && row.ownerId !== principal.userId)` would let
the link through. Verified by temporarily returning 403: three tests fail.

### Registration abuse

Open registration is a spam and cost vector. Minimum viable controls, in order of
importance:

- Per-IP rate limit on `/v1/auth/register` (tight).
- Per-email limit, since registration is keyed on email.
- Email verification before the account can create links. **This is the only real
  control** — the others raise the cost but do not stop it.

Ship the rate limits in the first pass and treat verification as a must-have before
this is exposed publicly. Note that verification requires an email provider, which is
a new external dependency; it can be stubbed with a logged link in development.

## 9. Rate limits and quotas — built now, billed later

This is the section that makes the paywall cheap later. The enforcement code reads a
plan from the request, so enabling billing means changing what a plan *is*, not
rewriting where enforcement happens.

```ts
const PLAN_LIMITS = {
  free: { linksPerMonth: 100,    redirectsPerMonth: 10_000,  customAlias: true  },
  pro:  { linksPerMonth: 10_000, redirectsPerMonth: 1_000_000, customAlias: true },
}
```

Two independent layers:

1. **Per-IP request rate limit** — `@fastify/rate-limit`, Redis-backed so limits are
   shared across instances. This is the abuse floor and always applies.
2. **Per-user monthly quota** — `INCR q:{userId}:{YYYYMM}` on create, TTL to month end.
   Anonymous callers fall back to the IP bucket.

**The Redis backing is not optional.** The plugin's default is an in-memory store, and
N instances behind a load balancer then allow N times the intended budget — the abuse
floor quietly stops being a floor precisely when it is load-bearing. The limiter reuses
the app's existing ioredis client rather than opening a second connection.

`skipOnError: true`, so a Redis outage loses the counter instead of returning 500 on
every request. Failing closed would let anyone take the service down by taking Redis
down; the same trade the redirect resolver makes — a cache outage should cost
throughput, not availability.

`RATE_LIMIT_REGISTER_MAX` is 3 per window, the tightest budget in the app. The
integration tests raise it through a `buildApp` seam because every `inject()` shares a
loopback address, and the real numbers are pinned in `tests/unit/env.test.ts` instead —
so the seam cannot be left switched on unnoticed.

Adding a paywall then means: attach a billing provider, map its price ID to a `plan`
value, and update `PLAN_LIMITS`. No route, service, or schema changes.

**Anonymous creation stays available**, with a lower IP quota. Requiring an account
before anyone can shorten a URL is a large product decision with real acquisition
consequences, and it is not needed to support a paywall. Flagged for explicit
confirmation rather than assumed either way.

## 10. Case sensitivity

All codes are lowercased on input and stored lowercase, so lookups are
case-insensitive by construction. This removes an entire class of bug: a user types
`/GO/Acme`, gets a 404, and files a bug that is not a bug.

The cost — `Go` and `go` cannot be distinct links — is not a real loss. The benefit
(one Redis key namespace, one comparison rule, no surprise) is worth it.

Enforced at the schema level, not in the service, so there is no way to bypass it.

## 11. Destination URL policy

Applied on top of JSON Schema validation, since these are rules JSON Schema cannot
express:

- `new URL(input)` must parse
- `protocol` is exactly `http:` or `https:` — **this is the check that matters**;
  `javascript:`, `data:`, and `file:` all parse successfully, so protocol allowlisting
  is what actually prevents open-redirect and XSS-via-redirect abuse
- no `username` or `password` embedded
- `href.length <= 2048`

No domain allowlist. If one is needed later (malware or phishing takedowns), it is a
config-driven addition in the same place.

## 12. Reserved codes

All routes the app serves, so they can never be claimed as aliases:

```
api v1 health livez readyz metrics admin static assets favicon.ico robots.txt
docs swagger graphql login signup logout about terms privacy support help
status www app dashboard _ .well-known
```

## 13. Resilience and abuse control

- **Rate limiting** — Redis-backed via `@fastify/rate-limit`, shared across instances,
  plan-aware per §9.
- **Destination policy** (§11) — prevents the service being used as a redirector to
  `javascript:` payloads or phishing infrastructure.
- **Idempotency** — `Idempotency-Key` on `POST /v1/links`, response cached in Redis for
  24h, so a client retry cannot create a duplicate link. Deferred to the final phase.
- **Graceful shutdown** — `onClose` hooks drain the Postgres pool and quit Redis before
  the process exits, so in-flight redirects are not cut off mid-flight.
- **API key leakage** — the raw key is shown once. Rotation is "issue new, revoke old",
  which is why keys are rows rather than a column on `users`.

## 14. Observability

- Structured Pino logs. Credentials are kept out of logs by two independent layers,
  and the primary one is **not** the redaction config: Fastify's own `req` serializer
  emits only method/url/host/remoteAddress, so request headers never reach the log at
  all. On top of that, `redact` paths cover the case the serializer misses — a route or
  plugin logging `request.headers` directly, where the object is not under `req`.
  `tests/integration/logging.test.ts` asserts both, including that the serializer has
  not been widened.
- `/metrics`: redirect p50/p95/p99, cache hit ratio, click-buffer depth, flush lag, DB
  pool saturation, create conflict-retry count, auth failure rate, quota rejections.
- Cache hit ratio and flush lag matter most — they are the early warning for the two
  failure modes most likely to occur.

## 15. Testing

- **Unit** — code generator (charset, length, uniqueness over many iterations),
  destination policy (every blocked scheme), reserved-word matching, plan-limit
  resolution, and for auth: key entropy and shape, HMAC determinism, the argon2id
  PHC prefix, bearer-header parsing, `isUniqueViolation`'s cause-chain walk, and the
  production-config guards.

Two testing rules this project has already learned the hard way, both from tests that
failed in a way that taught us nothing:

- **A test must not damage shared state on failure.** An early version forced a driver
  error by renaming the `users` table and restored it at the end — so when the assertion
  failed, the table stayed renamed and every later test in the file failed with
  `relation "users" does not exist`, burying the original signal. Fault injection now
  happens through a throwaway app instance with a route that throws.
- **Shared external state needs an explicit reset.** The rate-limit counters live in Redis
  under a per-IP key, so they outlive both `app.close()` and the test process. Without a
  `clearCounters` helper the suite passed once and failed forever after, which is the
  worst possible time to find out.

Where a design rule is load-bearing, the test that pins it is verified to have teeth by
temporarily breaking the code and watching it fail. Three that have been checked this
way: `citext` (§5, fails on `varchar` and then leaves a real duplicate row behind), the
404-not-403 rule (§8, three failures when swapped for 403), and the shared rate-limit
counter (§9, fails with the plugin's in-memory default).
- **Integration** — real Postgres and Redis via Docker Compose. Covers the ON CONFLICT
  retry path, alias 409, negative caching, single-flight coalescing, disable-visibility,
  and specifically: **an unowned link returns 404, not 403** (§8). The schema tests pin
  each constraint the design depends on — case-insensitive email, `ON DELETE SET NULL`
  on `links.owner_id`, cascade on `clicks`, and the additive click upsert — because a
  missing index or wrong delete action is invisible in normal use and quietly breaks a
  guarantee.
- **Load** — autocannon against the redirect path to measure actual p99.

The "sub-millisecond" claim is not credible without a benchmark. Expect p99 around
1–5ms in-region once TLS, network hops, and Node overhead are included; single-digit
milliseconds is the realistic target, and the SLO should be written down as a
percentile rather than a bare number.

## 16. Directory structure

Domain-first. Each module owns its own routes, schemas, service, and repository, so the
cache stays private to the hot path instead of becoming a global layer everything
reaches into.

src/
  app.ts                    buildApp() -> Fastify instance (no listen; used by tests)
  server.ts                 bootstrap, graceful shutdown
  db/schema.ts              Drizzle schema. Under src/ because the app imports it
                            at runtime, so dist/ stays self-contained
  config/
    schema.ts               zod schema + loadEnv(). No side effects; importable anywhere
    env.ts                  eager validated singleton. Throws at boot by design
    plans.ts                PLAN_LIMITS - the single paywall hook
  plugins/                  cross-cutting only
    db.ts                   Drizzle + pg pool + onClose
    cache.ts                ioredis + onClose
    errors.ts               setErrorHandler: one error shape for everything thrown
  modules/
    auth/
      routes.ts             route + JSON Schema, no business logic
      service.ts            register / login / revoke; throws AppError
      repository.ts         all auth SQL, in one place
      key-generator.ts      key entropy, HMAC, shape check
      password.ts           argon2id + the login timing equaliser
      guards.ts             authenticate / optionalAuth / requireOwner
    links/
      routes.ts  schemas.ts  service.ts  repository.ts  code-generator.ts
    redirects/
      routes.ts  resolver.ts  cache-keys.ts
    health/
      routes.ts
  lib/
    errors.ts               AppError + the notFound() that is the only source of 404
    url-policy.ts
  workers/
    click-flush.ts
db/
  drizzle.config.ts         build tooling, excluded from the app build
  migrations/               committed SQL
scripts/
  reset-db.ts               truncate, or --full to drop and replay
tests/
  unit/
  integration/
```

### Why a module has both a service and a repository

`service.ts` holds the rules and throws `AppError`; `repository.ts` holds every SQL
statement. The split is what lets a service be called from a route, a future worker, or a
test without knowing how an error will be rendered — and it means the shape of the auth
data is described in exactly one file. Routes stay thin enough to read as an API
surface: schema, guard, one service call, done.

`key-generator.ts` and `password.ts` are separate from the service for a sharper
reason: they are the two places where a security decision is encoded, and a security
decision that lives inside a 200-line service is a decision nobody re-reads.

### Why config is split in two

`env.ts` validates on import, which is deliberate: a misconfigured server must die at
boot rather than serve traffic with a placeholder `APP_SECRET` — which would mean
HMAC-ing every API key with a publicly known pepper.

The cost is that anything importing `env.ts` inherits that throw. So the schema and
`loadEnv()` live in `schema.ts`, which is side-effect free. Tests and build-time tools
(`drizzle.config.ts`) import that; only the running server imports `env.ts`. These two
were originally one module and the first version of the config tests could not run at
all, because reaching `loadEnv` meant importing a module that validated the ambient
environment first.

## 17. Build order

Each phase is independently verifiable. The order is not arbitrary: auth precedes link
creation because `owner_id` must be in the *initial* migration, not backfilled onto a
table that already holds live rows.

1. **Foundation** — TS/ESM strict, validated env config, `app.ts`/`server.ts` split,
   graceful shutdown, `/livez` + `/readyz`, Docker Compose for Postgres and Redis,
   lint and test runners.
2. **Data layer** — Drizzle schema (`users`, `api_keys`, `links` with `owner_id`,
   `clicks`) and the initial migration. One migration, before anything exists.
3. **Auth** — register, login, key issuance, HMAC hashing, argon2id, the three guards,
   404-not-403 ownership, the one error shape. **Done.**
4. **Create** — `POST /v1/links`: schemas, code generator, reserved words, alias 409,
   ON CONFLICT retry, plan-aware rate limiting, write-through.
5. **Redirect** — resolver, negative caching, single-flight, Redis-down degradation,
   302/404/410 semantics.
6. **Metrics** — click buffer, flush worker, per-user stats endpoint.
7. **Hardening** — Prometheus metrics, load test and SLO validation, idempotency keys,
   API docs, email verification.

Phases 1–5 produce a working, authenticated shortener. Phase 6 is analytics. Phase 7 is
production readiness.
