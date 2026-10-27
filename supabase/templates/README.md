# Sign-in and security emails

The emails Supabase Auth sends (confirm sign-up, magic link, password reset, email change, invite,
security code, and the security notifications), written to sound like Depotcharge: welcoming,
a little funny, and about charging.

- **Edit** the copy or layout in `scripts/emails.mjs`, then run `npm run emails` to rebuild the
  `.html` files and `subjects.json`. Don't edit the `.html` files by hand.
- **Apply** them in Supabase → Authentication → Emails. Supabase only allows custom templates
  once **custom SMTP** is set up (Emails → SMTP Settings). For each template, paste the subject
  from `subjects.json` and the body from the matching `.html` file:

| Supabase template | File |
| --- | --- |
| Confirm sign up | `confirmation.html` |
| Invite user | `invite.html` |
| Magic link or OTP | `magic_link.html` |
| Change email address | `email_change.html` |
| Reset password | `recovery.html` |
| Reauthentication | `reauthentication.html` |
| Password changed | `password_changed_notification.html` |
| Email address changed | `email_changed_notification.html` |
| Phone number changed | `phone_changed_notification.html` |
| Sign-in method linked | `identity_linked_notification.html` |
| Sign-in method removed | `identity_unlinked_notification.html` |
| MFA method added | `mfa_factor_enrolled_notification.html` |
| MFA method removed | `mfa_factor_unenrolled_notification.html` |

Security notifications are only sent once switched on for each one in the same screen.

The placeholders (`{{ .ConfirmationURL }}`, `{{ .Email }}`, `{{ .Token }}` …) are Supabase's and
are filled in per person when an email is sent. The layout is plain HTML tables with inline
styles and no images or web fonts, so it renders the same in Outlook, Gmail and Apple Mail, and
has a dark version for the mail apps that support one.
