#!/usr/bin/env node
/**
 * One-time helper: mint a Gmail API refresh token with the gmail.send scope.
 * Run this LOCALLY on your Mac (not in the routine). It opens a loopback OAuth
 * flow, you approve in the browser, and it prints the refresh token to paste
 * into the routine's environment variables.
 *
 * Prereqs (Google Cloud Console, one-time):
 *   1. Create/choose a project, enable the "Gmail API".
 *   2. OAuth consent screen: External, add your Gmail as a Test user.
 *   3. Credentials → Create OAuth client ID → application type "Desktop app".
 *      (Desktop clients allow http://localhost loopback redirects automatically.)
 *   4. Copy the Client ID and Client secret.
 *
 * Usage:
 *   GMAIL_CLIENT_ID=xxx GMAIL_CLIENT_SECRET=yyy node scripts/get-refresh-token.js
 */

const http = require('http');
const { exec } = require('child_process');

const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const PORT = Number(process.env.PORT || 53682);
const REDIRECT = `http://localhost:${PORT}`;
const SCOPE = 'https://www.googleapis.com/auth/gmail.send';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in the environment first.');
  process.exit(1);
}

const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT,
  response_type: 'code',
  scope: SCOPE,
  access_type: 'offline',
  prompt: 'consent',
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT);
  const code = url.searchParams.get('code');
  if (!code) {
    res.writeHead(400); res.end('No code in callback.');
    return;
  }
  try {
    const tokRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT,
        grant_type: 'authorization_code',
      }),
    });
    const data = await tokRes.json();
    if (!data.refresh_token) {
      res.writeHead(500);
      res.end('No refresh_token returned. Revoke prior access at https://myaccount.google.com/permissions and retry.');
      console.error('\nResponse:', JSON.stringify(data, null, 2));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Success. Refresh token printed in your terminal. You can close this tab.');
      console.log('\n=== GMAIL_REFRESH_TOKEN ===\n' + data.refresh_token + '\n');
      console.log('Paste this (plus your CLIENT_ID and CLIENT_SECRET) into the routine environment variables.');
    }
  } catch (err) {
    res.writeHead(500); res.end('Token exchange failed: ' + err.message);
    console.error(err);
  } finally {
    server.close();
    setTimeout(() => process.exit(0), 100);
  }
});

server.listen(PORT, () => {
  console.log(`Listening on ${REDIRECT}\nOpening browser for consent...\nIf it does not open, visit:\n${authUrl}\n`);
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${opener} "${authUrl}"`);
});
