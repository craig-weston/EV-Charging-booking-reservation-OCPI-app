// Password guidance in line with NCSC advice and Cyber Essentials (v3.3): a long minimum length,
// no maximum beyond the sign-in service's own limit, no forced complexity or expiry, and common
// passwords blocked with a deny list. Supabase Auth enforces the minimum on the server too
// (Authentication → Providers → Email → Minimum password length: 12).

/** Frequently breached passwords and patterns (lower case, digits and symbols stripped from the ends). */
const DENY = new Set([
  "password", "passw0rd", "password1", "qwerty", "qwertyuiop", "letmein", "welcome", "iloveyou", "admin", "administrator", "monkey",
  "dragon", "football", "baseball", "sunshine", "princess", "trustno", "master", "superman", "starwars", "whatever", "freedom",
  "shadow", "michael", "jennifer", "charlie", "liverpool", "arsenal", "chelsea", "manchester", "london", "england", "britain",
  "changeme", "default", "secret", "summer", "autumn", "winter", "spring", "january", "february", "october", "november",
  "december", "computer", "internet", "service", "support", "office", "company", "business", "logistics", "haulage", "transport",
  "truck", "trucking", "lorry", "fleet", "depot", "driver", "charging", "charger", "electric", "depotcharge", "booking",
  "abc", "abcdef", "abcdefg", "qazwsx", "zxcvbnm", "asdfgh", "asdfghjkl", "aaaaaa", "111111", "000000", "123123", "121212",
  "654321", "666666", "888888", "987654321", "1q2w3e4r", "1qaz2wsx", "q1w2e3r4", "zaq12wsx", "letmein1", "welcome1",
]);

export const PASSWORD_MAX_LENGTH = 72; // bcrypt limit in Supabase Auth

function core(pw: string): string {
  return pw.toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, "");
}

function sequential(pw: string): boolean {
  const s = pw.toLowerCase();
  const runs = ["0123456789012345678901234567890", "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz", "qwertyuiopasdfghjklzxcvbnm"];
  return runs.some((r) => r.includes(s) || r.split("").reverse().join("").includes(s));
}

/** Problems with a new password, as short sentences (empty when it's fine). */
export function passwordProblems(pw: string, opts: { min: number; email?: string | null; product?: string | null }): string[] {
  const out: string[] = [];
  if (pw.length < opts.min) out.push(`Use at least ${opts.min} characters. A few unrelated words make a long, memorable password.`);
  if (pw.length > PASSWORD_MAX_LENGTH) out.push(`Use at most ${PASSWORD_MAX_LENGTH} characters.`);
  const c = core(pw);
  const local = (opts.email ?? "").split("@")[0].toLowerCase();
  if (DENY.has(c) || DENY.has(pw.toLowerCase()) || (c.length >= 4 && [...DENY].some((d) => d.length >= 6 && c === d.repeat(Math.max(1, Math.round(c.length / d.length)))))) {
    out.push("This is one of the most commonly used passwords. Pick something less predictable.");
  } else if (/^(.)\1+$/.test(pw) || sequential(pw)) {
    out.push("Avoid repeated or sequential characters.");
  }
  if (local.length >= 4 && pw.toLowerCase().includes(local)) out.push("Don't include your email address.");
  if (opts.product && opts.product.length >= 4 && c === opts.product.toLowerCase().replace(/[^a-z]/g, "")) out.push("Don't use the product's name as your password.");
  return out;
}
