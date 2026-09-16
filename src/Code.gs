// ============================================================
// MANNMADE TIME TRACKER — Code.gs (complete file)
// ============================================================

var SHEET_NAME    = 'Time Log';
var JOBS_SHEET_ID = '1-ON0iZYt3gcum4eKDY8rtokI6SkSAOLam-HENf-fzf4';
var JOBS_TAB_GID  = 775320995;

// Live web app address. Hardcoded on purpose — do not replace this with
// ScriptApp.getService().getUrl(). Inside a triggered function that call can
// return the /dev URL, which only opens for accounts with edit access to this
// script, so staff clicking the button in a reminder email get an error.
// If the deployment is ever recreated (rather than updated in place), the URL
// changes and this constant must be updated to match.
var WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbz-f9MniexSzkyHBzQBBCL6sYTX3U7Tpo9berIlu3T4VdB1vTVnzfs49L-76o5GahuwtA/exec';

// Budgets, locks & reminders
var BUDGET_SHEET_NAME   = 'Job Budgets';
var SETTINGS_SHEET_NAME = 'Settings';
var BUDGET_WARN_PCT     = 80;   // warn when a job hits this % of budgeted hours
var REMINDER_MIN_HOURS  = 1;    // remind anyone who logged less than this many hours today
var REMINDER_HOUR       = 16;   // reminders go out around 16:00 on weekdays

// ── ACCESS CONTROL ────────────────────────────────────────────
// Two links, one deployment:
//
//   .../exec               TEAM link  — Track + My Logs (your own entries).
//                                       No Dashboard, no Job Lookup, no
//                                       all-staff data.
//   .../exec?key=<HOD_KEY> HOD link   — everything.
//
// Two independent things have to be true to see all-staff data:
//   1. You are signed in with a @mannmade.co.za Google account. This is what
//      the web app's "anyone with a Google account" access plus the domain
//      check below gives us, and it means the secret link on its own — leaked,
//      forwarded, or found in someone's history — opens nothing.
//   2. You presented the HOD key.
//
// HOD used to be an allowlist of emails (HOD_EMAILS), which meant an HOD saw
// the Dashboard on any URL. That is exactly what the team link must not do, so
// the allowlist is gone and the key is now the only thing that grants HOD.
// Access no longer follows the person, it follows the link they open.
var STAFF_DOMAIN = 'mannmade.co.za';

// The HOD link key. Long random string, generated 2026-08-17.
// Rotating it: replace this value, redeploy, and send out the new ?key= URL —
// the old link stops working the moment the new code goes live.
var HOD_KEY = 'ef7eb29e1899d9f53d5ad593a9bca6c00fa12a18f280763184a71300e74bf160';

// True if `key` is the HOD key. Compares every character rather than bailing
// out at the first mismatch, so the time it takes doesn't leak the key.
function hodKeyValid_(key) {
  key = String(key || '');
  if (key.length !== HOD_KEY.length) return false;
  var diff = 0;
  for (var i = 0; i < key.length; i++) {
    diff |= key.charCodeAt(i) ^ HOD_KEY.charCodeAt(i);
  }
  return diff === 0;
}

// Email of the current visitor (lowercased), or '' if unavailable.
function currentUserEmail_() {
  try { return String(Session.getActiveUser().getEmail() || '').trim().toLowerCase(); }
  catch (err) { return ''; }
}

// Resolve an email to a role: 'staff' or '' (no access).
//   - any @mannmade.co.za email -> 'staff'
//   - anything else / blank     -> '' (denied)
// Whether that staffer also gets HOD is decided by the link key, not the email.
function roleForEmail_(email) {
  email = String(email || '').trim().toLowerCase();
  if (!email) return '';
  var at = email.lastIndexOf('@');
  if (at !== -1 && email.slice(at + 1) === STAFF_DOMAIN) return 'staff';
  return '';
}

// Role of the current visitor.
function currentRole_() { return roleForEmail_(currentUserEmail_()); }

// Throws unless the caller is signed-in staff AND presented the HOD key.
//
// The key check has to live here, not only in doGet. google.script.run calls go
// straight to these functions without passing through doGet, so a team-link
// user could otherwise open the browser console and call getDashboardData()
// by hand. Every function that returns other people's hours takes the key as
// its last argument and checks it here.
function requireHod_(key) {
  requireAccess_();
  if (!hodKeyValid_(key)) {
    throw new Error('Not authorised — this view is restricted to the HOD link.');
  }
}

// Throws if the current visitor has no access at all (not HOD, not staff).
function requireAccess_() {
  if (!currentRole_()) throw new Error('Not authorised — please sign in with your MANNMADE account.');
}

// ── WHO THE VISITOR IS, FOR DATA ──────────────────────────────
// Access (above) has always come from the real Google login. Whose hours an
// entry belongs to used to come from a free-text box in the browser, and the
// two were never checked against each other — so anyone signed in could read a
// colleague's entries, or read a calendar, simply by typing their name.
//
// These two resolve the name server-side by matching the authenticated email
// against the People sheet, so the browser no longer gets a say.

// Every People-sheet spelling that belongs to the current visitor's email.
//
// Several people are in the sheet twice under different spellings — "Leya" and
// "Leya Tischhauser", "Marie Cillers" and "Marie Cilliers" — which has split
// their logged history across two names. So reads match *any* spelling, while
// writes always use the first (sheet order), letting the duplicates converge
// instead of needing the sheet cleaned up first.
//
// Returns { person: canonical name or '', aliases: [all spellings] }.
function resolveIdentity_() {
  var email = currentUserEmail_();
  if (!email) return { person: '', aliases: [] };
  var people = loadPeopleDirectory();   // name -> email
  var aliases = [];
  for (var name in people) {
    if (String(people[name] || '').trim().toLowerCase() === email) aliases.push(name);
  }
  return { person: aliases.length ? aliases[0] : '', aliases: aliases };
}

// True if a Time Log person cell belongs to the given identity.
function isMine_(cell, identity) {
  var v = String(cell || '').trim();
  for (var i = 0; i < identity.aliases.length; i++) {
    if (identity.aliases[i] === v) return true;
  }
  return false;
}

// Canonical People-sheet name for the current visitor, or '' if their email
// has no row there.
function resolvePerson_() {
  return resolveIdentity_().person;
}

// Same, but throws a message the front-end shows verbatim. Used by everything
// that reads or writes one person's data. Failing closed is deliberate: better
// a clear "you're not in the People sheet" than silently filing someone's time
// under the wrong name.
function requireIdentity_() {
  var identity = resolveIdentity_();
  if (!identity.person) {
    throw new Error('We can\'t match your account (' + (currentUserEmail_() || 'unknown') +
      ') to a name in the People sheet. Ask ' + DIGEST_ADMIN_EMAIL + ' to add you, then reload.');
  }
  return identity;
}

function requirePerson_() {
  return requireIdentity_().person;
}

// Called by the front-end on load to fill in the name field from the signed-in
// account rather than from localStorage, and to confirm the HOD flag the page
// was rendered with. The page passes back the key doGet gave it; an empty or
// wrong key simply comes back isHod:false.
function getUserRole(key) {
  var role = currentRole_();
  return {
    email:  currentUserEmail_(),
    role:   role,
    isHod:  !!role && hodKeyValid_(key),
    person: role ? resolvePerson_() : ''
  };
}

// Friendly page shown when an unauthorised / wrong account opens the web app.
// Because access is "anyone with a Google account", our code runs and can show
// this instead of Google's cryptic "unable to open the file" error.
function accessDeniedPage_() {
  var appUrl  = WEB_APP_URL;
  var chooser = 'https://accounts.google.com/AccountChooser?continue=' + encodeURIComponent(appUrl);
  var email   = currentUserEmail_();
  var who = email
    ? 'You are signed in as <b>' + email + '</b>, which is not authorised for this app.'
    : 'You may be signed in with a personal Google account, or signed into several accounts at once.';
  var html =
    '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
    '<title>MANNMADE · Access</title>' +
    '<style>body{margin:0;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#0e0e0e;color:#eee;' +
    'display:flex;align-items:center;justify-content:center;min-height:100vh}' +
    '.card{max-width:440px;padding:40px 36px;text-align:center}' +
    'h1{font-size:20px;margin:0 0 14px;letter-spacing:.02em}' +
    'p{font-size:14px;line-height:1.6;color:#bbb;margin:0 0 22px}' +
    '.btn{display:inline-block;background:#e6007e;color:#fff;text-decoration:none;font-weight:600;' +
    'padding:13px 26px;border-radius:4px;font-size:13px;letter-spacing:.04em}' +
    '.hint{margin-top:20px;font-size:12px;color:#777;line-height:1.6}</style></head>' +
    '<body><div class="card">' +
    '<h1>Sign in with your MANNMADE account</h1>' +
    '<p>' + who + '</p>' +
    '<a class="btn" href="' + chooser + '" target="_top">Switch account</a>' +
    '<div class="hint">Use your <b>@mannmade.co.za</b> account. If you have several Google accounts, ' +
    'pick the MANNMADE one on the next screen — or open this link in an Incognito window signed into ' +
    'only your work account.</div>' +
    '</div></body></html>';
  return HtmlService.createHtmlOutput(html)
    .setTitle('MANNMADE · Access')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// Column index (1-based) of the hidden Entry ID column. It lives in column 12,
// immediately after Notes (column 11). Existing rows below get an ID assigned
// lazily the first time they are edited.
var ENTRY_ID_COL = 12;

// Generate a short, collision-resistant unique id for a log row.
function makeEntryId() {
  return 'e-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1296).toString(36);
}

// Ensure the Time Log sheet has the Entry ID header in column 12. Safe to call
// repeatedly — only writes the header if it is missing. Returns the sheet.
function ensureEntryIdColumn(sheet) {
  if (!sheet) return sheet;
  var header = sheet.getRange(1, ENTRY_ID_COL).getValue();
  if (String(header || '').trim().toLowerCase() !== 'entry id') {
    sheet.getRange(1, ENTRY_ID_COL).setValue('Entry ID')
      .setFontWeight('bold').setBackground('#111111')
      .setFontColor('#f59e0b').setFontFamily('Courier New');
    sheet.setColumnWidth(ENTRY_ID_COL, 130);
  }
  return sheet;
}

// Routing. Signed-in staff always get the app; the ?key= parameter decides
// whether it renders as the team view or the HOD view.
//
// The page is a template so the answer is baked into the HTML at render time:
// the team link never receives the key, so its copy of the page has nothing to
// send to the HOD-only functions even if someone digs through the source. A
// hand-edited URL with a missing or wrong key falls through to the team view.
function doGet(e) {
  if (!currentRole_()) return accessDeniedPage_();

  var isHod = hodKeyValid_(e && e.parameter ? e.parameter.key : '');

  var page = HtmlService.createTemplateFromFile('Index');
  page.isHod  = isHod;
  page.hodKey = isHod ? HOD_KEY : '';

  return page.evaluate()
    .setTitle('MANNMADE · Time Tracker')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ── JOBS — reads ALL tabs ─────────────────────────────────────
function getJobs() {
  requireAccess_();
  try {
    var ss       = SpreadsheetApp.openById(JOBS_SHEET_ID);
    var sheets   = ss.getSheets();
    var allJobs  = [];

    for (var i = 0; i < sheets.length; i++) {
      var sheet = sheets[i];
      var rows  = sheet.getDataRange().getValues();
      if (rows.length < 2) continue;

      var headers   = rows[0].map(function(h) { return h.toString().trim().toLowerCase(); });
      var jobNumCol = headers.indexOf('job number');
      if (jobNumCol === -1) continue;

      var col = {
        jobNumber:     jobNumCol,
        jobName:       headers.indexOf('job name'),
        company:       headers.indexOf('company'),
        clientDetails: headers.indexOf('client details'),
        clientService: headers.indexOf('client service'),
        jobType:       headers.indexOf('job type'),
        status:        headers.indexOf('status')
      };

      for (var r = 1; r < rows.length; r++) {
        var row = rows[r];
        if (!row[col.jobNumber]) continue;
        allJobs.push({
          jobNumber:     String(row[col.jobNumber]     || '').trim(),
          jobName:       String(col.jobName    >= 0 ? row[col.jobName]    : '').trim(),
          company:       String(col.company    >= 0 ? row[col.company]    : '').trim(),
          clientDetails: String(col.clientDetails >= 0 ? row[col.clientDetails] : '').trim(),
          clientService: String(col.clientService >= 0 ? row[col.clientService] : '').trim(),
          jobType:       String(col.jobType    >= 0 ? row[col.jobType]    : '').trim(),
          status:        String(col.status     >= 0 ? row[col.status]     : '').trim()
        });
      }

      Logger.log('Tab: ' + sheet.getName() + ' → ' + allJobs.length + ' total so far');
    }

    Logger.log('Total jobs loaded: ' + allJobs.length);
    return allJobs;

  } catch(e) {
    Logger.log('getJobs error: ' + e.toString());
    return [];
  }
}

// ── LOG TIME ─────────────────────────────────────────────────
function logTime(entry) {
  requireAccess_();
  var person = requirePerson_();   // never trust entry.person

  // Month-end lock: reject entries dated before the lock date
  var lockErr = checkLock_(entry.startTime);
  if (lockErr) return lockErr;

  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    var headers = [
      'Date', 'Person', 'Job Number', 'Job Name',
      'Company', 'Task', 'Start Time', 'End Time',
      'Duration (hrs)', 'Billable', 'Notes', 'Entry ID'
    ];
    sheet.appendRow(headers);
    var hr = sheet.getRange(1, 1, 1, headers.length);
    hr.setFontWeight('bold')
      .setBackground('#111111')
      .setFontColor('#f59e0b')
      .setFontFamily('Courier New');
    sheet.setFrozenRows(1);
    var widths = [100,130,110,200,130,220,100,100,120,80,260,130];
    for (var i = 0; i < widths.length; i++) {
      sheet.setColumnWidth(i + 1, widths[i]);
    }
  }
  ensureEntryIdColumn(sheet);

  var startDate   = new Date(entry.startTime);
  var endDate     = new Date(entry.endTime);
  var durationHrs = Math.round(((endDate - startDate) / 3600000) * 100) / 100;
  var tz          = Session.getScriptTimeZone();
  var entryId     = makeEntryId();

  sheet.appendRow([
    Utilities.formatDate(startDate, tz, 'yyyy-MM-dd'),
    person,
    entry.jobNumber,
    entry.jobName,
    entry.company,
    entry.task,
    Utilities.formatDate(startDate, tz, 'HH:mm:ss'),
    Utilities.formatDate(endDate,   tz, 'HH:mm:ss'),
    durationHrs,
    entry.billable ? 'Yes' : 'No',
    entry.notes || '',
    entryId
  ]);

  return { success: true, duration: durationHrs, entryId: entryId, warning: getBudgetWarning(entry.jobNumber) };
}

// ── BULK LOG TIME ─────────────────────────────────────────────
// Writes many entries in one call. Each item in `entries` looks like a normal
// entry object (person, jobNumber, jobName, company, task, notes, billable,
// startTime, endTime). Used by the bulk "Manual loader" panel where the user
// supplies one task + billable for the whole batch and a list of day/hours.
function bulkLogTime(entries) {
  requireAccess_();
  var person = requirePerson_();   // never trust entry.person
  if (!entries || !entries.length) return { success: false, count: 0, error: 'No entries supplied' };

  // Month-end lock: reject the batch if any entry falls in a locked period
  for (var li = 0; li < entries.length; li++) {
    var lockErr = checkLock_(entries[li].startTime);
    if (lockErr) return { success: false, count: 0, error: lockErr.error };
  }

  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  var seededHrs = 0, seededCount = 0;

  if (!sheet) {
    // Sheet doesn't exist yet — reuse logTime's creation path for the first row,
    // then batch-write the remainder below.
    var first = logTime(entries[0]);
    seededCount = 1;
    seededHrs   = (first && first.duration) ? first.duration : 0;
    sheet = ss.getSheetByName(SHEET_NAME);
    entries = entries.slice(1);
    if (!entries.length) {
      return { success: true, count: seededCount, totalHrs: Math.round(seededHrs * 100) / 100 };
    }
  }
  ensureEntryIdColumn(sheet);

  var tz = Session.getScriptTimeZone();
  var rowsToWrite = [];
  var totalHrs = seededHrs;

  entries.forEach(function(entry) {
    var startDate   = new Date(entry.startTime);
    var endDate     = new Date(entry.endTime);
    var durationHrs = Math.round(((endDate - startDate) / 3600000) * 100) / 100;
    totalHrs += durationHrs;
    rowsToWrite.push([
      Utilities.formatDate(startDate, tz, 'yyyy-MM-dd'),
      person,
      entry.jobNumber,
      entry.jobName,
      entry.company,
      entry.task,
      Utilities.formatDate(startDate, tz, 'HH:mm:ss'),
      Utilities.formatDate(endDate,   tz, 'HH:mm:ss'),
      durationHrs,
      entry.billable ? 'Yes' : 'No',
      entry.notes || '',
      makeEntryId()
    ]);
  });

  // Single batched write — far faster than appendRow per line.
  var startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, rowsToWrite.length, 12).setValues(rowsToWrite);

  return {
    success: true,
    count: rowsToWrite.length + seededCount,
    totalHrs: Math.round(totalHrs * 100) / 100
  };
}

// ── MY LOGS — a single person's own entries ───────────────────
// Returns this person's entries (most recent first), each carrying its Entry ID
// so the row can be edited. `filter` reuses the dashboard windows
// (week/month/30days/all). Rows without an Entry ID are returned with a
// rowNumber fallback so they can be lazily assigned an ID on first edit.
function getMyLogs(person, filter) {
  requireAccess_();
  // The `person` argument is ignored — kept only so the existing front-end call
  // signature still works. Your own entries are the only ones you can read.
  var identity = requireIdentity_();
  person = identity.person;

  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return { person: person, entries: [], totalHrs: 0 };
  ensureEntryIdColumn(sheet);

  var tz    = Session.getScriptTimeZone();
  var today = new Date();
  today.setHours(23, 59, 59, 999);
  var from  = getFromDate(filter || 'month', today);

  var lastRow = sheet.getLastRow();
  var data = sheet.getRange(2, 1, lastRow - 1, 12).getValues();

  var entries = [];
  var totalHrs = 0, billableHrs = 0;

  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    if (!row[0]) continue;
    if (!isMine_(row[1], identity)) continue;
    var d = row[0] instanceof Date ? row[0] : new Date(row[0]);
    if (d < from || d > today) continue;

    var date = row[0] instanceof Date ? Utilities.formatDate(row[0], tz, 'yyyy-MM-dd') : String(row[0]).substring(0,10);
    var hrs  = parseFloat(row[8]) || 0;
    var isBill = row[9] === 'Yes';
    totalHrs += hrs;
    if (isBill) billableHrs += hrs;

    entries.push({
      entryId:   String(row[11] || '').trim(),
      rowNumber: i + 2,            // actual sheet row (header is row 1)
      date:      date,
      jobNumber: String(row[2] || '').trim(),
      jobName:   String(row[3] || '').trim(),
      company:   String(row[4] || '').trim(),
      task:      String(row[5] || '').trim(),
      start:     String(row[6] || '').trim(),
      end:       String(row[7] || '').trim(),
      hrs:       hrs,
      billable:  isBill,
      notes:     String(row[10] || '').trim()
    });
  }

  entries.sort(function(a,b){ return b.date.localeCompare(a.date); });

  return {
    person:      person,
    entries:     entries,
    totalHrs:    Math.round(totalHrs * 100) / 100,
    billableHrs: Math.round(billableHrs * 100) / 100,
    entryCount:  entries.length
  };
}

// ── EDIT MY ENTRY (edit-with-trail) ───────────────────────────
// Lets a person correct one of their own rows. Editable fields: task, notes,
// billable, and hours (via new start/end on the same date). The original value
// of any changed field is preserved by appending a marker to Notes, e.g.
// "[edited 27 May: hrs 6.00→3.00]". Person, job, and date are NOT editable here.
//
// `payload` = { entryId, rowNumber, person, task, notes, billable, date,
//               startTime ('HH:mm'), endTime ('HH:mm') }
// `person` MUST match the row's logged person — this is the ownership guard.
function updateMyEntry(payload) {
  requireAccess_();
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return { success: false, error: 'No data' };
  ensureEntryIdColumn(sheet);

  // Resolved from the login, not from payload.person — the old guard compared
  // two values the caller supplied, so it stopped accidents but not intent.
  var identity = requireIdentity_();
  var person   = identity.person;

  var tz = Session.getScriptTimeZone();
  var lastRow = sheet.getLastRow();
  var data = sheet.getRange(2, 1, lastRow - 1, 12).getValues();

  // Locate the row: prefer Entry ID, fall back to rowNumber for legacy rows.
  var targetIdx = -1;
  var wantId = String(payload.entryId || '').trim();
  if (wantId) {
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][11] || '').trim() === wantId) { targetIdx = i; break; }
    }
  }
  if (targetIdx === -1 && payload.rowNumber) {
    var rn = parseInt(payload.rowNumber, 10);
    if (rn >= 2 && rn <= lastRow) targetIdx = rn - 2;
  }
  if (targetIdx === -1) return { success: false, error: 'Entry not found' };

  var row = data[targetIdx];
  var sheetRow = targetIdx + 2;

  // Ownership guard — a person can only edit their own logged time. Matches any
  // of their People-sheet spellings, so older entries filed under a duplicate
  // name are still editable.
  if (!isMine_(row[1], identity)) {
    return { success: false, error: 'You can only edit your own entries.' };
  }

  // Lazily assign an Entry ID to legacy rows so future edits are stable.
  var existingId = String(row[11] || '').trim();
  if (!existingId) {
    existingId = makeEntryId();
    sheet.getRange(sheetRow, ENTRY_ID_COL).setValue(existingId);
  }

  // Current values
  var curTask    = String(row[5] || '').trim();
  var curStart   = String(row[6] || '').trim();
  var curEnd     = String(row[7] || '').trim();
  var curHrs     = parseFloat(row[8]) || 0;
  var curBill    = row[9] === 'Yes';
  var curNotes   = String(row[10] || '').trim();
  var dateStr    = row[0] instanceof Date ? Utilities.formatDate(row[0], tz, 'yyyy-MM-dd') : String(row[0]).substring(0,10);

  // Month-end lock — entries in a locked period can no longer be edited
  var lockErr = checkLock_(dateStr + 'T12:00:00');
  if (lockErr) return lockErr;

  // New values (fall back to current when a field is omitted)
  var newTask = payload.task != null ? String(payload.task).trim() : curTask;
  var newBill = payload.billable != null ? !!payload.billable : curBill;
  var newNotesRaw = payload.notes != null ? String(payload.notes).trim() : stripEditTrail(curNotes);

  // Recompute hours if start/end supplied
  var newStart = curStart, newEnd = curEnd, newHrs = curHrs;
  if (payload.startTime && payload.endTime) {
    var sd = new Date(dateStr + 'T' + padTime(payload.startTime) + ':00');
    var ed = new Date(dateStr + 'T' + padTime(payload.endTime) + ':00');
    if (isNaN(sd) || isNaN(ed) || ed <= sd) {
      return { success: false, error: 'End time must be after start time.' };
    }
    newStart = Utilities.formatDate(sd, tz, 'HH:mm:ss');
    newEnd   = Utilities.formatDate(ed, tz, 'HH:mm:ss');
    newHrs   = Math.round(((ed - sd) / 3600000) * 100) / 100;
  }

  // Build the change trail
  var changes = [];
  if (newTask !== curTask)             changes.push('task');
  if (newBill !== curBill)             changes.push('billable ' + (curBill?'Y':'N') + '\u2192' + (newBill?'Y':'N'));
  if (newHrs.toFixed(2) !== curHrs.toFixed(2)) changes.push('hrs ' + curHrs.toFixed(2) + '\u2192' + newHrs.toFixed(2));

  if (!changes.length) {
    return { success: true, unchanged: true, duration: curHrs };
  }

  // Compose notes: user's notes + preserved edit trail.
  var stamp = Utilities.formatDate(new Date(), tz, 'd MMM');
  var trail = '[edited ' + stamp + ': ' + changes.join(', ') + ']';
  var combinedNotes = newNotesRaw ? (newNotesRaw + ' ' + trail) : trail;

  // Write back the editable cells (Task, Start, End, Duration, Billable, Notes).
  sheet.getRange(sheetRow, 6).setValue(newTask);
  sheet.getRange(sheetRow, 7).setValue(newStart);
  sheet.getRange(sheetRow, 8).setValue(newEnd);
  sheet.getRange(sheetRow, 9).setValue(newHrs);
  sheet.getRange(sheetRow, 10).setValue(newBill ? 'Yes' : 'No');
  sheet.getRange(sheetRow, 11).setValue(combinedNotes);

  // Optional admin notification (controlled by EDIT_NOTIFY_ADMIN below).
  if (typeof EDIT_NOTIFY_ADMIN !== 'undefined' && EDIT_NOTIFY_ADMIN && DIGEST_ADMIN_EMAIL) {
    try {
      MailApp.sendEmail({
        to: DIGEST_ADMIN_EMAIL,
        subject: 'Time edit · ' + person + ' · ' + row[2],
        htmlBody: '<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">' +
          '<strong>' + escapeHtml(person) + '</strong> edited a logged entry.<br><br>' +
          'Job: ' + escapeHtml(String(row[2])) + ' — ' + escapeHtml(String(row[3])) + '<br>' +
          'Date: ' + escapeHtml(dateStr) + '<br>' +
          'Change: ' + escapeHtml(changes.join(', ')) + '</div>',
        name: 'MANNMADE Time'
      });
    } catch (e) { Logger.log('Edit notify failed: ' + e); }
  }

  return { success: true, duration: newHrs, entryId: existingId, changes: changes };
}

// Strip any previously-appended edit trail so trails don't stack endlessly.
function stripEditTrail(notes) {
  return String(notes || '').replace(/\s*\[edited [^\]]*\]/g, '').trim();
}

// Normalise a 'H:mm' or 'HH:mm' string to 'HH:mm'.
function padTime(t) {
  var parts = String(t).split(':');
  var h = ('0' + (parts[0] || '0')).slice(-2);
  var m = ('0' + (parts[1] || '0')).slice(-2);
  return h + ':' + m;
}

// Set to true if you want an email every time someone edits an entry.
var EDIT_NOTIFY_ADMIN = false;


// ── TODAY SUMMARY ─────────────────────────────────────────────
function getTodaySummary(person) {
  requireAccess_();
  var identity = requireIdentity_();   // argument ignored; your own rows only
  person = identity.person;
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return [];

  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var data  = sheet.getRange(2, 1, sheet.getLastRow() - 1, 10).getValues();
  var result = [];

  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    var rowDate = row[0] instanceof Date
      ? Utilities.formatDate(row[0], Session.getScriptTimeZone(), 'yyyy-MM-dd')
      : String(row[0]).substring(0, 10);
    if (rowDate === today && isMine_(row[1], identity)) {
      result.push({
        date: rowDate, person: row[1], jobNumber: row[2],
        jobName: row[3], company: row[4], task: row[5],
        start: row[6], end: row[7], duration: row[8], billable: row[9]
      });
    }
  }

  return result;
}

// ── DASHBOARD DATA ────────────────────────────────────────────
function getDashboardData(filter, key) {
  requireHod_(key);
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return emptyDashboard();

  var data  = sheet.getRange(2, 1, sheet.getLastRow() - 1, 11).getValues();
  var tz    = Session.getScriptTimeZone();
  var today = new Date();
  today.setHours(23, 59, 59, 999);
  var from  = getFromDate(filter, today);

  var rows = data.filter(function(row) {
    if (!row[0]) return false;
    var d = row[0] instanceof Date ? row[0] : new Date(row[0]);
    return d >= from && d <= today;
  });

  var totalHrs = 0, billableHrs = 0;
  var byClient = {}, byPerson = {}, byJob = {}, byDay = {};
  var recentEntries = [];

  rows.forEach(function(row) {
    var date      = row[0] instanceof Date ? Utilities.formatDate(row[0], tz, 'yyyy-MM-dd') : String(row[0]).substring(0,10);
    var person    = String(row[1] || 'Unknown').trim();
    var jobNum    = String(row[2] || '').trim();
    var jobName   = String(row[3] || '').trim();
    var company   = String(row[4] || '').trim();
    var task      = String(row[5] || '').trim();
    var hrs       = parseFloat(row[8]) || 0;
    var isBill    = row[9] === 'Yes';

    totalHrs += hrs;
    if (isBill) billableHrs += hrs;

    var clientKey = company || jobNum;
    if (!byClient[clientKey]) byClient[clientKey] = { name: clientKey, billable: 0, nonBillable: 0 };
    if (isBill) byClient[clientKey].billable += hrs; else byClient[clientKey].nonBillable += hrs;

    if (!byPerson[person]) byPerson[person] = { name: person, billable: 0, nonBillable: 0 };
    if (isBill) byPerson[person].billable += hrs; else byPerson[person].nonBillable += hrs;

    if (!byJob[jobNum]) byJob[jobNum] = { jobNumber: jobNum, jobName: jobName, company: company, hrs: 0, billable: 0 };
    byJob[jobNum].hrs += hrs;
    if (isBill) byJob[jobNum].billable += hrs;

    if (!byDay[date]) byDay[date] = 0;
    byDay[date] += hrs;

    recentEntries.push({ date: date, person: person, jobNum: jobNum, task: task, hrs: hrs, billable: isBill });
  });

  var clients = Object.values(byClient).sort(function(a,b) { return (b.billable+b.nonBillable)-(a.billable+a.nonBillable); }).slice(0,10);
  var people  = Object.values(byPerson).sort(function(a,b) { return (b.billable+b.nonBillable)-(a.billable+a.nonBillable); });
  var jobs    = Object.values(byJob).sort(function(a,b) { return b.hrs-a.hrs; }).slice(0,10);
  var recent  = recentEntries.slice(-20).reverse();

  var trend = [];
  for (var i = 13; i >= 0; i--) {
    var d   = new Date(today);
    d.setDate(today.getDate() - i);
    var key = Utilities.formatDate(d, tz, 'yyyy-MM-dd');
    trend.push({ date: key, hrs: Math.round((byDay[key] || 0) * 100) / 100 });
  }

  return {
    totalHrs:       Math.round(totalHrs * 100) / 100,
    billableHrs:    Math.round(billableHrs * 100) / 100,
    nonBillableHrs: Math.round((totalHrs - billableHrs) * 100) / 100,
    billablePct:    totalHrs > 0 ? Math.round((billableHrs / totalHrs) * 100) : 0,
    entryCount:     rows.length,
    clients:        clients,
    people:         people,
    jobs:           jobs,
    trend:          trend,
    recent:         recent,
    budgets:        getBudgetStatus()
  };
}

// ── PERSON DETAIL ─────────────────────────────────────────────
function getPersonDetail(person, filter, key) {
  requireHod_(key);
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return null;

  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 11).getValues();
  var tz   = Session.getScriptTimeZone();
  var today = new Date();
  today.setHours(23, 59, 59, 999);
  var from  = getFromDate(filter, today);

  var rows = data.filter(function(row) {
    if (!row[0]) return false;
    var rowPerson = String(row[1] || '').trim();
    if (rowPerson !== person) return false;
    var d = row[0] instanceof Date ? row[0] : new Date(row[0]);
    return d >= from && d <= today;
  });

  Logger.log('getPersonDetail: ' + person + ' filter=' + filter + ' rows=' + rows.length);

  if (!rows.length) return null;

  var totalHrs = 0, billableHrs = 0;
  var byJob = {}, byDay = {};

  rows.forEach(function(row) {
    var date      = row[0] instanceof Date ? Utilities.formatDate(row[0], tz, 'yyyy-MM-dd') : String(row[0]).substring(0,10);
    var jobNum    = String(row[2] || '').trim();
    var jobName   = String(row[3] || '').trim();
    var company   = String(row[4] || '').trim();
    var task      = String(row[5] || '').trim();
    var startT    = String(row[6] || '').trim();
    var endT      = String(row[7] || '').trim();
    var hrs       = parseFloat(row[8]) || 0;
    var isBill    = row[9] === 'Yes';

    totalHrs += hrs;
    if (isBill) billableHrs += hrs;

    if (!byJob[jobNum]) byJob[jobNum] = { jobNumber: jobNum, jobName: jobName, company: company, hrs: 0, billable: 0, nonBillable: 0, entries: [] };
    byJob[jobNum].hrs += hrs;
    if (isBill) byJob[jobNum].billable += hrs; else byJob[jobNum].nonBillable += hrs;
    byJob[jobNum].entries.push({ date: date, task: task, hrs: hrs, billable: isBill, start: startT, end: endT });

    if (!byDay[date]) byDay[date] = 0;
    byDay[date] += hrs;
  });

  // Sort entries within each job by date descending
  var jobs = Object.values(byJob).sort(function(a,b) { return b.hrs - a.hrs; });
  jobs.forEach(function(j) {
    j.entries.sort(function(a,b) { return b.date.localeCompare(a.date); });
    j.hrs        = Math.round(j.hrs * 100) / 100;
    j.billable   = Math.round(j.billable * 100) / 100;
    j.nonBillable = Math.round(j.nonBillable * 100) / 100;
  });

  // Group by company
  var byCompany = {};
  jobs.forEach(function(j) {
    var co = j.company || 'Internal / Other';
    if (!byCompany[co]) byCompany[co] = { company: co, hrs: 0, billable: 0, nonBillable: 0, jobs: [] };
    byCompany[co].hrs         += j.hrs;
    byCompany[co].billable    += j.billable;
    byCompany[co].nonBillable += j.nonBillable;
    byCompany[co].jobs.push(j);
  });

  var companies = Object.values(byCompany).sort(function(a,b) { return b.hrs - a.hrs; });

  return {
    person:         person,
    totalHrs:       Math.round(totalHrs * 100) / 100,
    billableHrs:    Math.round(billableHrs * 100) / 100,
    nonBillableHrs: Math.round((totalHrs - billableHrs) * 100) / 100,
    billablePct:    totalHrs > 0 ? Math.round((billableHrs / totalHrs) * 100) : 0,
    entryCount:     rows.length,
    companies:      companies,
    jobs:           jobs
  };
}

// ── HELPERS ───────────────────────────────────────────────────
function getFromDate(filter, today) {
  var from = new Date(today);
  if (filter === 'week') {
    var day = from.getDay();
    var diff = (day === 0) ? -6 : 1 - day;
    from.setDate(from.getDate() + diff);
    from.setHours(0,0,0,0);
  } else if (filter === 'month') {
    from = new Date(today.getFullYear(), today.getMonth(), 1);
    from.setHours(0,0,0,0);
  } else if (filter === '30days') {
    from = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
    from.setHours(0,0,0,0);
  } else {
    from = new Date(2000, 0, 1);
  }
  return from;
}

function emptyDashboard() {
  return { totalHrs: 0, billableHrs: 0, nonBillableHrs: 0, billablePct: 0, entryCount: 0, clients: [], people: [], jobs: [], trend: [], recent: [], budgets: getBudgetStatus() };
}

// ── COMPANY DETAIL ────────────────────────────────────────────
function getCompanyDetail(company, filter, key) {
  requireHod_(key);
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return null;

  var data  = sheet.getRange(2, 1, sheet.getLastRow() - 1, 11).getValues();
  var tz    = Session.getScriptTimeZone();
  var today = new Date();
  today.setHours(23, 59, 59, 999);
  var from  = getFromDate(filter, today);

  var rows = data.filter(function(row) {
    if (!row[0]) return false;
    var rowCompany = String(row[4] || '').trim();
    if (rowCompany !== company) return false;
    var d = row[0] instanceof Date ? row[0] : new Date(row[0]);
    return d >= from && d <= today;
  });

  if (!rows.length) return null;

  var totalHrs = 0, billableHrs = 0;
  var byJob    = {};
  var byPerson = {};
  var allEntries = [];

  rows.forEach(function(row) {
    var date      = row[0] instanceof Date ? Utilities.formatDate(row[0], tz, 'yyyy-MM-dd') : String(row[0]).substring(0,10);
    var person    = String(row[1] || '').trim();
    var jobNum    = String(row[2] || '').trim();
    var jobName   = String(row[3] || '').trim();
    var task      = String(row[5] || '').trim();
    var startT    = String(row[6] || '').trim();
    var endT      = String(row[7] || '').trim();
    var hrs       = parseFloat(row[8]) || 0;
    var isBill    = row[9] === 'Yes';

    totalHrs += hrs;
    if (isBill) billableHrs += hrs;

    // By job
    if (!byJob[jobNum]) byJob[jobNum] = { jobNumber: jobNum, jobName: jobName, hrs: 0, billable: 0, nonBillable: 0, people: {}, entries: [] };
    byJob[jobNum].hrs += hrs;
    if (isBill) byJob[jobNum].billable += hrs; else byJob[jobNum].nonBillable += hrs;
    if (!byJob[jobNum].people[person]) byJob[jobNum].people[person] = 0;
    byJob[jobNum].people[person] += hrs;
    byJob[jobNum].entries.push({ date: date, person: person, task: task, hrs: hrs, billable: isBill, start: startT, end: endT });

    // By person
    if (!byPerson[person]) byPerson[person] = { name: person, hrs: 0, billable: 0, nonBillable: 0 };
    byPerson[person].hrs += hrs;
    if (isBill) byPerson[person].billable += hrs; else byPerson[person].nonBillable += hrs;

    allEntries.push({ date: date, person: person, jobNum: jobNum, jobName: jobName, task: task, hrs: hrs, billable: isBill });
  });

  // Sort
  var jobs = Object.values(byJob).sort(function(a,b) { return b.hrs - a.hrs; });
  jobs.forEach(function(j) {
    j.hrs        = Math.round(j.hrs * 100) / 100;
    j.billable   = Math.round(j.billable * 100) / 100;
    j.nonBillable = Math.round(j.nonBillable * 100) / 100;
    j.entries.sort(function(a,b) { return b.date.localeCompare(a.date); });
    // Convert people map to sorted array
    j.peopleList = Object.keys(j.people).map(function(p) { return { name: p, hrs: Math.round(j.people[p]*100)/100 }; }).sort(function(a,b){return b.hrs-a.hrs;});
  });

  var people = Object.values(byPerson).sort(function(a,b) { return b.hrs - a.hrs; });
  allEntries.sort(function(a,b) { return b.date.localeCompare(a.date); });

  return {
    company:        company,
    totalHrs:       Math.round(totalHrs * 100) / 100,
    billableHrs:    Math.round(billableHrs * 100) / 100,
    nonBillableHrs: Math.round((totalHrs - billableHrs) * 100) / 100,
    billablePct:    totalHrs > 0 ? Math.round((billableHrs / totalHrs) * 100) : 0,
    entryCount:     rows.length,
    jobs:           jobs,
    people:         people,
    allEntries:     allEntries
  };
}

// ── JOB DETAIL ────────────────────────────────────────────────
function getJobDetail(jobNumber, filter, key) {
  requireHod_(key);
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return null;

  var data  = sheet.getRange(2, 1, sheet.getLastRow() - 1, 11).getValues();
  var tz    = Session.getScriptTimeZone();
  var today = new Date();
  today.setHours(23, 59, 59, 999);
  var from  = getFromDate(filter, today);

  var rows = data.filter(function(row) {
    if (!row[0]) return false;
    if (String(row[2] || '').trim() !== jobNumber) return false;
    var d = row[0] instanceof Date ? row[0] : new Date(row[0]);
    return d >= from && d <= today;
  });

  if (!rows.length) return null;

  var totalHrs = 0, billableHrs = 0;
  var byPerson = {};
  var entries = [];
  var jobName = '', company = '';
  var firstDate = null, lastDate = null;

  rows.forEach(function(row) {
    var date      = row[0] instanceof Date ? Utilities.formatDate(row[0], tz, 'yyyy-MM-dd') : String(row[0]).substring(0,10);
    var person    = String(row[1] || 'Unknown').trim();
    if (!jobName) jobName = String(row[3] || '').trim();
    if (!company) company = String(row[4] || '').trim();
    var task      = String(row[5] || '').trim();
    var startT    = String(row[6] || '').trim();
    var endT      = String(row[7] || '').trim();
    var hrs       = parseFloat(row[8]) || 0;
    var isBill    = row[9] === 'Yes';
    var notes     = String(row[10] || '').trim();

    totalHrs += hrs;
    if (isBill) billableHrs += hrs;

    if (!byPerson[person]) byPerson[person] = { name: person, hrs: 0, billable: 0, nonBillable: 0, entryCount: 0 };
    byPerson[person].hrs += hrs;
    byPerson[person].entryCount++;
    if (isBill) byPerson[person].billable += hrs; else byPerson[person].nonBillable += hrs;

    entries.push({ date: date, person: person, task: task, hrs: hrs, billable: isBill, start: startT, end: endT, notes: notes });

    if (!firstDate || date < firstDate) firstDate = date;
    if (!lastDate  || date > lastDate)  lastDate  = date;
  });

  var people = Object.values(byPerson).sort(function(a,b) { return b.hrs - a.hrs; });
  people.forEach(function(p) {
    p.hrs         = Math.round(p.hrs * 100) / 100;
    p.billable    = Math.round(p.billable * 100) / 100;
    p.nonBillable = Math.round(p.nonBillable * 100) / 100;
  });
  entries.sort(function(a,b) { return b.date.localeCompare(a.date); });

  // Budget — always measured against ALL-TIME tracked time on the job
  var budgetInfo = loadJobBudgets()[jobNumber];
  var jobTotals  = getAllTimeJobTotals()[jobNumber] || { hrs: 0, spend: 0 };

  return {
    budgetHrs:      budgetInfo ? budgetInfo.budget : 0,
    budgetRand:     budgetInfo ? budgetInfo.budgetRand : 0,
    allTimeSpend:   Math.round(jobTotals.spend),
    allTimeHrs:     Math.round(jobTotals.hrs * 100) / 100,
    jobNumber:      jobNumber,
    jobName:        jobName,
    company:        company,
    totalHrs:       Math.round(totalHrs * 100) / 100,
    billableHrs:    Math.round(billableHrs * 100) / 100,
    nonBillableHrs: Math.round((totalHrs - billableHrs) * 100) / 100,
    billablePct:    totalHrs > 0 ? Math.round((billableHrs / totalHrs) * 100) : 0,
    entryCount:     rows.length,
    firstDate:      firstDate,
    lastDate:       lastDate,
    people:         people,
    entries:        entries
  };
}

// ============================================================
// WEEKLY DIGEST — autonomous Friday 17:00 email per person
// ============================================================

var PEOPLE_SHEET_NAME        = 'People';
var DIGEST_SENDER_NAME       = 'Shayne — MANNMADE';
var DIGEST_TARGET_UTILISATION = 65;
var DIGEST_ADMIN_EMAIL       = 'shayne@mannmade.co.za';

// Run ONCE from the Apps Script editor to schedule the weekly digest.
function installWeeklyDigestTrigger() {
  removeWeeklyDigestTriggers();
  ScriptApp.newTrigger('sendWeeklyDigests')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.FRIDAY)
    .atHour(17)
    .inTimezone(Session.getScriptTimeZone())
    .create();
  // Ensure People sheet exists so the admin can populate emails before first send.
  loadPeopleDirectory();
  return 'Installed. Weekly digest will send every Friday 17:00 ' + Session.getScriptTimeZone();
}

function removeWeeklyDigestTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  triggers.forEach(function(t) {
    if (t.getHandlerFunction() === 'sendWeeklyDigests') {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  return 'Removed ' + removed + ' trigger(s)';
}

// Run this manually to preview the digest — sends a copy of the first person's week to the admin.
function testWeeklyDigest() {
  var bounds = getCurrentWeekBounds();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return 'No time log data to preview.';

  var peopleWithData = {};
  var rows = sheet.getRange(2, 2, sheet.getLastRow() - 1, 1).getValues();
  rows.forEach(function(r) { var n = String(r[0] || '').trim(); if (n) peopleWithData[n] = true; });
  var names = Object.keys(peopleWithData);
  if (!names.length) return 'No people found in Time Log.';

  var target = names[0];
  var digest = getWeeklyDigestForPerson_(target, bounds.start, bounds.end);
  if (!digest || digest.totalHrs === 0) {
    // Fall back to any person with hours this week
    for (var i = 0; i < names.length; i++) {
      var d = getWeeklyDigestForPerson_(names[i], bounds.start, bounds.end);
      if (d && d.totalHrs > 0) { digest = d; target = names[i]; break; }
    }
  }
  if (!digest) return 'Could not build a digest for anyone this week.';

  var html = buildWeeklyDigestHtml(digest, bounds.start, bounds.end);
  var subject = '[PREVIEW] Your week · ' + formatRange(bounds.start, bounds.end);
  MailApp.sendEmail({
    to: DIGEST_ADMIN_EMAIL,
    subject: subject,
    htmlBody: html,
    name: DIGEST_SENDER_NAME
  });
  return 'Preview digest for "' + target + '" sent to ' + DIGEST_ADMIN_EMAIL;
}

// Main job fired by the weekly trigger.
function sendWeeklyDigests() {
  var bounds = getCurrentWeekBounds();
  var people = loadPeopleDirectory();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) {
    Logger.log('No Time Log data — skipping weekly digest.');
    return;
  }

  var sent = [], skipped = [];
  Object.keys(people).forEach(function(name) {
    var email = people[name];
    if (!email) { skipped.push(name + ' (no email)'); return; }
    var digest = getWeeklyDigestForPerson_(name, bounds.start, bounds.end);
    if (!digest || digest.totalHrs === 0) { skipped.push(name + ' (no hours)'); return; }
    var html = buildWeeklyDigestHtml(digest, bounds.start, bounds.end);
    var subject = 'Your week · ' + formatRange(bounds.start, bounds.end);
    MailApp.sendEmail({
      to: email,
      subject: subject,
      htmlBody: html,
      name: DIGEST_SENDER_NAME,
      replyTo: DIGEST_ADMIN_EMAIL
    });
    sent.push(name + ' → ' + email + ' (' + digest.totalHrs.toFixed(1) + 'h)');
  });

  sendAdminRecap(bounds, sent, skipped);
  Logger.log('Digest run complete. Sent: ' + sent.length + '. Skipped: ' + skipped.length);
}

function sendAdminRecap(bounds, sent, skipped) {
  if (!DIGEST_ADMIN_EMAIL) return;
  var body =
    '<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;max-width:560px">' +
      '<div style="font-family:\'Archivo Black\',Arial,sans-serif;font-size:18px;margin-bottom:8px">Weekly digest sent</div>' +
      '<div style="color:#666;font-size:12px;margin-bottom:18px;letter-spacing:0.04em">' + formatRange(bounds.start, bounds.end) + '</div>' +
      '<div style="font-size:11px;color:#888;letter-spacing:0.2em;text-transform:uppercase;font-weight:700;margin-bottom:8px">Sent (' + sent.length + ')</div>' +
      (sent.length ? '<ul style="margin:0 0 20px;padding-left:20px;color:#222;line-height:1.6">' + sent.map(function(s){return '<li>' + s + '</li>';}).join('') + '</ul>' : '<div style="color:#888;margin-bottom:20px">None.</div>') +
      '<div style="font-size:11px;color:#888;letter-spacing:0.2em;text-transform:uppercase;font-weight:700;margin-bottom:8px">Skipped (' + skipped.length + ')</div>' +
      (skipped.length ? '<ul style="margin:0;padding-left:20px;color:#666;line-height:1.6">' + skipped.map(function(s){return '<li>' + s + '</li>';}).join('') + '</ul>' : '<div style="color:#888">None.</div>') +
    '</div>';
  MailApp.sendEmail({
    to: DIGEST_ADMIN_EMAIL,
    subject: 'Digest recap · ' + formatRange(bounds.start, bounds.end),
    htmlBody: body,
    name: 'MANNMADE Time'
  });
}

// ── People directory (Name → Email) ────────────────────────────
function loadPeopleDirectory() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(PEOPLE_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(PEOPLE_SHEET_NAME);
    sheet.appendRow(['Name', 'Email', 'Rate (R/hr)']);
    var hr = sheet.getRange(1, 1, 1, 3);
    hr.setFontWeight('bold').setBackground('#0a0a0a').setFontColor('#e8318a').setFontFamily('Courier New');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 220);
    sheet.setColumnWidth(2, 280);
    sheet.setColumnWidth(3, 120);
    // Seed with distinct names from Time Log
    var logSheet = ss.getSheetByName(SHEET_NAME);
    if (logSheet && logSheet.getLastRow() >= 2) {
      var seen = {};
      var rows = logSheet.getRange(2, 2, logSheet.getLastRow() - 1, 1).getValues();
      rows.forEach(function(r) { var n = String(r[0] || '').trim(); if (n) seen[n] = true; });
      Object.keys(seen).sort().forEach(function(n) { sheet.appendRow([n, '']); });
    }
  }
  var last = sheet.getLastRow();
  if (last < 2) return {};
  var data = sheet.getRange(2, 1, last - 1, 2).getValues();
  var map = {};
  data.forEach(function(r) {
    var name  = String(r[0] || '').trim();
    var email = String(r[1] || '').trim();
    if (name) map[name] = email;
  });
  return map;
}

// ── Digest data for one person, one week ──────────────────────
// Trailing underscore is deliberate: it makes this callable only from inside the
// script, never from the browser via google.script.run. It takes a name as an
// argument and returns that person's week, so leaving it public would have
// reopened exactly the hole the identity pinning above closes.
function getWeeklyDigestForPerson_(person, start, end) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return null;
  var tz = Session.getScriptTimeZone();
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 11).getValues();

  var rows = data.filter(function(row) {
    if (!row[0]) return false;
    if (String(row[1] || '').trim() !== person) return false;
    var d = row[0] instanceof Date ? row[0] : new Date(row[0]);
    return d >= start && d <= end;
  });

  if (!rows.length) return { person: person, totalHrs: 0, billableHrs: 0, nonBillableHrs: 0, billablePct: 0, entryCount: 0, clients: [], jobs: [], days: buildEmptyDays(start, tz) };

  var totalHrs = 0, billableHrs = 0;
  var byClient = {}, byJob = {}, byDay = {};

  rows.forEach(function(row) {
    var date    = row[0] instanceof Date ? Utilities.formatDate(row[0], tz, 'yyyy-MM-dd') : String(row[0]).substring(0, 10);
    var jobNum  = String(row[2] || '').trim();
    var jobName = String(row[3] || '').trim();
    var company = String(row[4] || '').trim() || 'Internal';
    var hrs     = parseFloat(row[8]) || 0;
    var isBill  = row[9] === 'Yes';

    totalHrs += hrs;
    if (isBill) billableHrs += hrs;

    if (!byClient[company]) byClient[company] = { name: company, hrs: 0, billable: 0 };
    byClient[company].hrs += hrs;
    if (isBill) byClient[company].billable += hrs;

    var jobKey = jobNum + '||' + jobName;
    if (!byJob[jobKey]) byJob[jobKey] = { jobNumber: jobNum, jobName: jobName, company: company, hrs: 0, billable: 0 };
    byJob[jobKey].hrs += hrs;
    if (isBill) byJob[jobKey].billable += hrs;

    byDay[date] = (byDay[date] || 0) + hrs;
  });

  var days = [];
  for (var i = 0; i < 7; i++) {
    var d = new Date(start);
    d.setDate(start.getDate() + i);
    var key = Utilities.formatDate(d, tz, 'yyyy-MM-dd');
    days.push({
      dayName: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][i],
      date:    Utilities.formatDate(d, tz, 'd MMM'),
      hrs:     Math.round((byDay[key] || 0) * 100) / 100
    });
  }

  var clients = Object.keys(byClient).map(function(k) { return byClient[k]; }).sort(function(a, b) { return b.hrs - a.hrs; });
  var jobs    = Object.keys(byJob).map(function(k) { return byJob[k]; }).sort(function(a, b) { return b.hrs - a.hrs; });

  return {
    person:         person,
    totalHrs:       Math.round(totalHrs * 100) / 100,
    billableHrs:    Math.round(billableHrs * 100) / 100,
    nonBillableHrs: Math.round((totalHrs - billableHrs) * 100) / 100,
    billablePct:    totalHrs > 0 ? Math.round((billableHrs / totalHrs) * 100) : 0,
    entryCount:     rows.length,
    clients:        clients,
    jobs:           jobs,
    days:           days
  };
}

function buildEmptyDays(start, tz) {
  var days = [];
  for (var i = 0; i < 7; i++) {
    var d = new Date(start);
    d.setDate(start.getDate() + i);
    days.push({ dayName: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][i], date: Utilities.formatDate(d, tz, 'd MMM'), hrs: 0 });
  }
  return days;
}

// ── Week bounds: Monday 00:00 → Sunday 23:59 ──────────────────
function getCurrentWeekBounds() {
  var now = new Date();
  var start = new Date(now);
  var day = start.getDay();
  var diff = (day === 0) ? -6 : 1 - day;
  start.setDate(start.getDate() + diff);
  start.setHours(0, 0, 0, 0);
  var end = new Date(start);
  end.setDate(end.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  return { start: start, end: end };
}

function formatRange(start, end) {
  var tz = Session.getScriptTimeZone();
  return Utilities.formatDate(start, tz, 'd MMM') + ' – ' + Utilities.formatDate(end, tz, 'd MMM yyyy');
}

// ── HTML email template (inline styles, table layout) ─────────
function buildWeeklyDigestHtml(d, start, end) {
  var dateRange   = formatRange(start, end);
  var firstName   = d.person.split(/\s+/)[0];
  var targetHit   = d.billablePct >= DIGEST_TARGET_UTILISATION;
  var utilColor   = targetHit ? '#e8318a' : '#666';

  var maxClientHrs = d.clients.length ? d.clients[0].hrs : 1;
  var clientRows = d.clients.slice(0, 8).map(function(c) {
    var w = Math.max(4, Math.round((c.hrs / maxClientHrs) * 100));
    return (
      '<tr>' +
        '<td style="padding:12px 0;font-size:13px;color:#222;font-family:Arial,sans-serif;font-weight:600;width:170px;vertical-align:top">' + escapeHtml(c.name) + '</td>' +
        '<td style="padding:12px 0;vertical-align:middle">' +
          '<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>' +
            '<td style="background:#eeeeee;height:6px;border-radius:3px;font-size:0;line-height:0">' +
              '<table cellpadding="0" cellspacing="0" border="0" width="' + w + '%"><tr><td style="background:#e8318a;height:6px;border-radius:3px;font-size:0;line-height:0">&nbsp;</td></tr></table>' +
            '</td>' +
          '</tr></table>' +
          '<div style="font-size:11px;color:#888;font-family:Arial,sans-serif;margin-top:5px">' + c.billable.toFixed(1) + 'h billable · ' + (c.hrs - c.billable).toFixed(1) + 'h non-billable</div>' +
        '</td>' +
        '<td style="padding:12px 0 12px 16px;font-size:14px;font-weight:700;color:#111;font-family:Arial,sans-serif;text-align:right;width:60px;vertical-align:top">' + c.hrs.toFixed(1) + 'h</td>' +
      '</tr>'
    );
  }).join('');

  var jobRows = d.jobs.slice(0, 5).map(function(j) {
    return (
      '<tr>' +
        '<td style="padding:10px 12px;font-size:11px;color:#111;font-family:Arial,sans-serif;font-weight:700;border-bottom:1px solid #eee;letter-spacing:0.03em">' + escapeHtml(j.jobNumber) + '</td>' +
        '<td style="padding:10px 12px;font-size:13px;color:#222;font-family:Arial,sans-serif;border-bottom:1px solid #eee">' + escapeHtml(j.jobName || '—') + '</td>' +
        '<td style="padding:10px 12px;font-size:11px;color:#888;font-family:Arial,sans-serif;border-bottom:1px solid #eee">' + escapeHtml(j.company) + '</td>' +
        '<td style="padding:10px 12px;font-size:13px;color:#111;font-family:Arial,sans-serif;font-weight:700;text-align:right;border-bottom:1px solid #eee">' + j.hrs.toFixed(1) + 'h</td>' +
      '</tr>'
    );
  }).join('');

  var maxDayHrs = d.days.reduce(function(m, x) { return Math.max(m, x.hrs); }, 1) || 1;
  var dayRows = d.days.map(function(day) {
    var w = day.hrs > 0 ? Math.max(4, Math.round((day.hrs / maxDayHrs) * 100)) : 0;
    var isWeekendEmpty = (day.dayName === 'Sat' || day.dayName === 'Sun') && day.hrs === 0;
    var labelColor = isWeekendEmpty ? '#bbb' : '#222';
    return (
      '<tr>' +
        '<td style="padding:7px 0;font-size:12px;color:' + labelColor + ';font-family:Arial,sans-serif;font-weight:700;width:44px;vertical-align:middle">' + day.dayName + '</td>' +
        '<td style="padding:7px 0;font-size:11px;color:#888;font-family:Arial,sans-serif;width:64px;vertical-align:middle">' + day.date + '</td>' +
        '<td style="padding:7px 0;vertical-align:middle">' +
          (day.hrs > 0
            ? '<table cellpadding="0" cellspacing="0" border="0" width="' + w + '%"><tr><td style="background:#e8318a;height:8px;border-radius:2px;font-size:0;line-height:0">&nbsp;</td></tr></table>'
            : '<div style="font-size:11px;color:#ccc;font-family:Arial,sans-serif">—</div>'
          ) +
        '</td>' +
        '<td style="padding:7px 0 7px 16px;font-size:12px;color:#111;font-family:Arial,sans-serif;font-weight:700;text-align:right;width:52px;vertical-align:middle">' + (day.hrs > 0 ? day.hrs.toFixed(1) + 'h' : '') + '</td>' +
      '</tr>'
    );
  }).join('');

  var utilCopy = targetHit
    ? '✓ You hit the ' + DIGEST_TARGET_UTILISATION + '% billable target this week.'
    : 'Below the ' + DIGEST_TARGET_UTILISATION + '% billable target — sitting at ' + d.billablePct + '%.';

  var intro = d.totalHrs === 0
    ? 'Looks like you didn\'t log any hours this week. If that\'s wrong, pop into the tracker and catch up.'
    : 'You logged <strong style="color:#111">' + d.totalHrs.toFixed(1) + ' hours</strong> across <strong style="color:#111">' + d.jobs.length + '</strong> job' + (d.jobs.length === 1 ? '' : 's') + ' this week.';

  return (
    '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Your week</title></head>' +
    '<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,sans-serif">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f4f4f4">' +
      '<tr><td align="center" style="padding:32px 12px">' +
        '<table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:#ffffff;border-radius:4px;overflow:hidden">' +

          // HERO
          '<tr><td style="background:#0a0a0a;padding:32px 32px 28px">' +
            '<div style="font-size:14px;color:#fff;margin-bottom:18px;letter-spacing:-0.01em">' +
              '<span style="font-family:\'Archivo Black\',Arial,sans-serif">mannmade</span>' +
              '<span style="color:#8a8a8a;font-size:10px;letter-spacing:0.2em;font-weight:700;margin-left:8px;text-transform:uppercase">· Time</span>' +
            '</div>' +
            '<div style="font-family:\'Archivo Black\',Arial,sans-serif;font-size:26px;color:#fff;letter-spacing:-0.01em;line-height:1.2">Your Week in Review</div>' +
            '<div style="font-size:13px;color:#8a8a8a;margin-top:6px;letter-spacing:0.04em">' + dateRange + '</div>' +
          '</td></tr>' +

          // GREETING
          '<tr><td style="padding:28px 32px 4px">' +
            '<div style="font-size:15px;color:#222;line-height:1.5">Hey ' + escapeHtml(firstName) + ',</div>' +
            '<div style="font-size:15px;color:#444;line-height:1.55;margin-top:10px">' + intro + '</div>' +
          '</td></tr>' +

          // STATS
          (d.totalHrs > 0 ?
          '<tr><td style="padding:20px 32px 0">' +
            '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +
              '<tr>' +
                statCell('Total',       d.totalHrs.toFixed(1) + 'h',       '#111') +
                statCellSpacer() +
                statCell('Billable',    d.billableHrs.toFixed(1) + 'h',    '#e8318a') +
                statCellSpacer() +
                statCell('Non-Bill',    d.nonBillableHrs.toFixed(1) + 'h', '#666') +
                statCellSpacer() +
                statCell('Utilisation', d.billablePct + '%',               utilColor) +
              '</tr>' +
            '</table>' +
            '<div style="font-size:12px;color:' + utilColor + ';font-weight:600;margin-top:14px">' + utilCopy + '</div>' +
          '</td></tr>' : '') +

          // BY CLIENT
          (d.clients.length ? sectionHeader('By Client') +
          '<tr><td style="padding:0 32px 8px">' +
            '<table cellpadding="0" cellspacing="0" border="0" width="100%">' + clientRows + '</table>' +
          '</td></tr>' : '') +

          // BY DAY
          (d.days.some(function(x){return x.hrs > 0;}) ? sectionHeader('By Day') +
          '<tr><td style="padding:0 32px 8px">' +
            '<table cellpadding="0" cellspacing="0" border="0" width="100%">' + dayRows + '</table>' +
          '</td></tr>' : '') +

          // TOP JOBS
          (jobRows ? sectionHeader('Top Jobs') +
          '<tr><td style="padding:0 32px 16px">' +
            '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border:1px solid #eee;border-radius:3px">' +
              '<tr style="background:#fafafa">' +
                '<th align="left" style="padding:9px 12px;font-size:10px;color:#888;font-family:Arial,sans-serif;letter-spacing:0.15em;text-transform:uppercase;border-bottom:1px solid #eee">Job</th>' +
                '<th align="left" style="padding:9px 12px;font-size:10px;color:#888;font-family:Arial,sans-serif;letter-spacing:0.15em;text-transform:uppercase;border-bottom:1px solid #eee">Name</th>' +
                '<th align="left" style="padding:9px 12px;font-size:10px;color:#888;font-family:Arial,sans-serif;letter-spacing:0.15em;text-transform:uppercase;border-bottom:1px solid #eee">Client</th>' +
                '<th align="right" style="padding:9px 12px;font-size:10px;color:#888;font-family:Arial,sans-serif;letter-spacing:0.15em;text-transform:uppercase;border-bottom:1px solid #eee">Hrs</th>' +
              '</tr>' +
              jobRows +
            '</table>' +
          '</td></tr>' : '') +

          // SIGN OFF
          '<tr><td style="padding:24px 32px 32px">' +
            '<div style="font-size:14px;color:#444;line-height:1.6">Thanks for keeping your time up to date. If anything here looks off, reply and let me know.</div>' +
            '<div style="font-size:14px;color:#222;margin-top:18px;line-height:1.5">— Shayne<br><span style="color:#888;font-size:12px">MANNMADE</span></div>' +
          '</td></tr>' +

          // FOOTER
          '<tr><td style="background:#fafafa;padding:14px 32px;border-top:1px solid #eee">' +
            '<div style="font-size:10px;color:#999;letter-spacing:0.15em;text-transform:uppercase;font-weight:700">MANNMADE · Time · Auto-digest</div>' +
          '</td></tr>' +

        '</table>' +
      '</td></tr>' +
    '</table>' +
    '</body></html>'
  );
}

function statCell(label, value, color) {
  return (
    '<td width="23%" style="background:#fafafa;border:1px solid #eee;border-radius:3px;padding:14px 12px;vertical-align:top">' +
      '<div style="font-size:10px;color:#888;letter-spacing:0.15em;text-transform:uppercase;font-weight:700;margin-bottom:8px">' + label + '</div>' +
      '<div style="font-family:\'Archivo Black\',Arial,sans-serif;font-size:22px;color:' + color + ';line-height:1;letter-spacing:-0.01em">' + value + '</div>' +
    '</td>'
  );
}

function statCellSpacer() {
  return '<td width="8" style="width:8px;font-size:0;line-height:0">&nbsp;</td>';
}

function sectionHeader(title) {
  return (
    '<tr><td style="padding:24px 32px 10px">' +
      '<div style="font-size:11px;color:#888;letter-spacing:0.2em;text-transform:uppercase;font-weight:700;border-bottom:1px solid #eee;padding-bottom:8px">' + title + '</div>' +
    '</td></tr>'
  );
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ============================================================
// JOB BUDGETS — booked hours per job + budget burn warnings
// ============================================================

// Sections of a MANNMADE budget spreadsheet that count as "time budget".
var BUDGET_SECTIONS = ['AGENCY', 'DESIGN', 'ANIMATION', 'POST PRODUCTION', 'VIDEO'];

// Reads the 'Job Budgets' sheet (creates/upgrades it if needed). Columns:
// Job Number | Job Name | Company | Budgeted Hours | Budget Sheet URL | Budget (R) | Last Synced
function getBudgetSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(BUDGET_SHEET_NAME);
  var headers = ['Job Number', 'Job Name', 'Company', 'Budgeted Hours', 'Budget Sheet URL', 'Budget (R)', 'Last Synced', 'Alert Level'];
  if (!sheet) {
    sheet = ss.insertSheet(BUDGET_SHEET_NAME);
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
    var widths = [120, 220, 160, 120, 320, 130, 160, 100];
    for (var i = 0; i < widths.length; i++) sheet.setColumnWidth(i + 1, widths[i]);
  }
  // Upgrade older sheets that only had 4 columns
  var existing = String(sheet.getRange(1, 5).getValue() || '').trim();
  if (existing.toLowerCase().indexOf('budget sheet url') !== 0) {
    sheet.getRange(1, 5, 1, 3).setValues([['Budget Sheet URL', 'Budget (R)', 'Last Synced']]);
  }
  var alertHdr = String(sheet.getRange(1, 8).getValue() || '').trim();
  if (alertHdr.toLowerCase().indexOf('alert') !== 0) {
    sheet.getRange(1, 8).setValue('Alert Level');
    sheet.setColumnWidth(8, 100);
  }
  sheet.getRange(1, 1, 1, headers.length)
    .setFontWeight('bold').setBackground('#0a0a0a').setFontColor('#f5c400').setFontFamily('Courier New');
  return sheet;
}

function loadJobBudgets() {
  var sheet = getBudgetSheet_();
  var last = sheet.getLastRow();
  if (last < 2) return {};
  var data = sheet.getRange(2, 1, last - 1, 6).getValues();
  var map = {};
  data.forEach(function(r) {
    var num        = String(r[0] || '').trim();
    var budgetHrs  = parseFloat(r[3]) || 0;
    var budgetRand = parseRand_(r[5]);
    if (num && (budgetHrs > 0 || budgetRand > 0)) {
      map[num] = {
        budget:     budgetHrs,
        budgetRand: budgetRand,
        jobName:    String(r[1] || '').trim(),
        company:    String(r[2] || '').trim()
      };
    }
  });
  return map;
}

// Parses 'R1,611,500.78', '1611500.78' or a number into a number.
function parseRand_(v) {
  if (typeof v === 'number') return v;
  var s = String(v == null ? '' : v).replace(/[^0-9.\-]/g, '');
  var n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function fmtRand_(n) {
  var neg = n < 0 ? '-' : '';
  var s = Math.round(Math.abs(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return neg + 'R' + s;
}

// ── MANN MADE RATE CARD (hourly = day rate ÷ 6) ────────────────
// Used when the People sheet has a ROLE NAME instead of a number.
var ROLE_RATES = {
  'client service director': 1260.00,
  'senior accounts manager': 961.40,
  'senior account manager': 961.40,
  'junior accounts manager': 600.00,
  'junior account manager': 600.00,
  'account manager': 961.40,
  'traffic manager': 630.92,
  'resource coordination': 630.92,
  'senior strategic director': 1640.39,
  'senior researcher': 757.10,
  'junior researcher': 543.40,
  'executive creative director': 1640.39,
  'creative director': 1261.84,
  'creative producer': 691.27,
  'video director': 1640.39,
  'assistant director': 1149.50,
  'senior copywriter': 1300.00,
  'junior copywriter': 522.50,
  'copywriter': 1300.00,
  'art director': 954.61,
  'senior designer': 954.61,
  'junior designer': 600.88,
  'designer': 954.61,
  'desktop publisher': 630.92,
  'storyboard artist': 570.57,
  'illustrator': 630.92,
  'ai designer': 650.00,
  'website developer': 1550.00,
  'developer': 1550.00,
  'animation director': 1388.02,
  'visual effects supervisor': 1442.10,
  'project manager': 961.40,
  'senior animator': 943.64,
  'animator': 691.27,
  'compositor': 822.94,
  '2d designer': 822.94,
  '3d designer': 943.64,
  'motion graphics designer': 757.10,
  'character design': 943.64,
  'rigging': 943.64,
  'post production manager': 470.25,
  'editor': 708.33,
  'assistant editor': 416.67,
  'data wrangler': 418.00,
  'sound engineer': 900.00,
  'event photographer': 1009.47,
  'specialist photographer': 1623.93,
  'photographer': 1009.47,
  'event senior project manager': 943.64,
  'event production manager': 691.27,
  'event project manager': 691.27,
  'production manager': 691.27,
  'production assistant': 504.74,
  'logistics manager': 1075.31,
  'logistics assistant': 504.74,
  'content manager': 691.27,
  'choreographer': 822.94,
  'lighting director': 768.08,
  'live director': 768.08,
  'show caller': 1206.98,
  'show producer': 822.94,
  'producer': 822.94,
  'stage manager': 766.67,
  'assistant stage manager': 438.90,
  'site manager': 691.27,
  'technical director': 822.94
};

// Turn whatever sits in the rate/role cell into an hourly rate.
// Accepts a number ('961.40', 'R961.40') or a role name ('Senior Designer').
function resolveRate_(value) {
  var raw = String(value == null ? '' : value).trim();
  if (!raw) return 0;
  // Numeric? (allow 'R' and thousands separators)
  if (/^[Rr]?\s*[\d.,\s]+$/.test(raw)) {
    var n = parseRand_(raw);
    if (n > 0) return n;
  }
  var key = raw.toLowerCase().replace(/\s+/g, ' ');
  if (ROLE_RATES[key]) return ROLE_RATES[key];
  // Fuzzy: exact word containment, longest key first so 'senior designer'
  // wins over 'designer'
  var keys = Object.keys(ROLE_RATES).sort(function(a, b) { return b.length - a.length; });
  for (var i = 0; i < keys.length; i++) {
    if (key.indexOf(keys[i]) !== -1) return ROLE_RATES[keys[i]];
  }
  return 0;
}

// Per-person hourly rates from the People sheet (column 3: number OR role name).
function loadPeopleRates() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(PEOPLE_SHEET_NAME);
  if (!sheet) { loadPeopleDirectory(); sheet = ss.getSheetByName(PEOPLE_SHEET_NAME); }
  var header = String(sheet.getRange(1, 3).getValue() || '').trim();
  if (!header) {
    sheet.getRange(1, 3).setValue('Rate or Role')
      .setFontWeight('bold').setBackground('#0a0a0a').setFontColor('#e8318a').setFontFamily('Courier New');
    sheet.setColumnWidth(3, 180);
  }
  var last = sheet.getLastRow();
  if (last < 2) return {};
  var lastCol = Math.max(sheet.getLastColumn(), 3);
  var data = sheet.getRange(2, 1, last - 1, lastCol).getValues();
  var map = {};
  data.forEach(function(r) {
    var name = String(r[0] || '').trim();
    if (!name) return;
    // Try column 3 first, then any later column that resolves (in case the
    // role was typed in its own column)
    var rate = resolveRate_(r[2]);
    for (var c = 3; c < r.length && rate === 0; c++) rate = resolveRate_(r[c]);
    map[name] = rate;
  });
  return map;
}

// Run from the Apps Script editor to see how every person's rate resolved.
function checkPeopleRates() {
  var people = loadPeopleDirectory();
  var rates  = loadPeopleRates();
  var lines = [], missing = [];
  Object.keys(people).sort().forEach(function(name) {
    var r = rates[name] || 0;
    if (r > 0) lines.push(name + ' → R' + r.toFixed(2) + '/hr');
    else missing.push(name);
  });
  var out = 'RESOLVED RATES:\n' + (lines.join('\n') || '(none)') +
            '\n\nNO RATE FOUND (will count as R0):\n' + (missing.join('\n') || '(none)');
  Logger.log(out);
  return out;
}

// Total tracked hours AND spend (hrs × person rate) per job, all time.
function getAllTimeJobTotals() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return {};
  var rates = loadPeopleRates();
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 9).getValues();
  var map = {};
  data.forEach(function(row) {
    var num    = String(row[2] || '').trim();
    var person = String(row[1] || '').trim();
    var hrs    = parseFloat(row[8]) || 0;
    if (!num) return;
    if (!map[num]) map[num] = { hrs: 0, spend: 0 };
    map[num].hrs   += hrs;
    map[num].spend += hrs * (rates[person] || 0);
  });
  return map;
}

// Kept for compatibility — hours only.
function getAllTimeJobHours() {
  var totals = getAllTimeJobTotals();
  var map = {};
  Object.keys(totals).forEach(function(k) { map[k] = totals[k].hrs; });
  return map;
}

// Booked vs tracked for every job with a budget — used by the dashboard.
// Rand budgets take priority; hours budgets still work as a fallback.
function getBudgetStatus() {
  var budgets = loadJobBudgets();
  var totals  = getAllTimeJobTotals();
  var out = [];
  Object.keys(budgets).forEach(function(num) {
    var b = budgets[num];
    var t = totals[num] || { hrs: 0, spend: 0 };
    var entry = {
      jobNumber: num,
      jobName:   b.jobName,
      company:   b.company
    };
    if (b.budgetRand > 0) {
      entry.mode        = 'rand';
      entry.pct         = Math.round((t.spend / b.budgetRand) * 100);
      entry.trackedDisp = fmtRand_(t.spend) + ' (' + (Math.round(t.hrs * 10) / 10) + 'h)';
      entry.budgetDisp  = fmtRand_(b.budgetRand);
    } else {
      entry.mode        = 'hours';
      entry.pct         = Math.round((t.hrs / b.budget) * 100);
      entry.trackedDisp = (Math.round(t.hrs * 100) / 100) + 'h';
      entry.budgetDisp  = b.budget + 'h';
    }
    out.push(entry);
  });
  out.sort(function(a, b) { return b.pct - a.pct; });
  return out;
}

// Short warning string shown as a toast right after logging time.
function getBudgetWarning(jobNumber) {
  try {
    var num = String(jobNumber || '').trim();
    var b = loadJobBudgets()[num];
    if (!b) return '';
    var t = getAllTimeJobTotals()[num] || { hrs: 0, spend: 0 };
    var pct = b.budgetRand > 0
      ? Math.round((t.spend / b.budgetRand) * 100)
      : Math.round((t.hrs / b.budget) * 100);
    if (pct >= 100) return '⚠ ' + num + ' IS OVER BUDGET — ' + pct + '% USED';
    if (pct >= BUDGET_WARN_PCT) return '⚠ ' + num + ' AT ' + pct + '% OF BUDGET';
    return '';
  } catch(e) {
    return '';
  }
}

// Internal job numbers that never have budgets — skipped by auto-populate.
var BUDGET_EXCLUDE_JOBS = ['MM01000', 'MM01001', 'MM01002', 'MM01003', 'MM01004', 'MM01005'];

// A job only counts as CURRENT (and gets auto-added) if someone logged time
// to it within this many days.
var BUDGET_CURRENT_DAYS = 30;

// Adds a row to Job Budgets for every CURRENT job (time logged in the last
// BUDGET_CURRENT_DAYS days) that isn't listed yet, skipping internal jobs.
function autoPopulateJobBudgets_(sheet) {
  // Jobs already listed
  var existing = {};
  var last = sheet.getLastRow();
  if (last >= 2) {
    sheet.getRange(2, 1, last - 1, 1).getValues().forEach(function(r) {
      var n = String(r[0] || '').trim();
      if (n) existing[n] = true;
    });
  }

  // Jobs with time logged in the recent window (num → name/company)
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var log = ss.getSheetByName(SHEET_NAME);
  if (!log || log.getLastRow() < 2) return 0;
  var cutoff = new Date(Date.now() - BUDGET_CURRENT_DAYS * 24 * 60 * 60 * 1000);
  var rows = log.getRange(2, 1, log.getLastRow() - 1, 5).getValues();
  var jobs = {};
  rows.forEach(function(r) {
    if (!r[0]) return;
    var d = r[0] instanceof Date ? r[0] : new Date(String(r[0]));
    if (isNaN(d.getTime()) || d < cutoff) return;
    var num = String(r[2] || '').trim();
    if (!num || jobs[num]) return;
    jobs[num] = { name: String(r[3] || '').trim(), company: String(r[4] || '').trim() };
  });

  var added = 0;
  Object.keys(jobs).sort().forEach(function(num) {
    if (existing[num]) return;
    if (BUDGET_EXCLUDE_JOBS.indexOf(num) !== -1) return;
    sheet.appendRow([num, jobs[num].name, jobs[num].company, '', '', '', 'new — looking for budget file…']);
    added++;
  });
  return added;
}

// Searches Drive for a job's budget spreadsheet by job number.
// Scores candidates ('budget'/'approved'/'cost' in the name, then newest),
// then OPENS the top few and keeps the first one that actually contains the
// AGENCY cost sections — so files like 'MM02755 | Liberty - Challenge 2026 V3'
// are found even without 'budget' in the name.
function findBudgetFileUrl_(jobNumber) {
  try {
    // Uses the full Drive API so SHARED DRIVES are searched too —
    // the basic DriveApp search only looks in My Drive.
    var resp = Drive.Files.list({
      q: "name contains '" + jobNumber + "' and trashed = false and mimeType = 'application/vnd.google-apps.spreadsheet'",
      corpora: 'allDrives',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      fields: 'files(id,name,modifiedTime)',
      pageSize: 50
    });
    var files = (resp && resp.files) || [];
    var candidates = [];
    files.forEach(function(f) {
      var name = String(f.name || '').toUpperCase();
      var score = 0;
      if (name.indexOf('BUDGET') !== -1)   score += 4;
      if (name.indexOf('APPROVED') !== -1) score += 3;
      if (name.indexOf('COST') !== -1)     score += 2;
      score += new Date(f.modifiedTime).getTime() / 1e13; // newer wins ties (V3 over V2)
      candidates.push({ url: 'https://docs.google.com/spreadsheets/d/' + f.id + '/edit', score: score });
    });
    candidates.sort(function(a, b) { return b.score - a.score; });
    for (var i = 0; i < Math.min(candidates.length, 4); i++) {
      try {
        if (readBudgetTotalFromFile_(candidates[i].url) > 0) return candidates[i].url;
      } catch(e) {}
    }
    return '';
  } catch(e) {
    Logger.log('findBudgetFileUrl_ error for ' + jobNumber + ': ' + e);
    return '';
  }
}

// Run this from the editor to test the finder on one job and see the result.
function testFindJetourBudget() {
  var url = findBudgetFileUrl_('MM02794');
  Logger.log(url ? 'FOUND: ' + url : 'NOT FOUND');
  return url || 'NOT FOUND';
}

// ============================================================
// CALENDAR BACK-IMPORT — pull past meetings into the Time Log
//
// Add a profile below, then run its preview/import pair from the function
// dropdown. Preview writes nothing; import appends to the Time Log.
//
//   person   — the name written into the Time Log. Must match that person's
//              People sheet name, or the entries will not show in their My Logs.
//   calendar — '' reads the calendar of whoever runs the import. An email reads
//              that person's calendar instead, which only works if it is
//              visible to the account running it.
//   keywords — event titles containing ANY of these are imported.
//   from     — only look at events on or after this date.
//
// Imported entries are matched against what is already logged for that person
// and job, so running a profile twice does not duplicate anything.
// ============================================================

var IMPORT_PROFILES = {
  shayneLiberty: {
    person:   'shayne mann',
    calendar: '',                      // Shayne runs this against his own diary
    keywords: ['liberty', 'challenge'],
    job:      { number: 'MM02755', name: 'Liberty - Challenge 2026', company: 'Liberty' },
    from:     '2026-04-27'
  },
  ayshaLiberty: {
    person:   'Aysha Outram',
    calendar: 'aysha@mannmade.co.za',  // read from Shayne's account
    keywords: ['liberty', 'challenge'],
    job:      { number: 'MM02755', name: 'Liberty - Challenge 2026', company: 'Liberty' },
    from:     '2026-07-01'             // nothing Liberty in her diary before this
  }
};

// "challenge" is in the keyword lists because most Liberty meetings are titled
// "Challenge 2026" and never mention Liberty — on 2026-09-09 that was 22
// meetings and 24.5 hours the narrower keyword could not see. Always preview
// first: a broad keyword can also pull in work belonging to another job.

function importProfile_(name) {
  var cfg = IMPORT_PROFILES[name];
  if (!cfg) throw new Error('No import profile called "' + name + '".');
  return cfg;
}

function logAndReturn_(msg) { Logger.log(msg); return msg; }

// ── Run these by hand from the editor's function dropdown ─────
function previewCalendarImport() { return logAndReturn_(buildCalendarImport_(importProfile_('shayneLiberty')).summary); }
function importCalendarMeetings() { return logAndReturn_(runCalendarImport_(importProfile_('shayneLiberty'))); }

function previewAyshaLiberty()    { return logAndReturn_(buildCalendarImport_(importProfile_('ayshaLiberty')).summary); }
function importAyshaLiberty()     { return logAndReturn_(runCalendarImport_(importProfile_('ayshaLiberty'))); }

// Writes the planned entries to the Time Log. Appends directly rather than
// going through logTime, because logTime files time under whoever is signed in
// and this deliberately files it under cfg.person.
function runCalendarImport_(cfg) {
  var plan = buildCalendarImport_(cfg);
  if (!plan.entries.length) return 'Nothing to import. ' + plan.summary;

  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  ensureEntryIdColumn(sheet);
  var tz = Session.getScriptTimeZone();

  var rows = plan.entries.map(function(ev) {
    return [
      Utilities.formatDate(ev.start, tz, 'yyyy-MM-dd'),
      cfg.person,
      cfg.job.number,
      cfg.job.name,
      cfg.job.company,
      ev.title,
      Utilities.formatDate(ev.start, tz, 'HH:mm:ss'),
      Utilities.formatDate(ev.end,   tz, 'HH:mm:ss'),
      ev.hrs,
      'Yes',
      '[calendar import]',
      makeEntryId()
    ];
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 12).setValues(rows);

  var total = plan.entries.reduce(function(s, e) { return s + e.hrs; }, 0);
  return 'Imported ' + rows.length + ' meetings (' + total.toFixed(2) + 'h) into ' +
         cfg.job.number + ' as ' + cfg.person + '. ' + plan.skippedNote;
}

function buildCalendarImport_(cfg) {
  var whose = cfg.calendar || Session.getEffectiveUser().getEmail();
  var cal = cfg.calendar
    ? CalendarApp.getCalendarById(cfg.calendar)
    : CalendarApp.getDefaultCalendar();
  if (!cal) {
    throw new Error('Cannot open the calendar for ' + whose + '. Ask them to share it with ' +
                    Session.getEffectiveUser().getEmail() + ', including event details.');
  }

  var from = new Date(cfg.from + 'T00:00:00');
  var now  = new Date();
  var events = cal.getEvents(from, now);
  var tz = Session.getScriptTimeZone();

  // True if an event title mentions any of this profile's keywords.
  function titleMatches_(title) {
    var t = String(title || '').toLowerCase();
    for (var i = 0; i < cfg.keywords.length; i++) {
      if (t.indexOf(String(cfg.keywords[i]).toLowerCase()) !== -1) return true;
    }
    return false;
  }

  // Someone who declined did not attend, so it is not their time. Note this
  // asks for THIS profile's person, not whoever is running the import. Wrapped
  // because getGuestByEmail throws on some event types; on doubt we keep it.
  function declined_(ev) {
    try {
      var g = ev.getGuestByEmail(whose);
      return !!g && g.getGuestStatus() === CalendarApp.GuestStatus.NO;
    } catch (err) {
      return false;
    }
  }

  // Existing Time Log entries for this person+job → skip already-logged slots
  var logged = {};
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (sheet && sheet.getLastRow() >= 2) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 7).getValues().forEach(function(r) {
      if (String(r[1] || '').trim().toLowerCase() !== cfg.person.toLowerCase()) return;
      if (String(r[2] || '').trim() !== cfg.job.number) return;
      var date = r[0] instanceof Date ? Utilities.formatDate(r[0], tz, 'yyyy-MM-dd') : String(r[0]).substring(0, 10);
      // Start Time is stored as a real time value, so this cell comes back as a
      // Date, not text. It used to be read with String(r[6]).substring(0,5),
      // which yields "Sat D" — never matching an "HH:mm" key, so nothing was
      // ever skipped and every run re-imported what was already there. That is
      // where the duplicated Liberty hours came from.
      var st = r[6] instanceof Date
        ? Utilities.formatDate(r[6], tz, 'HH:mm')
        : String(r[6] || '').substring(0, 5);
      logged[date + ' ' + st] = true;
    });
  }

  var seen = {}, entries = [], skippedDup = 0, skippedLogged = 0, skippedDeclined = 0;
  events.forEach(function(ev) {
    if (ev.isAllDayEvent()) return;
    var title = ev.getTitle() || '';
    if (!titleMatches_(title)) return;
    var start = ev.getStartTime(), end = ev.getEndTime();
    if (end > now) return; // only the past
    if (declined_(ev)) { skippedDeclined++; return; }
    var key = Utilities.formatDate(start, tz, 'yyyy-MM-dd HH:mm');
    if (seen[key]) { skippedDup++; return; }        // same-slot duplicates
    seen[key] = true;
    if (logged[key]) { skippedLogged++; return; }   // already in the Time Log
    var hrs = Math.round(((end - start) / 3600000) * 100) / 100;
    if (hrs <= 0) return;
    entries.push({ start: start, end: end, hrs: hrs, title: title });
  });

  entries.sort(function(a, b) { return a.start - b.start; });
  var total = entries.reduce(function(s, e) { return s + e.hrs; }, 0);
  var lines = entries.map(function(e) {
    return Utilities.formatDate(e.start, tz, 'EEE d MMM HH:mm') + ' · ' + e.hrs.toFixed(2) + 'h · ' + e.title;
  });
  var skippedNote = '(skipped: ' + skippedDup + ' duplicate slot(s), ' + skippedLogged +
                    ' already logged, ' + skippedDeclined + ' declined)';
  return {
    entries: entries,
    skippedNote: skippedNote,
    summary: 'Will import ' + entries.length + ' meetings, ' + total.toFixed(2) + 'h total, into ' +
             cfg.job.number + ' as ' + cfg.person + ' ' + skippedNote + ':\n' + lines.join('\n')
  };
}

// ── BUDGET SYNC — auto-populates jobs, finds budget files, pulls totals ──
// 1. Adds any job with logged time to the Job Budgets sheet.
// 2. For rows without a Budget Sheet URL, searches Drive by job number.
// 3. Opens each linked file, finds the tab with a 'Cost - Rands' column and
//    adds up AGENCY, DESIGN, ANIMATION, POST PRODUCTION and VIDEO.
// A manually typed Budget (R) or pasted URL always wins — the sync never
// overwrites a URL you entered yourself.
function syncJobBudgets(key) {
  requireHod_(key);
  return runBudgetSync_(false); // gap-fill only; daily trigger refreshes all
}

// Google caps script runs at ~6 minutes, so each sync run does at most this
// many slow operations (Drive searches / file opens). Click Sync again (or
// wait for the next daily run) to continue where it left off.
var SYNC_MAX_FILE_OPS = 30;

function runBudgetSync_(refreshAll) {
  var sheet = getBudgetSheet_();
  var added = autoPopulateJobBudgets_(sheet);
  var last = sheet.getLastRow();
  if (last < 2) return 'No jobs to sync yet.';
  var data = sheet.getRange(2, 1, last - 1, 7).getValues();
  var tz = Session.getScriptTimeZone();
  var stamp = Utilities.formatDate(new Date(), tz, 'd MMM HH:mm');
  var synced = 0, failed = 0, manual = 0, skipped = 0, remaining = 0;
  var ops = 0;

  for (var i = 0; i < data.length; i++) {
    var row = i + 2;
    var num = String(data[i][0] || '').trim();
    if (!num) continue;
    var url = String(data[i][4] || '').trim();
    var hasBudget = parseRand_(data[i][5]) > 0;

    // Manual clicks only fill gaps (fast); the daily run refreshes everything.
    if (!refreshAll && url && hasBudget) { skipped++; continue; }

    if (ops >= SYNC_MAX_FILE_OPS) { remaining++; continue; }

    // Try to auto-find a budget file for rows without a URL
    if (!url) {
      ops++;
      url = findBudgetFileUrl_(num);
      if (url) sheet.getRange(row, 5).setValue(url);
    }

    if (!url) {
      // No file found — a hand-typed Budget (R) still works fine
      if (hasBudget) { manual++; sheet.getRange(row, 7).setValue('manual amount (' + stamp + ')'); }
      else sheet.getRange(row, 7).setValue('✗ no budget file found — paste URL or type Budget (R) (' + stamp + ')');
      continue;
    }

    try {
      ops++;
      var total = readBudgetTotalFromFile_(url);
      if (total > 0) {
        sheet.getRange(row, 6).setValue(total);
        sheet.getRange(row, 7).setValue('✓ ' + stamp);
        synced++;
      } else {
        sheet.getRange(row, 7).setValue('✗ could not find AGENCY sections (' + stamp + ')');
        failed++;
      }
    } catch(e) {
      sheet.getRange(row, 7).setValue('✗ ' + String(e).substring(0, 80) + ' (' + stamp + ')');
      failed++;
    }
  }
  var alerted = checkBudgetAlerts_(sheet);
  return 'Sync: ' + added + ' added, ' + synced + ' synced, ' + manual + ' manual, ' + failed + ' not found' +
         (skipped ? ', ' + skipped + ' up to date' : '') +
         (alerted ? ', ' + alerted + ' alert(s) emailed' : '') +
         (remaining ? '. ' + remaining + ' still to do — click Sync again' : '.');
}

// ── BUDGET ALERTS — email when a job crosses into a new burn band ──────
// Bands: 80%, 90%, 100%, 110%, … Each job's last-alerted band is stored in
// the 'Alert Level' column so you only get ONE email per band, not one per day.
function alertBand_(pct) {
  if (pct < BUDGET_WARN_PCT) return 0;
  return Math.floor(pct / 10) * 10;
}

function checkBudgetAlerts_(sheet) {
  var status = getBudgetStatus();
  if (!status.length) return 0;
  var byJob = {};
  status.forEach(function(b) { byJob[b.jobNumber] = b; });

  var last = sheet.getLastRow();
  if (last < 2) return 0;
  var data = sheet.getRange(2, 1, last - 1, 8).getValues();
  var newAlerts = [];

  for (var i = 0; i < data.length; i++) {
    var num = String(data[i][0] || '').trim();
    var b = byJob[num];
    if (!b) continue;
    var band = alertBand_(b.pct);
    var prevBand = parseInt(data[i][7], 10) || 0;
    if (band > prevBand) {
      newAlerts.push(b);
      sheet.getRange(i + 2, 8).setValue(band);
    }
  }

  if (newAlerts.length) sendBudgetAlertEmail_(newAlerts);
  return newAlerts.length;
}

function sendBudgetAlertEmail_(jobs) {
  var rows = jobs.map(function(b) {
    var col = b.pct >= 100 ? '#f04e23' : '#b8860b';
    var note = b.pct >= 100
      ? 'OVER BUDGET — time to talk to the client about additional scope.'
      : 'Heading for the limit — consider raising it with the client now, before it\'s used up.';
    return (
      '<tr>' +
        '<td style="padding:12px 14px;border-bottom:1px solid #eee;font-family:Arial,sans-serif">' +
          '<div style="font-size:13px;font-weight:700;color:#111">' + escapeHtml(b.jobNumber) + (b.jobName ? ' — ' + escapeHtml(b.jobName) : '') + '</div>' +
          '<div style="font-size:11px;color:#888;margin-top:2px">' + escapeHtml(b.company || '') + '</div>' +
          '<div style="font-size:12px;color:#444;margin-top:6px">' + b.trackedDisp + ' tracked of ' + b.budgetDisp + ' budget</div>' +
          '<div style="font-size:11px;color:' + col + ';font-weight:700;margin-top:4px">' + note + '</div>' +
        '</td>' +
        '<td style="padding:12px 14px;border-bottom:1px solid #eee;text-align:right;vertical-align:top">' +
          '<span style="font-family:Arial,sans-serif;font-size:20px;font-weight:800;color:' + col + '">' + b.pct + '%</span>' +
        '</td>' +
      '</tr>'
    );
  }).join('');

  var url = WEB_APP_URL;

  var html =
    '<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,sans-serif">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f4f4f4"><tr><td align="center" style="padding:32px 12px">' +
      '<table cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#ffffff;border-radius:4px;overflow:hidden">' +
        '<tr><td style="background:#0a0a0a;padding:26px 28px">' +
          '<div style="font-size:14px;color:#fff;margin-bottom:14px"><span style="font-family:\'Archivo Black\',Arial,sans-serif">mannmade</span><span style="color:#8a8a8a;font-size:10px;letter-spacing:0.2em;font-weight:700;margin-left:8px;text-transform:uppercase">· Time</span></div>' +
          '<div style="font-family:\'Archivo Black\',Arial,sans-serif;font-size:22px;color:#fff;line-height:1.25">⚠ Budget alert — ' + jobs.length + ' job' + (jobs.length === 1 ? '' : 's') + '</div>' +
        '</td></tr>' +
        '<tr><td style="padding:8px 14px 4px"><table cellpadding="0" cellspacing="0" border="0" width="100%">' + rows + '</table></td></tr>' +
        (url ? '<tr><td style="padding:18px 28px 28px"><a href="' + url + '" style="display:inline-block;background:#e8318a;color:#ffffff;font-size:12px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;text-decoration:none;padding:13px 24px;border-radius:3px">Open the dashboard</a></td></tr>' : '') +
        '<tr><td style="background:#fafafa;padding:12px 28px;border-top:1px solid #eee"><div style="font-size:10px;color:#999;letter-spacing:0.15em;text-transform:uppercase;font-weight:700">MANNMADE · Time · Auto budget alert</div></td></tr>' +
      '</table>' +
    '</td></tr></table></body></html>';

  MailApp.sendEmail({
    to: DIGEST_ADMIN_EMAIL,
    subject: '⚠ Budget alert: ' + jobs.map(function(b) { return b.jobNumber + ' at ' + b.pct + '%'; }).join(', '),
    htmlBody: html,
    name: DIGEST_SENDER_NAME
  });
}

function readBudgetTotalFromFile_(url) {
  var file = SpreadsheetApp.openByUrl(url);
  var sheets = file.getSheets();

  for (var s = 0; s < sheets.length; s++) {
    var sh = sheets[s];
    var lastRow = Math.min(sh.getLastRow(), 120);
    var lastCol = Math.min(sh.getLastColumn(), 20);
    if (lastRow < 2 || lastCol < 2) continue;
    var vals = sh.getRange(1, 1, lastRow, lastCol).getDisplayValues();

    // Find the 'Cost - Rands' column
    var costCol = -1, headerRow = -1;
    for (var r = 0; r < vals.length && costCol === -1; r++) {
      for (var c = 0; c < vals[r].length; c++) {
        if (String(vals[r][c]).toLowerCase().indexOf('cost - rand') !== -1) {
          costCol = c; headerRow = r; break;
        }
      }
    }
    if (costCol === -1) continue;

    // Sum the time-based section rows below the header
    var total = 0, found = 0;
    for (var r2 = headerRow + 1; r2 < vals.length; r2++) {
      var label = '';
      for (var c2 = 0; c2 < Math.min(4, vals[r2].length); c2++) {
        if (String(vals[r2][c2]).trim()) { label = String(vals[r2][c2]).trim().toUpperCase(); break; }
      }
      if (!label) continue;
      if (label.indexOf('TOTAL') !== -1) break; // stop at SUB TOTAL / TOTAL rows
      var isSection = false;
      for (var b = 0; b < BUDGET_SECTIONS.length; b++) {
        if (label === BUDGET_SECTIONS[b] || label.indexOf(BUDGET_SECTIONS[b] + ' ') === 0) { isSection = true; break; }
      }
      // Exclude hard-cost PRODUCTION rows (but keep POST PRODUCTION)
      if (!isSection) continue;
      var amount = parseRand_(vals[r2][costCol]);
      if (amount > 0) { total += amount; found++; }
    }
    if (found > 0) return Math.round(total * 100) / 100;
  }
  return 0;
}

// Optional: run once to auto-sync budgets every morning at 06:00.
function installBudgetSyncTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'syncJobBudgetsAuto') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncJobBudgetsAuto')
    .timeBased().everyDays(1).atHour(6)
    .inTimezone(Session.getScriptTimeZone()).create();
  return 'Installed. Budgets will re-sync daily around 06:00.';
}

// Trigger wrapper — runs as you, so no HOD check needed.
function syncJobBudgetsAuto() {
  try {
    Logger.log(runBudgetSync_(true));
  } catch(e) {
    Logger.log('syncJobBudgetsAuto error: ' + e);
  }
}

// ============================================================
// SETTINGS + MONTH-END LOCK
// ============================================================

function getSettingsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SETTINGS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SETTINGS_SHEET_NAME);
    sheet.appendRow(['Setting', 'Value']);
    sheet.appendRow(['Lock entries before (yyyy-mm-dd)', '']);
    var hr = sheet.getRange(1, 1, 1, 2);
    hr.setFontWeight('bold').setBackground('#0a0a0a').setFontColor('#1a6ef5').setFontFamily('Courier New');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 280);
    sheet.setColumnWidth(2, 160);
  }
  return sheet;
}

// Returns the lock date (entries before this date are rejected), or null.
function getLockDate() {
  try {
    var sheet = getSettingsSheet_();
    var last = sheet.getLastRow();
    if (last < 2) return null;
    var data = sheet.getRange(2, 1, last - 1, 2).getValues();
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][0]).toLowerCase().indexOf('lock entries before') === 0) {
        var v = data[i][1];
        if (!v) return null;
        var d = v instanceof Date ? new Date(v) : new Date(String(v) + 'T00:00:00');
        if (isNaN(d.getTime())) return null;
        d.setHours(0, 0, 0, 0);
        return d;
      }
    }
    return null;
  } catch(e) {
    return null;
  }
}

// Shared lock check. Returns an error object if the datetime falls in a locked
// period, or null if it's fine.
function checkLock_(dateTimeStr) {
  var lockDate = getLockDate();
  if (!lockDate) return null;
  var d = new Date(dateTimeStr);
  if (isNaN(d.getTime())) return null;
  if (d < lockDate) {
    var tz = Session.getScriptTimeZone();
    return {
      success: false,
      error: 'LOCKED — TIME BEFORE ' + Utilities.formatDate(lockDate, tz, 'd MMM yyyy').toUpperCase() + ' IS CLOSED'
    };
  }
  return null;
}

// Run from the Apps Script editor at month end to close the previous month.
function lockPreviousMonth() {
  var sheet = getSettingsSheet_();
  var now = new Date();
  var firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  var tz = Session.getScriptTimeZone();
  var val = Utilities.formatDate(firstOfMonth, tz, 'yyyy-MM-dd');
  var last = sheet.getLastRow();
  var data = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][0]).toLowerCase().indexOf('lock entries before') === 0) {
      sheet.getRange(i + 2, 2).setValue(val);
      return 'Locked. Entries before ' + val + ' can no longer be added or edited.';
    }
  }
  sheet.appendRow(['Lock entries before (yyyy-mm-dd)', val]);
  return 'Locked. Entries before ' + val + ' can no longer be added or edited.';
}

// ============================================================
// CALENDAR AUTO-POPULATE
// Each person's email comes from the People sheet. Their calendar
// must be shared with the account that runs this script.
// ============================================================

function getCalendarEvents(person, dateStr) {
  requireAccess_();
  try {
    // `person` is ignored. This used to take the name straight from the browser,
    // and because the web app runs as USER_DEPLOYING, CalendarApp used the
    // deploying user's permissions — so any signed-in member of staff could
    // read the titles and times of any calendar that account could see,
    // including its own. You now only ever get your own calendar.
    person = requirePerson_();

    var people = loadPeopleDirectory();
    var email  = String(people[person] || '').trim();
    var me     = Session.getEffectiveUser().getEmail();

    if (!email) {
      return { success: false, error: 'No email found for "' + person + '". Add it to the People sheet first.' };
    }

    var cal = null;
    if (email.toLowerCase() === me.toLowerCase()) {
      cal = CalendarApp.getDefaultCalendar();
    } else {
      cal = CalendarApp.getCalendarById(email);
    }
    if (!cal) {
      return { success: false, error: 'Cannot see the calendar for ' + email + '. Ask them to share their Google Calendar (with event details) with ' + me + '.' };
    }

    var dayStart = new Date(dateStr + 'T00:00:00');
    var dayEnd   = new Date(dateStr + 'T23:59:59');
    var tz       = Session.getScriptTimeZone();
    var events   = cal.getEvents(dayStart, dayEnd);

    var out = [];
    events.forEach(function(ev) {
      if (ev.isAllDayEvent()) return;
      out.push({
        title: ev.getTitle() || '(no title)',
        start: Utilities.formatDate(ev.getStartTime(), tz, 'HH:mm'),
        end:   Utilities.formatDate(ev.getEndTime(),   tz, 'HH:mm')
      });
    });
    out.sort(function(a, b) { return a.start.localeCompare(b.start); });
    return { success: true, events: out };

  } catch(e) {
    return { success: false, error: 'Calendar error: ' + e.toString() };
  }
}

// ============================================================
// DAILY TIMESHEET REMINDERS — weekdays ~16:00
// Emails anyone in the People sheet who logged less than
// REMINDER_MIN_HOURS today.
// ============================================================

// Run ONCE from the Apps Script editor to schedule daily reminders.
function installDailyReminderTrigger() {
  removeDailyReminderTriggers();
  ScriptApp.newTrigger('sendTimesheetReminders')
    .timeBased()
    .everyDays(1)
    .atHour(REMINDER_HOUR)
    .inTimezone(Session.getScriptTimeZone())
    .create();
  loadPeopleDirectory();
  return 'Installed. Reminders will send weekdays around ' + REMINDER_HOUR + ':00 ' + Session.getScriptTimeZone();
}

function removeDailyReminderTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  triggers.forEach(function(t) {
    if (t.getHandlerFunction() === 'sendTimesheetReminders') {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  return 'Removed ' + removed + ' trigger(s)';
}

// Sends a preview reminder to the admin so you can see what it looks like.
function testTimesheetReminder() {
  var html = buildReminderHtml_('there', 0);
  MailApp.sendEmail({
    to: DIGEST_ADMIN_EMAIL,
    subject: '[PREVIEW] Don\'t forget your timesheet',
    htmlBody: html,
    name: DIGEST_SENDER_NAME
  });
  return 'Preview reminder sent to ' + DIGEST_ADMIN_EMAIL;
}

function sendTimesheetReminders() {
  var now = new Date();
  var day = now.getDay();
  if (day === 0 || day === 6) return; // skip weekends

  var people = loadPeopleDirectory();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  var tz = Session.getScriptTimeZone();
  var todayKey = Utilities.formatDate(now, tz, 'yyyy-MM-dd');

  // Hours logged today, per person
  var loggedToday = {};
  if (sheet && sheet.getLastRow() >= 2) {
    var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 9).getValues();
    data.forEach(function(row) {
      if (!row[0]) return;
      var rowDate = row[0] instanceof Date ? Utilities.formatDate(row[0], tz, 'yyyy-MM-dd') : String(row[0]).substring(0, 10);
      if (rowDate !== todayKey) return;
      var name = String(row[1] || '').trim();
      loggedToday[name] = (loggedToday[name] || 0) + (parseFloat(row[8]) || 0);
    });
  }

  var sent = [];
  Object.keys(people).forEach(function(name) {
    var email = people[name];
    if (!email) return;
    var hrs = loggedToday[name] || 0;
    if (hrs >= REMINDER_MIN_HOURS) return;
    var firstName = name.split(/\s+/)[0];
    MailApp.sendEmail({
      to: email,
      subject: 'Don\'t forget your timesheet — ' + Utilities.formatDate(now, tz, 'EEE d MMM'),
      htmlBody: buildReminderHtml_(firstName, hrs, now),
      name: DIGEST_SENDER_NAME,
      replyTo: DIGEST_ADMIN_EMAIL
    });
    sent.push(name + ' (' + hrs.toFixed(1) + 'h logged)');
  });

  Logger.log('Reminders sent: ' + (sent.length ? sent.join(', ') : 'none — everyone is up to date'));
}

// ── QUOTES & REFLECTION ───────────────────────────────────────
// One quote a day, rotating. Deliberately chosen to be humane rather than
// hustle-culture: the point is "your time is your life", not "work harder".
// Everyone gets the SAME quote on the same day — it's rotated by date, not
// picked at random per person — so it can become something people mention to
// each other rather than 45 private fortune cookies.
var TIME_QUOTES = [
  { q: 'How we spend our days is, of course, how we spend our lives.', a: 'Annie Dillard' },
  { q: 'It is not that we have a short time to live, but that we waste a lot of it.', a: 'Seneca' },
  { q: 'All we have to decide is what to do with the time that is given us.', a: 'J.R.R. Tolkien' },
  { q: 'Time is the coin of your life. It is the only coin you have, and only you can determine how it will be spent.', a: 'Carl Sandburg' },
  { q: 'If you love life, don\'t waste time, for time is what life is made up of.', a: 'Bruce Lee' },
  { q: 'It is not enough to be busy. The question is: what are we busy about?', a: 'Henry David Thoreau' },
  { q: 'Time isn\'t the main thing. It\'s the only thing.', a: 'Miles Davis' },
  { q: 'Yesterday is gone. Tomorrow has not yet come. We have only today. Let us begin.', a: 'Mother Teresa' },
  { q: 'Time is what we want most, but what we use worst.', a: 'William Penn' },
  { q: 'You may delay, but time will not.', a: 'Benjamin Franklin' },
  { q: 'The two most powerful warriors are patience and time.', a: 'Leo Tolstoy' },
  { q: 'Guard well your spare moments. They are like uncut diamonds.', a: 'Ralph Waldo Emerson' },
  { q: 'Time flies over us, but leaves its shadow behind.', a: 'Nathaniel Hawthorne' },
  { q: 'Nothing is a waste of time if you use the experience wisely.', a: 'Auguste Rodin' },
  { q: 'How did it get so late so soon?', a: 'Dr. Seuss' },
  { q: 'We must use time as a tool, not as a couch.', a: 'John F. Kennedy' },
  { q: 'Better three hours too soon than a minute too late.', a: 'William Shakespeare' },
  { q: 'Time is the most valuable thing a person can spend.', a: 'Theophrastus' },
  { q: 'The bad news is time flies. The good news is you\'re the pilot.', a: 'Michael Altshuler' },
  { q: 'The trouble is, you think you have time.', a: 'Jack Kornfield' }
];

// Short invitations to look back at the day. Phrased as an open question, never
// as "account for yourself" — the tone this email lands in matters more than
// the words. Index 0 is reserved for Friday, where a week-shaped question fits.
var REFLECTION_PROMPTS = [
  'That\'s the week. What did it go into?',
  'What did today actually go into?',
  'Worth a look back before the day blurs.',
  'Where did the hours actually land today?',
  'A minute to think about how today was spent.'
];

// Same quote for everybody on a given day, cycling through the list.
function quoteForDate_(date) {
  var epoch = Math.floor(date.getTime() / 86400000);
  return TIME_QUOTES[((epoch % TIME_QUOTES.length) + TIME_QUOTES.length) % TIME_QUOTES.length];
}

// Friday gets the week-shaped prompt; other weekdays rotate through the rest.
function reflectionForDate_(date) {
  if (date.getDay() === 5) return REFLECTION_PROMPTS[0];
  var epoch = Math.floor(date.getTime() / 86400000);
  var n = REFLECTION_PROMPTS.length - 1;
  return REFLECTION_PROMPTS[1 + (((epoch % n) + n) % n)];
}

function buildReminderHtml_(firstName, hrs, when) {
  var url  = WEB_APP_URL;
  var date = when || new Date();
  var quote      = quoteForDate_(date);
  var reflection = reflectionForDate_(date);
  var copy = hrs > 0
    ? 'You\'ve only logged <strong style="color:#111">' + hrs.toFixed(1) + ' hours</strong> so far today. If there\'s more to add, now\'s a good time.'
    : 'You haven\'t logged any time today. Two minutes now saves a scramble at month end.';
  return (
    '<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,sans-serif">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f4f4f4"><tr><td align="center" style="padding:32px 12px">' +
      '<table cellpadding="0" cellspacing="0" border="0" width="520" style="max-width:520px;background:#ffffff;border-radius:4px;overflow:hidden">' +
        '<tr><td style="background:#0a0a0a;padding:26px 28px">' +
          '<div style="font-size:14px;color:#fff;margin-bottom:14px"><span style="font-family:\'Archivo Black\',Arial,sans-serif">mannmade</span><span style="color:#8a8a8a;font-size:10px;letter-spacing:0.2em;font-weight:700;margin-left:8px;text-transform:uppercase">· Time</span></div>' +
          '<div style="font-family:\'Archivo Black\',Arial,sans-serif;font-size:22px;color:#fff;line-height:1.25">Don\'t forget your timesheet</div>' +
        '</td></tr>' +
        '<tr><td style="padding:26px 28px 8px">' +
          '<div style="font-size:15px;color:#222;line-height:1.5">Hey ' + escapeHtml(firstName) + ',</div>' +
          '<div style="font-size:14px;color:#444;line-height:1.6;margin-top:10px">' + copy + '</div>' +
        '</td></tr>' +
        // Quote of the day — the pause before the ask.
        '<tr><td style="padding:18px 28px 4px">' +
          '<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>' +
            '<td style="width:3px;background:#f5c400"></td>' +
            '<td style="padding:2px 0 2px 16px">' +
              '<div style="font-size:15px;color:#222;line-height:1.55;font-style:italic">“' + escapeHtml(quote.q) + '”</div>' +
              '<div style="font-size:10px;color:#999;letter-spacing:0.14em;text-transform:uppercase;font-weight:700;margin-top:8px">' + escapeHtml(quote.a) + '</div>' +
            '</td>' +
          '</tr></table>' +
        '</td></tr>' +
        '<tr><td style="padding:14px 28px 0">' +
          '<div style="font-size:14px;color:#444;line-height:1.6">' + escapeHtml(reflection) + '</div>' +
        '</td></tr>' +
        (url ?
        '<tr><td style="padding:20px 28px 28px">' +
          '<a href="' + url + '" style="display:inline-block;background:#e8318a;color:#ffffff;font-size:12px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;text-decoration:none;padding:14px 26px;border-radius:3px">Log your time</a>' +
        '</td></tr>' : '<tr><td style="padding:8px 28px 28px"></td></tr>') +
        // Says out loud what this is for. A daily nudge about your time reads as
        // surveillance unless you tell people plainly that it isn't.
        '<tr><td style="background:#fafafa;padding:14px 28px;border-top:1px solid #eee">' +
          '<div style="font-size:12px;color:#777;line-height:1.55">Nearest half-hour is fine. This is so we bill our clients properly and know which jobs are worth doing — not to count anybody\'s minutes.</div>' +
          '<div style="font-size:10px;color:#bbb;letter-spacing:0.15em;text-transform:uppercase;font-weight:700;margin-top:10px">MANNMADE · Time · Auto-reminder</div>' +
        '</td></tr>' +
      '</table>' +
    '</td></tr></table></body></html>'
  );
}
// Deployed via clasp

