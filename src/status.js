import { chromium } from "playwright-core";

const {
  BILKY_NIF,
  BILKY_PASSWORD,
  BROWSERLESS_TOKEN,
  ADMIN_TELEGRAM_BOT_TOKEN,
  ADMIN_TELEGRAM_CHAT_ID,
  REQUEST_CHAT_ID,
} = process.env;

const CLIENT_NAME = "Irakli";
const LOGIN_URL = "https://panel.bilky.es/auth/login";
const WORKSHIFT_URL = "https://panel.bilky.es/employee/hour-registration/hour-registration/show/ekzv7lndr9eqy5da";
const TIMEZONE = "Europe/Madrid";

for (const [name, value] of Object.entries({
  BILKY_NIF,
  BILKY_PASSWORD,
  BROWSERLESS_TOKEN,
  ADMIN_TELEGRAM_BOT_TOKEN,
  ADMIN_TELEGRAM_CHAT_ID,
  REQUEST_CHAT_ID,
})) {
  if (!value) throw new Error(`Missing environment variable: ${name}`);
}

if (String(REQUEST_CHAT_ID) !== String(ADMIN_TELEGRAM_CHAT_ID)) {
  throw new Error("Unauthorized Telegram chat_id");
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function madridParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

function ymdFromParts(p) {
  return `${p.year}-${p.month}-${p.day}`;
}

function utcNoonFromYmd(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

function ymdFromDateUtc(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(ymd, days) {
  const date = utcNoonFromYmd(ymd);
  date.setUTCDate(date.getUTCDate() + days);
  return ymdFromDateUtc(date);
}

function isoWeekInfo(ymd) {
  const date = utcNoonFromYmd(ymd);
  const day = date.getUTCDay() || 7;
  const monday = new Date(date);
  monday.setUTCDate(date.getUTCDate() - day + 1);
  const thursday = new Date(date);
  thursday.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1, 12));
  const week = Math.ceil((((thursday - yearStart) / 86400000) + 1) / 7);
  return {
    week,
    monday: ymdFromDateUtc(monday),
    friday: addDays(ymdFromDateUtc(monday), 4),
  };
}

function ordinal(n) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  if (n % 10 === 1) return `${n}st`;
  if (n % 10 === 2) return `${n}nd`;
  if (n % 10 === 3) return `${n}rd`;
  return `${n}th`;
}

function dayMonth(ymd) {
  const [, m, d] = ymd.split("-");
  return `${d}/${m}`;
}

function monthName(month) {
  return [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ][Number(month) - 1];
}

function weekRangeLabel(monday, friday) {
  const [y1, m1, d1] = monday.split("-");
  const [y2, m2, d2] = friday.split("-");
  if (y1 === y2 && m1 === m2) {
    return `${Number(d1)}-${Number(d2)} ${monthName(m1)} ${y1}`;
  }
  return `${Number(d1)} ${monthName(m1)} - ${Number(d2)} ${monthName(m2)} ${y2}`;
}

function minutes(time) {
  if (!time) return null;
  const [h, m] = time.slice(0, 5).split(":").map(Number);
  return h * 60 + m;
}

function durationMinutes(start, end) {
  const a = minutes(start);
  const b = minutes(end);
  if (a == null || b == null || b < a) return null;
  return b - a;
}

function formatDuration(value) {
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

function shortTime(value) {
  return value ? value.slice(0, 5) : null;
}

function compareYmd(a, b) {
  return a.localeCompare(b);
}

function currentMadridMinutes() {
  const p = madridParts();
  return Number(p.hour) * 60 + Number(p.minute);
}

async function sendTelegram(message) {
  const response = await fetch(
    `https://api.telegram.org/bot${ADMIN_TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: ADMIN_TELEGRAM_CHAT_ID, text: message }),
    }
  );

  if (!response.ok) {
    throw new Error(`Telegram failed: ${response.status} ${await response.text()}`);
  }
}

function extractFact(value) {
  if (!value) return null;
  const match = value.match(
    /^\d{2}\/\d{2}\/\d{4}\s+(\d{2}:\d{2}:\d{2})$/
  );
  return match ? match[1] : null;
}

function extractVisibleTime(text) {
  const match = String(text || "").match(/\b\d{2}:\d{2}\b/);
  return match ? match[0] : null;
}

async function locateDay(page, date) {
  const locator = page.locator(`#container_${date}`).first();
  try {
    await locator.waitFor({ state: "visible", timeout: 8000 });
    return locator;
  } catch {
    return null;
  }
}

async function readLegacyCell(cell) {
  let planned = null;

  const input = cell.locator("input.clockpicker").first();
  if (await input.count()) {
    planned = await input.inputValue();
  }

  if (!planned) {
    planned = extractVisibleTime(await cell.innerText());
  }

  let fact = null;
  const attrs = cell.locator("[data-original-title]");
  const attrCount = await attrs.count();

  for (let i = 0; i < attrCount; i += 1) {
    const raw = await attrs.nth(i).getAttribute("data-original-title");
    const parsed = extractFact(raw);
    if (parsed) {
      fact = parsed;
      break;
    }
  }

  return { planned, fact };
}

async function readDayState(page, date) {
  const container = await locateDay(page, date);

  if (!container) {
    return { exists: false, error: `container_${date} not found` };
  }

  const row = container
    .locator("tr")
    .filter({ hasText: /Primer turno|First shift/ })
    .first();

  if (!(await row.count())) {
    return { exists: false, error: "shift row not found" };
  }

  const cells = row.locator("td.hr-container");

  if ((await cells.count()) < 2) {
    return { exists: false, error: "morning/evening cells not found" };
  }

  const morning = await readLegacyCell(cells.nth(0));
  const evening = await readLegacyCell(cells.nth(1));

  const signed =
    (await container
      .locator(".badge-success")
      .filter({ hasText: /Firmado|Signed/ })
      .count()) > 0;

  log(`${date}: morning=${morning.fact || "NONE"} evening=${evening.fact || "NONE"} signed=${signed}`);

  return { exists: true, morning, evening, signed };
}

async function login(page) {
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

  const visibleInputs = page.locator("input:visible");
  if ((await visibleInputs.count()) < 2) {
    throw new Error("Bilky login fields not found");
  }

  await visibleInputs.nth(0).fill(BILKY_NIF);
  await page.locator('input[type="password"]').first().fill(BILKY_PASSWORD);

  const submit = page.locator('button[type="submit"]').first();
  if (!(await submit.count())) {
    throw new Error("Bilky login button not found");
  }

  await submit.click();

  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    if (!page.url().includes("/auth/login")) break;
  }

  if (page.url().includes("/auth/login")) {
    throw new Error("Bilky security verification/login did not clear within 25 seconds");
  }

  await page.goto(WORKSHIFT_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1500);
}

function classifyDay(date, state, today, nowMinutes) {
  const label = dayMonth(date);
  const relation = compareYmd(date, today);

  if (!state.exists) {
    if (relation > 0) return { line: `⚪ ${label}: wait`, total: 0 };
    return {
      line: `❌ ${label}: ERROR: ${state.error || "day data unavailable"}`,
      total: 0,
    };
  }

  const morning = shortTime(state.morning.fact);
  const evening = shortTime(state.evening.fact);
  const duration = durationMinutes(state.morning.fact, state.evening.fact);

  if (relation > 0) return { line: `⚪ ${label}: wait`, total: 0 };
  if (!morning && evening) {
    return { line: `❌ ${label}: ERROR: morning fact missing; evening=${evening}`, total: 0 };
  }
  if (!morning) {
    if (relation === 0 && nowMinutes < 8 * 60 + 20) {
      return { line: `⚪ ${label}: wait`, total: 0 };
    }
    return { line: `❌ ${label}: ERROR: morning fact missing`, total: 0 };
  }
  if (!evening) {
    if (relation === 0 && nowMinutes <= 16 * 60 + 20) {
      return { line: `🟡 ${label}: ${morning}, wait`, total: 0 };
    }
    return { line: `❌ ${label}: ${morning}, ERROR: evening fact missing`, total: 0 };
  }
  if (duration == null) {
    return { line: `❌ ${label}: ${morning}, ${evening}, ERROR: invalid Workday interval`, total: 0 };
  }

  const workday = formatDuration(duration);

  if (!state.signed) {
    return { line: `⚠️ ${label}: ${morning}, ${evening}, NOT SIGNED, Workday ${workday}`, total: 0 };
  }

  return {
    line: `✅ ${label}: ${morning}, ${evening}, Signed, Workday ${workday}`,
    total: duration,
  };
}

async function main() {
  const nowParts = madridParts();
  const today = ymdFromParts(nowParts);
  const nowMinutes = currentMadridMinutes();
  const { week, monday, friday } = isoWeekInfo(today);
  const dates = Array.from({ length: 5 }, (_, i) => addDays(monday, i));

  const browser = await chromium.connectOverCDP(
    `wss://production-ams.browserless.io/stealth?token=${BROWSERLESS_TOKEN}`
  );

  const context = browser.contexts()[0] || (await browser.newContext());
  const page = context.pages()[0] || (await context.newPage());

  try {
    await login(page);

    const lines = [];
    let totalMinutes = 0;

    for (const date of dates) {
      const state = await readDayState(page, date);
      const classified = classifyDay(date, state, today, nowMinutes);
      lines.push(classified.line);
      totalMinutes += classified.total;
    }

    const report = [
      `📋 Bilky for ${CLIENT_NAME} — ${ordinal(week)} week ${weekRangeLabel(monday, friday)}`,
      "",
      ...lines,
      "",
      `Total week = ${formatDuration(totalMinutes)}`,
    ].join("\n");

    await sendTelegram(report);
    log("STATUS SUCCESS");
  } catch (error) {
    console.error(`STATUS FAILED: ${error.message}`);
    try {
      await sendTelegram(`❌ Bilky for ${CLIENT_NAME} STATUS. ERROR: ${error.message}`);
    } catch {}
    throw error;
  } finally {
    await browser.close();
  }
}

await main();