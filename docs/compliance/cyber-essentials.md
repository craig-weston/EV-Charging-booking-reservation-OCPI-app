# Cyber Essentials readiness

Cyber Essentials is the UK government-backed scheme, delivered by IASME for the National Cyber
Security Centre (NCSC), that certifies an organisation's protection against the most common
internet attacks. This document gets the organisation that runs Depotcharge ready for it.

> **What gets certified is your organisation, not the app.** The assessment covers the devices
> your people use, the networks they connect from, their accounts, and every cloud service that
> holds your data. Depotcharge's cloud services (Cloudflare, Supabase, GitHub, your email) are
> therefore in scope. The custom code of Depotcharge itself is not assessed: the requirements say
> "bespoke and custom components are out of scope" and point to the UK Software Security Code of
> Practice instead, which [secure-development.md](secure-development.md) covers.

## The current standard

Since 27 April 2026 assessments use version 3.3 of *Cyber Essentials: Requirements for IT
Infrastructure* and the matching "Danzell" question set. Points that matter most:

- **MFA on every cloud service where it's available.** A cloud service that offers MFA (free or
  paid) without it switched on for every user **fails the whole assessment automatically**.
  Services with no MFA option are declared separately.
- **High and critical updates within 14 days** (vendor-rated critical or high, or CVSS v3 base
  score 7 or above), for operating systems, router and firewall firmware (question A6.4) and for
  applications (A6.5). Missing either is now an automatic failure.
- **Only supported software.** Anything past its vendor's end of support fails (for example
  Windows 10 without Extended Security Updates).
- **Point in time.** Everything must be compliant on the day the certificate is issued, not
  "being worked on".
- **Board declaration.** A director or board member signs that the organisation will keep all
  controls in place for the whole certification period.
- For Cyber Essentials Plus, the self-assessment must be final before testing starts, and
  failures found on sampled devices must be fixed across the whole estate.

## Scope

Certify the **whole organisation** if you can: it is simpler to assess and to explain to
customers. If you exclude anything, it must be separated by a firewall or VLAN (security groups and
software segmentation don't count) and the reason given. Cloud services can never be excluded.

Fill in and keep up to date:

### Devices

| Device | User | Operating system and version | Supported until | Disk encrypted | Anti-malware |
| --- | --- | --- | --- | --- | --- |
| [Laptop, make/model] | [Name] | [macOS 26 / Windows 11 24H2] | [date] | [Yes] | [XProtect / Defender] |
| [Phone] | [Name] | [iOS 26 / Android 16] | [date] | [Yes] | [Official app store only] |

Include personal phones or laptops used to reach work email or any service below (bring your own
device is in scope when it accesses organisational data or services).

### Cloud services

| Service | Used for | Admins | MFA on for every user | Notes |
| --- | --- | --- | --- | --- |
| Cloudflare | Hosting the app and API, DNS, WAF | [Names] | [ ] | Members: Manage Account → Members |
| Supabase | Database, sign-in | [Names] | [ ] | Organisation → Team; also require MFA for the organisation |
| GitHub | Source code, CI | [Names] | [ ] | Organisation → Settings → Authentication security → require 2FA |
| [Google Workspace / Microsoft 365] | Email, documents | [Names] | [ ] | Enforce for all users |
| [Domain registrar] | The app's domain | [Names] | [ ] | |
| [Email delivery, e.g. Postmark] | Sign-in emails | [Names] | [ ] | |
| [Password manager] | Shared secrets | [Names] | [ ] | |
| Depotcharge itself | Your team's own use | Platform admins | Enforced for admins | Fleets can require it for everyone |

### Networks

- Office: [router make/model], default admin password changed, remote admin off.
- Home and remote working (question A2.4.2 asks how people connect): [home routers / business
  router / corporate VPN]. Home routers supplied by an ISP are generally treated as out of scope,
  so each laptop's own software firewall must be on.

## Control by control

### 1. Firewalls

| Requirement | Depotcharge and hosting | What you do | Evidence |
| --- | --- | --- | --- |
| Every device protected by a correctly configured firewall | The app has no servers to manage: Cloudflare's network fronts the app and API; the database is reached over HTTPS only | Turn on each laptop's firewall; routers: change default admin passwords, keep admin interfaces off the internet (or behind MFA / an IP allow list) | Compliance → Firewalls |
| Unauthenticated inbound connections blocked; rules approved and documented | Only `/api`, `/ocpi` and `/sim` are dynamic; everything else is static files | Supabase → Database → Network restrictions: allow only the IPs that need direct Postgres access (or none) | Screenshot of the setting |
| Protection at the boundary | Per-IP rate limits and request size limits in the Functions (`server/live.ts`) | Cloudflare → Security: managed WAF rules on, plus a rate-limiting rule for `/api/*` and `/ocpi/*` | Compliance → "Cloudflare WAF and rate limiting on" |

### 2. Secure configuration

| Requirement | Depotcharge and hosting | What you do | Evidence |
| --- | --- | --- | --- |
| Remove or disable unnecessary software, accounts and services | The CPO simulator is off unless `ENABLE_CPO_SIMULATOR=true`; demo mode runs only without Supabase keys | Remove `ENABLE_CPO_SIMULATOR` in production; delete unused API keys, Supabase features and accounts | Compliance → "Test simulator switched off", "Unused services switched off" |
| Change default or guessable passwords | No default accounts exist; platform admins are added explicitly in SQL | Same on routers, devices and every service | Compliance → Secure configuration |
| Secure settings for each cloud service | Strict Content-Security-Policy and security headers (`public/_headers`, `server/security.ts`); HTTPS only with HSTS | Supabase Auth: minimum password length 12, email confirmation, TOTP MFA, leaked-password protection, custom SMTP; protect preview deployments | Compliance → "Supabase Auth hardened", "Preview deployments are not public copies" |
| Device unlocking: PIN or password of at least 6 characters, or biometrics | n/a | Set screen locks on every laptop and phone | Device list above |
| Auto-run disabled | n/a | Default on current Windows and macOS; check | Device list |

### 3. Security update management

| Requirement | Depotcharge and hosting | What you do | Evidence |
| --- | --- | --- | --- |
| Software licensed and supported | Node.js 22 LTS (`.nvmrc`); React 19; esbuild; TypeScript. Cloudflare and Supabase patch their platforms | Replace anything past end of support; keep Node.js on a supported LTS line | Compliance → "Only supported software in use" |
| High and critical updates within 14 days | Exact dependency versions and a lockfile; CI runs `npm audit --audit-level=high` on every change **and every Monday**; Dependabot opens update pull requests | Turn on Dependabot alerts and security updates; merge security updates within 14 days; automatic updates on devices and browsers | Compliance → "Dependency alerts and updates on", "High and critical updates within 14 days"; CI history |

### 4. User access control

| Requirement | Depotcharge and hosting | What you do | Evidence |
| --- | --- | --- | --- |
| Process to create, approve and remove accounts | Team members join only through single-use invite links that expire after 7 days, bound to the invited email; owners remove people in Settings → Team; every change is in the audit log | Approve accounts before inviting; remove people the day they leave; review every quarter | Settings → Security → Activity log; Compliance → "Joiners, movers and leavers process" |
| Unique credentials, least privilege, separate admin accounts | Roles: owner, planner, viewer. Platform admin is a separate, explicit grant. Fleets are isolated in the API and again by row level security | Keep platform admins to the people who need it; do admin work from admin accounts | Compliance → "Least privilege and separate admin accounts" |
| MFA wherever available, and always for cloud services | Two-step verification with an authenticator app (Supabase TOTP). Required for platform admins in production; fleet owners can require it for their whole team | MFA on for every person on every cloud service listed above | Compliance → "MFA on every cloud service"; "Platform admins must use two-step verification" (automatic) |
| Password-based authentication: protection against guessing, and password quality | Minimum 12 characters, no forced complexity, common passwords blocked (`shared/password.ts`); Supabase Auth rate-limits sign-in attempts; MFA satisfies both requirements on its own | Set Supabase's minimum password length to 12 and turn on leaked-password protection | Compliance → "Supabase Auth hardened" |
| Account recovery doesn't bypass MFA | A lost authenticator can only be reset by a platform admin, who must record how they verified the person (audit log) | Follow the recovery procedure in the security policy | Compliance → Platform activity log |

### 5. Malware protection

| Requirement | Depotcharge and hosting | What you do | Evidence |
| --- | --- | --- | --- |
| Malware protection on every in-scope device | Uploaded logos are checked (real image types only; SVGs with scripts, event handlers or external references refused); the CSP blocks third-party and inline scripts | Up-to-date anti-malware on Windows and macOS (Microsoft Defender and XProtect qualify when on and updating); phones install apps only from official stores | Compliance → "Malware protection on every device" |

## Getting certified

1. Work through **Compliance** until every item is done, ticking manual items with a note of the
   evidence (where the screenshot or setting is). Print it (Print evidence) for your records.
2. Choose a certification body on IASME's website (iasme.co.uk). The assessment fee depends on
   the size of your organisation; IASME's fee for micro organisations (0–9 staff) starts at about
   £320 plus VAT. Check the current price list, and note consultancies' packages cost more.
3. Answer the online question set honestly and completely. Describe your scope exactly as above.
4. A director signs the declaration.
5. The assessor marks it. If something fails, the certification body explains what's needed;
   check its rules on fixing and resubmitting (automatic-fail items have no partial credit).
6. When the certificate is issued, add it in **Compliance → Certificates**. It then appears on the
   sign-in and security pages with a link to IASME's public certificate search
   (https://iasme.co.uk/cyber-essentials/ncsc-certificate-search/), and disappears when it expires.
7. Certificates last 12 months. The Compliance page warns 60 days before expiry; re-certify before
   then.
8. Optional: **Cyber Essentials Plus** adds a hands-on technical audit by the certification body
   (external vulnerability scan, checks on a sample of devices and accounts). It must follow the
   basic certification within three months.

## Claims and the badge

- Say "Cyber Essentials certified" only while you hold a valid certificate, and never say the
  app is certified: the certificate belongs to the organisation and its stated scope.
- The app shows certificates as text with a link to verify them. It does not draw the Cyber
  Essentials logo. If you want the badge on your website, use the files your certification body
  gives you, under its terms of use.

## For your customers

Fleet operators who are working towards Cyber Essentials themselves must have MFA on every cloud
service they use, and Depotcharge is one. Point them to **Settings → Security**: each person can
add an authenticator app, and an owner can require it for the whole fleet.
