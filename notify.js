/**
 * Email the form-monitor report. Two transports, picked by which env vars are set:
 *
 *   1. Resend (preferred) — one API key, a single HTTPS POST, no OAuth dance.
 *   2. Gmail REST API (fallback) — OAuth2 refresh token.
 *
 * Both send over plain HTTPS, which works through the remote sandbox's egress
 * proxy once the API host is allowlisted. The Gmail MCP connector is deliberately
 * not used: scheduled remote runs need a transport that works headless.
 *
 * Resend env:
 *   RESEND_API_KEY  API key from resend.com  (required to select this transport)
 *   RESEND_FROM     From address; MUST be on a domain verified in Resend.
 *                   Falls back to REPORT_FROM, then to Resend's shared test
 *                   sender, which can ONLY deliver to your own Resend account
 *                   address — cc recipients will silently not receive it.
 *
 * Gmail env (used only when RESEND_API_KEY is absent):
 *   GMAIL_CLIENT_ID      OAuth client id (Desktop app)
 *   GMAIL_CLIENT_SECRET  OAuth client secret
 *   GMAIL_REFRESH_TOKEN  refresh token with scope gmail.send (minted once via scripts/get-refresh-token.js)
 *
 * Shared optional env:
 *   REPORT_TO    primary recipient(s), comma-separated
 *   REPORT_CC    cc recipient(s), comma-separated
 *
 * Egress allowlist: api.resend.com (Resend) or oauth2.googleapis.com +
 * gmail.googleapis.com (Gmail).
 */

const DEFAULT_TO = 'angshuman.talukdar@vantagecircle.com';
const DEFAULT_CC = 'himashree.sarma@vantagecircle.com,gayatri.nath@vantagecircle.com';
const RESEND_TEST_FROM = 'Form Monitor <onboarding@resend.dev>';

function addrList(s) {
  return String(s || '').split(',').map(x => x.trim()).filter(Boolean);
}

function base64url(str) {
  return Buffer.from(str, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Link back to the Actions run, so the reader can grab the debug artifacts. */
function ciRunUrl() {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  if (!GITHUB_SERVER_URL || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) return null;
  return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
}

/** Per-form explanation: named field culprits when we have them, else the raw detail. */
function faultLines(r) {
  if (r.fieldFaults && r.fieldFaults.length) return r.fieldFaults;
  return [r.detail || 'No detail captured'];
}

const C = {
  ink: '#18181b',
  muted: '#52525b',
  faint: '#71717a',
  line: '#e4e4e7',
  bg: '#ffffff',
  shell: '#f4f4f5',
  badBg: '#fef3f2',
  bad: '#b42318',
  goodBg: '#ecfdf3',
  good: '#067647',
};

/**
 * Build the report in both HTML and plain text.
 *
 * HTML is the primary form: the previous version emitted a space-padded ASCII
 * table, which only lines up in a monospace font. Mail clients render text/plain
 * in a proportional font, so every column collapsed into ragged noise. Tables
 * here are real <table> markup with inline styles (mail clients strip <style>).
 */
function buildSummary(results, runPath) {
  const pass = results.filter(r => r.ok).length;
  const total = results.length;
  const failures = results.filter(r => !r.ok);
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toISOString().slice(11, 16) + ' UTC';
  const runUrl = ciRunUrl();

  const subject = failures.length
    ? `Form Monitor ALERT — ${failures.length} of ${total} failing · ${dateStr}`
    : `Form Monitor OK — ${total}/${total} passing · ${dateStr}`;

  /* ---------- plain text ---------- */
  const t = [];
  t.push(failures.length
    ? `FORM MONITOR ALERT — ${failures.length} of ${total} forms failing`
    : `FORM MONITOR OK — all ${total} forms passing`);
  t.push(`${dateStr} ${timeStr}`);
  t.push('');
  if (failures.length) {
    t.push('NEEDS ATTENTION');
    t.push('');
    for (const f of failures) {
      t.push(`  ${f.label || f.slug}`);
      t.push(`    page:    ${f.url}`);
      t.push(`    failed:  ${f.stage || 'unknown'} stage`);
      for (const line of faultLines(f)) t.push(`    cause:   ${line}`);
      t.push('');
    }
  }
  t.push(`PASSING (${pass}/${total})`);
  t.push('');
  for (const r of results.filter(r => r.ok)) {
    t.push(`  ok    ${r.label || r.slug}`);
  }
  t.push('');
  if (runUrl) {
    t.push(`CI run + debug artifacts: ${runUrl}`);
  }
  t.push(`Run log: ${runPath}`);

  /* ---------- html ---------- */
  const statusBg = failures.length ? C.badBg : C.goodBg;
  const statusInk = failures.length ? C.bad : C.good;
  const headline = failures.length
    ? `${failures.length} of ${total} forms failing`
    : `All ${total} forms passing`;

  const h = [];
  h.push(`<div style="margin:0;padding:24px 12px;background:${C.shell};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">`);
  h.push(`<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:640px;margin:0 auto;background:${C.bg};border:1px solid ${C.line};border-radius:10px;">`);

  // Status band
  h.push(`<tr><td style="padding:20px 24px;background:${statusBg};border-bottom:1px solid ${C.line};border-radius:10px 10px 0 0;">`);
  h.push(`<div style="font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:${C.faint};">Form Monitor</div>`);
  h.push(`<div style="margin-top:6px;font-size:22px;font-weight:700;color:${statusInk};line-height:1.3;">${esc(headline)}</div>`);
  h.push(`<div style="margin-top:4px;font-size:13px;color:${C.muted};">${esc(dateStr)} &middot; ${esc(timeStr)}</div>`);
  h.push(`</td></tr>`);

  // Failures
  if (failures.length) {
    h.push(`<tr><td style="padding:24px 24px 8px;">`);
    h.push(`<div style="font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:${C.faint};">Needs attention</div>`);
    h.push(`</td></tr>`);
    for (const f of failures) {
      h.push(`<tr><td style="padding:8px 24px;">`);
      h.push(`<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${C.badBg};border:1px solid #fecdc9;border-radius:8px;"><tr><td style="padding:14px 16px;">`);
      h.push(`<div style="font-size:15px;font-weight:650;color:${C.ink};">${esc(f.label || f.slug)}</div>`);
      h.push(`<div style="margin-top:2px;font-size:12px;color:${C.faint};font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${esc(f.slug)} &middot; failed at ${esc(f.stage || 'unknown')} stage</div>`);
      h.push(`<div style="margin-top:10px;font-size:13px;color:${C.ink};line-height:1.55;">`);
      for (const line of faultLines(f)) {
        h.push(`<div style="margin-top:3px;"><span style="color:${C.bad};font-weight:700;">&#8226;</span> ${esc(line)}</div>`);
      }
      h.push(`</div>`);
      h.push(`<div style="margin-top:12px;"><a href="${esc(f.url)}" style="font-size:13px;color:${C.bad};font-weight:600;text-decoration:underline;">Open the page &rarr;</a></div>`);
      h.push(`</td></tr></table></td></tr>`);
    }
  }

  // All results table
  h.push(`<tr><td style="padding:24px 24px 8px;">`);
  h.push(`<div style="font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:${C.faint};">All results</div>`);
  h.push(`</td></tr>`);
  h.push(`<tr><td style="padding:0 24px 8px;">`);
  h.push(`<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;font-size:13px;">`);
  for (const r of results) {
    const pillBg = r.ok ? C.goodBg : C.badBg;
    const pillInk = r.ok ? C.good : C.bad;
    h.push(`<tr>`);
    h.push(`<td style="padding:9px 10px 9px 0;border-bottom:1px solid ${C.line};vertical-align:top;">`);
    h.push(`<span style="display:inline-block;padding:2px 8px;border-radius:20px;background:${pillBg};color:${pillInk};font-size:11px;font-weight:700;letter-spacing:.04em;">${r.ok ? 'PASS' : 'FAIL'}</span>`);
    h.push(`</td>`);
    h.push(`<td style="padding:9px 0;border-bottom:1px solid ${C.line};vertical-align:top;color:${C.ink};">`);
    h.push(`<div style="font-weight:550;">${esc(r.label || r.slug)}</div>`);
    // Failing rows point up at their own card rather than repeating the whole
    // fault list, which otherwise wraps over three lines here.
    const rowNote = r.ok
      ? (r.detail || '')
      : `failed at ${r.stage || 'unknown'} stage \u2014 see above`;
    h.push(`<div style="margin-top:2px;color:${C.muted};font-size:12px;line-height:1.45;">${esc(rowNote)}</div>`);
    h.push(`</td></tr>`);
  }
  h.push(`</table></td></tr>`);

  // Footer
  h.push(`<tr><td style="padding:16px 24px 22px;border-top:1px solid ${C.line};">`);
  if (runUrl) {
    h.push(`<div style="font-size:13px;"><a href="${esc(runUrl)}" style="color:${C.muted};text-decoration:underline;">CI run &amp; debug artifacts (screenshot + page HTML)</a></div>`);
  }
  h.push(`<div style="margin-top:6px;font-size:12px;color:${C.faint};font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${esc(runPath)}</div>`);
  h.push(`</td></tr>`);

  h.push(`</table></div>`);

  return { subject, body: t.join('\n'), html: h.join(''), pass, total };
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

async function sendViaResend({ to, cc, subject, body, html }) {
  const from = process.env.RESEND_FROM || process.env.REPORT_FROM || RESEND_TEST_FROM;
  const testMode = from === RESEND_TEST_FROM;

  // Resend's shared test sender may only deliver to the address that owns the
  // Resend account. Any other recipient 403s the WHOLE send, so drop cc rather
  // than lose the report entirely. Verify a domain and set RESEND_FROM to cc.
  if (testMode) {
    console.warn('[form-monitor] RESEND_FROM unset — using Resend\'s shared test sender.');
    console.warn(`[form-monitor] cc dropped in test mode (${cc || 'none'}); only the Resend account address will receive this.`);
    cc = '';
  }

  const payload = { from, to: addrList(to), subject, text: body };
  if (html) payload.html = html;
  const ccList = addrList(cc);
  if (ccList.length) payload.cc = ccList;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) {
    // Resend returns { statusCode, name, message } on failure.
    const reason = `Resend send failed (${res.status}): ${data.message || data.name || JSON.stringify(data)}`;
    console.error(`[form-monitor] ${reason}`);
    return { sent: false, reason };
  }
  console.log(`[form-monitor] report emailed to ${to}${cc ? ` (cc ${cc})` : ''} — id ${data.id}`);
  return { sent: true, subject };
}

/**
 * Send the report. Returns { sent: boolean, reason?: string, subject?: string }.
 * Never throws — email failure must not mask the monitor result.
 */
async function sendReport(results, runPath) {
  const to = process.env.REPORT_TO || DEFAULT_TO;
  const cc = process.env.REPORT_CC || DEFAULT_CC;
  const { subject, body, html } = buildSummary(results, runPath);

  if (process.env.RESEND_API_KEY) {
    try {
      return await sendViaResend({ to, cc, subject, body, html });
    } catch (err) {
      const reason = `Resend send error: ${err.message}`;
      console.error(`[form-monitor] ${reason}`);
      return { sent: false, reason };
    }
  }

  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
    const reason = 'No email transport configured — set RESEND_API_KEY, or all three of GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN. Skipping email.';
    console.warn(`[form-monitor] ${reason}`);
    return { sent: false, reason };
  }

  const from = process.env.REPORT_FROM || 'me';

  try {
    const accessToken = await getAccessToken();

    // multipart/alternative: text first, HTML second — clients pick the last part
    // they can render, so the HTML report wins wherever it is supported.
    const boundary = 'fm_boundary_9d4c1f';
    const headers = [
      from !== 'me' ? `From: ${from}` : null,
      `To: ${to}`,
      cc ? `Cc: ${cc}` : null,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ].filter(Boolean).join('\r\n');
    const parts = [
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      body,
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      '',
      html,
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const raw = base64url(`${headers}\r\n\r\n${parts}`);

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
