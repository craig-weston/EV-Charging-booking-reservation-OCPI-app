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

/** A row of ten cells filled to `pct`, like a charge bar. */
function meter(pct, label) {
  const filled = Math.round(pct / 10);
  const cells = Array.from({ length: 10 }, (_, i) =>
    `<td width="10%" style="padding:0 2px;"><div class="${i < filled ? "cell-on" : "cell-off"}" style="height:10px;border-radius:3px;background:${i < filled ? BRAND.blue : BRAND.line};font-size:0;line-height:0;">&nbsp;</div></td>`).join("");
  return `
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px;">
            <tr><td style="padding:0 0 8px;font:600 12px/1.2 ${FONT};letter-spacing:.06em;text-transform:uppercase;color:${BRAND.muted};" class="muted">⚡ ${esc(label)}</td></tr>
            <tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${cells}</tr></table></td></tr>
          </table>`;
}

const p = (html, extra = "") => `<p class="ink" style="margin:0 0 16px;font:400 16px/1.6 ${FONT};color:${BRAND.ink};${extra}">${html}</p>`;
const small = (html) => `<p class="muted" style="margin:0 0 12px;font:400 14px/1.6 ${FONT};color:${BRAND.muted};">${html}</p>`;

function button(href, label) {
  return `
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;">
            <tr><td style="border-radius:10px;background:${BRAND.blue};" bgcolor="${BRAND.blue}">
              <a href="${href}" target="_blank" style="display:inline-block;padding:15px 28px;border-radius:10px;border:1px solid ${BRAND.blue};font:700 16px/1 ${FONT};color:#FFFFFF;text-decoration:none;">${esc(label)} &rarr;</a>
            </td></tr>
          </table>`;
}

function fallback(href) {
  return small(`Button not working? Copy this link into your browser:<br><a class="link" href="${href}" style="color:${BRAND.blue};word-break:break-all;">${href}</a>`);
}

function panel(icon, html) {
  return `
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 20px;">
            <tr><td class="panel" style="background:${BRAND.panel};border-radius:12px;padding:14px 16px;">
              <table role="presentation" cellpadding="0" cellspacing="0"><tr>
                <td valign="top" style="padding:0 12px 0 0;font:400 20px/1.3 ${FONT};">${icon}</td>
                <td class="ink" style="font:400 14px/1.6 ${FONT};color:${BRAND.ink};">${html}</td>
              </tr></table>
            </td></tr>
          </table>`;
}

function code(token) {
  return `
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 24px;">
            <tr><td align="center" class="panel ink" style="background:${BRAND.panel};border:1px dashed ${BRAND.line};border-radius:12px;padding:18px;font:700 34px/1 'SFMono-Regular', Menlo, Consolas, monospace;letter-spacing:.3em;color:${BRAND.ink};">${token}</td></tr>
          </table>`;
}

function layout({ preheader, heading, body, footerReason }) {
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
    .card { padding:28px 22px !important; }
    .h1 { font-size:24px !important; }
  }
  @media (prefers-color-scheme: dark) {
    .bg { background:#0F131A !important; }
    .card { background:#181D25 !important; border-color:#2B3139 !important; }
    .ink { color:#EEF1F5 !important; }
    .muted { color:#A3ACB8 !important; }
    .panel { background:#20252C !important; border-color:#2B3139 !important; }
    .cell-off { background:#2B3139 !important; }
    .brand { color:#EEF1F5 !important; }
    .link { color:#8EA8FF !important; }
  }
</style>
</head>
<body class="bg" style="margin:0;padding:0;background:${BRAND.canvas};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${esc(preheader)}&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="bg" style="background:${BRAND.canvas};">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
        <tr><td style="padding:0 4px 18px;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td width="30" height="30" align="center" bgcolor="${BRAND.blue}" style="width:30px;height:30px;border-radius:8px;background:${BRAND.blue};font:800 15px/30px ${FONT};color:#FFFFFF;">D</td>
            <td class="brand" style="padding-left:10px;font:700 17px/1 ${FONT};color:${BRAND.ink};">${BRAND.name}</td>
          </tr></table>
        </td></tr>
        <tr><td class="card" style="background:#FFFFFF;border:1px solid ${BRAND.line};border-radius:16px;padding:36px 36px 28px;">
          <h1 class="h1 ink" style="margin:0 0 18px;font:700 28px/1.25 ${FONT};letter-spacing:-.01em;color:${BRAND.ink};">${heading}</h1>
${body}
        </td></tr>
        <tr><td style="padding:22px 8px 0;">
          <p class="muted" style="margin:0 0 6px;font:600 13px/1.6 ${FONT};color:${BRAND.muted};">${BRAND.name} · HGV charging, booked ahead. No cards, no terminals, no queue.</p>
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
    subject: "⚡ One tap to plug you in to Depotcharge",
    preheader: "Confirm your email and your trucks are ready to book their first charge.",
    heading: "You're nearly plugged in",
    body: [
      meter(80, "Account charge: 80%"),
      p("Welcome aboard! Before we hand over the keys to the bays, we just need to check this email address is really yours."),
      p("It's one tap. That's fewer than it takes to find a working charger at most motorway services."),
      button("{{ .ConfirmationURL }}", "Confirm my email"),
      panel("🔐", "<strong>What happens next:</strong> you'll set up two-step verification with an authenticator app (about a minute), then you're ready to book your first slot. Booked trucks just drive in and plug in."),
      fallback("{{ .ConfirmationURL }}"),
      small("Didn't sign up? Someone may have mistyped their email. Ignore this and the account stays switched off."),
    ].join(""),
    footerReason: sentTo,
  },
  invite: {
    subject: "You've been invited to Depotcharge ⚡",
    preheader: "There's a bay with your name on it. Accept the invite to get started.",
    heading: "There's a bay with your name on it",
    body: [
      p("You've been invited to Depotcharge, where fleets book HGV charging in seconds and drivers just turn up and plug in. No RFID cards in the glovebox, no app to install, no queue."),
      button("{{ .ConfirmationURL }}", "Accept the invite"),
      fallback("{{ .ConfirmationURL }}"),
      small("Not expecting this? You can ignore it; nothing happens unless you accept."),
    ].join(""),
    footerReason: sentTo,
  },
  magic_link: {
    subject: "🔌 Your sign-in link is fully charged",
    preheader: "One tap and you're in. No password needed.",
    heading: "Your sign-in link is ready",
    body: [
      meter(100, "Link charge: 100%"),
      p("Tap below and you're in. No password, no faff, no hunting for a cable that reaches."),
      button("{{ .ConfirmationURL }}", "Sign in to Depotcharge"),
      panel("⏱️", "The link works once and runs flat after an hour, so use it soon."),
      fallback("{{ .ConfirmationURL }}"),
      small("Didn't ask for this? Ignore it. Nobody can sign in without the link, and it's only been sent to you."),
    ].join(""),
    footerReason: sentTo,
  },
  email_change: {
    subject: "Switching sockets? Confirm your new email",
    preheader: "Confirm the new email address for your Depotcharge account.",
    heading: "Confirm your new email address",
    body: [
      p("You asked to move your Depotcharge account from <strong>{{ .Email }}</strong> to <strong>{{ .NewEmail }}</strong>. One tap to finish the switch-over."),
      button("{{ .ConfirmationURL }}", "Confirm new email"),
      fallback("{{ .ConfirmationURL }}"),
      small("Wasn't you? Don't tap anything. Sign in and change your password straight away, then tell your fleet administrator."),
    ].join(""),
    footerReason: sentTo,
  },
  recovery: {
    subject: "🔋 Flat password? Let's get you recharged",
    preheader: "Choose a new password for your Depotcharge account.",
    heading: "Reset your password",
    body: [
      meter(10, "Password charge: 10%"),
      p("It happens to the best of us, usually right after a long weekend. Tap below to choose a new one."),
      button("{{ .ConfirmationURL }}", "Choose a new password"),
      panel("💡", "<strong>Tip:</strong> use at least 12 characters. A short sentence is easy to remember and hard to guess: <em>my truck charges at 400 kilowatts</em> beats <em>P@ssw0rd1</em> every time."),
      fallback("{{ .ConfirmationURL }}"),
      small("Didn't ask for a reset? Ignore this and your password stays as it is. If these keep arriving, let your fleet administrator know."),
    ].join(""),
    footerReason: sentTo,
  },
  reauthentication: {
    subject: "Your Depotcharge security code: {{ .Token }}",
    preheader: "Enter this code to confirm it's you.",
    heading: "Here's your security code",
    body: [
      p("Enter this code to confirm it's really you. Think of it as the barrier camera reading your plate, without the queue."),
      code("{{ .Token }}"),
      small("It expires shortly and works once. Didn't ask for a code? Someone may be trying to change your account: change your password now."),
    ].join(""),
    footerReason: sentTo,
  },

  // ---- Security notifications
  password_changed_notification: {
    subject: "Your Depotcharge password was changed",
    preheader: "If that was you, you're all set.",
    heading: "Password changed ✅",
    body: [
      p("The password for <strong>{{ .Email }}</strong> was just changed. If that was you, you're all set and fully charged."),
      panel("⚠️", "<strong>Not you?</strong> Reset your password straight away from the sign-in page and tell your fleet administrator."),
      button("{{ .SiteURL }}", "Go to Depotcharge"),
    ].join(""),
    footerReason: sentTo,
  },
  email_changed_notification: {
    subject: "Your Depotcharge email address was changed",
    preheader: "Your account now uses a new email address.",
    heading: "Email address changed",
    body: [
      p("Your Depotcharge account has moved from <strong>{{ .OldEmail }}</strong> to <strong>{{ .Email }}</strong>. Sign-in links and alerts now go to the new address."),
      panel("⚠️", "<strong>Not you?</strong> Contact your fleet administrator right away so they can lock the account."),
    ].join(""),
    footerReason: "You're getting this because the email on a " + BRAND.name + " account changed.",
  },
  phone_changed_notification: {
    subject: "Your Depotcharge phone number was changed",
    preheader: "The phone number on your account has changed.",
    heading: "Phone number changed",
    body: [
      p("The phone number on your Depotcharge account changed from <strong>{{ .OldPhone }}</strong> to <strong>{{ .Phone }}</strong>."),
      panel("⚠️", "<strong>Not you?</strong> Sign in, change your password and tell your fleet administrator."),
    ].join(""),
    footerReason: sentTo,
  },
  identity_linked_notification: {
    subject: "A new sign-in method was added to Depotcharge",
    preheader: "{{ .Provider }} can now be used to sign in to your account.",
    heading: "New sign-in method added",
    body: [
      p("You can now sign in to Depotcharge with <strong>{{ .Provider }}</strong>. Another way in, like a second charging connector on the same bay."),
      panel("⚠️", "<strong>Not you?</strong> Sign in, remove it and change your password."),
    ].join(""),
    footerReason: sentTo,
  },
  identity_unlinked_notification: {
    subject: "A sign-in method was removed from Depotcharge",
    preheader: "{{ .Provider }} can no longer be used to sign in.",
    heading: "Sign-in method removed",
    body: [
      p("<strong>{{ .Provider }}</strong> can no longer be used to sign in to your Depotcharge account."),
      panel("⚠️", "<strong>Not you?</strong> Change your password and tell your fleet administrator."),
    ].join(""),
    footerReason: sentTo,
  },
  mfa_factor_enrolled_notification: {
    subject: "🔐 Two-step verification added to Depotcharge",
    preheader: "Your account now has a second lock.",
    heading: "Two-step verification is on",
    body: [
      meter(100, "Security charge: 100%"),
      p("A new <strong>{{ .FactorType }}</strong> verification method was added to your account. It's now protected by a barrier <em>and</em> a plate reader: a password plus a code from your phone."),
      panel("⚠️", "<strong>Not you?</strong> Sign in, remove the method and change your password."),
    ].join(""),
    footerReason: sentTo,
  },
  mfa_factor_unenrolled_notification: {
    subject: "Two-step verification removed from Depotcharge",
    preheader: "A verification method was removed from your account.",
    heading: "Verification method removed",
    body: [
      meter(50, "Security charge: 50%"),
      p("A <strong>{{ .FactorType }}</strong> verification method was removed from your Depotcharge account. If your fleet requires two-step verification, you'll be asked to set it up again next time you sign in."),
      panel("⚠️", "<strong>Not you?</strong> Change your password straight away and tell your fleet administrator."),
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
