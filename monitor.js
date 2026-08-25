#!/usr/bin/env node
/**
 * Vantage Circle form-monitor.
 * Visits each page in pages.config.json with a headless browser, locates the
 * primary form (HubSpot embed or inline HTML), fills required fields with a
 * marker test email, submits, and verifies a success state.
 *
 * Failures (and successes) are written as JSON to logs/runs/<timestamp>.json
 * and a rolling logs/failures.log digest captures only the failing runs.
 *
 * Run modes:
 *   node monitor.js              # real submit
 *   node monitor.js --dry        # fill but do not click submit (safe rehearsal)
 *   node monitor.js --only=slug  # restrict to one page (matches config slug)
 *   node monitor.js --headed     # show the browser (debugging)
 */

const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const { sendReport } = require('./notify');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'pages.config.json');
const LOG_DIR = path.join(ROOT, 'logs');
const RUN_DIR = path.join(LOG_DIR, 'runs');
const DEBUG_DIR = path.join(LOG_DIR, 'debug');
const FAILURE_LOG = path.join(LOG_DIR, 'failures.log');

const args = new Set(process.argv.slice(2));
const argOnly = process.argv.slice(2).find(a => a.startsWith('--only='));
const ONLY_SLUG = argOnly ? argOnly.split('=')[1] : null;
const DRY_RUN = args.has('--dry');
const HEADED = args.has('--headed');

// Deep enough for any real lead form; a backstop against a step loop that
// never terminates because the form keeps re-rendering.
const MAX_FORM_STEPS = 5;

const PLACEHOLDER = {
  firstname: 'Form',
  lastname: 'Monitor',
  fullname: 'Form Monitor',
  name: 'Form Monitor',
  company: 'VC Form Monitor (Test)',
  organization: 'VC Form Monitor (Test)',
  jobtitle: 'QA Automation',
  designation: 'QA Automation',
  title: 'QA Automation',
  phone: '9999999999',
  mobile: '9999999999',
  mobilephone: '9999999999',
  website: 'https://www.vantagecircle.com',
  message: 'Automated form-health monitor. Please disregard.',
  comment: 'Automated form-health monitor. Please disregard.',
  comments: 'Automated form-health monitor. Please disregard.',
  numberofemployees: '500',
  employees: '500',
  country: 'India',
  state: 'Assam',
  city: 'Guwahati',
  industry: 'Information Technology and Services',
  budget: '10000',
};

function ensureDirs() {
  for (const d of [LOG_DIR, RUN_DIR, DEBUG_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function buildEmail(cfg, slug) {
  return `${cfg.testEmailLocal}+${slug}@${cfg.testEmailDomain}`;
}

/**
 * Run per-page preActions (click, scroll, wait, waitForSelector).
 * Allows each page to nudge a lazy-loaded form into the DOM before we hunt for it.
 */
async function runPreActions(page, actions) {
  if (!Array.isArray(actions) || !actions.length) return;
  for (const a of actions) {
    try {
      if (a.type === 'click') {
        await page.click(a.selector, { timeout: 5000 });
      } else if (a.type === 'clickByText') {
        const loc = page.getByRole('button', { name: new RegExp(a.text, 'i') }).first();
        await loc.click({ timeout: 5000 }).catch(async () => {
          // Fall back to link
          await page.getByRole('link', { name: new RegExp(a.text, 'i') }).first().click({ timeout: 5000 });
        });
      } else if (a.type === 'scrollTo') {
        await page.evaluate(sel => {
          const el = document.querySelector(sel);
          if (el) el.scrollIntoView({ behavior: 'instant', block: 'center' });
        }, a.selector);
      } else if (a.type === 'wait') {
        await page.waitForTimeout(a.ms || 1000);
      } else if (a.type === 'waitForSelector') {
        await page.waitForSelector(a.selector, { timeout: a.timeout || 10000 });
      }
    } catch (err) {
      // Don't abort the whole probe — log on the result via the caller.
      console.warn(`    preAction ${a.type} failed: ${err.message}`);
    }
  }
}

/**
 * Try to dismiss cookie banners / chat widgets that might sit on top of the form.
 */
async function dismissOverlays(page) {
  const selectors = [
    'button:has-text("Accept")',
    'button:has-text("I agree")',
    'button:has-text("Got it")',
    'button:has-text("Allow all")',
    '#hs-eu-confirmation-button',
    '#onetrust-accept-btn-handler',
    'button[aria-label="Close"]',
  ];
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click({ timeout: 1500 }).catch(() => {});
        await page.waitForTimeout(300);
      }
    } catch {}
  }
}

/**
 * Locate the primary form. HubSpot embeds typically render an iframe with
 * id starting with "hs-form-iframe-" or directly inject a .hs-form element.
 * Returns a Locator (page or frame scoped).
 */
async function locateFormContext(page) {
  // Some HubSpot pages need a scroll to lazy-load the form.
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 400) {
      window.scrollTo(0, y); await new Promise(r => setTimeout(r, 80));
    }
  });
  await page.waitForTimeout(500);

  // If we see an empty .hubspot-form-container, wait up to 8s for HubSpot's
  // script to inject the form into it.
  const lazyContainer = await page.$('.hubspot-form-container, [class*="hubspot-form"]');
  if (lazyContainer) {
    await page.waitForFunction(() => {
      const c = document.querySelector('.hubspot-form-container, [class*="hubspot-form"]');
      return c && (c.querySelector('form') || c.querySelector('iframe[id^="hs-form"]'));
    }, { timeout: 8000 }).catch(() => {});
  }

  // HubSpot iframe path
  const iframeEl = await page.$('iframe[id^="hs-form-iframe"], iframe.hs-form-iframe');
  if (iframeEl) {
    const frame = await iframeEl.contentFrame();
    if (frame) {
      const form = await frame.$('form');
      if (form) return { context: frame, type: 'hubspot-iframe' };
    }
  }

  // Inline HubSpot form
  const inlineHs = await page.$('form.hs-form, form[id^="hsForm_"]');
  if (inlineHs) return { context: page, type: 'hubspot-inline' };

  // Generic: pick the first <form> that has an email input
  const forms = await page.$$('form');
  for (const f of forms) {
    const emailInput = await f.$('input[type="email"], input[name*="email" i]');
    if (emailInput) return { context: page, type: 'generic', formHandle: f };
  }

  return null;
}

/**
 * Heuristic field filling. We look at each visible input/select/textarea,
 * decide what it represents from name/id/placeholder/label, and fill it.
 * Runs two passes to catch fields that appear after initial fields are filled
 * (progressive disclosure). Radios are picked one-per-group.
 */
async function fillFormFields(ctx, email) {
  const filled = [];
  const radioGroupsHandled = new Set();

  async function singlePass() {
    const fields = await ctx.$$('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea');
    let changed = 0;

    for (const el of fields) {
      const meta = await el.evaluate(node => {
        const labelText = (() => {
          if (node.id) {
            const l = document.querySelector(`label[for="${CSS.escape(node.id)}"]`);
            if (l) return l.innerText || '';
          }
          const parentLabel = node.closest('label');
          if (parentLabel) return parentLabel.innerText || '';
          return '';
        })();
        return {
          tag: node.tagName.toLowerCase(),
          type: (node.getAttribute('type') || '').toLowerCase(),
          name: (node.getAttribute('name') || '').toLowerCase(),
          id: (node.getAttribute('id') || '').toLowerCase(),
          placeholder: (node.getAttribute('placeholder') || '').toLowerCase(),
          label: labelText.toLowerCase(),
          required: node.required || node.getAttribute('aria-required') === 'true',
          visible: !!(node.offsetParent !== null),
          alreadyFilled: node.tagName.toLowerCase() === 'select'
            ? !!node.value
            : (node.type === 'checkbox' || node.type === 'radio')
              ? !!node.checked
              : !!node.value,
        };
      });

      if (!meta.visible || meta.alreadyFilled) continue;
      const fingerprint = `${meta.name} ${meta.id} ${meta.placeholder} ${meta.label}`;

      if (meta.type === 'checkbox') {
        if (meta.required || /consent|agree|terms|gdpr|privacy/.test(fingerprint)) {
          await el.check({ force: true }).catch(() => {});
          filled.push({ fingerprint, value: 'checked' }); changed++;
        }
        continue;
      }

      if (meta.type === 'radio') {
        // Group by name. One pick per group covers the requirement.
        const groupKey = meta.name || meta.id;
        if (!groupKey || radioGroupsHandled.has(groupKey)) continue;
        // Try to pick a semantically safe option for known group types.
        const groupRadios = await ctx.$$(`input[type="radio"][name="${CSS.escape(meta.name)}"]`);
        let chosen = null;
        if (/preferred|solution|interested|product/.test(fingerprint)) {
          // Prefer the "All of the above" / last option
          chosen = groupRadios[groupRadios.length - 1];
        } else {
          chosen = groupRadios[0];
        }
        if (chosen) {
          await chosen.check({ force: true }).catch(() => {});
          filled.push({ fingerprint, value: 'radio-group-picked' }); changed++;
          radioGroupsHandled.add(groupKey);
        }
        continue;
      }

      if (meta.tag === 'select') {
        const value = await el.evaluate((sel, fp) => {
          // Try to match the placeholder hint to an option text first.
          const wantsEmployees = /employee|headcount|company.?size/.test(fp);
          const wantsCountry = /country/.test(fp);
          const wantsState = /state|region/.test(fp);
          for (const opt of sel.options) {
            const text = (opt.text || '').toLowerCase();
            if (!opt.value || /select|choose|please|^--/.test(text)) continue;
            if (wantsEmployees && /50|100|250|500|1000/.test(text)) return opt.value;
            if (wantsCountry && /india/.test(text)) return opt.value;
            if (wantsState && /assam|delhi|karnataka|maharashtra/.test(text)) return opt.value;
          }
          // Fallback: first non-placeholder option with a value.
          for (const opt of sel.options) {
            const text = (opt.text || '').toLowerCase();
            if (opt.value && !/select|choose|please|^--/.test(text)) return opt.value;
          }
          return sel.options[sel.options.length - 1]?.value || '';
        }, fingerprint);
        if (value) {
          await el.selectOption(value).catch(() => {});
          filled.push({ fingerprint, value }); changed++;
        }
        continue;
      }

      // Text-like inputs
      let value = null;
      if (meta.type === 'email' || /e-?mail/.test(fingerprint)) value = email;
      else if (meta.type === 'tel' || /phone|mobile|contact number/.test(fingerprint)) value = PLACEHOLDER.phone;
      else if (/first.?name|fname|given.?name/.test(fingerprint)) value = PLACEHOLDER.firstname;
      else if (/last.?name|lname|surname|family.?name/.test(fingerprint)) value = PLACEHOLDER.lastname;
      else if (/full.?name|your.?name|^name$|contact.?name/.test(fingerprint)) value = PLACEHOLDER.fullname;
      else if (/company|organisation|organization|employer|business/.test(fingerprint)) value = PLACEHOLDER.company;
      else if (/job.?title|designation|^title$|role|position/.test(fingerprint)) value = PLACEHOLDER.jobtitle;
      else if (/website|url|domain/.test(fingerprint)) value = PLACEHOLDER.website;
      else if (/message|comments?|enquiry|inquiry|note|details/.test(fingerprint)) value = PLACEHOLDER.message;
      else if (/employee|headcount|company.?size/.test(fingerprint)) value = PLACEHOLDER.numberofemployees;
      else if (/country/.test(fingerprint)) value = PLACEHOLDER.country;
      else if (/state|region/.test(fingerprint)) value = PLACEHOLDER.state;
      else if (/city/.test(fingerprint)) value = PLACEHOLDER.city;
      else if (/industry|sector/.test(fingerprint)) value = PLACEHOLDER.industry;
      else if (meta.required) value = 'N/A';

      if (value !== null) {
        await el.fill(String(value)).catch(async () => {
          try { await el.click(); await el.type(String(value)); } catch {}
        });
        filled.push({ fingerprint, value }); changed++;
      }
    }
    return changed;
  }

  // First pass
  await singlePass();
  // Settle, then second pass for progressively-disclosed fields
  await ctx.evaluate(() => new Promise(r => setTimeout(r, 600))).catch(() => {});
  await singlePass();
  return filled;
}

async function findSubmitButton(ctx) {
  const candidates = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Submit")',
    'button:has-text("Send")',
    'button:has-text("Download")',
    'button:has-text("Get")',
    'button:has-text("Request")',
    'button:has-text("Book")',
    // Multi-step forms advance through a control that is not always a submit.
    'button:has-text("Next")',
    'button:has-text("Continue")',
  ];
  // Prefer something actually on screen: a gated form can keep the real submit
  // in the DOM on step 1, and clicking that instead of "Next" skips the step
  // machinery entirely.
  let fallback = null;
  for (const sel of candidates) {
    for (const el of await ctx.$$(sel)) {
      if (await el.isVisible().catch(() => false)) return el;
      if (!fallback) fallback = el;
    }
  }
  return fallback;
}

/**
 * Which fields are on screen right now, as a comparable string.
 *
 * This is how we detect a step boundary. Looking for a button labelled "Next"
 * would be fragile — the label varies per form ("Continue", "Book a Meeting")
 * and the same page serves different variants to different visitors — whereas
 * every multi-step form swaps its visible field set when it advances.
 */
async function stepSignature(ctx) {
  return ctx.$$eval(
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea',
    nodes => nodes
      .filter(n => n.offsetParent !== null)
      .map(n => n.getAttribute('name') || n.getAttribute('id') || n.type)
      .join(',')
  );
}

/**
 * After clicking the action button, decide what the form did:
 *
 *   'advanced' — a different set of fields is on screen; fill them and go again
 *   'gone'     — the form is finished with (submitted, replaced, or navigated)
 *   'same'     — nothing moved; either the final step or a rejected submit
 */
async function waitForStepChange(tab, ctx, before, startUrl, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await tab.waitForTimeout(250);
    // A redirect is the end of the road; bail immediately rather than sit out
    // the timeout on every page that submits by navigating.
    try { if (tab.url() !== startUrl) return 'gone'; } catch { return 'gone'; }
    let now;
    try { now = await stepSignature(ctx); } catch { return 'gone'; }
    if (!now) return 'gone';
    if (now !== before) return 'advanced';
  }
  return 'same';
}

async function detectSuccess(page, ctx, cfg, startUrl) {
  const deadline = Date.now() + 25000;
  const successUrlRegex = new RegExp(cfg.successUrlPatterns.join('|'), 'i');
  const successTextRegex = new RegExp(cfg.defaultSuccessPatterns.join('|'), 'i');

  while (Date.now() < deadline) {
    // URL changed at all — HubSpot redirect-on-submit is itself a strong signal.
    // (We can't reliably read ctx after navigation, so check URL first.)
    let currentUrl;
    try { currentUrl = page.url(); } catch { currentUrl = startUrl; }
    if (currentUrl !== startUrl) {
      if (successUrlRegex.test(currentUrl)) {
        return { ok: true, signal: 'url-change-match', detail: currentUrl };
      }
      // URL changed to something that doesn't match success patterns but is also
      // not the start URL — most likely a thank-you page on a different path. Wait
      // briefly for the new page to settle, then accept it as success.
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
      return { ok: true, signal: 'url-change', detail: currentUrl };
    }

    // Standard HubSpot success block — query both page and the form context.
    // Presence alone is the signal; HubSpot may inject a meeting-scheduler
    // iframe inside .submitted-message, which leaves innerText empty.
    const successSelectors = '.submitted-message, .hs-form-success, .hs_submitted, [data-test-id="form-submission-message"]';
    let submitted = await ctx.$(successSelectors).catch(() => null);
    if (!submitted && ctx !== page) submitted = await page.$(successSelectors).catch(() => null);
    if (submitted) {
      const text = (await submitted.innerText().catch(() => '')).trim();
      return { ok: true, signal: 'success-element', detail: text ? text.slice(0, 200) : 'submitted-message element present (likely meeting-scheduler iframe)' };
    }

    // Generic text scan on the page body. Accept success text when the form
    // is either removed OR no longer visible (display:none, hidden, etc.) —
    // many sites swap the form for an inline success state without unmounting.
    const bodyText = await ctx.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
    if (successTextRegex.test(bodyText)) {
      const formStillVisible = await ctx.evaluate(() => {
        const forms = Array.from(document.querySelectorAll('form'));
        return forms.some(f => {
          if (f.offsetParent === null) return false;
          const r = f.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          const style = getComputedStyle(f);
          return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        });
      }).catch(() => true);
      if (!formStillVisible) {
        return { ok: true, signal: 'text-form-hidden', detail: 'Form no longer visible, success text present' };
      }
    }

    await page.waitForTimeout(500);
  }
  return { ok: false, signal: 'timeout', detail: 'No success state detected within 25s' };
}

async function collectErrors(ctx) {
  const errs = await ctx.$$eval(
    '.hs-error-msg, .hs-error-msgs, .field-error, [role="alert"], .error',
    nodes => nodes.map(n => (n.innerText || '').trim()).filter(Boolean)
  ).catch(() => []);
  return [...new Set(errs)].slice(0, 10);
}

/**
 * Post-submit forensics. HubSpot's rejection text ("Please complete this
 * required field") never says WHICH field, so on failure we walk the form and
 * record what every field actually holds plus any error message pinned to it.
 *
 * This is the only way to diagnose a failure that reproduces on the CI runner
 * but not locally — the runner is gone seconds after the run, so whatever we
 * don't capture here is lost.
 */
async function captureFieldState(ctx) {
  return ctx.$$eval(
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea',
    nodes => nodes.map(n => {
      const wrap = n.closest('.hs-form-field, .field, .form-group') || n.parentElement;
      const labelText = (() => {
        if (n.id) {
          const l = document.querySelector(`label[for="${CSS.escape(n.id)}"]`);
          if (l) return l.innerText || '';
        }
        return n.closest('label')?.innerText || '';
      })();
      const isToggle = n.type === 'checkbox' || n.type === 'radio';
      const raw = String(n.value == null ? '' : n.value);
      return {
        name: n.getAttribute('name') || n.getAttribute('id') || '(unnamed)',
        type: n.tagName.toLowerCase() === 'select' ? 'select' : n.type,
        // HubSpot marks required with a .hs-form-required span rather than the
        // native attribute, so check both.
        required: n.required || n.getAttribute('aria-required') === 'true'
          || !!wrap?.querySelector('.hs-form-required'),
        visible: n.offsetParent !== null,
        empty: isToggle ? !n.checked : !raw.trim(),
        value: isToggle ? (n.checked ? 'checked' : 'unchecked') : raw.slice(0, 60),
        label: (labelText || n.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim().slice(0, 90),
        error: (wrap?.querySelector('.hs-error-msg, .hs-error-msgs, .field-error, [role="alert"]')
          ?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 140) || null,
      };
    })
  ).catch(() => []);
}

/**
 * Turn captured field state into named culprits for the alert email.
 * Required-but-empty fields first (the actual cause), then any field carrying
 * an inline error message.
 */
function describeFieldFaults(fields) {
  const blank = fields.filter(f => f.visible && f.required && f.empty);
  const errored = fields.filter(f => f.error && !blank.includes(f));
  const faults = [
    ...blank.map(f => `${f.name} is required but empty`),
    // A field we never saw cannot be one we failed to fill. When the form
    // rejects hidden required fields it is gated — a later step, or a
    // collapsed group — and the monitor needs to advance it, not fill harder.
    ...errored.map(f => f.visible
      ? `${f.name}: ${f.error}`
      : `${f.name} (hidden — behind a later step or collapsed group): ${f.error}`),
  ];
  if (errored.some(f => !f.visible)) {
    faults.push('Form looks multi-step: required fields are rejected while still hidden, so submit never advances.');
  }
  return faults;
}

async function testPage(browser, page, cfg) {
  const result = {
    slug: page.slug,
    url: page.url,
    label: page.label,
    startedAt: new Date().toISOString(),
    ok: false,
    stage: 'init',
    detail: null,
    fieldsFilled: 0,
    validationErrors: [],
    formType: null,
    dryRun: DRY_RUN,
  };

  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 VC-Form-Monitor',
    // The remote cloud sandbox routes HTTPS through an egress proxy; when a host
    // is reached through it the cert chain can fail validation. Forms are known
    // production sites, so ignore cert errors rather than report false navigate failures.
    ignoreHTTPSErrors: true,
  });
  const tab = await context.newPage();

  try {
    result.stage = 'navigate';
    await tab.goto(page.url, { waitUntil: 'domcontentloaded', timeout: cfg.defaultTimeoutMs });
    await tab.waitForLoadState('networkidle', { timeout: cfg.defaultTimeoutMs }).catch(() => {});

    result.stage = 'dismiss-overlays';
    await dismissOverlays(tab);

    if (page.preActions) {
      result.stage = 'pre-actions';
      await runPreActions(tab, page.preActions);
    }

    result.stage = 'locate-form';
    const found = await locateFormContext(tab);
    if (!found) {
      result.detail = 'No form located on page after scroll + overlay dismissal';
      return result;
    }
    result.formType = found.type;
    const ctx = found.context;

    result.stage = 'fill';
    const filled = await fillFormFields(ctx, buildEmail(cfg, page.slug));
    result.fieldsFilled = filled.length;

    if (DRY_RUN) {
      result.stage = 'dry-run-complete';
      result.ok = filled.length > 0;
      result.detail = `Dry run: filled ${filled.length} fields. Skipped submit.`;
      return result;
    }

    result.stage = 'submit';
    const startUrl = tab.url();

    // Walk the form one step at a time. Single-step forms simply exit after the
    // first pass, so this costs them nothing beyond the change check.
    const steps = [];
    for (let step = 1; step <= MAX_FORM_STEPS; step++) {
      const before = await stepSignature(ctx).catch(() => '');
      const submitBtn = await findSubmitButton(ctx);
      if (!submitBtn) {
        if (step === 1) {
          result.detail = 'Could not find submit button';
          return result;
        }
        break;
      }
      await submitBtn.click({ timeout: 5000 }).catch(async () => {
        await ctx.evaluate(() => {
          const f = document.querySelector('form');
          if (f) f.requestSubmit ? f.requestSubmit() : f.submit();
        });
      });

      const moved = await waitForStepChange(tab, ctx, before, startUrl);
      steps.push({ step, outcome: moved, fieldsOnStep: before });
      if (moved !== 'advanced') break;

      result.stage = `fill-step-${step + 1}`;
      const more = await fillFormFields(ctx, buildEmail(cfg, page.slug));
      result.fieldsFilled += more.length;
    }
    if (steps.length > 1) {
      result.stepsTraversed = steps.length;
      result.steps = steps;
    }

    result.stage = 'verify';
    const success = await detectSuccess(tab, ctx, cfg, startUrl);
    if (success.ok) {
      result.ok = true;
      result.detail = `${success.signal}: ${success.detail}`;
    } else {
      const errs = await collectErrors(ctx);
      result.validationErrors = errs;
      const fields = await captureFieldState(ctx);
      const faults = describeFieldFaults(fields);
      // Only attach the full field dump on failure — it would bloat every run log.
      result.fields = fields;
      result.fieldFaults = faults;
      const captchaHit = errs.some(e => /captcha|recaptcha|turnstile|are you a robot/i.test(e));
      const fieldErrors = errs.filter(e => !/captcha|recaptcha|turnstile|are you a robot/i.test(e));
      if (page.captchaProtected && captchaHit && fieldErrors.length === 0) {
        // Form loaded, every required field filled, submit wired, server reached.
        // The only blocker is the captcha — that means the page itself is healthy.
        result.ok = true;
        result.detail = 'captcha-rejected: form healthy, captcha blocked automation (expected for captchaProtected pages)';
      } else {
        // Prefer the named culprit over HubSpot's anonymous complaint.
        result.detail = faults.length
          ? `Form rejected: ${faults.join('; ')}`
          : errs.length
            ? `Form validation errors: ${errs.join(' | ')}`
            : success.detail;
      }
    }
  } catch (err) {
    result.detail = `Exception in stage "${result.stage}": ${err.message}`;
  } finally {
    if (!result.ok) {
      try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const shot = path.join(DEBUG_DIR, `${page.slug}-${stamp}.png`);
        const html = path.join(DEBUG_DIR, `${page.slug}-${stamp}.html`);
        await tab.screenshot({ path: shot, fullPage: true }).catch(() => {});
        const content = await tab.content().catch(() => '');
        if (content) fs.writeFileSync(html, content);
        result.debugScreenshot = path.relative(ROOT, shot);
        result.debugHtml = path.relative(ROOT, html);
      } catch {}
    }
    result.finishedAt = new Date().toISOString();
    await context.close().catch(() => {});
  }

  return result;
}

async function main() {
  ensureDirs();
  const cfg = readConfig();
  const pages = ONLY_SLUG ? cfg.pages.filter(p => p.slug === ONLY_SLUG) : cfg.pages;
  if (!pages.length) {
    console.error(`No pages matched ${ONLY_SLUG ? `--only=${ONLY_SLUG}` : 'config'}`);
    process.exit(2);
  }

  console.log(`[form-monitor] ${DRY_RUN ? 'DRY RUN ' : ''}testing ${pages.length} page(s)...`);
  const browser = await chromium.launch({ headless: !HEADED, channel: 'chrome' });
  const results = [];
  for (const p of pages) {
    console.log(`  → ${p.slug} (${p.url})`);
    const r = await testPage(browser, p, cfg);
    results.push(r);
    console.log(`    ${r.ok ? 'OK   ' : 'FAIL '} ${r.detail || ''}`);
  }
  await browser.close();

  const stamp = timestamp();
  const runPath = path.join(RUN_DIR, `${stamp}.json`);
  fs.writeFileSync(runPath, JSON.stringify({ ranAt: new Date().toISOString(), dryRun: DRY_RUN, results }, null, 2));

  // Email the report (no-op if Gmail OAuth env vars are unset, e.g. local dry runs).
  if (!DRY_RUN) {
    const outcome = await sendReport(results, path.relative(ROOT, runPath));
    if (!outcome.sent) console.warn(`[form-monitor] report not emailed: ${outcome.reason}`);
  }

  const failures = results.filter(r => !r.ok);
  if (failures.length) {
    const digest = `\n[${new Date().toISOString()}] ${failures.length}/${results.length} form(s) failing:\n` +
      failures.map(f => `  - ${f.slug} (${f.url})\n      stage=${f.stage} detail=${f.detail}`).join('\n') +
      `\n  Full run: ${path.relative(ROOT, runPath)}\n`;
    fs.appendFileSync(FAILURE_LOG, digest);
    console.error(digest);
    process.exit(1);
  }
  console.log(`[form-monitor] All ${results.length} form(s) passing. Run log: ${path.relative(ROOT, runPath)}`);
}

main().catch(err => {
  console.error('[form-monitor] fatal:', err);
  process.exit(2);
});
