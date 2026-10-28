// Builds the sign-in and security emails Supabase Auth sends (supabase/templates/*.html) from one
// layout, so every email looks and sounds the same.   node scripts/emails.mjs
//
// The output keeps Supabase's Go-template placeholders ({{ .ConfirmationURL }}, {{ .Email }}, …):
// paste each file into Supabase → Authentication → Emails, with the subject from
// supabase/templates/subjects.json (custom SMTP must be set up first; see docs/deploy.md).
//
// Email-safe HTML: tables for layout, inline styles, no images or web fonts (many inboxes block
// them), a hidden preheader, a dark-mode stylesheet for the clients that support one, and every
// link also written out in full.
import fs from "node:fs";
import path from "node:path";

const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "supabase", "templates");
const BRAND = { name: "Depotcharge", blue: "#2F5BEA", blueDark: "#1F44C4", ink: "#1C2128", muted: "#5D6673", line: "#DDE1E6", canvas: "#EEF0F2", panel: "#F6F7F9" };
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

// Each email has its own colourway: a gradient header, and a button, panels and code box to match.
const THEMES = {
  electric: { from: "#2F5BEA", to: "#7C3AED", soft: "#EEF1FE", emoji: "⚡" },
  plug: { from: "#059669", to: "#0EA5E9", soft: "#E8F7F2", emoji: "🔌" },
  battery: { from: "#F97316", to: "#E11D74", soft: "#FFF1E8", emoji: "🔋" },
  swap: { from: "#0D9488", to: "#2F5BEA", soft: "#E7F6F4", emoji: "✉️" },
  code: { from: "#7C3AED", to: "#DB2777", soft: "#F3EEFE", emoji: "🔐" },
  good: { from: "#059669", to: "#22C55E", soft: "#E8F7EE", emoji: "✅" },
  shield: { from: "#0EA5E9", to: "#059669", soft: "#E6F5FC", emoji: "🛡️" },
  phone: { from: "#0D9488", to: "#2F5BEA", soft: "#E7F6F4", emoji: "📱" },
  info: { from: "#4F46E5", to: "#0EA5E9", soft: "#EEEEFD", emoji: "🔗" },
  alert: { from: "#DC2626", to: "#F97316", soft: "#FDECEC", emoji: "⚠️" },
};
// Red to green, like a state-of-charge gauge.
const RAMP = ["#EF4444", "#F97316", "#F59E0B", "#EAB308", "#A3E635", "#84CC16", "#22C55E", "#10B981", "#14B8A6", "#06B6D4"];

/** A row of ten cells filled to `pct`, coloured like a state-of-charge gauge. */
function meter(t, pct, label) {
  const filled = Math.round(pct / 10);
  const cells = Array.from({ length: 10 }, (_, i) =>
    `<td width="10%" style="padding:0 2px;"><div class="${i < filled ? "cell-on" : "cell-off"}" style="height:12px;border-radius:4px;background:${i < filled ? RAMP[i] : BRAND.line};font-size:0;line-height:0;">&nbsp;</div></td>`).join("");
  return `
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
            <tr><td style="padding:0 0 8px;font:700 12px/1.2 ${FONT};letter-spacing:.07em;text-transform:uppercase;color:${t.from};">${esc(label)}</td></tr>
            <tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${cells}</tr></table></td></tr>
          </table>`;
}

const p = (html, extra = "") => `<p class="ink" style="margin:0 0 16px;font:400 16px/1.6 ${FONT};color:${BRAND.ink};${extra}">${html}</p>`;
const small = (html) => `<p class="muted" style="margin:0 0 12px;font:400 14px/1.6 ${FONT};color:${BRAND.muted};">${html}</p>`;
const grad = (t) => `background-color:${t.from};background-image:linear-gradient(135deg, ${t.from} 0%, ${t.to} 100%);`;

function button(t, href, label) {
  return `
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 26px;">
            <tr><td bgcolor="${t.from}" style="border-radius:999px;${grad(t)}box-shadow:0 6px 16px -6px ${t.from};">
              <a href="${href}" target="_blank" style="display:inline-block;padding:16px 30px;border-radius:999px;font:700 16px/1 ${FONT};color:#FFFFFF;text-decoration:none;">${esc(label)} &rarr;</a>
            </td></tr>
          </table>`;
}

function fallback(href) {
  return `
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;">
            <tr><td class="panel muted" bgcolor="${BRAND.panel}" style="background:${BRAND.panel};border-radius:10px;padding:10px 12px;font:400 12px/1.5 ${FONT};color:${BRAND.muted};">
              Button not working? Copy this link into your browser:<br>
              <a class="link" href="${href}" style="color:${BRAND.muted};word-break:break-all;text-decoration:underline;">${href}</a>
            </td></tr>
          </table>`;
}

/** A progress tracker: done steps ticked, the current one highlighted, the rest waiting. */
function steps(t, items, current) {
  const cells = items.map((label, i) => {
    const done = i < current, now = i === current;
    const dot = done ? `<span style="display:inline-block;width:22px;height:22px;border-radius:999px;background:#22C55E;color:#FFFFFF;font:800 12px/22px ${FONT};text-align:center;">&#10003;</span>`
      : now ? `<span style="display:inline-block;width:22px;height:22px;border-radius:999px;${grad(t)}color:#FFFFFF;font:800 12px/22px ${FONT};text-align:center;">${i + 1}</span>`
      : `<span class="cell-off" style="display:inline-block;width:22px;height:22px;border-radius:999px;background:${BRAND.line};color:${BRAND.muted};font:800 12px/22px ${FONT};text-align:center;">${i + 1}</span>`;
    const color = now ? t.from : done ? "#15803D" : BRAND.muted;
    return `<td align="center" valign="top" width="${Math.floor(100 / items.length)}%" style="padding:0 2px;">${dot}<div style="margin-top:6px;font:${now ? 800 : 600} 11px/1.3 ${FONT};color:${color};">${label}</div></td>`;
  }).join("");
  return `
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;"><tr>${cells}</tr></table>`;
}

/** A UK-style number plate with the GB band: a little Depotcharge signature in every header. */
function plate(text) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="border-radius:6px;box-shadow:0 2px 0 rgba(0,0,0,.18);"><tr>
                  <td bgcolor="#1E3A8A" style="background:#1E3A8A;border-radius:6px 0 0 6px;padding:7px 6px;font:800 9px/1 ${FONT};color:#FFD23F;letter-spacing:.04em;">GB</td>
                  <td bgcolor="#FFD23F" style="background:#FFD23F;border-radius:0 6px 6px 0;padding:6px 12px;font:800 16px/1 'Arial Black', ${FONT};letter-spacing:.06em;color:#111111;white-space:nowrap;">${esc(text)}</td>
                </tr></table>`;
}

function panel(t, icon, html) {
  return `
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 22px;">
            <tr><td class="panel" bgcolor="${t.soft}" style="background:${t.soft};border-left:4px solid ${t.from};border-radius:12px;padding:16px 18px;">
              <table role="presentation" cellpadding="0" cellspacing="0"><tr>
                <td valign="top" style="padding:0 12px 0 0;font:400 22px/1.2 ${FONT};">${icon}</td>
                <td class="ink" style="font:400 15px/1.6 ${FONT};color:${BRAND.ink};">${html}</td>
              </tr></table>
            </td></tr>
          </table>`;
}

function code(t, token) {
  return `
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 24px;">
            <tr><td align="center" class="panel codebox" bgcolor="${t.soft}" style="background:${t.soft};border:2px dashed ${t.from};border-radius:14px;padding:20px;font:800 36px/1 'SFMono-Regular', Menlo, Consolas, monospace;letter-spacing:.32em;color:${t.from};">${token}</td></tr>
          </table>`;
}

function layout({ preheader, heading, kicker, body, footerReason, theme, plate: plateText }) {
  const t = THEMES[theme];
  return `<!doctype html>
<html lang="en-GB" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(heading)}</title>
<style>
  body { margin:0; padding:0; }
  a { color:${BRAND.blue}; }
  @media (max-width:600px) {
    .pad { padding-left:22px !important; padding-right:22px !important; }
    .h1 { font-size:26px !important; }
  }
  @media (prefers-color-scheme: dark) {
    .bg { background:#0F131A !important; }
    .card { background:#181D25 !important; border-color:#2B3139 !important; }
    .ink { color:#EEF1F5 !important; }
    .muted { color:#A3ACB8 !important; }
    .panel { background:#20252C !important; }
    .cell-off { background:#2B3139 !important; }
    .brand { color:#EEF1F5 !important; }
    .link { color:#8EA8FF !important; }
    .codebox { color:#D8CCFF !important; }
  }
</style>
</head>
<body class="bg" style="margin:0;padding:0;background:${BRAND.canvas};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${esc(preheader)}&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="bg" style="background:${BRAND.canvas};">
    <tr><td align="center" style="padding:28px 14px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;">
        <tr><td style="padding:0 6px 16px;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td width="32" height="32" align="center" bgcolor="${BRAND.blue}" style="width:32px;height:32px;border-radius:9px;${grad(THEMES.electric)}font:800 16px/32px ${FONT};color:#FFFFFF;">D</td>
            <td class="brand" style="padding-left:10px;font:800 18px/1 ${FONT};letter-spacing:-.01em;color:${BRAND.ink};">${BRAND.name}</td>
          </tr></table>
        </td></tr>
        <tr><td class="card" style="background:#FFFFFF;border:1px solid ${BRAND.line};border-radius:20px;overflow:hidden;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr><td class="pad" bgcolor="${t.from}" style="${grad(t)}padding:34px 36px 30px;border-radius:19px 19px 0 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
                <td valign="middle"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td width="56" height="56" align="center" style="width:56px;height:56px;border-radius:16px;background:rgba(255,255,255,.22);font:400 30px/56px ${FONT};">${t.emoji}</td></tr></table></td>
                <td valign="middle" align="right">${plate(plateText)}</td>
              </tr></table>
              <p style="margin:18px 0 6px;font:700 12px/1.2 ${FONT};letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,.85);">${esc(kicker)}</p>
              <h1 class="h1" style="margin:0;font:800 30px/1.2 ${FONT};letter-spacing:-.02em;color:#FFFFFF;">${heading}</h1>
            </td></tr>
            <tr><td bgcolor="#1F2430" style="background:#1F2430;padding:6px 36px;font-size:0;line-height:0;">
              <div style="border-top:3px dashed #FFD23F;font-size:0;line-height:0;">&nbsp;</div>
            </td></tr>
            <tr><td class="pad" style="padding:30px 36px 26px;">
${body(t)}
            </td></tr>
          </table>
        </td></tr>
        <tr><td align="center" style="padding:22px 10px 0;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td style="padding:0 4px;"><span style="display:inline-block;padding:6px 11px;border-radius:999px;background:#E8F7EE;color:#047857;font:700 12px/1 ${FONT};">No cards</span></td>
            <td style="padding:0 4px;"><span style="display:inline-block;padding:6px 11px;border-radius:999px;background:#EEF1FE;color:#2F5BEA;font:700 12px/1 ${FONT};">No terminals</span></td>
            <td style="padding:0 4px;"><span style="display:inline-block;padding:6px 11px;border-radius:999px;background:#FFF1E8;color:#C2410C;font:700 12px/1 ${FONT};">No queue</span></td>
          </tr></table>
          <p class="muted" style="margin:14px 0 4px;font:600 13px/1.6 ${FONT};color:${BRAND.muted};">${BRAND.name} · HGV charging, booked ahead</p>
          <p class="muted" style="margin:0;font:400 12px/1.6 ${FONT};color:${BRAND.muted};">${footerReason} <a href="{{ .SiteURL }}" style="color:${BRAND.muted};">Open ${BRAND.name}</a></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>
`;
}

const sentTo = "You're getting this because {{ .Email }} was used on " + BRAND.name + ".";

// ------------------------------------------------------------------ the emails
const emails = {
  // ---- Authentication
  confirmation: {
    plate: "PLUG 1N",
    subject: "⚡ One tap to plug you in to Depotcharge",
    preheader: "Confirm your email and your trucks are ready to book their first charge.",
    heading: "You're nearly plugged in",
    theme: "electric",
    kicker: "Welcome to Depotcharge",
    body: (t) => [
      steps(t, ["Sign up", "Confirm email", "Two-step", "Book a bay"], 1),
      p("Welcome aboard! Before we hand over the keys to the bays, we just need to check this email address is really yours."),
      p("It's one tap. That's fewer than it takes to find a working charger at most motorway services."),
      button(t, "{{ .ConfirmationURL }}", "Confirm my email"),
      panel(t, "🔐", "<strong>What happens next:</strong> you'll set up two-step verification with an authenticator app (about a minute), then you're ready to book your first slot. Booked trucks just drive in and plug in."),
      fallback("{{ .ConfirmationURL }}"),
      small("Didn't sign up? Someone may have mistyped their email. Ignore this and the account stays switched off."),
    ].join(""),
    footerReason: sentTo,
  },
  invite: {
    plate: "W3LC0ME",
    subject: "You've been invited to Depotcharge ⚡",
    preheader: "There's a bay with your name on it. Accept the invite to get started.",
    heading: "There's a bay with your name on it",
    theme: "electric",
    kicker: "You're invited",
    body: (t) => [
      p("You've been invited to Depotcharge, where fleets book HGV charging in seconds and drivers just turn up and plug in. No RFID cards in the glovebox, no app to install, no queue."),
      button(t, "{{ .ConfirmationURL }}", "Accept the invite"),
      fallback("{{ .ConfirmationURL }}"),
      small("Not expecting this? You can ignore it; nothing happens unless you accept."),
    ].join(""),
    footerReason: sentTo,
  },
  magic_link: {
    plate: "1 TAP",
    subject: "🔌 Your sign-in link is fully charged",
    preheader: "One tap and you're in. No password needed.",
    heading: "Your sign-in link is ready",
    theme: "plug",
    kicker: "Sign in",
    body: (t) => [
      meter(t, 100, "Link charge: 100%"),
      p("Tap below and you're in. No password, no faff, no hunting for a cable that reaches."),
      button(t, "{{ .ConfirmationURL }}", "Sign in to Depotcharge"),
      panel(t, "⏱️", "The link works once and runs flat after an hour, so use it soon."),
      fallback("{{ .ConfirmationURL }}"),
      small("Didn't ask for this? Ignore it. Nobody can sign in without the link, and it's only been sent to you."),
    ].join(""),
    footerReason: sentTo,
  },
  email_change: {
    plate: "N3W ADDR",
    subject: "Switching sockets? Confirm your new email",
    preheader: "Confirm the new email address for your Depotcharge account.",
    heading: "Confirm your new email address",
    theme: "swap",
    kicker: "Account update",
    body: (t) => [
      p("You asked to move your Depotcharge account from <strong>{{ .Email }}</strong> to <strong>{{ .NewEmail }}</strong>. One tap to finish the switch-over."),
      button(t, "{{ .ConfirmationURL }}", "Confirm new email"),
      fallback("{{ .ConfirmationURL }}"),
      small("Wasn't you? Don't tap anything. Sign in and change your password straight away, then tell your fleet administrator."),
    ].join(""),
    footerReason: sentTo,
  },
  recovery: {
    plate: "R3CHARGE",
    subject: "🔋 Flat password? Let's get you recharged",
    preheader: "Choose a new password for your Depotcharge account.",
    heading: "Reset your password",
    theme: "battery",
    kicker: "Password reset",
    body: (t) => [
      meter(t, 10, "Password charge: 10%"),
      p("It happens to the best of us, usually right after a long weekend. Tap below to choose a new one."),
      button(t, "{{ .ConfirmationURL }}", "Choose a new password"),
      panel(t, "💡", "<strong>Tip:</strong> use at least 12 characters. A short sentence is easy to remember and hard to guess: <em>my truck charges at 400 kilowatts</em> beats <em>P@ssw0rd1</em> every time."),
      fallback("{{ .ConfirmationURL }}"),
      small("Didn't ask for a reset? Ignore this and your password stays as it is. If these keep arriving, let your fleet administrator know."),
    ].join(""),
    footerReason: sentTo,
  },
  reauthentication: {
    plate: "IT'S ME",
    subject: "Your Depotcharge security code: {{ .Token }}",
    preheader: "Enter this code to confirm it's you.",
    heading: "Here's your security code",
    theme: "code",
    kicker: "Security check",
    body: (t) => [
      p("Enter this code to confirm it's really you. Think of it as the barrier camera reading your plate, without the queue."),
      code(t, "{{ .Token }}"),
      small("It expires shortly and works once. Didn't ask for a code? Someone may be trying to change your account: change your password now."),
    ].join(""),
    footerReason: sentTo,
  },

  // ---- Security notifications
  password_changed_notification: {
    plate: "ALL G00D",
    subject: "Your Depotcharge password was changed",
    preheader: "If that was you, you're all set.",
    heading: "Password changed",
    theme: "good",
    kicker: "Security alert",
    body: (t) => [
      p("The password for <strong>{{ .Email }}</strong> was just changed. If that was you, you're all set and fully charged."),
      panel(t, "⚠️", "<strong>Not you?</strong> Reset your password straight away from the sign-in page and tell your fleet administrator."),
      button(t, "{{ .SiteURL }}", "Go to Depotcharge"),
    ].join(""),
    footerReason: sentTo,
  },
  email_changed_notification: {
    plate: "M0VED",
    subject: "Your Depotcharge email address was changed",
    preheader: "Your account now uses a new email address.",
    heading: "Email address changed",
    theme: "swap",
    kicker: "Security alert",
    body: (t) => [
      p("Your Depotcharge account has moved from <strong>{{ .OldEmail }}</strong> to <strong>{{ .Email }}</strong>. Sign-in links and alerts now go to the new address."),
      panel(t, "⚠️", "<strong>Not you?</strong> Contact your fleet administrator right away so they can lock the account."),
    ].join(""),
    footerReason: "You're getting this because the email on a " + BRAND.name + " account changed.",
  },
  phone_changed_notification: {
    plate: "N3W N0",
    subject: "Your Depotcharge phone number was changed",
    preheader: "The phone number on your account has changed.",
    heading: "Phone number changed",
    theme: "phone",
    kicker: "Security alert",
    body: (t) => [
      p("The phone number on your Depotcharge account changed from <strong>{{ .OldPhone }}</strong> to <strong>{{ .Phone }}</strong>."),
      panel(t, "⚠️", "<strong>Not you?</strong> Sign in, change your password and tell your fleet administrator."),
    ].join(""),
    footerReason: sentTo,
  },
  identity_linked_notification: {
    plate: "+1 WAY",
    subject: "A new sign-in method was added to Depotcharge",
    preheader: "{{ .Provider }} can now be used to sign in to your account.",
    heading: "New sign-in method added",
    theme: "info",
    kicker: "Security alert",
    body: (t) => [
      p("You can now sign in to Depotcharge with <strong>{{ .Provider }}</strong>. Another way in, like a second charging connector on the same bay."),
      panel(t, "⚠️", "<strong>Not you?</strong> Sign in, remove it and change your password."),
    ].join(""),
    footerReason: sentTo,
  },
  identity_unlinked_notification: {
    plate: "-1 WAY",
    subject: "A sign-in method was removed from Depotcharge",
    preheader: "{{ .Provider }} can no longer be used to sign in.",
    heading: "Sign-in method removed",
    theme: "alert",
    kicker: "Security alert",
    body: (t) => [
      p("<strong>{{ .Provider }}</strong> can no longer be used to sign in to your Depotcharge account."),
      panel(t, "⚠️", "<strong>Not you?</strong> Change your password and tell your fleet administrator."),
    ].join(""),
    footerReason: sentTo,
  },
  mfa_factor_enrolled_notification: {
    plate: "2 STEPS",
    subject: "🔐 Two-step verification added to Depotcharge",
    preheader: "Your account now has a second lock.",
    heading: "Two-step verification is on",
    theme: "shield",
    kicker: "Security alert",
    body: (t) => [
      meter(t, 100, "Security charge: 100%"),
      p("A new <strong>{{ .FactorType }}</strong> verification method was added to your account. It's now protected by a barrier <em>and</em> a plate reader: a password plus a code from your phone."),
      panel(t, "⚠️", "<strong>Not you?</strong> Sign in, remove the method and change your password."),
    ].join(""),
    footerReason: sentTo,
  },
  mfa_factor_unenrolled_notification: {
    plate: "1 STEP",
    subject: "Two-step verification removed from Depotcharge",
    preheader: "A verification method was removed from your account.",
    heading: "Verification method removed",
    theme: "alert",
    kicker: "Security alert",
    body: (t) => [
      meter(t, 50, "Security charge: 50%"),
      p("A <strong>{{ .FactorType }}</strong> verification method was removed from your Depotcharge account. If your fleet requires two-step verification, you'll be asked to set it up again next time you sign in."),
      panel(t, "⚠️", "<strong>Not you?</strong> Change your password straight away and tell your fleet administrator."),
    ].join(""),
    footerReason: sentTo,
  },
};

fs.mkdirSync(OUT, { recursive: true });
const subjects = {};
for (const [name, e] of Object.entries(emails)) {
  fs.writeFileSync(path.join(OUT, `${name}.html`), layout(e));
  subjects[name] = e.subject;
}
fs.writeFileSync(path.join(OUT, "subjects.json"), JSON.stringify(subjects, null, 2) + "\n");
console.log(`wrote ${Object.keys(emails).length} templates to supabase/templates/`);
