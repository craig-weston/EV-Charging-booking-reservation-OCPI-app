# Information security policy

| | |
| --- | --- |
| Organisation | [Company legal name] ("we") |
| Applies to | Everyone who works for us or on our behalf (employees, directors, contractors), every device and account they use for work, and the Depotcharge service |
| Owner | [Name, role] |
| Approved by | [Director], [date] |
| Review | Every 12 months, before each Cyber Essentials renewal, and after significant changes or incidents |

## 1. Purpose and principles

We run a service that fleet operators trust with their vehicles, drivers and bookings, and that
charge point operators trust with credentials to their systems. We protect that information by:

- giving people only the access they need, and proving who they are with a second factor;
- keeping every device, service and dependency supported and up to date;
- configuring systems securely from the start and removing what we don't use;
- keeping secrets out of code and out of reach;
- recording security-relevant actions, and acting quickly when something goes wrong.

These rules implement the five Cyber Essentials controls and support our obligations under UK data
protection law. Breaking them may lead to access being removed and, for staff, disciplinary action.

## 2. Responsibilities

- **Director responsible** ([Name]): accountable for security, approves this policy and signs the
  Cyber Essentials declaration.
- **Security lead** ([Name]): keeps this policy and the asset lists current, runs access reviews,
  tracks updates, leads incidents.
- **Everyone**: follows this policy, reports suspected incidents straight away to
  [security@your-domain] or [phone], and completes security awareness training each year.

## 3. Accounts and access

1. **One person, one account.** No shared accounts or shared passwords, except documented
   service accounts held in the password manager.
2. **Joiners.** Accounts are created only after [manager] approves them, with the least privilege
   needed for the role. In Depotcharge, colleagues join only through an invite to their own email
   address.
3. **Movers and leavers.** Access is changed or removed **on the day** someone changes role or
   leaves: Cloudflare, Supabase, GitHub, email, the domain registrar, the password manager, and
   Depotcharge (Settings → Team; platform admins are removed from the `platform_admins` table).
4. **Admin accounts.** Administrative work is done from accounts used only for that. Platform
   admin, Cloudflare and Supabase owner roles, and GitHub organisation owner roles are limited to
   [names]. API tokens are scoped to the minimum and have an owner and an expiry.
5. **Multi-factor authentication** is switched on for every person on every cloud service that
   offers it, including Depotcharge. Authenticator apps or security keys are preferred to SMS.
6. **Passwords.** At least 12 characters; long passphrases encouraged; no forced complexity or
   periodic changes; never reused between services; stored in the password manager
   ([name of product]). Change a password at once if it may have been exposed.
7. **Access reviews.** Every quarter the security lead reviews who has access to each cloud
   service and who is a Depotcharge platform admin, removes anything no longer needed, and records
   the review (date, reviewer, changes) in Compliance → "Joiners, movers and leavers process".
8. **Lost authenticator.** A platform admin may reset someone's two-step verification only after
   confirming their identity by a second channel, for example calling them back on a number held
   in HR records, or confirmation from their fleet owner. An email alone is never enough. The
   reason is recorded when the reset is made (Compliance → Lost authenticator), and the person
   sets up a new authenticator at their next sign-in.

## 4. Devices

Every laptop, desktop, phone and tablet used for work, including personal devices that access work
email or services:

- runs an operating system and apps that are still supported, with automatic updates on;
- locks after a short idle time and needs a PIN or password of at least 6 characters, or
  biometrics, to unlock; disks are encrypted (FileVault, BitLocker, or the phone's built-in
  encryption);
- has anti-malware on and updating (Microsoft Defender or macOS XProtect are fine) and its
  software firewall on;
- installs software only from official sources (app stores, vendors' sites); phones only from the
  official app store; nothing jailbroken or rooted;
- has default or guessable passwords changed, unused software and accounts removed, and auto-run
  off.

Report a lost or stolen device immediately. We then sign the person out everywhere (Depotcharge:
Settings → Security → Sign out everywhere; the same in email and other services) and change any
passwords stored on it.

## 5. Networks and firewalls

- Office routers and firewalls have their default admin passwords changed, remote administration
  off (or protected by MFA or an IP allow list), firmware updated, and no inbound rules without a
  documented reason approved by the security lead. Unneeded rules are removed.
- On public or untrusted wifi, use the device's firewall and [the company VPN / a phone hotspot].
- In front of the service: Cloudflare WAF managed rules and a rate-limiting rule for `/api/*` and
  `/ocpi/*`; Supabase network restrictions so the database accepts direct connections only from
  approved addresses (or none).

## 6. Cloud services and configuration baselines

We keep an inventory of cloud services in [cyber-essentials.md](cyber-essentials.md#cloud-services)
and apply these baselines:

- **Cloudflare:** MFA for every member; least-privilege member roles; SSL/TLS "Full (strict)",
  minimum TLS 1.2, Always Use HTTPS; WAF managed rules; preview deployments protected with
  Cloudflare Access or pointed at a separate Supabase project; secrets stored as encrypted
  environment variables, never in the repository.
- **Supabase:** MFA required for the organisation; a UK or EU region; Auth with minimum password
  length 12, email confirmation, secure email change, TOTP MFA, leaked-password protection, custom
  SMTP with SPF, DKIM and DMARC; network restrictions on; unused features off; the service-role key
  used only by the Pages Functions.
- **GitHub:** 2FA required for the organisation; branch protection on `main` (pull requests,
  passing CI, at least one review, no force-push); Dependabot alerts and security updates on;
  secret scanning on where available.
- **Depotcharge:** `REQUIRE_ADMIN_MFA` left on; `DATA_ENCRYPTION_KEY` set; `ENABLE_CPO_SIMULATOR`
  unset; `SECURITY_CONTACT` set.

## 7. Updates and vulnerabilities

- Critical and high-risk updates (vendor-rated, or CVSS v3 7.0 or above) are installed within
  **14 days** of release on every device, router, service and dependency; automatic updates are on
  wherever possible. Anything that can no longer be updated is replaced or removed.
- The application's dependencies are pinned in `package-lock.json`. CI fails on high or critical
  advisories on every change and every Monday; Dependabot raises update pull requests. Security
  updates are reviewed and merged within 14 days.
- Vulnerability reports from outside are handled under [`SECURITY.md`](../../SECURITY.md):
  acknowledged within 3 working days, high and critical issues fixed within 14 days.

## 8. Secrets and keys

| Secret | Where it lives | Rotate |
| --- | --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | Cloudflare environment variable (encrypted) | When anyone with access leaves, or on suspected exposure |
| `DATA_ENCRYPTION_KEY` | Cloudflare environment variable | Every 12 months, or at once on suspected exposure (procedure below) |
| Operator (OCPI) credentials | Database: tokens we issue as SHA-256 hashes only; tokens operators give us AES-256-GCM encrypted | Ask the operator to re-register, or issue a new registration token |
| Driver pass and team invite links | Database: AES-256-GCM encrypted, looked up by SHA-256 | A planner resets a pass link; an owner revokes an invite |
| Personal passwords, recovery codes | Password manager | On suspected exposure |

**Rotating `DATA_ENCRYPTION_KEY`:** generate 32 random bytes (`openssl rand -base64 32`); set the
current value as `DATA_ENCRYPTION_KEY_PREVIOUS` and the new one as `DATA_ENCRYPTION_KEY`; redeploy;
in Compliance → Encryption key, choose **Re-encrypt stored credentials** (this covers operator
credentials and pass and invite links); then remove
`DATA_ENCRYPTION_KEY_PREVIOUS` and redeploy. Never commit keys or paste them into chat or tickets.

## 9. Logging and monitoring

- Depotcharge records security-relevant actions (team and role changes, invites, exports,
  deletions, policy changes, admin actions) in its audit log for 12 months, and OCPI messages for 30
  days, with credentials redacted.
- Cloudflare and Supabase keep their own access and authentication logs.
- The security lead looks over the platform activity log and failed-authentication alerts every
  month, and after any alert.

## 10. Backups and recovery

- Supabase daily backups (Pro plan or above) are on; point-in-time recovery is used if the data
  changes too fast to accept up to a day's loss. Targets: recovery point [24 hours], recovery time
  [4 hours].
- The code and configuration live in GitHub; environment variables are listed (names, not values)
  in the README, and their values are kept in the password manager.
- At least once a year, restore a backup into a separate Supabase project, point a preview
  deployment at it, check the app works, record the result in Compliance → "Backups and a tested
  restore", and delete the copy.

## 11. Suppliers

Before we use a new service that will hold personal data or credentials, the security lead checks
its security (certifications such as ISO 27001 or SOC 2, MFA, data location), accepts its data
processing terms, and adds it to the sub-processor list in [data-protection.md](data-protection.md)
and to the app's data processing terms (30 days' notice to customers).

## 12. Training

Everyone completes security awareness training when they join and every year (phishing, passwords
and MFA, reporting incidents). The NCSC's free "Top Tips for Staff" training is a good baseline.

## 13. Incidents

Report anything suspicious at once. The [incident response plan](incident-response.md) says who
does what, including telling customers and, when required, the ICO within 72 hours.
