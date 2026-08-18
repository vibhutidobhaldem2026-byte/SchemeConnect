/**
 * Email delivery via Resend.
 *
 * Talks to the Resend REST API directly with fetch — the official SDK is a
 * thin wrapper over the same two endpoints and would be the project's second
 * runtime dependency for no gain.
 *
 * The API key is read from the environment and never logged. Delivery failures
 * are surfaced to the caller with Resend's own error text rather than being
 * swallowed, because "the code never arrived" is otherwise impossible to debug.
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/**
 * Which transport delivers the mail.
 *
 * SMTP takes precedence when configured, because it is the option that works
 * without owning a domain. Resend — like every reputable API provider — will
 * only deliver to arbitrary recipients from a domain you have verified with
 * DNS records; without one it is limited to the account owner's own address.
 * Sending through a provider's own SMTP (Gmail's, for instance) sidesteps that
 * entirely: the provider signs the message as itself, so there is no SPF or
 * DKIM for us to publish.
 */
export function transport() {
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) return 'smtp';
  if (process.env.RESEND_API_KEY) return 'resend';
  return null;
}

export function isEmailConfigured() {
  return transport() !== null;
}

export function senderAddress() {
  if (transport() === 'smtp') {
    // Most providers refuse to send as an address other than the authenticated
    // account, so the account itself is the safe default.
    return process.env.SMTP_FROM || process.env.SMTP_USER;
  }
  return process.env.RESEND_FROM || 'SchemeConnect <onboarding@resend.dev>';
}

/** Replies to no-reply transactional mail should still reach a human. */
export function replyToAddress() {
  return process.env.RESEND_REPLY_TO || null;
}

/** The domain we send from, for display and diagnostics. */
export function senderDomain() {
  const match = /<([^>]+)>/.exec(senderAddress());
  const address = match ? match[1] : senderAddress();
  return address.split('@')[1] ?? null;
}

/** Never let the key reach a log line or an error page. */
function redact(text) {
  return String(text ?? '').replace(/re_[A-Za-z0-9_-]+/g, 're_***redacted***');
}

/** Resend's wording when the From domain has not passed DNS verification. */
const DOMAIN_UNVERIFIED = /domain is not verified/i;

/** Always-available sender, used only while a custom domain is still pending. */
export const FALLBACK_SENDER = process.env.RESEND_FROM_FALLBACK
  || 'SchemeConnect <onboarding@resend.dev>';

/** One POST to Resend. No retry logic — the caller decides about fallback. */
async function postEmail(from, { to, subject, html, text }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);

  const payload = { from, to: [to], subject, html, text };
  const replyTo = replyToAddress();
  if (replyTo) payload.reply_to = replyTo;

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const bodyText = await res.text();
    let body = null;
    try { body = JSON.parse(bodyText); } catch { /* non-JSON error page */ }

    if (!res.ok) {
      const message = body?.message || body?.error?.message || bodyText || `HTTP ${res.status}`;
      return { ok: false, status: res.status, error: redact(message), from };
    }
    return { ok: true, id: body?.id, status: res.status, from };
  } catch (err) {
    const message = err.name === 'AbortError' ? 'Resend request timed out' : err.message;
    return { ok: false, error: redact(message), from };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sends one email.
 *
 * DNS verification of a new sending domain takes anywhere from minutes to a
 * day. Rather than letting every OTP fail during that window, a
 * "domain is not verified" rejection retries once from Resend's shared sender.
 * That keeps sign-in working, and the moment DNS verifies the configured
 * domain takes over on its own with no code or config change.
 *
 * The fallback is announced loudly rather than silently: it is a degraded
 * state, and it reverts Resend's sandbox limits (delivery only to the account
 * owner's own address).
 *
 * @returns {Promise<{ok:boolean, id?:string, error?:string, status?:number,
 *                    from?:string, usedFallback?:boolean, domainUnverified?:boolean}>}
 */
export async function sendEmail({ to, subject, html, text }) {
  if (!isEmailConfigured()) {
    return { ok: false, error: 'No email transport configured (set SMTP_* or RESEND_API_KEY)' };
  }

  if (transport() === 'smtp') return sendViaSmtp({ to, subject, html, text });

  const primary = senderAddress();
  const first = await postEmail(primary, { to, subject, html, text });
  if (first.ok) return { ...first, usedFallback: false };

  const unverified = first.status === 403 && DOMAIN_UNVERIFIED.test(first.error || '');
  if (!unverified || FALLBACK_SENDER === primary) {
    return { ...first, usedFallback: false, domainUnverified: unverified };
  }

  console.warn(
    `  [mail] ${senderDomain()} is not verified in Resend yet — falling back to ${FALLBACK_SENDER}.\n` +
    '         Add the DNS records from https://resend.com/domains to send from your own domain.'
  );

  const second = await postEmail(FALLBACK_SENDER, { to, subject, html, text });
  return { ...second, usedFallback: true, domainUnverified: true };
}

/**
 * Delivers through an SMTP server.
 *
 * The transporter is built once and reused — every send would otherwise pay a
 * fresh TCP connection, TLS handshake and SMTP AUTH.
 */
let transporter = null;

async function sendViaSmtp({ to, subject, html, text }) {
  const port = Number(process.env.SMTP_PORT || 587);
  try {
    if (!transporter) {
      const { createTransport } = await import('nodemailer');
      transporter = createTransport({
        host: process.env.SMTP_HOST,
        port,
        // 465 is implicit TLS; 587 upgrades with STARTTLS.
        secure: port === 465,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
    }

    const info = await transporter.sendMail({
      from: senderAddress(),
      to,
      subject,
      html,
      text,
      ...(replyToAddress() ? { replyTo: replyToAddress() } : {}),
    });

    return { ok: true, id: info.messageId, from: senderAddress(), usedFallback: false };
  } catch (err) {
    // A bad app password is the usual cause and the message says so plainly;
    // pass it through rather than flattening it to "send failed".
    transporter = null;
    return {
      ok: false,
      error: `SMTP: ${err.message}`,
      from: senderAddress(),
      usedFallback: false,
    };
  }
}

/** Plain-text fallback for clients that don't render HTML. */
function otpText(code, minutes) {
  return [
    'SchemeConnect verification code',
    '',
    `Your code is ${code}`,
    '',
    `It expires in ${minutes} minutes and can only be used once.`,
    '',
    'If you did not request this, you can ignore this email. Nobody can access',
    'your account without this code.',
    '',
    'Questions? support@schemeconnect.com',
    '',
    'SchemeConnect never asks you to share this code with anyone — not by phone,',
    'not by SMS, not by email.',
  ].join('\n');
}

/**
 * OTP email. Inline styles and a table layout because email clients strip
 * <style> blocks and have patchy flexbox support.
 */
function otpHtml(code, minutes, isInstitute) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F4F8FA;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F8FA;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:460px;background:#ffffff;border:1px solid #E1E9EF;border-radius:14px;overflow:hidden;">

        <tr><td style="padding:32px 32px 0;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td style="width:10px;height:10px;background:#3B82F6;border-radius:3px;font-size:0;line-height:0;">&nbsp;</td>
            <td style="padding-left:8px;font-size:16px;font-weight:800;color:#0A2540;letter-spacing:-0.2px;">SchemeConnect</td>
          </tr></table>
        </td></tr>

        <tr><td style="padding:26px 32px 0;">
          <div style="font-size:12px;font-weight:700;color:#3B82F6;text-transform:uppercase;letter-spacing:.06em;">
            ${isInstitute ? 'Institute sign-in' : 'Verify your email'}
          </div>
          <h1 style="margin:8px 0 6px;font-size:22px;line-height:1.3;color:#0A2540;font-weight:800;">Your verification code</h1>
          <p style="margin:0;font-size:14px;line-height:1.6;color:#64748B;">
            Enter this code on SchemeConnect to finish signing in.
          </p>
        </td></tr>

        <tr><td style="padding:24px 32px 0;">
          <div style="background:#F4F8FA;border:1px solid #E1E9EF;border-radius:12px;padding:22px;text-align:center;">
            <div style="font-size:34px;font-weight:800;letter-spacing:10px;color:#0A2540;font-family:'SFMono-Regular',Consolas,Menlo,monospace;">
              ${code}
            </div>
            <div style="margin-top:10px;font-size:12.5px;color:#64748B;">
              Expires in ${minutes} minutes · single use
            </div>
          </div>
        </td></tr>

        <tr><td style="padding:22px 32px 0;">
          <div style="background:#FEF3E8;border-left:3px solid #C2660A;border-radius:0 8px 8px 0;padding:13px 16px;font-size:12.5px;line-height:1.6;color:#7C3A00;">
            <b>We will never ask you for this code.</b> Not by phone, not by SMS, not by email.
            Anyone who does is trying to take over your account.
          </div>
        </td></tr>

        <tr><td style="padding:20px 32px 30px;">
          <p style="margin:0;font-size:12px;line-height:1.7;color:#64748B;">
            Didn't try to sign in? You can safely ignore this email — your account stays locked without this code.
          </p>
          <p style="margin:14px 0 0;font-size:11.5px;line-height:1.7;color:#94A3B8;">
            SchemeConnect helps students find government scholarships they qualify for. We are an independent
            platform, not a government body, and we never charge students.
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * Sends a one-time code to an email address.
 * @param {string} to
 * @param {string} code
 * @param {{minutes?: number, isInstitute?: boolean}} opts
 */
export async function sendOtpEmail(to, code, { minutes = 10, isInstitute = false } = {}) {
  return sendEmail({
    to,
    subject: `${code} is your SchemeConnect verification code`,
    html: otpHtml(code, minutes, isInstitute),
    text: otpText(code, minutes),
  });
}
