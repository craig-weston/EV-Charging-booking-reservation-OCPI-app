// The checklist behind Settings → Security & compliance. Automatic checks are computed by the
// server from the live configuration; manual ones are things only the organisation can do (in
// Cloudflare, Supabase, GitHub and on its own devices) and are ticked off with a name and date,
// which doubles as evidence for a Cyber Essentials assessment. Grouped by the five Cyber
// Essentials controls (Requirements for IT Infrastructure v3.3), plus data protection.

export type ComplianceArea =
  | "Firewalls"
  | "Secure configuration"
  | "User access control"
  | "Malware protection"
  | "Security update management"
  | "Data protection";

export type CheckStatus = "pass" | "fail" | "warn" | "todo" | "info";

export interface ComplianceCheck {
  id: string;
  area: ComplianceArea;
  title: string;
  detail: string;
  kind: "auto" | "manual";
  status: CheckStatus;
  /** What the server saw (auto) or the note left when ticked (manual). */
  evidence?: string | null;
  done_by?: string | null;
  done_at?: string | null;
}

export interface ManualTick {
  done_by: string;
  done_at: string;
  note?: string | null;
}

export const COMPLIANCE_AREAS: ComplianceArea[] = [
  "Firewalls", "Secure configuration", "User access control", "Malware protection", "Security update management", "Data protection",
];

/** Things only the organisation can do. `detail` says exactly where. */
export const MANUAL_CHECKS: Omit<ComplianceCheck, "kind" | "status">[] = [
  // Firewalls
  { id: "cf-waf", area: "Firewalls", title: "Cloudflare WAF and rate limiting on", detail: "Cloudflare dashboard → your domain → Security: managed rules on, and a rate-limiting rule for /api/* and /ocpi/* (for example 300 requests per minute per IP). The app also limits per IP itself." },
  { id: "db-network", area: "Firewalls", title: "Direct database access restricted", detail: "Supabase → Project Settings → Database → Network restrictions: allow only the IP addresses that need psql access (or none). The app reaches the database over HTTPS, not directly." },
  { id: "routers", area: "Firewalls", title: "Office and home routers secured", detail: "Every router or firewall in scope has its default admin password changed, remote admin off (or MFA / IP allow list), and no inbound rules without a documented reason. Laptops used on public wifi have their software firewall on." },
  // Secure configuration
  { id: "supabase-auth", area: "Secure configuration", title: "Supabase Auth hardened", detail: "Supabase → Authentication: minimum password length 12, email confirmation on, secure email change on, TOTP MFA enabled, leaked-password protection on (Pro plan), rate limits left at their defaults or lower, custom SMTP with SPF, DKIM and DMARC." },
  { id: "previews", area: "Secure configuration", title: "Preview deployments are not public copies", detail: "Cloudflare Pages → Settings: protect preview deployments with Cloudflare Access, or give previews their own Supabase project, so a preview URL is never a second door into production data." },
  { id: "unused", area: "Secure configuration", title: "Unused services switched off", detail: "Remove ENABLE_CPO_SIMULATOR in production, disable Supabase features you don't use (for example GraphQL), delete unused API keys and accounts." },
  { id: "devices", area: "Secure configuration", title: "Devices configured securely", detail: "On every laptop and phone used for work: default or guessable passwords changed, unneeded software and accounts removed, auto-run off, and a screen lock of at least a 6-digit PIN, password or biometric." },
  // User access control
  { id: "mfa-cloud", area: "User access control", title: "MFA on every cloud service", detail: "Each person's accounts on Cloudflare, Supabase, GitHub, your email (Google Workspace or Microsoft 365), the domain registrar and any other cloud service have MFA on. Under Cyber Essentials (Danzell) a cloud service with MFA available but not enabled fails the whole assessment." },
  { id: "least-privilege", area: "User access control", title: "Least privilege and separate admin accounts", detail: "Platform admins (platform_admins table) and Cloudflare/Supabase/GitHub admins are only the people who need it; admin work is done from admin accounts; API tokens are scoped to what they need." },
  { id: "access-review", area: "User access control", title: "Joiners, movers and leavers process", detail: "Accounts are approved before they are created and removed or disabled the day someone leaves. Review platform admins, Supabase and Cloudflare members at least every quarter." },
  // Malware protection
  { id: "anti-malware", area: "Malware protection", title: "Malware protection on every device", detail: "Windows and macOS devices run up-to-date anti-malware (Microsoft Defender or XProtect count) that blocks malicious files and websites; phones and tablets only install apps from the official stores." },
  // Security update management
  { id: "dependabot", area: "Security update management", title: "Dependency alerts and updates on", detail: "GitHub → Settings → Code security: Dependabot alerts and security updates on. The CI workflow in this repository fails on high or critical npm advisories." },
  { id: "patch-14", area: "Security update management", title: "High and critical updates within 14 days", detail: "Operating systems, browsers, router firmware, apps and this app's dependencies get high or critical (CVSS 7+) fixes within 14 days of release; automatic updates on wherever possible." },
  { id: "supported", area: "Security update management", title: "Only supported software in use", detail: "Nothing in scope is past its vendor's end of support (for example Windows 10 without Extended Security Updates, or an unsupported Node.js version)." },
  // Data protection
  { id: "ico-fee", area: "Data protection", title: "ICO data protection fee paid", detail: "Register with the Information Commissioner's Office and pay the annual fee (tier 1 is £52, or £47 by direct debit). Enter the registration number in Company & legal." },
  { id: "dpas", area: "Data protection", title: "Processor agreements in place", detail: "Accept Cloudflare's and Supabase's data processing addendums (they cover UK transfers), choose a UK or EU Supabase region, and list them as sub-processors (the DPA page does)." },
  { id: "legal-review", area: "Data protection", title: "Legal documents reviewed", detail: "Have a solicitor review the terms of service, privacy notice and data processing terms (Legal pages) and fill in your company details before launch." },
  { id: "backups", area: "Data protection", title: "Backups and a tested restore", detail: "Supabase backups (point-in-time recovery on paid plans) are on, and a restore has been tested in a separate project in the last 12 months." },
  { id: "incident-plan", area: "Data protection", title: "Incident response plan ready", detail: "Everyone knows docs/compliance/incident-response.md: who decides, how to rotate keys, telling customers without undue delay, and the ICO within 72 hours when a breach puts people at risk." },
];
