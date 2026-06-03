#!/usr/bin/env node
/**
 * Debugging tool: for each page (or one if --only=<slug>), load it, wait for
 * full load + a bit, then report what we can see — forms, iframes, HubSpot
 * containers, CTAs. Helps diagnose why monitor.js can't locate a form.
 *
 *   node inspect.js                 # all pages
 *   node inspect.js --only=request-demo
 *   node inspect.js --only=product-rewards-recognition --headed
 */

const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'pages.config.json'), 'utf8'));
const args = process.argv.slice(2);
const onlyArg = args.find(a => a.startsWith('--only='));
const ONLY = onlyArg ? onlyArg.split('=')[1] : null;
const HEADED = args.includes('--headed');

async function inspect(browser, page) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const tab = await ctx.newPage();
  const report = { slug: page.slug, url: page.url, sections: {} };

  try {
    await tab.goto(page.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await tab.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

    // Scroll the whole page to trigger lazy-loads
    await tab.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 400) {
        window.scrollTo(0, y); await new Promise(r => setTimeout(r, 100));
      }
      window.scrollTo(0, 0);
    });
    await tab.waitForTimeout(2000);

    report.sections.iframes = await tab.$$eval('iframe', els => els.map(e => ({
      id: e.id || null,
      class: e.className || null,
      src: e.src ? e.src.slice(0, 120) : null,
    })));

    report.sections.forms = await tab.$$eval('form', els => els.map(e => ({
      id: e.id || null,
      class: e.className || null,
      action: e.action || null,
      visibleInputs: Array.from(e.querySelectorAll('input,select,textarea'))
        .filter(i => i.offsetParent !== null && i.type !== 'hidden').length,
    })));

    report.sections.hsContainers = await tab.$$eval(
      '.hbspt-form, [data-hs-form-portal], .hs-form, [data-hubspot-form], #hs-form',
      els => els.map(e => ({ tag: e.tagName, id: e.id || null, class: e.className || null }))
    ).catch(() => []);

    report.sections.demoCTAs = await tab.$$eval(
      'a, button',
      els => els
        .map(e => ({ text: (e.innerText || '').trim().slice(0, 80), tag: e.tagName, href: e.getAttribute('href') }))
        .filter(c => c.text && /demo|book|request|download|get.+(copy|access|started)|talk to/i.test(c.text))
        .slice(0, 15)
    );

    // Iframes that look HubSpot-y
    report.sections.hubspotIframes = report.sections.iframes.filter(f =>
      (f.id && /hs-?form/i.test(f.id)) ||
      (f.class && /hs-?form/i.test(f.class)) ||
      (f.src && /hsforms\.|hubspot/i.test(f.src))
    );

    report.sections.url = tab.url();
    report.sections.title = await tab.title();
  } catch (err) {
    report.error = err.message;
  } finally {
    await ctx.close();
  }
  return report;
}

async function main() {
  const pages = ONLY ? config.pages.filter(p => p.slug === ONLY) : config.pages;
  if (!pages.length) { console.error(`no page matched ${ONLY}`); process.exit(2); }

  const browser = await chromium.launch({ headless: !HEADED, channel: 'chrome' });
  const all = [];
  for (const p of pages) {
    console.log(`\n=== ${p.slug} ===\n${p.url}`);
    const r = await inspect(browser, p);
    all.push(r);
    console.log(`title: ${r.sections.title || '(none)'}`);
    console.log(`forms found: ${r.sections.forms?.length || 0}`, JSON.stringify(r.sections.forms || [], null, 2));
    console.log(`iframes: ${r.sections.iframes?.length || 0}`);
    if (r.sections.hubspotIframes?.length) {
      console.log('hubspot-shaped iframes:', JSON.stringify(r.sections.hubspotIframes, null, 2));
    }
    if (r.sections.hsContainers?.length) {
      console.log('hubspot containers:', JSON.stringify(r.sections.hsContainers, null, 2));
    }
    if (r.sections.demoCTAs?.length) {
      console.log('demo-ish CTAs (top 15):', JSON.stringify(r.sections.demoCTAs, null, 2));
    }
    if (r.error) console.log('ERROR:', r.error);
  }
  await browser.close();

  const out = path.join(__dirname, 'logs', `inspect-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(out, JSON.stringify(all, null, 2));
  console.log(`\nFull report: ${path.relative(__dirname, out)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
