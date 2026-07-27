# MANNMADE Time — Project Context

Internal time tracking web app for MANNMADE, a creative agency in Cape Town.
Built in Google Apps Script on Google Workspace. Replaces Magnetic.

**Owner:** Shayne (shayne@mannmade.co.za) — non-technical. Explain in plain
language, avoid jargon, don't assume familiarity with programming concepts.
When something needs doing by hand, give exact click-by-click steps.

---

## How to read this file

This file carries the *reasoning* behind the project — decisions, constraints,
and hard-won gotchas. **The code in `src/` is the source of truth.** This file
explains why the code is the way it is.

It was reconciled against the live code on 2026-07-27. Where the previous
handover was wrong, the correction is noted inline.

---

## Live Google resources

| Thing | ID / location |
|---|---|
| Apps Script project "Time tracker" | `12QLJffAthBngKU908QcXcgx8lr80s1AXsaL3mwLiVGdjHTL68qCZOFGe` |
| Container spreadsheet "MANNMADE Time Log" | `1yZoZ_mfeEP37gZ1cfVFOVOJqB3a3hw1JyhtfIvJRV2U` |
| Jobs list "MM Job Numbers" (read-only) | `1-ON0iZYt3gcum4eKDY8rtokI6SkSAOLam-HENf-fzf4` |

The script is **container-bound** to "MANNMADE Time Log". Nearly every backend
function calls `SpreadsheetApp.getActiveSpreadsheet()`, which resolves to that
spreadsheet. It is not a standalone script — this matters for clasp and for any
future move to a shared account.

Both files are owned by shayne@mannmade.co.za.

---

## Architecture

Single Apps Script project, deployed as a web app.

| File | Purpose |
|---|---|
| `src/Code.gs` | Entire backend — all server-side functions (~2300 lines) |
| `src/Index.html` | Entire frontend — inline CSS and JS (~1150 lines) |
| `src/appsscript.json` | Manifest — timezone, runtime, webapp access settings |

> **Correction:** the old handover called the backend `CompleteCode.gs`. The
> real filename is `Code.gs`.

The backend was deliberately consolidated into one `.gs` file. Shayne was
copy-pasting between the Apps Script editor and chat, and multiple files meant
multiple chances to paste the wrong thing in the wrong place. Now that the code
lives in git and can be pushed with clasp, that reason is weaker — but don't
split it up without agreeing it first.

### Backend function groups

- **Access control** — `currentUserEmail_`, `roleForEmail_`, `currentRole_`,
  `isHod_`, `requireHod_`, `requireAccess_`, `getUserRole`, `accessDeniedPage_`
- **Core tracking** — `doGet`, `getJobs`, `logTime`, `bulkLogTime`,
  `getMyLogs`, `updateMyEntry`, `getTodaySummary`, `makeEntryId`,
  `ensureEntryIdColumn`
- **Dashboard** — `getDashboardData`, `getPersonDetail`, `getCompanyDetail`,
  `getJobDetail`, `getFromDate`, `emptyDashboard`
- **Weekly digest emails** — `sendWeeklyDigests`, `getWeeklyDigestForPerson`,
  `buildWeeklyDigestHtml`, `sendAdminRecap`, `loadPeopleDirectory`,
  `installWeeklyDigestTrigger`, `testWeeklyDigest`
- **Budgets & rates** — `loadJobBudgets`, `getBudgetStatus`, `getBudgetWarning`,
  `syncJobBudgets`, `runBudgetSync_`, `readBudgetTotalFromFile_`,
  `checkBudgetAlerts_`, `sendBudgetAlertEmail_`, `loadPeopleRates`,
  `getAllTimeJobTotals`, `installBudgetSyncTrigger`
- **Month-end lock** — `getSettingsSheet_`, `getLockDate`, `checkLock_`,
  `lockPreviousMonth`
- **Calendar** — `getCalendarEvents`, `previewCalendarImport`,
  `importCalendarMeetings`, `buildCalendarImport_`
- **Daily reminders** — `sendTimesheetReminders`, `buildReminderHtml_`,
  `installDailyReminderTrigger`, `testTimesheetReminder`

The frontend calls exactly these, via `google.script.run`: `getUserRole`,
`getJobs`, `logTime`, `bulkLogTime`, `getMyLogs`, `updateMyEntry`,
`getDashboardData`, `getPersonDetail`, `getCompanyDetail`, `getJobDetail`,
`getCalendarEvents`. Everything else is trigger-driven or run by hand from the
editor.

### Data — tabs in "MANNMADE Time Log"

| Tab | Role |
|---|---|
| `Time Log` | Every entry. ~9,000 rows. Written by `logTime` / `bulkLogTime`. |
| `People` | Name → Email → Rate (R/hr). Drives digests and cost figures. |
| `Job Budgets` | Per-job budgeted hours/value, used for the 80% warnings. |
| `Settings` | Key/value. Currently only "Lock entries before (yyyy-mm-dd)". |
| `Job Mapping`, `RawLog`, `Sheet2`, `Copy of Mann Made Rate Card 202` | Legacy / scratch. Not read by the code. |

**Time Log columns (1–12):** Date, Person, Job Number, Job Name, Company, Task,
Start Time, End Time, Duration (hrs), Billable, Notes, Entry ID.
Entry ID (col 12) is hidden and assigned lazily to old rows when first edited.

**Jobs list** — read-only, owned by the business, **never write to it**.
`getJobs` iterates *all* tabs so jobs from previous years stay searchable.
Columns are found by matching header text, not fixed position, because humans
maintain the sheet and columns move. Keep it that way.

---

## Access control (as actually built)

> **Correction:** the old handover described "Super Admin sees everything, HoDs
> see themselves and their team". That is *not* what the code does.

There are two roles, resolved from the visitor's authenticated Google email
(`Session.getActiveUser()`), so it can't be spoofed from the frontend:

- Email on the `HOD_EMAILS` allowlist (14 addresses, hardcoded at the top of
  `Code.gs`) → **`hod`** — sees Track, My Logs, **and** Dashboard.
- Any other `@mannmade.co.za` address → **`staff`** — Track and My Logs only.
- Anything else → denied, shown `accessDeniedPage_()`.

HODs see **everyone's** data, not a filtered team view. There is no per-team
structure anywhere in the code.

`doGet` gates the whole page; `requireAccess_()` and `requireHod_()` gate the
individual server functions, so the dashboard data can't be pulled by a staff
member calling the backend directly.

> **Correction:** the old handover said access was handled by having two
> separate URLs (staff vs management). The code now does it in-app with one
> deployment and a hidden Dashboard tab. Confirm in the Apps Script UI whether
> a second legacy deployment still exists before assuming there's only one.

---

## Apps Script gotchas — these cost real hours

1. **Sheet tabs by gid or name, never by index.** An index-based lookup broke
   the moment someone reordered tabs in the jobs spreadsheet.

2. **Dates come back inconsistently.** A cell may yield a `Date` object or a
   string depending on formatting. Always guard with
   `row[0] instanceof Date ? row[0] : new Date(row[0])`, and format with
   `Utilities.formatDate` using `Session.getScriptTimeZone()`. Timezone is
   SAST (UTC+2) — the manifest sets `Africa/Johannesburg`.

3. **`ScriptApp.getService().getUrl()` is unsafe inside triggered functions.**
   It can return the `/dev` URL, which only works for accounts with edit access
   to the script. Staff clicking it get an error. **This is still live** in
   three places: `accessDeniedPage_` (line ~87), `sendBudgetAlertEmail_`
   (~1969) and `buildReminderHtml_` (~2275). The last two run on triggers and
   email real staff. Fix by hardcoding the `/exec` URL in a constant.

4. **Don't put `/a/mannmade.co.za/` in URLs sent to staff.** It pins the link
   to a specific Google account context and breaks for anyone signed into a
   personal Gmail in the same browser. Use the plain
   `https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec` form.

5. **Older-engine `var` style.** The manifest is on **V8**, so `const`/`let`
   would work — but the entire file is `var`, with zero arrow functions, and
   consistency is worth more than modernity here. Match the surrounding style;
   don't modernise as a tidy-up.

---

## Deployment

**Manifest currently says:**

```json
"webapp": { "executeAs": "USER_DEPLOYING", "access": "ANYONE" }
```

> **Correction / open question:** the old handover said this should be
> `USER_ACCESSING` + domain-restricted, so entries log under each person's own
> identity. `USER_DEPLOYING` would make `Session.getActiveUser()` unreliable and
> could break the role check entirely. The live deployment may still be running
> an older manifest version — a deployment snapshots the manifest at the time
> its version was created. **Verify against the actual deployment settings in
> the Apps Script UI before changing anything here.**

`access: ANYONE` is deliberate in one respect: it lets *our* code run and show
the friendly `accessDeniedPage_()` instead of Google's cryptic "unable to open
the file" error. The real gate is `roleForEmail_`.

**Redeploying does not change the URL** if you edit the existing deployment and
bump the version. Creating a *new* deployment creates a *new* URL — and any
hardcoded URL in the email code then points at a dead deployment. This has
already broken the reminder emails once.

### Triggers

Three installer functions exist. They must be run once, by hand, from the Apps
Script editor — check **Triggers** in the UI to see what is actually scheduled:

| Installer | Installs | Schedule |
|---|---|---|
| `installDailyReminderTrigger` | `sendTimesheetReminders` | weekdays ~16:00 |
| `installWeeklyDigestTrigger` | `sendWeeklyDigests` | weekly |
| `installBudgetSyncTrigger` | `syncJobBudgetsAuto` | periodic |

---

## Roadmap

- **Weekly hours-per-job email** — spreadsheet attached, sent Mondays to a
  chosen list. Note: a weekly *per-person* digest already exists
  (`sendWeeklyDigests`); this is the per-job variant.
- **Calendar drafts** — pull the previous day's Google Calendar events in as
  pre-filled draft entries to accept, edit, or discard. Partly built:
  `getCalendarEvents` is already wired to the frontend, and
  `importCalendarMeetings` exists but is hardcoded to one person and one job
  (`IMPORT_PERSON` / `IMPORT_JOB`, ~line 1740) — it's a one-off, not a feature.
- **Quick-capture field** — dump "2h Woolworths deck" during the day, convert
  to proper entries later.
- **Simplified view for overhead roles** — Dean (IT) and Shelley (finance).
  Their work is reactive and non-billable, so standard timesheets fit badly.
  Agreed approach: exception-based logging (a default daily allocation they
  only override when something unusual happens), 4–6 fixed category buttons
  instead of job search, and a weekly grid instead of a daily timer. Daily
  precision for non-billable roles is fake precision.
- **Migrate to a shared company Google account.** Everything is currently tied
  to Shayne's personal Workspace account — script ownership, the container
  spreadsheet, deployments, triggers. If Shayne is unavailable, nobody can fix
  or redeploy anything. This is the largest structural risk in the project.

---

## Design and tone

**Brand:** pink `#e8318a`, yellow `#f5c400`, blue `#1a6ef5`, orange `#f04e23`,
black background. Archivo Black for headings, Archivo for body. Numbered block
layout. (Note: `accessDeniedPage_` uses `#e6007e` — a slightly different pink to
the rest of the app. Worth unifying.)

**Utilisation target:** 65%. Dashboard defaults to This Week; filters are This
Week / This Month / Last 30 Days / All Time.

**Framing matters.** This tool is for client billing and job profitability, not
staff surveillance — and it should read that way in every email and label. Most
timesheet resistance comes from people believing they must account for every
minute. Nearest half-hour is fine, and the UI should say so.

---

## Working practices

- Build incrementally: get one thing working, confirm it, then layer the next.
  Large rewrites are hard for Shayne to verify.
- This app emails staff. A bad deploy reaches real people. **After any deploy
  that touches email or the tracker URL, click the button in a test email and
  confirm it loads.** Ten seconds.
- Some steps genuinely require Shayne — anything where Google needs a human to
  grant permission (`clasp login`, OAuth consent). Say so plainly rather than
  attempting a workaround.

---

## Working with this repo

The code in `src/` was exported from the live Apps Script project on
2026-07-27. `.clasp.json` points at the right script ID.

To push changes back to Apps Script you need clasp authenticated:

```bash
npm install -g @google/clasp
clasp login          # opens a browser — Shayne must approve
clasp push           # uploads src/ to the live script
```

**`clasp login` cannot be done from a Claude Code session** — it needs a
browser and a human at the keyboard. Until it's done, changes can be written
and reviewed here but must be pasted into the Apps Script editor by hand.

Because `clasp push` overwrites the live script, always confirm the live code
hasn't drifted (someone editing in the browser) before pushing.
