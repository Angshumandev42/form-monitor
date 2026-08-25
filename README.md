# VC Form Monitor

Headless-browser health check for the lead-capture forms on `vantagecircle.com` and `vantagefit.io`. Visits each configured page, finds the form (HubSpot iframe, inline HubSpot, or generic), fills required fields with a marker test email (`formtest+<slug>@vantagecircle.com`), submits, and verifies a success state. Results land as JSON in `logs/runs/`; failures also get appended to `logs/failures.log`.

## 1. Install

```bash
cd /Users/angshumandevtalukdar/thinker/form-monitor
npm install
```

Uses `playwright-core` and drives your installed Google Chrome via `channel: 'chrome'` — no separate Chromium download. Install is small and fast (~10 MB). If Chrome ever moves or is uninstalled, `chromium.launch({ channel: 'chrome' })` will throw — reinstall Chrome (or change `channel` to `'chrome-beta'` / `'msedge'`) and re-run.

## 2. Dry run (no real submissions)

Before letting it submit live, rehearse against the real pages with `--dry`. This loads each page, locates the form, fills every detectable field, then **stops without clicking submit**. Use this to confirm field detection works on every page.

```bash
npm run dry
```

Check `logs/runs/<timestamp>.json` to see, per page:
- `formType` — `hubspot-iframe`, `hubspot-inline`, or `generic`
- `fieldsFilled` — should be ≥ 3 for most forms
- `stage` — where it stopped (`dry-run-complete` on success)

If a page reports `formType: null` or `fieldsFilled: 0`, the form lives behind a CTA/modal/tab and needs a per-page hook — see "Adding selectors" below.

## 3. Live run

```bash
npm run monitor
```

What happens per page:
1. Navigate, dismiss cookie/consent overlays.
2. Scroll to lazy-load HubSpot embed.
3. Fill fields (`firstname`, `lastname`, `email`, `company`, `phone`, `country`, message, plus required checkboxes/selects).
4. Click the action button (or call `form.requestSubmit()` as fallback).
5. Work out what the form did, by comparing which fields are on screen before
   and after the click:
   - **a different field set** — the form advanced a step. Fill the new fields
     and click again, up to `MAX_FORM_STEPS` (5).
   - **no fields left, or the URL changed** — the form is done; go verify.
   - **nothing moved** — the final step, or a rejected submit; go verify.
6. Watch up to 25s for any of:
   - URL change to a path matching `successUrlPatterns` (thank-you, success, confirmation, ...)
   - `.submitted-message` / `.hs-form-success` element appearing (HubSpot's standard)
   - Body text matching `defaultSuccessPatterns` **and** the form being removed from the DOM

### Multi-step forms

Some pages serve a gated form that reveals its fields across two screens
("STEP 1 OF 2"), and which variant you get can depend on where you are browsing
from — `/request-demo/` served a single-step form to an Indian IP and a
two-step one to a US datacenter IP on the same day. Step detection is therefore
based on the *visible field set changing*, not on finding a button labelled
"Next": labels vary per form and per variant, and the advance control is not
always a `type="submit"`.

Consequence worth knowing: a gated form validates its hidden fields too, so
clicking through without handling steps produces "Please complete all required
fields" while every field you can see is filled. When a run fails that way the
report names the offending fields and marks them `hidden — behind a later step
or collapsed group`.

Exit code is `0` if all pages pass, `1` if any fail (so /schedule + cron can detect failure).

## 4. Single-page debugging

```bash
node monitor.js --only=request-demo --headed
```

`--headed` opens a visible browser so you can watch the run. `--only=<slug>` targets one page from `pages.config.json`.

## 5. HubSpot suppression workflow (one-time setup)

Real submissions land in HubSpot as contacts. To keep them out of marketing campaigns and reporting:

1. Build a static or active list with criterion: **Email contains `formtest+` AND email domain is `vantagecircle.com`**.
2. Build a workflow triggered by enrollment in that list. Actions:
   - Set lifecycle stage = `Other` (or a custom "Form Monitor" stage)
   - Set marketable status = non-marketing (via UI; API is read-only on this)
   - Add to a suppression list used by all marketing sends
   - Optional: add the `formtest` label to the contact name so it's obvious in the table
3. Add the same suppression to your sales-routing rules so reps don't get a task on these.

The slug in `formtest+<slug>@vantagecircle.com` tells you which page the test submission came from, useful when reconciling test contacts to runs.

## 6. Adding a new page

Edit `pages.config.json`, append:

```json
{
  "slug": "kebab-case-slug",
  "url": "https://...",
  "label": "Human-readable name",
  "notes": "Anything quirky about the form"
}
```

Then run `npm run dry -- --only=kebab-case-slug` to verify field detection before scheduling.

### Forms behind a CTA / modal

If a page hides its form behind a "Request demo" button, the auto-detector won't find it. Two options:
- **Quick fix**: change the page URL in config to a direct link that lands you on the form (most HubSpot forms have a direct page).
- **Robust fix**: add a `preActions` array to the page config (e.g. `[{"click": "button:has-text('Request a demo')"}]`) and extend `monitor.js` to honor it. Not implemented yet — add when first needed.

## 7. Wiring to /schedule (every 3 days at 8 AM IST)

In Claude Code:

```
/schedule
```

…then create a routine like:

- **Name**: `vc-form-monitor`
- **Cron**: `0 2 */3 * *`  (08:00 IST = 02:30 UTC; adjust per your shell's TZ — `30 2 */3 * *` if your cron honors minutes-first IST=UTC+5:30)
- **Working directory**: `/Users/angshumandevtalukdar/thinker/form-monitor`
- **Prompt**: 
  > Run `npm run monitor` in this directory. If the command exits non-zero, summarize the failing pages from `logs/failures.log` (the latest digest block) and the most recent `logs/runs/*.json`. Include slug, URL, stage where it failed, and the `detail` field. If it exits zero, just say "All forms passing as of <timestamp>".

This way the LLM only does diagnostic summarization; the actual probing is deterministic Node code.

## 8. Files

- `monitor.js` — the runner
- `pages.config.json` — pages + success-detection patterns + alert recipients
- `logs/runs/*.json` — full per-run results
- `logs/failures.log` — append-only digest of every failing run

## 9. Known limitations (v1)

- Submit-only verification. We confirm the form *thinks* it succeeded; we do **not** verify HubSpot actually created the contact, that downstream workflows fired, or that confirmation emails reached an inbox. Add those checks if a silent breakage ever slips past this layer.
- Email alerting goes out via Resend (`notify.js`), which needs `RESEND_API_KEY` set on the routine's cloud environment. Until a sending domain is verified in Resend and `RESEND_FROM` is set, the report uses Resend's shared test sender, which delivers **only to the Resend account's own address** — cc recipients are dropped automatically to avoid a 403 on the whole send. With no transport configured at all, `sendReport` no-ops and results stay in `logs/failures.log` plus the routine run output.
- Forms behind a CTA/modal aren't currently supported automatically (see §6).
- `--dry` stops before the first click, so on a multi-step form it only ever
  sees and fills step 1. `fieldsFilled` will look low and the later steps go
  unexercised; use a live run to check a gated form end to end.
- Step detection reads the visible field set, so a form that advances without
  changing which fields are on screen (an in-place re-render keeping identical
  field names) reads as "nothing moved" and gets verified as if it were the
  final step.
- The `country`/`state`/`industry` placeholder values may not match the dropdown options on every form. The field-filler picks the first non-empty option as a fallback, which is fine for monitoring.
