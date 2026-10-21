# Security policy

## Reporting a vulnerability

Please report security problems privately to the contact in `/.well-known/security.txt` on the
live site, or the security contact on its **Security** page (`/#/legal/security`). Don't open a
public issue.

Include what you found, where (URL or file), how to reproduce it, and what an attacker could do with
it. We acknowledge reports within **3 working days**, keep you updated, and aim to fix high and
critical issues within **14 days**.

Good-faith research is welcome. Please:

- only use accounts and data you own or have permission to use;
- don't access, change or delete other people's data, and stop if you reach any;
- don't degrade the service (no denial of service, spam or automated scanning at volume);
- don't test real charge point operators' systems through the OCPI interface;
- give us reasonable time to fix the issue before telling anyone else.

We won't take legal action against research that follows these rules.

Out of scope: the in-browser demo mode and the CPO simulator (fictional data by design), missing
headers with no demonstrated impact, social engineering, and reports from automated scanners
without a working proof.

## Supported versions

Only the latest deployment of the `main` branch is supported. Security fixes are not backported.

## How this project stays secure

- Dependencies are pinned (`package-lock.json`, `save-exact`), checked by `npm audit` on every
  change and weekly in CI, and updated by Dependabot.
- Tests in `tests/security.test.ts` cover the security controls; `tests/sql/rls_check.sql` checks
  database isolation between fleets.
- Policies, the Cyber Essentials readiness pack and data protection records are in
  [`docs/compliance`](docs/compliance/README.md).
