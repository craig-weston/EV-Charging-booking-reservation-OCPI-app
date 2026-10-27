# Secure development

How Depotcharge is built and changed, mapped to the UK government's **Software Security Code of
Practice** (DSIT and NCSC, May 2025). The code is voluntary, but it is what customers and Cyber
Essentials point to for software you build yourself, since bespoke code is outside Cyber
Essentials' scope.

## The code of practice, principle by principle

| # | Principle | How we meet it | To do |
| --- | --- | --- | --- |
| 1 | Follow an established secure development framework | This document, OWASP ASVS level 2 as the reference for web controls, OWASP API Security Top 10 for the API | Record which ASVS items are verified at each release |
| 2 | Understand the composition of the software and the risks of third-party components | Two runtime dependencies (React, React DOM); build tools pinned; `package-lock.json`; `npm ls --all` gives the full tree; licences listed at `/#/legal/licences` | Generate an SBOM at release (`npm sbom --sbom-format cyclonedx`) |
| 3 | Test software and updates before distribution | CI runs type checks, the test suite (OCPI flows, booking logic, security controls) and a row level security check on Postgres for every pull request | Add a pre-release manual test of sign-in and two-step verification against a staging Supabase project |
| 4 | Secure by design and by default | Two-step verification enforced for admins; strict Content-Security-Policy; deny-by-default authorisation (every fleet route checks membership; RLS as a second layer); secrets encrypted or hashed; simulator off by default; uploads validated | |
| 5 | Protect the build environment | GitHub organisation with 2FA required; branch protection on `main`; CI with read-only `contents` permission and actions pinned to commit SHAs; Cloudflare builds from `main` only | Restrict who can change Cloudflare build settings and environment variables |
| 6 | Control and log changes to the build environment | Changes go through pull requests; GitHub and Cloudflare keep audit logs | Review those audit logs in the quarterly access review |
| 7 | Distribute software securely | Delivered only over HTTPS with HSTS from Cloudflare Pages; content-hashed asset names; no third-party scripts or fonts | |
| 8 | Publish a vulnerability disclosure process | [`SECURITY.md`](../../SECURITY.md), `/.well-known/security.txt` (from `SECURITY_CONTACT`), and the in-app Security page | |
| 9 | Detect, prioritise and manage vulnerabilities in components | Dependabot alerts and updates; `npm audit --audit-level=high` in CI on every change and weekly | |
| 10 | Report vulnerabilities to relevant parties | If we find a flaw in a dependency or an operator's OCPI implementation, we report it privately to its maintainer or operator | |
| 11 | Provide timely security updates | High and critical fixes within 14 days; as a hosted service, customers get fixes without doing anything | |
| 12 | Tell customers the level of support | The terms of service describe support and availability, and commit to security updates for as long as the service runs | Publish support hours and response times in order forms |
| 13 | Give at least a year's notice before ending support | The terms commit to at least 12 months' notice before the service ends | |
| 14 | Tell customers about notable incidents | Incident response plan: fleet owners told without undue delay, within 48 hours for breaches of their data | |

## How changes are made

1. Work on a branch; open a pull request to `main`.
2. CI must pass (typecheck, tests, build, dependency audit, RLS check).
3. At least one other person reviews it, with extra care for anything touching authentication,
   authorisation (`requireMember`, `adminRoutes`), the OCPI receiver, the database migration or
   RLS policies, `public/_headers` and `server/security.ts`.
4. Database changes are new files in `supabase/migrations/`; never edit one that has run.
5. Merging to `main` deploys to production. Preview deployments must not be able to reach
   production data (see the security policy).

## Rules for this codebase

- **Authorisation on the server, always.** The Functions use the Supabase service-role key, so
  every fleet route must call `requireMember` (and check the role for writes) and every lookup by
  ID must confirm the row belongs to that fleet. RLS stays as defence in depth.
- **Validate input** at the API boundary: types, lengths, formats, allowed values. Bodies are size
  limited (`readLimited`); OCPI objects from operators are only accepted for the parties their
  credentials cover.
- **No secrets in the browser.** Only the Supabase URL and publishable (anon) key reach the client.
  Tokens we issue are stored as SHA-256 hashes; tokens we hold are AES-256-GCM encrypted; neither is
  written to logs (the OCPI log redacts them).
- **Keep the CSP strict.** No inline scripts or `<style>` elements, no `eval`, no third-party
  origins. Set styles through React's `style` prop or CSS files. If you must add an origin, add it
  to `public/_headers` deliberately and note why.
- **Outbound calls to operators** go through `ocpiCall`: https only to public hosts (checked at
  registration), no redirects followed, pagination kept on the same host, response size capped,
  15-second timeout.
- **Bearer links** (driver passes, invites) use 24 random bytes, expire, and can be revoked.
- **Errors** shown to users never include stack traces or database messages; the server logs them
  with a short reference.
- **Audit** security-relevant actions with `audit()` in `server/api/router.ts`.

## Threat model summary

| Asset | Main threats | Controls |
| --- | --- | --- |
| User accounts | Phishing, password reuse, guessing | 12-character minimum with deny list, Supabase rate limits, TOTP two-step verification (required for admins, optional per fleet), sign out everywhere |
| Fleet data (plates, drivers, bookings) | Another tenant reading it; insider misuse | Membership checks on every route, RLS, roles, audit log, export only by owners |
| Operator credentials | Database leak; log leak; token sent to the wrong host | Hashing and encryption at rest, log redaction, URL checks, no redirects |
| OCPI receiver | Forged pushes; one operator changing another's data | Token authentication, party ownership checks, rate limits and auth-failure lockout, body limits |
| Driver pass links and team invites | Link forwarded or guessed; links taken from a database copy or backup | 24-byte random tokens, rate limits on lookups, expiry, revocation, minimal data on the pass; stored encrypted (AES-256-GCM) and looked up by SHA-256 |
| The web app | XSS, clickjacking, malicious dependencies | Strict CSP, React escaping, frame-ancestors none, pinned and audited dependencies |
| Admin functions | Stolen admin session | MFA required, separate role, audit log, recovery needs a recorded identity check |

## Testing

- Automated: `npm test` (including `tests/security.test.ts`), `npm run typecheck`, the RLS check
  in `tests/sql`.
- Before launch and then yearly, or after major changes: an independent penetration test of the
  web app, API and OCPI interface by a CREST-accredited tester. Track findings to closure
  (high and critical within 14 days).
