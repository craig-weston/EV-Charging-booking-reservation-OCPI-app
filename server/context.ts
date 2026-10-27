// Request-scoped context shared by the OCPI router, the app API and the CPO simulator.
// Everything here uses web-standard APIs only, so the same code runs on Cloudflare Pages
// Functions, in Node (tests) and in the browser (demo mode).
import type { Store } from "./store/types";
import type { Brand, LegalInfo } from "../shared/model";
import { DEFAULT_BRAND, EMPTY_LEGAL } from "../shared/model";

export interface Env {
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string; // public "anon" / publishable key — sent to the browser for sign-in
  SUPABASE_SERVICE_ROLE_KEY?: string; // secret — server only
  OCPI_COUNTRY_CODE?: string; // your eMSP country code, e.g. "GB"
  OCPI_PARTY_ID?: string; // your eMSP party id, e.g. "DPC"
  OCPI_BUSINESS_NAME?: string;
  PUBLIC_BASE_URL?: string; // optional, e.g. "https://book.example.com"
  ENABLE_CPO_SIMULATOR?: string; // "true" to expose /sim (test CPO network)
  BRAND_NAME?: string;
  BRAND_PRIMARY_COLOR?: string;
  BRAND_LOGO_URL?: string;
  BRAND_SUPPORT_EMAIL?: string;
  BRAND_SUPPORT_PHONE?: string;
  /** 32 random bytes, base64: encrypts the credentials tokens operators give us (AES-256-GCM). */
  DATA_ENCRYPTION_KEY?: string;
  /** The key before a rotation: still decrypts old values until Security & compliance → Re-encrypt has run. */
  DATA_ENCRYPTION_KEY_PREVIOUS?: string;
  /** "false" lets platform admins work without two-step verification (not recommended). */
  REQUIRE_ADMIN_MFA?: string;
  /** Defaults for Settings → Company & legal (the saved settings win). */
  LEGAL_COMPANY_NAME?: string;
  LEGAL_TRADING_NAME?: string;
  LEGAL_COMPANY_NUMBER?: string;
  LEGAL_REGISTERED_OFFICE?: string;
  LEGAL_VAT_NUMBER?: string;
  LEGAL_CONTACT_EMAIL?: string;
  LEGAL_PRIVACY_EMAIL?: string;
  LEGAL_ICO_NUMBER?: string;
  SECURITY_CONTACT?: string;
  /** Twilio, for automatic driver texts / WhatsApp messages (Settings → Fleet). */
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string; // secret
  TWILIO_FROM?: string; // SMS sender: an E.164 number or an alphanumeric sender ID
  TWILIO_WHATSAPP_FROM?: string; // WhatsApp-enabled sender number, E.164
}

export interface AuthUser {
  id: string;
  email: string | null;
  /** Authenticator assurance level of this session: aal2 = signed in with a second factor. */
  aal?: "aal1" | "aal2";
  /** The account has a verified second factor (so every session must reach aal2). */
  mfa?: boolean;
}

export interface Party {
  country_code: string;
  party_id: string;
  name: string;
}

export interface Ctx {
  mode: "live" | "demo";
  env: Env;
  store: Store;
  /** Public origin of this deployment, no trailing slash. */
  baseUrl: string;
  party: Party;
  simulatorEnabled: boolean;
  /** Processing delay the simulated CPO uses before confirming (ms). */
  simDelayMs: number;
  now(): Date;
  waitUntil(p: Promise<unknown>): void;
  /** Outbound HTTP. Requests to `baseUrl` are dispatched in-process (no network hop). */
  transport(req: Request): Promise<Response>;
  verifyUser(req: Request): Promise<AuthUser | null>;
  /** Per-request cache (e.g. authenticated partner). */
  cache: Map<string, unknown>;
}

export function partyFromEnv(env: Env): Party {
  return {
    country_code: (env.OCPI_COUNTRY_CODE || "GB").toUpperCase().slice(0, 2),
    party_id: (env.OCPI_PARTY_ID || "DPC").toUpperCase().slice(0, 3),
    name: env.OCPI_BUSINESS_NAME || env.BRAND_NAME || "Depotcharge",
  };
}

export function brandFromEnv(env: Env): Brand {
  return {
    ...DEFAULT_BRAND,
    ...(env.BRAND_NAME ? { name: env.BRAND_NAME } : {}),
    ...(env.BRAND_PRIMARY_COLOR ? { primary_color: env.BRAND_PRIMARY_COLOR } : {}),
    ...(env.BRAND_LOGO_URL ? { logo_url: env.BRAND_LOGO_URL } : {}),
    ...(env.BRAND_SUPPORT_EMAIL ? { support_email: env.BRAND_SUPPORT_EMAIL } : {}),
    ...(env.BRAND_SUPPORT_PHONE ? { support_phone: env.BRAND_SUPPORT_PHONE } : {}),
  };
}

export function legalFromEnv(env: Env): LegalInfo {
  return {
    ...EMPTY_LEGAL,
    company_name: env.LEGAL_COMPANY_NAME ?? "",
    trading_name: env.LEGAL_TRADING_NAME ?? env.BRAND_NAME ?? "",
    company_number: env.LEGAL_COMPANY_NUMBER ?? "",
    registered_office: env.LEGAL_REGISTERED_OFFICE ?? "",
    vat_number: env.LEGAL_VAT_NUMBER ?? "",
    contact_email: env.LEGAL_CONTACT_EMAIL ?? env.BRAND_SUPPORT_EMAIL ?? "",
    privacy_email: env.LEGAL_PRIVACY_EMAIL ?? env.LEGAL_CONTACT_EMAIL ?? "",
    ico_number: env.LEGAL_ICO_NUMBER ?? "",
    security_contact: env.SECURITY_CONTACT ?? "",
  };
}

/** Platform admins need two-step verification in live mode unless explicitly switched off. */
export const adminMfaRequired = (ctx: Pick<Ctx, "mode" | "env">) => ctx.mode === "live" && ctx.env.REQUIRE_ADMIN_MFA !== "false";

/** Bumped whenever the terms of service or the data processing terms change materially. */
export const TERMS_VERSION = "2026-10-21";
export const PASSWORD_MIN_LENGTH = 12;

export const OCPI_VERSION = "2.3.0";
export const ocpiUrls = (base: string) => ({
  versions: `${base}/ocpi/versions`,
  details: `${base}/ocpi/${OCPI_VERSION}`,
  module: (m: string) => `${base}/ocpi/emsp/${OCPI_VERSION}/${m}`,
});
export const simUrls = (base: string) => ({
  versions: `${base}/sim/cpo/versions`,
  details: `${base}/sim/cpo/${OCPI_VERSION}`,
  module: (m: string) => `${base}/sim/cpo/${OCPI_VERSION}/${m}`,
});
