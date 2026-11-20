# Form Monitor: handoff for Himashree

_Last updated: 2026-11-20_

This note explains what the form monitor does, where it stands today, and how to change it safely. Use `README.md` as the full technical reference.

---

## 1. What it is

The form monitor is an automated health check for our lead-capture forms on **vantagecircle.com** and **vantagefit.io**. A headless Chrome (Playwright) does the following on each configured page:

1. Opens the page and dismisses cookie banners.
2. Finds the form: a HubSpot iframe, inline HubSpot, or a generic `<form>`.
3. Fills it with a marked test email: `formtest+<page-slug>@vantagecircle.com`.
4. Submits it and confirms success, through a thank-you redirect, the HubSpot success message, or success text.
5. **For demo forms**, also confirms that the **RevenueHero meeting scheduler** popup appears (added 2026-11-20).

When every form passes, the job exits green. If any form fails, the job turns red and the email report names the broken form, with a screenshot and the page HTML kept as evidence.

- **Repo:** https://github.com/Angshumandev42/form-monitor (public; you have write access)
- **Runs on:** GitHub Actions, on the **1st and 15th of each month at 08:30 IST**
- **Report email:** sent through Resend from `form-monitor@mail.vantagecircle.com`, to Angshuman with you and Gayatri on cc

---

## 2. Pages currently monitored

| Slug | Page | Scheduler check |
|---|---|---|
| `pulse-survey-buyers-guide` | vantagecircle.com/resources/pulse-survey-buyers-guide/ | No (gated download) |
| `industry-report-hybrid-leadership` | vantagecircle.com/hr-academy/industry-reports/... (form behind "Download the Report") | No (gated download) |
| `request-demo` | vantagecircle.com/request-demo/ | **Yes** |
| `product-rewards-recognition` | vantagecircle.com/products/rewards-recognition/ | **Yes** |
| `product-employee-survey` | vantagecircle.com/products/employee-survey/ | **Yes** |
| `product-employee-discount` | vantagecircle.com/products/employee-discount/ | **Yes** |
| `vantagefit-request-demo` | vantagefit.io/request-demo/ | **Yes** |

The last full scheduled run, on **2026-11-01**, passed 7/7. A manual live run on **2026-11-20** confirmed the RevenueHero scheduler appears on all 5 demo forms.

---

## 3. Current status and open items

### ⚠️ Scheduled runs are blocked (needs Angshuman)
The **2026-11-15** run never started. GitHub reported: *"The job was not started because your account is locked due to a billing issue."* Until the GitHub billing on Angshuman's account is fixed, both scheduled runs and manual "Run workflow" runs will fail instantly. In the meantime the monitor can only run locally (see §5).

### Vantage Fit coverage gap (proposed, not done)
Right now we check only one Vantage Fit form, the demo form. These pages also have forms and are **not monitored yet**:

- `vantagefit.io/contact-us/`
- `vantagefit.io/partnership/`
- `vantagefit.io/2026-global-workplace-well-being-industry-report/`
- `vantagefit.io/running-step-challenges-report-2026/`
- One guide, e.g. `vantagefit.io/guides/the-ultimate-buyers-guide-to-corporate-wellness-programs/` (about 13 guides likely share one template)
- One template, e.g. `vantagefit.io/tools-and-templates/corporate-wellness-budget-template/` (about 15 templates likely share one template)
- `vantagefit.io/tools-and-templates/employee-wellness-roi-calculator/`

These are plain `<form>` tags, not HubSpot embeds, so dry-run each one first (see §6).

---

## 4. The RevenueHero scheduler check (new)

**Why we added it:** a demo form used to pass as soon as HubSpot accepted the submit. If the RevenueHero router or popup broke, the lead would land in HubSpot but never see a booking calendar, and the monitor would still report green.

**How it works:** pages with `"expectScheduler": true` in `pages.config.json` must show the scheduler popup within 20 seconds after a successful submit, or the page fails.

**What to look for in the page:**
- The container is `#rh-dialog`, a full-screen dark overlay.
- The calendar is `#rh-scheduler-iframe`.
- The iframe is served from **`popup.schedulehero.io`**, RevenueHero's white-label booking host. It is **not** `revenuehero.io`. Our first version only looked for "revenuehero" and wrongly reported the popup as missing, so keep this in mind if RevenueHero changes hosts.
- The SDK script is `app.revenuehero.io/scheduler.min.js`. It loads on every demo page, so its presence alone proves nothing.

**When it fails**, the report lists every RevenueHero network call the page made. Use it to tell the failure types apart:
- **No calls at all:** the SDK didn't load or wasn't triggered. Check the site code.
- **`api/sessions/create` but no `time_slots`:** the router rejected or disqualified the lead. Check the RevenueHero router rules.
- **`time_slots` present but no popup:** the popup failed to render. Check the front end.

**Side effect to know about:** RevenueHero treats our `formtest+` submissions as **qualified** leads (they come from the vantagecircle.com domain) and offers real time slots. We never book a meeting, but routing may still notify a rep.

---

## 5. Running it yourself

```bash
git clone https://github.com/Angshumandev42/form-monitor.git
cd form-monitor
npm install          # small; uses your installed Google Chrome, no Chromium download
```

| Command | What it does |
|---|---|
| `npm run dry` | Loads every page, fills the forms, **does not submit**. Safe: no HubSpot contacts. |
| `npm run monitor` | Full live run of all pages (creates test contacts). |
| `node monitor.js --only=request-demo` | Live run of one page. |
| `node monitor.js --only=request-demo --headed` | Same, but opens a visible browser so you can watch. |
| `node monitor.js --dry --only=<slug>` | Dry run of one page. |

Locally the email is skipped because `RESEND_API_KEY` isn't set. Results go to:
- `logs/runs/<timestamp>.json`: the full result for each page
- `logs/debug/<slug>-<timestamp>.png` / `.html`: a screenshot and page HTML for any failure
- `logs/failures.log`: a running digest of failures

`logs/` is gitignored, so nothing there gets committed.

**On GitHub:** go to the Actions tab, open **Form Monitor**, and click **Run workflow**. You can tick `dry`, or set `only` to a slug. Logs and screenshots are attached to each run as an artifact and kept for 30 days. (This will only work once the billing lock is cleared.)

---

## 6. Making changes

### Add a page
Append an entry to `pages.config.json`:

```json
{
  "slug": "vantagefit-contact-us",
  "url": "https://www.vantagefit.io/contact-us/",
  "label": "Vantage Fit — Contact Us",
  "notes": "Anything quirky about the form"
}
```

Optional keys:
- `"expectScheduler": true`: also require the RevenueHero popup after submit. Use it only on forms that route to a meeting.
- `"captchaProtected": true`: if the only error after submit is a captcha, count the page as healthy.
- `"preActions"`: for forms hidden behind a button, for example:
  ```json
  "preActions": [
    { "type": "clickByText", "text": "Download the Report" },
    { "type": "wait", "ms": 2500 }
  ]
  ```
  `{ "type": "scrollTo", "selector": "#form" }` is also supported for lazy-loaded forms.

Then:
1. Run `node monitor.js --dry --only=<slug>` and check that `formType` is set and `fieldsFilled` is 3 or more in the run JSON.
2. Run `node monitor.js --only=<slug> --headed` once live and watch it go through.
3. Commit and push to `main`.

### Change the schedule
Edit the `cron` line in `.github/workflows/form-monitor.yml`. It uses UTC, so `0 3 1,15 * *` means 08:30 IST on the 1st and 15th.

### Change who gets the email
Set the repo variables `REPORT_TO` / `REPORT_CC` (comma-separated) under **Settings → Secrets and variables → Actions → Variables**. Variable changes need admin access, so ask Angshuman. `RESEND_FROM` is already set. The `RESEND_API_KEY` secret is stored in the repo, and you can't view it, but your runs still use it.

### Code map
| File | Purpose |
|---|---|
| `monitor.js` | The runner: form finding, filling, multi-step handling, success and scheduler detection |
| `pages.config.json` | Pages to check, success text/URL patterns, timeouts |
| `notify.js` | Email report via Resend (Gmail OAuth fallback) |
| `inspect.js` | One-off helper to inspect a page's form structure |
| `.github/workflows/form-monitor.yml` | The GitHub Actions schedule |

Commit convention: so far we've pushed small, focused commits directly to `main`, and the scheduled job runs whatever is on `main`. For anything risky, use a branch and a PR.

---

## 7. HubSpot hygiene

Every live run creates contacts like `formtest+request-demo@vantagecircle.com`. The part after `+` is the page slug, so you can trace each contact back to a run. A HubSpot suppression list and workflow (email contains `formtest+`) keeps them out of marketing sends and reporting. If test contacts start showing up in MQL counts or sales queues, check that workflow first.

---

## 8. Known limitations

- We only check that the **form reports success**. We don't check that the HubSpot contact was created, that downstream workflows ran, or that any confirmation email arrived.
- `--dry` stops before the first click, so a multi-step form only gets step 1 tested in a dry run.
- Some demo forms show different variants by visitor location. A two-step form appeared for a US IP and a one-step form for an Indian IP. GitHub runners are US-based, so local runs from India may follow a different path.
- Scheduled runs on GitHub may start a few minutes late.

---

## 9. History (short)

- **May 2026:** built and run locally.
- **Aug 2026:** moved to GitHub Actions. The Claude cloud routine couldn't reach our sites (false 0/7 results). Added multi-step form handling.
- **Sep 30, 2026:** Resend email delivery confirmed working from mail.vantagecircle.com, with cc to Himashree and Gayatri.
- **Oct 7, 2026:** schedule changed to the 1st and 15th of each month.
- **Nov 15, 2026:** scheduled run blocked by the GitHub billing lock. **Still open.**
- **Nov 20, 2026:** added the RevenueHero scheduler check (commit `d180348`). Himashree added as a collaborator.

Questions: ask Angshuman.
