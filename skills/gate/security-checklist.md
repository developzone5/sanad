<!-- Author: Eng. Mohammed Almutairi - Developzone.net -->
<!-- Full security gate checklist. Loaded by /gate; also load it directly whenever a
     change touches auth, data access, money, file/URL handling, or user input.
     The always-on summary lives in ~/.claude/CLAUDE.md ("Security gate" section). -->

# 🔒 Security gate — the full checklist

Run this whole checklist. If a change touches auth, data access, money, file/URL handling, or user input, call out the risk + mitigation in your report. (API names below are .NET — map them to your framework's equivalent.)

**Quick table — what the gate report must show per touched risk** (the sections below hold the detail; this table is the report's shape, not a waiver):

| Touched | Required proof in the report |
|---|---|
| New or changed endpoint / page | anonymous → 401, wrong role → 403, not-owner → 404/403 test names; tenant filter named |
| Query, migration, raw SQL | parameterized; tenant filter; index in the same migration; generated SQL quoted |
| File upload / download / path | extension + magic-byte check; generated storage name; served as attachment + nosniff; path stays under root |
| Login, session, password, SSO | vetted KDF / OIDC library; lockout; no enumeration; session regenerated; tokens hashed and single-use |
| Outbound HTTP, redirect, webhook | host allowlist + IP validation; local-only redirect; HMAC over raw body in constant time |
| Money or state transition | server recompute; idempotency key in a shared store; re-authorization per step |
| Config, env, packages | no secret in tracked files; dependency scan High/Critical = block; headers unchanged or justified |
| User input rendered or logged | encoder matches the sink; structured log template; no raw HTML from input |

**Reading order — start where the change bites, then sweep the rest.** This routes attention; it does NOT waive sections.
- New/changed endpoint or page → Access control · Validation & API surface · Prove it.
- Login, session, password, MFA, SSO → AuthN & session · Crypto · Logging & audit.
- Query / DB / migration → Injection (SQL) · Access control (tenant filter) · Logging & audit.
- File upload/download/path, exports → Injection (path/CSV) · Validation (uploads/archives) · Config (headers).
- Outbound HTTP, webhook, redirect, email → SSRF & redirects · Injection (CRLF/email).
- Parsing external input (JSON/XML/archives) → Deserialization & XML · Validation.
- Config, deploy, env, packages → Config & headers · Secrets · Dependencies.
- Money or state transitions → Access control (re-authorize every step) · Validation (idempotency, server recompute).

## Access control (A01)
- Deny-by-default: register a global authenticated-user fallback policy; anonymous access is the only opt-out and must be explicit + justified. A forgotten authorization attribute must fail closed.
- Authorize every action AND every verb — protect POST/PUT/PATCH/DELETE, not just the GET that renders the form.
- Resource ownership enforced server-side via a real authorization check + handler — not ad-hoc `WHERE UserId=…` per action. Owned-resource denial → 404 (don't confirm the row); pure role/function denial → 403.
- Never trust a client-supplied id for ownership (IDOR). Re-derive role/claim/ownership from the server store each request, never from a value the client echoes back (hidden field, temp data, token).
- UI hiding ≠ authz. Every privileged action (role grant, user disable, price/quota/config change, export, impersonation) carries its own policy. Block self-escalation: acting user id must differ from target for role grants / self-approval.
- Named policies referenced by name — no scattered `IsInRole("Admin")` literals. Constants/enums for role names.
- Multi-tenant isolation at the data layer: a global query filter on tenant id driven by a request-scoped tenant resolved from the principal, never a client header/route/body. Set tenant id server-side on insert. Any filter bypass / raw SQL must be explicit + separately authorized — one missing filter leaks every tenant.
- Re-authorize EVERY step of multi-step/state-transition flows (wizard, checkout, approve/cancel): re-load, re-verify ownership/tenant AND that the current state permits this transition for this role. Enforce the state machine server-side.
- Authz parity across surfaces — REST, JSON API, file download, realtime hubs enforce identical checks.

## AuthN & session (A07)
- Passwords only via a vetted KDF (PBKDF2 with a high iteration count, or Argon2id/bcrypt) with a per-user salt — never MD5/SHA1/SHA256/unsalted/plaintext, never a custom compare. Passwords are hashed, never encrypted.
- Password policy per current NIST guidance: length is the control (≥ 12, or ≥ 8 with a breached-password check) — allow long passphrases and paste, screen candidates against a known-breached list, no forced composition rules or periodic rotation.
- Sign in with lockout-on-failure enabled (~5–10 attempts). Lockout complements, not replaces, IP/edge rate-limit against distributed credential stuffing.
- Offer TOTP MFA (at least for admin/privileged): single-use recovery codes, step-up re-auth for password/email change + MFA disable.
- External login/SSO only through a vetted OIDC library: authorization-code + PKCE, validate `state` and `nonce`, exact-match redirect-URI allowlist — never hand-rolled token exchange or implicit flow.
- No user enumeration: login/register/forgot-password return identical message, status, and comparable latency whether the account exists or not. Forgot-password always succeeds with "if an account exists, an email was sent".
- Reset/confirm tokens are framework-generated, short-lived (15–60 min), purpose-scoped. If self-persisted: store a hash only, single-use, delete on use. Never log tokens or put them in query strings.
- On reset / password / privilege change: invalidate live sessions (rotate the security stamp) and refresh the current one; keep the validation interval short.
- On login regenerate the identity (fresh ticket) — never reuse a pre-auth cookie (session fixation). Logout fully signs out.
- Auth cookie: `HttpOnly`, secure-always, `SameSite=Lax` (Strict for same-site admin), host-prefixed. Idle expiry + sliding renewal AND an absolute cap.

## Injection & output (A03)
- Parameterized queries only — never string-built SQL. Allowlist any client-supplied sort/filter/include column against known names before dynamic ordering/raw SQL. Keep risky DB features (e.g. `LOCAL INFILE`) disabled.
- Templating: the encoder must match the sink. Ban raw-HTML helpers on user input. JS context: emit as JSON in a data island + parse — never interpolate into `<script>`. URL context: encode + validate the scheme is http/https before `href`/`src` (block `javascript:`/`data:`). If user HTML must render, sanitize server-side.
- Path traversal: never concat user input into a path. Take the file name only, combine with a server-owned root, resolve the full path, verify it stays under the root else 404. Reject `..`, rooted/UNC paths, device names, trailing dots/spaces. Downloads serve the validated physical path — never a user-supplied name.
- OS command: no shell strings from input; prefer in-process APIs; if unavoidable pass args as a list (one element per arg) + allowlist the executable.
- CRLF/header injection: strip CR/LF before any response header/redirect/cookie; set download filename via the RFC 6266 filename* parameter.
- Email: never interpolate user input into To/Cc/Bcc/Subject/From — reject CR/LF, use a real MIME builder. LDAP/XPath: escape or parameterize, never concatenate.
- CSV/Excel export: prefix any cell starting with `=`/`+`/`-`/`@`/TAB/CR with `'`; quote per RFC 4180.
- ReDoS: never compile a regex from user input; use a source-generated/non-backtracking engine, always a match timeout (~100ms), cap input length first.

## Crypto & data, at rest/in transit (A02)
- Unguessable values (reset tokens, API keys, OTP, upload keys) from a cryptographic RNG — never a non-crypto PRNG/ticks/incrementing ids. URL-safe, ≥ 128 bits.
- Reversible secrets/PII at rest: an authenticated cipher (AES-GCM) with a key from the secret store — never ECB or a hardcoded key/IV. Banned: MD5, SHA1, DES/3DES, ECB, custom XOR.
- Compare secrets/tokens/HMACs in constant time — never `==`/ordinary sequence-equality.
- JWT (if exposed): asymmetric (RS256/ES256) or HS256 with a ≥256-bit secret, pin allowed algorithms (reject `alg:none`), validate issuer+audience+lifetime+signature, short access-token life + rotated refresh.
- DB connections require TLS over the network — never disable/downgrade it.

## Config, headers & TLS (A05)
- Security-header middleware on every response: a strict CSP (`default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'`; no `'unsafe-inline'`/`'unsafe-eval'`; per-request nonce if a vendor needs inline), plus `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, `X-Frame-Options: DENY`. CSP report-only first, then enforce.
- Enable HSTS in prod only (never dev — it poisons localhost), max-age ≥ 1y + includeSubDomains, alongside HTTPS redirection.
- Behind a proxy: process forwarded headers with a known-proxy allowlist set BEFORE auth — else "is HTTPS" is false and HSTS/secure cookies silently no-op.
- Gate diagnostics on the dev environment (detailed error pages, API explorers, sensitive-data logging). Prod uses a generic error handler. Set the environment to Production in the runtime image.
- CORS (JSON APIs only): a named policy with explicit origins/methods from typed config; never allow-any-origin together with credentials. Server-rendered apps stay CORS-free.
- Caching: `Cache-Control: no-store` on authenticated/personalized/sensitive responses (browser AND shared proxies); anything cacheable must never vary on a secret or session. Static assets: long-lived immutable caching under fingerprinted names only.
- Strip fingerprint headers (server banner, `X-Powered-By`). No directory browsing; serve only the public web root; keep config/secrets/source out of it.
- Shared key-ring across instances (cookies, anti-forgery, reset tokens): persist keys to a shared store + pin an application name + protect them with a cert. Without it, those tokens forge or invalidate on restart/scale. Never "fix" the errors by disabling protection.

## Validation & API surface (A03/A04/A08)
- Anti-forgery on every state-changing request (global auto-validation). Cookie-auth APIs still need it (header token) or a Bearer/custom-header scheme.
- Over-posting: never bind a persistence entity from a request — bind an explicit input DTO of only client-editable fields, then map field by field. Server-owned columns (id, owner id, timestamps, role/admin flags, status, row-version, prices, FK owners, tenant id) are set server-side. On update: load the row, copy allowed fields, save. Treat blanket model-binding/`Update(entityFromForm)` as a bug.
- Money and business limits are recomputed server-side: totals, prices, discounts, and quantities derive from server data, never a client-echoed amount; clamp quantities/amounts to sane positive ranges; enforce coupon/stock/limit rules atomically in the DB (guarded UPDATE / unique constraint), not in app-side checks.
- Cap payload before model binding: max body size globally + per-endpoint; form limits → 413 not buffer; bound collection size / validation depth.
- Every DTO property constrained: required/length/range, anchored regex with a timeout, enums bound by type. Validate international free text by Unicode category/length, not ASCII regex. Model validation is mandatory; return 400 with a problem-details body — never silently truncate.
- JSON APIs: explicit binding source per parameter, restricted content type, no polymorphic JSON bound to a client-controlled type discriminator.
- File uploads: extension allowlist + magic-byte check, size cap at the pipeline, store under generated names (never the user filename as a path component). Serve them back with `Content-Disposition: attachment` + `nosniff` from a non-executing location — an inline-rendered SVG/HTML upload is stored XSS.
- Archive input (zip, office docs, imports): resolve every entry path under the extraction root before writing (zip-slip), cap entry count AND total decompressed size (zip bomb) before extracting.
- Pagination mandatory on every collection endpoint — page/pageSize clamped to a server-const max, capped before materialization. Same ceiling on exports (stream, don't buffer).
- Idempotency/anti-replay on sensitive non-GET (payments, order submit, role change): a client idempotency key or server one-time token in a SHARED store. Layers on optimistic concurrency.

## SSRF, redirects & outbound HTTP (A10)
- Never pass a user-influenced URL straight to an HTTP client. Require a host allowlist; reject non-https. Resolve DNS yourself, validate EVERY returned IP against loopback / private ranges (`10/8`, `172.16/12`, `192.168/16`, `169.254/16` incl. `169.254.169.254`) / IPv6 ULA + link-local / IPv4-mapped IPv6 forms (`::ffff:10.0.0.1`), then connect to the validated IP (pin it to close DNS-rebind). Re-validate every redirect hop.
- Disable auto-redirect on user-influenced fetches; if you must follow, cap hops and re-run scheme+allowlist+IP checks per redirect. Strip auth/cookie headers on cross-origin redirects.
- Outbound clients via a pooled factory (never a fresh per-call client): timeout, header-read streaming, a hard byte ceiling on the body. NEVER disable cert validation. Centralize user-influenced fetching behind ONE vetted client.
- Open redirect: never redirect to or set a location from request input. Use a local-only redirect / is-local-url check, falling back to a fixed path — covers login return URLs, post-action redirects, OAuth state, culture switches.
- Inbound webhooks (anonymous by design — the signature IS the auth): recompute the HMAC over the RAW body bytes, compare in constant time, 401 on mismatch, enforce a timestamp/nonce window against replay, exempt explicitly from anti-forgery (don't disable it globally).

## Deserialization & XML (A08)
- Banned: any type-aware/polymorphic binary deserializer on untrusted input. Use a plain JSON serializer with type-name handling off. Deserialize untrusted input into explicit DTOs only — no `object`/`dynamic`, no attacker-controlled type discriminator.
- Any XML parse of external/user input (uploads, SVG, office docs, config import): disable DTD processing and external entity resolution. Treat XXE = SSRF-via-DTD.

## LLM & model output (if the app calls one)
- Model output is untrusted input, same as a request body: encode before rendering, never eval/execute it, never pass it unvalidated into a SQL/shell/URL/file-path sink. Any tool/function call the model triggers runs under the CALLING USER's authorization — never a blanket service credential.
- Prompts are an exfiltration surface: no secrets/keys/PII in prompts sent to an external provider. User-supplied content embedded in a prompt is hostile (prompt injection) — it must never be able to override the instructions that gate an action; keep the action gate in code, not in the prompt.

## Secrets (A05)
- Secrets NEVER in committed config. Dev → a local secret manager; prod → env vars / secret store injected at runtime. Keep keys present but empty as shape docs.
- Never bake secrets into the image: no build-arg/env secrets (they persist in image history), no copying real config/.env. The ignore file excludes dev config, `.env`, secret paths, build output, VCS dirs.
- Secrets stop at the server boundary: never reach templates/inline scripts/data attributes/any client model (expose only publishable client keys). Never in a URL/query string — use a POST body or headers.
- One secret = one purpose = one environment. The app's DB user gets DML on its own schema only — no all-privileges/root/DDL at runtime; run migrations under a separate elevated credential.
- Any secret that ever touched a commit/pushed branch/log/screenshot is COMPROMISED — ROTATE at the source + redeploy; history scrub is cleanup, not the fix. A `git rm` + force-push alone is insufficient.

## Logging & audit (A09)
- Never log: passwords, tokens, secrets, connection strings, PII, full request bodies, auth/cookie headers. Register a masking policy on sensitive property names so it doesn't depend on memory.
- Structured templates only (`"Login failed for {User} from {Ip}"`) — never interpolate user input into the message (CRLF log forging). A JSON formatter so control chars are escaped.
- An append-only audit row (not just a log line) for every security event (login success/failure, logout, lockout, password/MFA change, role grant/revoke, 403 denial, data export, admin/destructive action): event type, UTC, actor id + name-at-time, subject id, outcome, source IP, user-agent, correlation id. Write it in the SAME transaction as the state change.
- Audit table append-only at the data layer: insert+select grants only, hash-chain rows for tamper-evidence, ship off-box to a write-only sink.
- Alert on patterns (logging without alerting fails A09): repeated authn failures/lockouts, 403/401 bursts, anti-forgery rejections, unusual export volume. Fail safe if the sink is unreachable.
- Retention per data class (security audit ≥ 1y). A correlation id from the edge propagated across instances + outbound calls.

## Dependencies (A06)
- No new dependencies without asking. Verify the exact package name + publisher when adding (typosquats ship malware). Scan for vulnerable + deprecated packages before adding and before every PR — High/Critical blocks merge. Commit the lockfile, restore in locked mode. Pin base images by digest; scan the final image, fail on High/Critical.

## Prove it
Every state-changing or owned-resource endpoint ships negative tests — anonymous → 401/redirect, wrong role → 403, not-owner → 404/403 (IDOR probe with another user's row id), cross-tenant id → 404 (multi-tenant apps), missing anti-forgery → rejected. "I added authorization" is not proof; a passing 403/IDOR test is.
