// Security & compliance report for platform admins: automatic checks of the live configuration
// plus the organisation's own checklist (ticked with a name and date). See shared/compliance.ts.
import type { Certification, LegalInfo } from "../../shared/model";
import { EMPTY_LEGAL } from "../../shared/model";
import { MANUAL_CHECKS, type ComplianceCheck, type ManualTick } from "../../shared/compliance";
import { iso } from "../../shared/util";
import { adminMfaRequired, legalFromEnv, type AuthUser, type Ctx } from "../context";
import { ApiError } from "../emsp/service";

async function legal(ctx: Ctx): Promise<LegalInfo> {
  const saved = (await ctx.store.getSetting<Partial<LegalInfo>>("legal")) ?? {};
  const env = legalFromEnv(ctx.env);
  const out = { ...EMPTY_LEGAL };
  for (const k of Object.keys(out) as (keyof LegalInfo)[]) out[k] = (saved[k] || env[k] || EMPTY_LEGAL[k]) as string;
  return out;
}

function keyOk(k: string | undefined): boolean {
  if (!k) return false;
  try {
    const bin = atob(k.trim().replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(k.trim().length / 4) * 4, "="));
    return bin.length === 32;
  } catch {
    return false;
  }
}

export async function complianceReport(ctx: Ctx, user: AuthUser): Promise<{ generated_at: string; mode: Ctx["mode"]; checks: ComplianceCheck[] }> {
  const [info, certs, ticks, partners] = await Promise.all([
    legal(ctx),
    ctx.store.getSetting<Certification[]>("certifications"),
    ctx.store.getSetting<Record<string, ManualTick>>("compliance"),
    ctx.store.listPartners(),
  ]);
  const today = iso(ctx.now()).slice(0, 10);
  const in60 = iso(new Date(ctx.now().getTime() + 60 * 86_400_000)).slice(0, 10);
  const live = ctx.mode === "live";
  const checks: ComplianceCheck[] = [];
  const auto = (c: Omit<ComplianceCheck, "kind">) => checks.push({ ...c, kind: "auto" });

  auto({
    id: "admin-mfa", area: "User access control", title: "Platform admins must use two-step verification",
    detail: "Admin pages and the admin API refuse sessions without a second factor (REQUIRE_ADMIN_MFA is not \"false\").",
    status: adminMfaRequired(ctx) ? "pass" : live ? "fail" : "info",
    evidence: live ? (adminMfaRequired(ctx) ? "Enforced" : "REQUIRE_ADMIN_MFA=false") : "Demo mode: no real sign-in",
  });
  auto({
    id: "my-mfa", area: "User access control", title: "Your account uses two-step verification",
    detail: "Settings → Security → Two-step verification. Every admin should have it.",
    status: !live ? "info" : user.mfa ? "pass" : "fail",
    evidence: !live ? "Demo mode" : user.mfa ? "Authenticator app set up" : "Not set up",
  });
  auto({
    id: "encryption", area: "Secure configuration", title: "Operator credentials encrypted at rest",
    detail: "DATA_ENCRYPTION_KEY (32 random bytes, base64) is set, so the tokens operators give us are stored AES-256-GCM encrypted. Tokens we issue are only ever stored as SHA-256 hashes.",
    status: !live ? "info" : keyOk(ctx.env.DATA_ENCRYPTION_KEY) ? "pass" : "fail",
    evidence: !live ? "Demo mode" : keyOk(ctx.env.DATA_ENCRYPTION_KEY) ? "Key set" : ctx.env.DATA_ENCRYPTION_KEY ? "Key is not 32 bytes" : "Not set",
  });
  auto({
    id: "simulator", area: "Secure configuration", title: "Test simulator switched off",
    detail: "ENABLE_CPO_SIMULATOR exposes a fictional operator at /sim. Remove it in production.",
    status: !ctx.simulatorEnabled ? "pass" : live ? "warn" : "info",
    evidence: ctx.simulatorEnabled ? "Enabled" : "Off",
  });
  auto({
    id: "https", area: "Secure configuration", title: "Served over HTTPS only",
    detail: "The public address is https:// and every response carries HSTS, a strict Content-Security-Policy and anti-framing headers.",
    status: ctx.baseUrl.startsWith("https://") ? "pass" : "fail",
    evidence: ctx.baseUrl,
  });
  const insecure = partners.filter((p) => p.status === "CONNECTED" && !p.is_simulator && p.endpoints.some((e) => !e.url.startsWith("https://")));
  auto({
    id: "partners-tls", area: "Firewalls", title: "Operator connections use TLS",
    detail: "Every connected operator's OCPI endpoints are https:// on public hosts (enforced when they connect).",
    status: insecure.length ? "fail" : "pass",
    evidence: insecure.length ? insecure.map((p) => p.name).join(", ") : `${partners.filter((p) => p.status === "CONNECTED").length} connected`,
  });
  const missing = (["company_name", "company_number", "registered_office", "contact_email", "privacy_email"] as const).filter((k) => !info[k]);
  auto({
    id: "legal-details", area: "Data protection", title: "Company details published",
    detail: "Registered name, number, office and contact details appear on the legal pages, as UK company and e-commerce rules require (Company & legal, on this page).",
    status: missing.length ? "todo" : "pass",
    evidence: missing.length ? `Missing: ${missing.join(", ").replace(/_/g, " ")}` : info.company_name,
  });
  auto({
    id: "ico", area: "Data protection", title: "ICO registration number recorded",
    detail: "Shown in the privacy notice once you've paid the data protection fee.",
    status: info.ico_number ? "pass" : "todo",
    evidence: info.ico_number || "Not set",
  });
  auto({
    id: "security-contact", area: "Security update management", title: "Vulnerability reporting contact published",
    detail: "Used for /.well-known/security.txt (set SECURITY_CONTACT at build time) and the security page, so researchers can report issues.",
    status: info.security_contact ? "pass" : "todo",
    evidence: info.security_contact || "Not set",
  });
  const ce = (certs ?? []).filter((c) => c.scheme.startsWith("Cyber Essentials")).sort((a, b) => b.expires_on.localeCompare(a.expires_on))[0];
  auto({
    id: "certificate", area: "Data protection", title: "Cyber Essentials certificate",
    detail: "Once your IASME certification body has issued it, add it under Certificates on this page. It is shown on the sign-in and security pages only while valid; certificates last 12 months.",
    status: !ce ? "todo" : ce.expires_on < today ? "fail" : ce.expires_on <= in60 ? "warn" : "pass",
    evidence: !ce ? "None recorded" : `${ce.scheme} ${ce.certificate_number}, ${ce.expires_on < today ? "expired" : "valid until"} ${ce.expires_on}`,
  });

  for (const m of MANUAL_CHECKS) {
    const t = ticks?.[m.id];
    checks.push({ ...m, kind: "manual", status: t ? "pass" : "todo", evidence: t?.note ?? null, done_by: t?.done_by ?? null, done_at: t?.done_at ?? null });
  }
  return { generated_at: iso(ctx.now()), mode: ctx.mode, checks };
}

export async function saveTick(ctx: Ctx, user: AuthUser, id: string, done: boolean, note: string | null) {
  if (!MANUAL_CHECKS.some((m) => m.id === id)) throw new ApiError(404, "Unknown checklist item");
  const ticks = (await ctx.store.getSetting<Record<string, ManualTick>>("compliance")) ?? {};
  if (done) ticks[id] = { done_by: user.email ?? user.id, done_at: iso(ctx.now()), note };
  else delete ticks[id];
  await ctx.store.setSetting("compliance", ticks);
}
