/**
 * poll.js — Books Lilla Ego at midnight when new dates are released
 *
 * New dates release at exactly 00:00 Stockholm. In --watch mode the script
 * sleeps until midnight then immediately attempts fetchTimes + booking,
 * retrying every 1s for up to 30 attempts to handle server lag.
 *
 * Usage:
 *   node poll.js            # one-shot check for today's date (no waiting)
 *   node poll.js --watch    # sleep until midnight, attempt booking, stop on result
 *   npm run check           # alias for node poll.js
 *   npm run watch           # alias for node poll.js --watch
 *
 * Env overrides (set in .env or inline):
 *   PARTY_SIZE=2            # number of guests (default: 3)
 *   LATEST_TIME=20:00       # latest acceptable slot (default: 19:00)
 *   DRY_RUN=false           # set to false to actually book (default: dry run)
 *   WINDOW_START=23:50:00   # when to wake and start waiting (default: 23:50:00)
 *   WINDOW_DURATION=180     # minutes after window start before giving up (default: 180)
 *   FIRST_NAME / LAST_NAME / EMAIL / PHONE / COMMENT — contact details for booking
 */

import { writeFileSync, readFileSync, existsSync, appendFileSync } from 'fs';
import { execSync } from 'child_process';
import 'dotenv/config';

const LOG_FILE = './poll.log';

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  appendFileSync(LOG_FILE, line + '\n');
}

const RESTAURANT_HASH = 'a6ec81a26b9ea18ff9ba9852b8dcaa0b';
const MEAL_ID         = '6518';   // Middag at Lilla Ego
const PARTY_SIZE      = parseInt(process.env.PARTY_SIZE ?? '3');
const LATEST_TIME     = process.env.LATEST_TIME ?? '19:00';  // book this time or earlier
const DRY_RUN         = process.env.DRY_RUN !== 'false';

const contact = {
  firstName:   process.env.FIRST_NAME   ?? '',
  lastName:    process.env.LAST_NAME    ?? '',
  email:       process.env.EMAIL        ?? '',
  phone:       process.env.PHONE        ?? '',
  countryCode: process.env.COUNTRY_CODE ?? '+46',
  comment:     process.env.COMMENT      ?? '',
};

const STATE_FILE  = './poll-state.json';
const BOOKED_FILE = './.booked';  // exists = already booked, delete to re-enable
const POLL_MS     = 1 * 1000;   // 1 second

// Window can be overridden: WINDOW_START=23:59:30 WINDOW_DURATION=30 node poll.js --watch
const [WINDOW_START_H, WINDOW_START_M, WINDOW_START_S] = (process.env.WINDOW_START ?? '23:50:00').split(':').map(Number);
const WINDOW_DURATION_MIN = parseInt(process.env.WINDOW_DURATION ?? '180');
const WINDOW_END_SEC = (WINDOW_START_H * 3600 + WINDOW_START_M * 60 + WINDOW_START_S) + WINDOW_DURATION_MIN * 60; // may exceed 86400 (crosses midnight)

const WATCH = process.argv.includes('--watch');

// ─── Stockholm time helpers ───────────────────────────────────────────────────

function stockholmTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = t => parseInt(parts.find(p => p.type === t).value);
  return { h: get('hour'), m: get('minute'), s: get('second') };
}

function inPollWindow() {
  const { h, m, s } = stockholmTime();
  const nowSec   = h * 3600 + m * 60 + s;
  const startSec = WINDOW_START_H * 3600 + WINDOW_START_M * 60 + WINDOW_START_S;
  if (WINDOW_END_SEC >= 24 * 3600) {
    // Window crosses midnight: active if after start OR before wrapped end
    return nowSec >= startSec || nowSec < WINDOW_END_SEC % (24 * 3600);
  }
  return nowSec >= startSec && nowSec < WINDOW_END_SEC;
}

function msUntilWindowStart() {
  const { h, m, s } = stockholmTime();
  const nowSec   = h * 3600 + m * 60 + s;
  const startSec = WINDOW_START_H * 3600 + WINDOW_START_M * 60 + WINDOW_START_S;
  const secsUntil = nowSec <= startSec
    ? startSec - nowSec
    : 24 * 3600 - nowSec + startSec;
  return secsUntil * 1000;
}

// Schedule a wake via launchd user agent (no sudo required).
// launchd fires the job at StartCalendarInterval and wakes the Mac if asleep.
function scheduleLaunchdWake(targetDate) {
  const pad = n => String(n).padStart(2, '0');
  // Use local time for launchd calendar interval
  const hh = targetDate.getHours();
  const mm = targetDate.getMinutes();
  const nodeBin = process.execPath;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>             <string>se.bokabord.poll-wake</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${process.argv[1]}</string>
    <string>--watch</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>   <integer>${hh}</integer>
    <key>Minute</key> <integer>${mm}</integer>
    <key>Second</key> <integer>0</integer>
  </dict>
  <key>WorkingDirectory</key> <string>${process.cwd()}</string>
  <key>RunAtLoad</key> <false/>
</dict>
</plist>`;

  const agentsDir = `${process.env.HOME}/Library/LaunchAgents`;
  const plistPath = `${agentsDir}/se.bokabord.poll-wake.plist`;
  try {
    execSync(`mkdir -p "${agentsDir}"`);
    writeFileSync(plistPath, plist);
    execSync(`launchctl unload "${plistPath}" 2>/dev/null; launchctl load "${plistPath}"`, { stdio: 'pipe' });
    log(`launchd agent installed — will wake Mac at ${pad(hh)}:${pad(mm)} local time`);
  } catch (e) {
    log(`launchd scheduling failed: ${e.message}`);
  }
}

// Schedule a macOS wake event so the Mac wakes from sleep at the target time.
// pmset uses local system time (should match Stockholm if Mac timezone is correct).
function scheduleSystemWake(targetDate) {
  const pad = n => String(n).padStart(2, '0');
  const mo = pad(targetDate.getMonth() + 1);
  const dy = pad(targetDate.getDate());
  const yr = String(targetDate.getFullYear()).slice(-2);
  const hh = pad(targetDate.getHours());
  const mm = pad(targetDate.getMinutes());
  const ss = pad(targetDate.getSeconds());
  const dateStr = `${mo}/${dy}/${yr} ${hh}:${mm}:${ss}`;

  try {
    execSync(`pmset schedule wake "${dateStr}"`, { stdio: 'pipe' });
    log(`System wake scheduled via pmset for ${dateStr} (local time)`);
    return true;
  } catch {
    log(`Note: pmset wake scheduling failed — falling back to launchd.`);
    return false;
  }
}

// ─── Notifications ────────────────────────────────────────────────────────────

function notify(title, msg) {
  log(`*** ${title}: ${msg} ***`);
  if (process.platform === 'darwin') {
    // Strip non-ASCII to avoid AppleScript encoding issues
    const safe  = msg.replace(/[^\x20-\x7E]/g, '-').replace(/"/g, '\\"');
    const safeT = title.replace(/[^\x20-\x7E]/g, '-').replace(/"/g, '\\"');
    try {
      execSync(`osascript -e 'display notification "${safe}" with title "${safeT}"'`, { stdio: 'pipe' });
    } catch (e) {
      log(`notify error: ${e.stderr?.toString().trim() ?? e.message}`);
    }
  }
}

// ─── State ────────────────────────────────────────────────────────────────────

function loadState() {
  if (!existsSync(STATE_FILE)) return {};
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

function saveState(s) {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// ─── Fetch available times for a specific date ────────────────────────────────

async function fetchTimes(date) {
  const res = await fetch('https://app.bokabord.se/booking-widget/api/getTimes', {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin':  'https://app.bokabord.se',
      'Referer': 'https://app.bokabord.se/',
    },
    body: JSON.stringify({
      hash:      RESTAURANT_HASH,
      mealid:    MEAL_ID,
      date,
      amount:    PARTY_SIZE,
      date_code: '',
    }),
  });

  const data = await res.json().catch(() => null);

  if (!data?.times) return { times: [], durations: {} };
  // times: { "57600": ["17:00", timestamp], ... }
  // lengths: { mealid: { "17:00": 150, ... } }
  const times  = Object.values(data.times).map(v => v[0]).sort();
  const durMap = data.lengths?.[MEAL_ID] ?? {};
  return { times, durations: durMap };
}

// ─── Pick best slot ≤ LATEST_TIME ─────────────────────────────────────────────

function pickSlot(times) {
  const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const cutoff = toMin(LATEST_TIME);
  const valid  = times.filter(t => toMin(t) <= cutoff).sort();
  return valid.at(-1) ?? null;   // latest slot at or before cutoff
}

// ─── Book a slot ──────────────────────────────────────────────────────────────

async function bookSlot(date, time, duration) {
  const body = {
    mealid:           MEAL_ID,
    firstname:        contact.firstName,
    lastname:         contact.lastName,
    email:            contact.email,
    phone:            contact.phone,
    country_code:     contact.countryCode,
    dial_code:        contact.countryCode,
    amount:           PARTY_SIZE,
    date,
    offer_ID:         0,
    time,
    bookingid:        0,
    comment:          contact.comment,
    waitlist:         false,
    waitlist_end:     0,
    length:           duration ?? 0,
    saveinfo:         false,
    hd_meal:          '',
    ap_label:         '',
    testmode:         0,
    children_amount:  0,
    mc_code:          '',
    from_url:         'bokabord_fat',
    hash:             RESTAURANT_HASH,
    date_code:        '',
    products:         [],
    giftcard:         null,
    segment:          '',
    terms:            { general: true, restaurant: true, bokabord: true },
    temp_sid:         '',
    waitb:            '',
    linked_meals:     [],
    lid:              '',
    city:             'Stockholm',
    widget_lang:      '',
    important_tags:   '',
    is_bokabord_web:  'Y',
    statistic_id:     '',
    query_params:     {},
    isl:              0,
    ol:               0,
  };

  const res  = await fetch('https://app.bokabord.se/reservation/api/booking/saveBooking', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://app.bokabord.se', Referer: 'https://app.bokabord.se/' },
    body:    JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

// ─── Stockholm date string (YYYY-MM-DD) ──────────────────────────────────────

function stockholmDateStr(date = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

// ─── Ms until next Stockholm midnight ────────────────────────────────────────

function msUntilMidnight() {
  const { h, m, s } = stockholmTime();
  const secsFromMidnight = h * 3600 + m * 60 + s;
  return secsFromMidnight === 0 ? 0 : (24 * 3600 - secsFromMidnight) * 1000;
}

// ─── Attempt direct booking for a known date ─────────────────────────────────

async function tryBookDate(date) {
  const ts = new Date().toISOString();
  log(`Fetching times for ${date} (party of ${PARTY_SIZE})...`);

  const { times, durations } = await fetchTimes(date)
    .catch(e => { log(`fetchTimes error: ${e.message}`); return { times: [], durations: {} }; });

  log(`${date}: ${times.length ? times.join(', ') : 'no slots'}`);

  if (!times.length) return false;

  notify('Lilla Ego', `${date}: ${times.join(' ')}`);
  writeFileSync('new-slots.json', JSON.stringify({ date, times, at: ts }, null, 2));

  const chosen = pickSlot(times);
  if (!chosen) {
    log(`No slot at ${LATEST_TIME} or earlier on ${date}`);
    return true;
  }

  log(`Best slot: ${chosen} on ${date}`);

  const hasContact = contact.firstName && contact.lastName && contact.email && contact.phone;
  if (!hasContact) {
    log('Skipping booking — fill FIRST_NAME/LAST_NAME/EMAIL/PHONE in .env');
    return true;
  }

  if (DRY_RUN) {
    log(`[DRY RUN] Would book ${date} at ${chosen} for ${PARTY_SIZE} — set DRY_RUN=false to book for real`);
    return true;
  }

  log(`Booking ${date} at ${chosen}...`);
  const result = await bookSlot(date, chosen, durations[chosen]).catch(e => ({ error: e.message }));

  if (result.error) {
    log(`Booking error: ${result.error}`);
  } else if (result.data?.success || result.data?.bookingid) {
    const bookingId = result.data?.bookingid ?? result.data?.id ?? '?';
    log(`BOOKED! ${date} at ${chosen} — booking ID: ${bookingId}`);
    notify('Lilla Ego BOOKED', `${date} at ${chosen} for ${PARTY_SIZE} — ID ${bookingId}`);
    writeFileSync('booking-result.json', JSON.stringify(result.data, null, 2));
    writeFileSync(BOOKED_FILE, `${date} at ${chosen} — ID ${bookingId}\n`);
  } else {
    log(`Booking failed: ${JSON.stringify(result.data?.errors ?? result.data?.message ?? result.data)}`);
    notify('Lilla Ego booking failed', `${date} ${chosen} — check booking-result.json`);
    writeFileSync('booking-result.json', JSON.stringify(result.data, null, 2));
  }

  return true;
}

// ─── One-shot check (used for --check mode) ───────────────────────────────────

async function check() {
  const date = stockholmDateStr();
  const { h, m } = stockholmTime();
  log(`(Stockholm ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}) Checking ${date}…`);
  await tryBookDate(date);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  if (existsSync(BOOKED_FILE)) {
    log(`Booking already made — delete ${BOOKED_FILE} to re-enable.`);
    return;
  }

  if (!WATCH) {
    await check();
    return;
  }

  // If outside the window, schedule a system wake and wait until midnight
  const pad = n => String(n).padStart(2, '0');
  const windowStartStr = `${pad(WINDOW_START_H)}:${pad(WINDOW_START_M)}:${pad(WINDOW_START_S)}`;
  const windowEndH = Math.floor(WINDOW_END_SEC / 3600) % 24;
  const windowEndM = Math.floor((WINDOW_END_SEC % 3600) / 60);
  const windowEndStr = `${pad(windowEndH)}:${pad(windowEndM)}`;

  if (!inPollWindow()) {
    const ms  = msUntilWindowStart();
    const mins = Math.round(ms / 60_000);
    const { h, m, s } = stockholmTime();
    const startDate = new Date(Date.now() + ms);

    log(`Stockholm ${pad(h)}:${pad(m)}:${pad(s)} — outside window. ${Math.floor(mins/60)}h ${mins%60}m until ${windowStartStr}.`);

    if (process.platform === 'darwin') {
      scheduleLaunchdWake(startDate);
      scheduleSystemWake(startDate);
      log(`Sleeping. Mac will wake at ${windowStartStr} — you can close the lid now.`);
    } else {
      log(`Sleeping until ${windowStartStr}.`);
    }

    await new Promise(r => setTimeout(r, ms));
    log(`${windowStartStr} reached — starting poll.`);
  }

  // Wait for midnight
  const msToMidnight = msUntilMidnight();
  if (msToMidnight > 0) {
    log(`Waiting ${(msToMidnight / 1000).toFixed(1)}s for Stockholm midnight...`);
    await new Promise(r => setTimeout(r, msToMidnight));
  }

  // Releases are always 30 days out
  const targetDate = stockholmDateStr(new Date(Date.now() + 30 * 24 * 3600 * 1000));
  const { lastOpen } = loadState();
  log(`Midnight — targeting ${targetDate} (30 days out)`);

  const DIRECT_RETRIES = 30;
  for (let i = 0; i < DIRECT_RETRIES; i++) {
    const done = await tryBookDate(targetDate).catch(err => { log(`Error: ${err.message}`); return false; });
    if (done) { log('Done.'); process.exit(0); }

    log(`Not released yet (${i + 1}/${DIRECT_RETRIES}), retrying in 1s...`);
    await new Promise(r => setTimeout(r, 1000));
  }

  log(`No release after ${DIRECT_RETRIES} fast retries — switching to poll every 5s for 5 min.`);
  notify('Lilla Ego', `${targetDate}: fast retries exhausted, polling every 5s`);

  const SLOW_POLL_MS = 5_000;
  const windowEndMs  = Date.now() + 5 * 60_000;

  while (Date.now() < windowEndMs) {
    await new Promise(r => setTimeout(r, SLOW_POLL_MS));

    const done = await tryBookDate(targetDate).catch(err => { log(`Error: ${err.message}`); return false; });
    if (done) { log('Done.'); process.exit(0); }

    const secsLeft = Math.round((windowEndMs - Date.now()) / 1_000);
    log(`Still not released — ${secsLeft}s remaining.`);
  }

  log(`5 min window expired — switching to poll every 1 min for 3 hours.`);

  const LONG_POLL_MS  = 60_000;
  const longEndMs     = Date.now() + 3 * 60 * 60_000;

  while (Date.now() < longEndMs) {
    await new Promise(r => setTimeout(r, LONG_POLL_MS));

    const done = await tryBookDate(targetDate).catch(err => { log(`Error: ${err.message}`); return false; });
    if (done) { log('Done.'); process.exit(0); }

    const minsLeft = Math.round((longEndMs - Date.now()) / 60_000);
    log(`Still not released — ${minsLeft} min remaining.`);
  }

  log(`3 hour window expired. No release for ${targetDate}.`);
  notify('Lilla Ego', `${targetDate}: no release after 3 hours of polling`);
}

run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
