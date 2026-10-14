# Security report — OWASP Top 10 round

Scope: the store application, its server, and the payment integration, as of commit `f2113df`
(9 Oct 2026). Part 1 is complete. Part 2 runs on go-live day, because it needs the store live on
its domain.

**Part 1, done:** code review against each OWASP Top 10 (2021) risk, with every control backed by
an automated test that runs on every change (217 tests); secrets scan over the full git history;
server hardening verified from outside.
**Part 2, on go-live day:** OWASP ZAP baseline and authenticated scans against the live domain;
`npm audit` and an image scan; header check through Cloudflare; findings fixed and re-scanned.
Results are added below.

## Results by risk

| # | Risk | How the store handles it | Proved by |
|---|---|---|---|
| A01 | Broken access control | Every admin page and action sits behind the session guard. A customer's order is looked up **with their account id inside the query**, so another customer's order is a 404, not a 403. Guest lookup needs order number **and** email. Unpublished products 404 like missing ones. | `admin-*.test.ts` "needs a signed-in admin"; `account.test.ts` "another customer's order is a 404"; `lookup.test.ts`; `shop.test.ts` "inactive product 404s" |
| A02 | Cryptographic failures | Name, email and address are AES-256-GCM encrypted, each bound to its column; email lookups via HMAC blind index. Passwords argon2id. Session cookies hold a random token; the database stores only its SHA-256. Exports and backups are locked to the client's age key; the server cannot open them. HTTPS end to end (Cloudflare Full Strict, HSTS). | `crypto.test.ts` (16 tests); `checkout.test.ts` "stored encrypted"; `age.test.ts`; `admin-export.test.ts`; `account.test.ts` "only its hash is stored" |
| A03 | Injection | Every query is parameterised (Kysely); no string-built SQL. Templates escape everything; no `safe` filter anywhere. Product text, policy pages, names and codes are tested with script payloads. | `shop.test.ts` "description text is escaped"; `admin-products.test.ts` "shown back escaped"; `pages.test.ts`; `checkout.test.ts` |
| A04 | Insecure design | Totals re-priced inside the order transaction with stock rows locked; an order is never placed at a total the customer did not see; one order per form. Payment state changes only through one state machine with the order locked; replays and out-of-order events are no-ops. Data minimised by design (no phone, no address on accounts). | `checkout.test.ts` "double-click places one order", "price changed"; `payments.test.ts` (22 tests) |
| A05 | Security misconfiguration | Strict Content-Security-Policy (no third-party anything), `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, HSTS. Config validated at startup; the store refuses to start half-configured. Errors show a request id, never a stack trace. File upload limited to one route. | `routes.test.ts` "security headers"; "a 404 reveals nothing"; `admin-images.test.ts` "multipart anywhere else is refused"; `payments.test.ts` "page security policy" |
| A06 | Vulnerable components | Few dependencies, pinned; `ignore-scripts=true` so no package runs code at install. `npm audit` in CI on every push (0 known vulnerabilities at last run). Docker images rebuilt on every deploy; OS security updates install nightly. | CI step "Audit production dependencies" |
| A07 | Identification and authentication failures | Same message and same timing for wrong password and unknown account; per-account lockout (5 failures, doubling); per-address rate limits; session cookies httpOnly, SameSite; new session id at every sign-in; password change signs out other sessions. Registering an existing email is indistinguishable from a new one. | `routes.test.ts`; `account.test.ts` "five wrong passwords lock the account", "looks exactly like a new one"; `pages.test.ts` password change |
| A08 | Software and data integrity failures | Payment webhooks are HMAC-verified over the raw body before anything is read; each delivery stored once by id. The deployed image is the exact one tested and smoke-tested in CI; the deploy key can only run the deploy script; the server's host key is pinned. Migrations are checksummed and refuse edited history. | `payments.test.ts` "without a valid signature is refused", "applied once"; `docs/04_TECH_DECISIONS.md` (Deploy pipeline) |
| A09 | Logging and monitoring failures | Every admin action is audited (who, what, which fields), including each time an order's address is viewed. Logs carry request ids and outcomes, never personal data. Purge runs and payment reconciliation are recorded. | `routes.test.ts`; `admin-orders.test.ts` "the opening is recorded"; deliverable `15_no_pii_in_logs.png` |
| A10 | Server-side request forgery | The store never fetches a URL supplied by a user. The only outbound calls are to the client's own BTCPay at a fixed configured address. Photos are uploaded, never fetched by URL. | Code review: `src/lib/btcpay.ts` is the only `fetch` |

## Found and fixed during the build

1. **CSRF protection registered but not applied** to sign-in (23 Sep). Fixed; both directions tested.
2. **CSRF check ran before the form was read**, rejecting every sign-in (23 Sep). Fixed; tested.
3. **Forgeable visitor address**: `X-Forwarded-For` was appended to, not replaced, so per-address
   limits could be bypassed (25 Sep). Fixed at the proxy. *Verify through Cloudflare at go-live.*
4. **Production build served an error on every page** (29 Sep): tests ran from source. Fixed; CI
   now smoke-tests the real image.
5. **Checkout would have been blocked by the store's own security policy** at the redirect to
   BTCPay (9 Oct): browsers apply `form-action` to redirects. Fixed; regression test.
6. **Purge job would crash on the first night deletion was switched off** (4 Oct). Fixed; tested.
7. **UltaHost image re-enabled SSH passwords at every boot** (28 Sep). Disabled permanently;
   verified across two reboots.

## Secrets scan (9 Oct)

24 commits, full history: no private keys, cloud keys, API tokens or age secret keys; no `.env`,
`.pem`, `.key` or `.age` file ever committed; no secret values assigned in tracked files. All
production secrets were generated on the server and have never been on a developer machine.

## Part 2 — live checks (9 Oct, store live at https://madlabsoil.net)

- [x] **ZAP baseline against the deployed app** (internal network): first run 0 failures, 7
      warnings, 60 passed. Three were real and fixed the same hour (commit `e8e62bf`): the app's
      own CSP had picked up a library default allowing fonts from any HTTPS site; the app now
      also sets Cross-Origin-Embedder-Policy and Permissions-Policy itself. Re-scan: **0 failures,
      3 warnings (all informational: pages marked no-store, a sign-in form exists), 64 passed.**
- [x] **ZAP baseline against the live domain through Cloudflare**: 0 failures, 6 warnings, 61
      passed. One real (Low): the `_csrf` cookie lacked the Secure flag. Fixed (`c2f21b2`) and
      verified live: `HttpOnly; Secure; SameSite=Strict`. The other five are informational
      (cache directives on no-store pages, an echoed order number that is escaped, sign-in and
      session cookies identified).
- [x] **Headers through Cloudflare**: CSP (form-action allows only `https://pay.madlabsoil.net`),
      HSTS with preload, X-Frame-Options DENY, nosniff, no-referrer, Permissions-Policy,
      COOP/COEP/CORP same-origin. Server header shows only `cloudflare`.
- [x] **Forged visitor address** (item 3 above, open since 25 Sep): seven requests each claiming
      a different address via `X-Forwarded-For`, `X-Real-IP` or `True-Client-IP` were all
      counted against the real address and the sixth was refused (429). Requests carrying a
      forged `CF-Connecting-IP` are rejected by Cloudflare before reaching the server. **Closed.**
- [x] **Direct access to the server's IP** on 443 and 80: no answer. Only Cloudflare gets in.
- [x] **Cloudflare Pro firewall** (10 Oct, set by the developer in the client's dashboard, checked
      from outside): `POST /webhooks/btcpay` from the internet gets Cloudflare's 403 block page
      (the real webhook arrives inside the server); `http://` redirects to `https://`; a TLS 1.1
      connection is refused (not conclusive on its own: this test machine also refuses TLS 1.1);
      shop, checkout, admin login and payment pages answer normally. Rate-limit rule (20 POSTs a
      minute per IP on login, checkout, order lookup) deliberately not triggered.
- [x] **Managed rulesets** (Cloudflare Managed + OWASP Core, both active, 10 Oct): probes from
      outside get 403 for a script tag, SQL injection and a log4j-style string in the query. A
      `../../etc/passwd` query value still passes (below the OWASP score threshold); the app never
      reads files from request input, so nothing is exposed. Shop, policy pages, order lookup,
      admin login, assets and payment server unaffected.
- [x] **Payment webhook path on the server**: from BTCPay's network, a wrong signature is
      refused (401); a correctly signed delivery is accepted and processed.
- [x] **Rollback drill**: a deliberately broken release deployed through the real deploy script
      never became ready; the previous release was restored automatically, the deploy reported
      failure, and the store answered healthy afterwards.
- [x] **Restore drill on the server**: a real backup, encrypted by the store, opened by the
      reference `age` tool, restored into a throwaway database: 17 tables, 5 migrations, matching
      live. The reference tool's own files also open with ours (interop both ways).
- [x] `npm audit --omit=dev`: 0 vulnerabilities (CI, every push).
- [x] **Signed-in admin scan** (10 Oct, `.github/workflows/security-scan.yml`, run on commit
      `c0bb7d2`): OWASP ZAP baseline with a throwaway admin session against a throwaway copy of
      the store. The spider reached the signed-in pages (orders, products, discount codes, pages,
      export, settings, password; 92 endpoints). **0 High, 0 Medium, 0 Low**, 4 informational.
      The session is injected as a fixed header, so no admin form could be submitted by the scan.
- [x] **Image scan** (10 Oct, same workflow): Trivy over the production image. First run: 0 in
      the OS layer after upgrades, but 11 HIGH and 9 MEDIUM inside npm's own bundled packages
      (brace-expansion, pacote, sigstore, http-cache-semantics, ip-address and others) shipped by
      the Node base image and never used at runtime. **Fixed** by removing npm, npx, corepack and
      yarn from the runtime image and upgrading Alpine packages at build (`c736855`, `c0bb7d2`);
      CI now fails if a package manager reappears. Re-scan: **0 vulnerabilities** across the OS and
      all 125 npm packages. Repeats weekly; fails on any fixable HIGH or CRITICAL.
- Note on the scanner itself: Trivy's release channel was compromised in March 2026 and its
  2022–March 2026 releases withdrawn. The scan job is pinned to a later release (v0.74.0),
  checksum-verified, and runs with no secrets and read-only access, apart from deploys.

### Found by the live checks
8. **The restore drill could not read the key** on the server (the app container runs
   unprivileged). Fixed (`e8e62bf`); the drill then passed.
10. **CSRF cookie without Secure** on the live site (ZAP). Fixed and verified (`c2f21b2`).
9. **Web server and BTCPay both wanted port 80.** Removed the web server's port 80: Cloudflare
   in Full (strict) only uses 443 (`370584f`).
