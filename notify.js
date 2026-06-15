/**
 * Email the form-monitor report via the Gmail REST API (OAuth2 refresh token).
 *
 * Why the Gmail API and not the Gmail MCP connector: the connector only exposes
 * create_draft (no send), so scheduled remote runs could never actually deliver.
 * This module sends over plain HTTPS, which works through the remote sandbox's
 * HTTP/HTTPS egress proxy once the two Google API hosts are allowlisted.
 *
 * Required env (set as environment variables on the routine's cloud environment):
 *   GMAIL_CLIENT_ID      OAuth client id (Desktop app)
 *   GMAIL_CLIENT_SECRET  OAuth client secret
 *   GMAIL_REFRESH_TOKEN  refresh token with scope gmail.send (minted once via scripts/get-refresh-token.js)
 * Optional env (sensible defaults below):
 *   REPORT_FROM  From address (defaults to the authorized Gmail account)
 *   REPORT_TO    primary recipient(s), comma-separated
 *   REPORT_CC    cc recipient(s), comma-separated
 *
 * Egress allowlist needed: oauth2.googleapis.com, gmail.googleapis.com
 */

const DEFAULT_TO = 'angshuman.talukdar@vantagecircle.com';
const DEFAULT_CC = 'himashree.sarma@vantagecircle.com,gayatri.nath@vantagecircle.com';

function base64url(str) {
  return Buffer.from(str, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function buildSummary(results, runPath) {
  const pass = results.filter(r => r.ok).length;
  const total = results.length;
  const dateStr = new Date().toISOString().slice(0, 10);
  const subject = `Form Monitor: ${pass}/${total} passing — ${dateStr}`;

  const failures = results.filter(r => !r.ok);
  const lines = [];
  lines.push(`Form Monitor Run — ${dateStr}`);
  lines.push(`Run timestamp: ${new Date().toISOString()}`);
  lines.push(`Result: ${pass} / ${total} forms passing`);
  lines.push('');

  if (failures.length) {
    lines.push(failures.length === total ? 'ALL FORMS FAILING:' : 'FAILURES:');
    lines.push(`${pad('slug', 34)}| ${pad('ok', 5)}| ${pad('stage', 18)}| detail`);
    lines.push(`${'-'.repeat(34)}|${'-'.repeat(6)}|${'-'.repeat(19)}|${'-'.repeat(40)}`);
    for (const f of failures) {
      lines.push(`${pad(f.slug, 34)}| ${pad('FAIL', 5)}| ${pad(f.stage || '', 18)}| ${f.detail || ''}`);
    }
    lines.push('');
  }

  lines.push('ALL RESULTS:');
  lines.push(`${pad('slug', 34)}| ${pad('ok', 5)}| ${pad('stage', 18)}| detail`);
  lines.push(`${'-'.repeat(34)}|${'-'.repeat(6)}|${'-'.repeat(19)}|${'-'.repeat(40)}`);
  for (const r of results) {
    lines.push(`${pad(r.slug, 34)}| ${pad(r.ok ? 'ok' : 'FAIL', 5)}| ${pad(r.stage || '', 18)}| ${r.detail || ''}`);
  }
  lines.push('');
  lines.push(`Run log: ${runPath}`);

  return { subject, body: lines.join('\n'), pass, total };
}

async function getAccessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      refresh_token: process.env.GMAIL_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`token exchange failed (${res.status}): ${data.error || ''} ${data.error_description || ''}`.trim());
  }
  return data.access_token;
}

/**
 * Send the report. Returns { sent: boolean, reason?: string, subject?: string }.
 * Never throws — email failure must not mask the monitor result.
 */
async function sendReport(results, runPath) {
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
    const reason = 'Gmail OAuth env vars missing (GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN) — skipping email.';
    console.warn(`[form-monitor] ${reason}`);
    return { sent: false, reason };
  }

  const to = process.env.REPORT_TO || DEFAULT_TO;
  const cc = process.env.REPORT_CC || DEFAULT_CC;
  const from = process.env.REPORT_FROM || 'me';
  const { subject, body } = buildSummary(results, runPath);

  try {
    const accessToken = await getAccessToken();

    const headers = [
      from !== 'me' ? `From: ${from}` : null,
      `To: ${to}`,
      cc ? `Cc: ${cc}` : null,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
    ].filter(Boolean).join('\r\n');
    const raw = base64url(`${headers}\r\n\r\n${body}`);

    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = `Gmail send failed (${res.status}): ${data.error?.message || JSON.stringify(data)}`;
      console.error(`[form-monitor] ${reason}`);
      return { sent: false, reason };
    }
    console.log(`[form-monitor] report emailed to ${to}${cc ? ` (cc ${cc})` : ''} — id ${data.id}`);
    return { sent: true, subject };
  } catch (err) {
    const reason = `Gmail send error: ${err.message}`;
    console.error(`[form-monitor] ${reason}`);
    return { sent: false, reason };
  }
}

module.exports = { sendReport, buildSummary };
