# Contributing to Depotcharge

Thanks for helping make fleet charging simpler. Fleet operators, charge point operators, software
providers and individual developers are all welcome.

## Ways to help

- **Try it and tell us what's missing.** Open an issue describing your fleet or network and what
  you needed.
- **Connect a real operator.** Reports from OCPI 2.3.0 integrations (what worked, what an
  operator's implementation did differently) are especially valuable.
- **Fix a bug or build a feature.** Comment on an issue first for anything large, so we can agree
  the approach.
- **Improve the docs**, including translations of the driver pass.

Security problems: please don't open an issue. Follow [SECURITY.md](SECURITY.md).

## Getting started

```bash
npm install          # Node 22+
npm run dev          # demo mode at http://localhost:5173: API, OCPI and a simulated operator network in your browser
npm test             # OCPI flows, booking logic, security controls
npm run typecheck

# Browser tests (real Chromium, production CSP, axe-core accessibility checks):
npm install --no-save playwright axe-core && npx playwright install chromium
npm run build && npm run test:e2e
```

No Supabase or Cloudflare account is needed for development: demo mode runs the whole stack
in the browser.

## Pull requests

1. Fork the repo and create a branch from `main`.
2. Keep changes focused, with tests for new behaviour (`tests/*.test.ts`).
3. Run `npm test` and `npm run typecheck` before pushing; CI also builds, audits dependencies,
   checks row level security against Postgres, and runs the browser and accessibility tests.
4. Database changes go in a **new** file in `supabase/migrations/`; never edit one that has run.
5. Follow the rules in [docs/compliance/secure-development.md](docs/compliance/secure-development.md):
   authorisation on every API route, input validation, no secrets in the browser, no inline
   scripts or third-party origins (the Content-Security-Policy forbids them).
6. Describe what changed and why in the pull request.

By contributing you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), the same as the project.

## Code of conduct

Everyone taking part is expected to follow the [code of conduct](CODE_OF_CONDUCT.md).
