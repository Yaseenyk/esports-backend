# esports-api

Backend for an esports community hub: event owners manage rosters, issue signed passes, run live gate check-in and let teams self-register. It is a **Cloudflare Worker + D1 (SQLite)** written in TypeScript with [Hono](https://hono.dev) as the only runtime dependency.

It replaces the earlier Express/MongoDB prototype, which is kept untouched in [`legacy-express/`](legacy-express/).

## Privacy by design

The server **never stores a date of birth or any Aadhaar digits**. A person row holds only:

| field | meaning |
| --- | --- |
| `name` | display name |
| `role` | Player / Substitute / Coach / Manager / Staff (free text for owners) |
| `team` | team reference |
| `zones` | access zones |
| `minor` | boolean |
| `guardian` | boolean, "guardian consent recorded" |
| photo (optional) | webp/png/jpeg, at most 400 KB, in its own table |

Unknown fields in a request (for example `dob` or `aadhaar`) are ignored and never written. A test inspects the schema to make sure no such column exists. IP addresses are only ever stored as salted SHA-256 hashes (rate limiting). Logs never contain request data. Gate keys are stored only as SHA-256 hashes; passwords as salted PBKDF2.

## Setup

```bash
npm install
npm run typecheck
npm test            # runs the suite against a local D1 (miniflare)
npm run dev         # wrangler dev (needs a .dev.vars with JWT_SECRET, see below)
```

Local secrets go in `.dev.vars` (gitignored):

```
JWT_SECRET=some-long-random-string
```

### Configuration

| name | kind | notes |
| --- | --- | --- |
| `JWT_SECRET` | secret, required | signs the HS256 login tokens |
| `ALLOWED_ORIGINS` | var | comma list; default `https://esports.streamerosai.com,http://localhost:3000,http://localhost:4173` |
| `PBKDF2_ITERATIONS` | var, optional | default and maximum `100000` (the Workers WebCrypto cap) |

## Deploying (instructions for the owner; nothing here was run)

```bash
# 1. create the database, then copy the printed database_id into wrangler.toml
npx wrangler d1 create esports-db

# 2. apply the migrations to the remote database
npx wrangler d1 migrations apply esports-db --remote

# 3. set the signing secret (paste a long random value when asked)
#    e.g. generate one with: node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
npx wrangler secret put JWT_SECRET

# 4. deploy
npx wrangler deploy
```

For a purely local database use `npx wrangler d1 migrations apply esports-db --local`.

## API

All bodies and responses are JSON, errors look like `{ "error": "message" }`. Authenticated routes use `Authorization: Bearer <token>`. Events that belong to someone else answer **404**, never 403.

| method | path | auth | purpose |
| --- | --- | --- | --- |
| GET | `/` | none | `{ok:true,name:"esports-api"}` |
| POST | `/auth/register` | none | `{email,password,name}` -> `{token,user}` |
| POST | `/auth/login` | none | `{email,password}` -> `{token,user}` |
| GET | `/me` | user | current user |
| GET | `/events` | user | your events |
| POST | `/events` | user | `{name,game,organiser,date,venue,emergency,rules,settings}` |
| GET / PUT / DELETE | `/events/:id` | owner | read, partial update, delete with cascade |
| PUT | `/events/:id/roster` | owner | `{teams:[{id,name,logo?}], people:[{id,name,teamId,role,zones?,minor?,guardian?,photo?}]}`, replaces atomically, returns counts |
| GET | `/events/:id/roster` | owner | teams and people with `photoUrl` |
| GET | `/events/:id/photos/:personId` | owner | photo bytes |
| PUT | `/events/:id/photos/:personId` | owner | extra: upload one photo as a raw image body (400 KB) |
| DELETE | `/events/:id/photos/:personId` | owner | extra: remove a photo |
| GET | `/events/:id/passes` | owner | `[{personId, code}]` for the whole roster |
| POST | `/events/:id/gate-keys` | owner | `{label, expiresInHours?}` -> `{key}` (shown once, `gk_` prefix) |
| GET | `/events/:id/gate-keys` | owner | list, without raw keys |
| DELETE | `/events/:id/gate-keys/:keyId` | owner | revoke |
| GET | `/events/:id/checkins?since=<ISO>` | owner | `{checkins, total, checkedIn}` |
| DELETE | `/events/:id/checkins` | owner | reset check-ins |
| POST / DELETE | `/events/:id/people/:personId/share` | owner | create or revoke a share link `{token}` |
| POST | `/events/:id/invites` | owner | `{teamId,label,maxUses?,expiresInHours?}` -> `{token}` |
| GET | `/events/:id/invites` | owner | list |
| DELETE | `/events/:id/invites/:inviteId` | owner | revoke |
| GET | `/events/:id/submissions?status=pending` | owner | self-submitted people |
| GET | `/events/:id/submissions/:sid/photo` | owner | submission photo |
| POST | `/events/:id/submissions/:sid/approve` | owner | optional `{personId?, guardian?}`; creates the person (id like `ALP-001`) and copies the photo |
| POST | `/events/:id/submissions/:sid/reject` | owner | reject (photo is discarded) |
| GET | `/gate/roster` | `X-Gate-Key` | `{event, people:[{id,name,team,role,zones,minor,guardian,photoUrl,checkedInAt}]}` |
| GET | `/gate/photos/:personId` | `X-Gate-Key` | photo bytes |
| POST | `/gate/checkin` | `X-Gate-Key` | `{code}` -> `{status:"ok"\|"again"\|"bad", reason?, person?, at?}` |
| GET | `/public/pass/:token` | none | pass page data for a share link |
| GET | `/public/pass/:token/photo` | none | photo for a share link |
| GET | `/public/invite/:token` | none | `{event:{name,date}, team:{name}}`, 404 if revoked/expired/used up |
| POST | `/public/invite/:token/submit` | none | `{name, role?, minor?, photo?}` -> 201 |

Revoked or expired gate keys answer 401. `zones` is stored as given (a string or an array of short strings) and returned unchanged.

### Pass format

`EH1.<eventKey>.<personId>.<sig>`

* `eventKey` is the event slug: the name lower-cased, non-alphanumerics to `-`, trimmed, cut to 24 characters, `event` as fallback, unique per owner (`-2`, `-3`, ...). It never changes after creation.
* `sig` = first 16 characters of `base64url(HMAC-SHA256(signing_secret, "<eventKey>|<personId>|<role>"))`, where `signing_secret` is a random 32-byte value per event (UTF-8 bytes of its base64url string are the key). Verification is constant time. A pass is bad when the person is unknown, the role changed, the event differs or the signature does not match.

### Limits

* Request bodies: 1 MB (413 above). Photos: 400 KB decoded, webp/png/jpeg only, content-sniffed (415 otherwise). Team logos: 60 KB data URL. Roster: 2000 people, 100 teams.
* Rate limits (D1 table, hashed IP): 10 login/register attempts per 15 minutes per IP; 30 public submissions per hour per invite and IP.
* Tokens (share, invite, gate keys) are 24 random bytes, base64url. Login tokens are HS256 JWTs with `{sub, exp}` and a 7-day lifetime.

## Free plan notes

* The Worker is written for the Workers Free plan: 10 ms CPU per request. Per-request work is small and indexed, except operations that are inherently proportional to roster size (`/events/:id/passes`, `/gate/roster`, roster replace).
* Password hashing is PBKDF2-SHA256 at 100000 iterations (the highest value Workers allows). The CPU time of that on the Free plan has not been measured. If login or register hits the CPU limit, lower `PBKDF2_ITERATIONS` or move to the paid plan.
* D1 Free limits to be aware of: 50 queries per Worker invocation (a roster replace uses a handful of statements thanks to JSON-batched inserts, plus one per inline photo), 5 GB total storage, 100 000 writes/day. Photos are stored in D1 as BLOBs. For rosters with many photos, upload them one by one with `PUT /events/:id/photos/:personId` instead of inlining them in the roster (the 1 MB body limit applies to the roster request).
* Tests run against a local D1 (`@cloudflare/vitest-pool-workers`, which is deprecated in favour of `@cloudflare/vitest-plugin`; it works but the package may need migrating later).
