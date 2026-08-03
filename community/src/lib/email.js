/**
 * Sends via Resend, not Cloudflare's own Email Sending — that product is
 * paid-tier only. Resend's free tier (3,000/mo, no card required) covers
 * this comfortably, and a plain `fetch` needs no SDK and no Cloudflare
 * binding at all.
 *
 * The one place any outbound email actually leaves this Worker — magic
 * links (lib/auth.js) and report alerts (routes/messages.js) both call
 * this rather than building their own Resend request.
 */
export async function sendEmail(env, { to, subject, html, text }) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: `${env.EMAIL_FROM_NAME} <${env.EMAIL_FROM_ADDRESS}>`,
      to,
      subject,
      html,
      text,
    }),
  });

  if (!response.ok) {
    // Bounded, not the full body: a provider error page is not something
    // to echo back wholesale into a log line.
    const detail = await response.text().catch(() => '');
    throw new Error(`Resend API error (${response.status}): ${detail.slice(0, 300)}`);
  }
}
