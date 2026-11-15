// Email via Resend (https://resend.com) free tier. No SDK dependency: plain fetch.
// Without RESEND_API_KEY the mailer is a no-op that logs, so local dev and tests
// never send real email.
const FROM = process.env.MAIL_FROM || 'Sahaay <onboarding@resend.dev>';

async function sendMail({ to, subject, text }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.log(`[mail:no-key] to=${to} subject=${subject}`); return { sent: false, reason: 'no_api_key' }; }
  if (!to) return { sent: false, reason: 'no_recipient' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: Array.isArray(to) ? to : [to], subject, text }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`[mail:error] ${res.status} ${body}`);
      return { sent: false, reason: `http_${res.status}` };
    }
    return { sent: true };
  } catch (e) {
    console.error('[mail:error]', e.message);
    return { sent: false, reason: e.message };
  }
}

module.exports = { sendMail };
