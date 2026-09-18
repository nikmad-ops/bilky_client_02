import { chromium } from "playwright-core";
import fs from "node:fs";

const {
  BILKY_NIF,
  BILKY_PASSWORD,
  BROWSERLESS_TOKEN,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  ADMIN_TELEGRAM_BOT_TOKEN,
  ADMIN_TELEGRAM_CHAT_ID,
  ACTION,
  EXECUTE,
} = process.env;

const CLIENT_NAME = "Irakli";
const LOGIN_URL = "https://panel.bilky.es/auth/login";
const WORKSHIFT_URL = "https://panel.bilky.es/employee/hour-registration/hour-registration/show/ekzv7lndr9eqy5da";
const TIMEZONE = "Europe/Madrid";

for (const [name, value] of Object.entries({
  BILKY_NIF,
  BILKY_PASSWORD,
  BROWSERLESS_TOKEN,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  ADMIN_TELEGRAM_BOT_TOKEN,
  ADMIN_TELEGRAM_CHAT_ID,
  ACTION,
  EXECUTE,
})) {
  if (!value) throw new Error(`Missing environment variable: ${name}`);
}

if (!["morning", "evening"].includes(ACTION)) {
  throw new Error(`ACTION must be morning or evening. Got: ${ACTION}`);
}

function madridDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const v = (type) => parts.find((p) => p.type === type)?.value;
  return `${v("year")}-${v("month")}-${v("day")}`;
}

const targetDate = madridDate();

function displayDate(date) {
  const [y, m, d] = date.split("-");
  return `${d}.${m}.${y}`;
}

function shortFact(time) {
  return time ? time.slice(0, 5) : "--:--";
}

function minutes(time) {
  if (!time) return null;
  const [h, m] = time.slice(0, 5).split(":").map(Number);
  return h * 60 + m;
}

function workday(start, end) {
  const a = minutes(start);
  const b = minutes(end);
  if (a == null || b == null || b < a) return null;
  const diff = b - a;
  return `${Math.floor(diff / 60)}:${String(diff % 60).padStart(2, "0")}`;
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

async function sendTo(botToken, chatId, message, label) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: message }),
  });
  if (!response.ok) {
    throw new Error(`${label} Telegram failed: ${response.status} ${await response.text()}`);
  }
}

async function sendTelegram(message) {
  await sendTo(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, message, "Alena");
  await sendTo(ADMIN_TELEGRAM_BOT_TOKEN, ADMIN_TELEGRAM_CHAT_ID, message, "Admin");
}

function extractFact(value) {
  if (!value) return null;
  const match = value.match(/^\d{2}\/\d{2}\/\d{4}\s+(\d{2}:\d{2}:\d{2})$/);
  return match ? match[1] : null;
}

async function locateDay(page, date) {
  const legacy = page.locator(`#container_${date}`);
  try {
    await legacy.waitFor({ state: "visible", timeout: 8000 });
    return { locator: legacy, mode: "legacy" };
  } catch {}

  const [, month, dayRaw] = date.split("-");
  const day = String(Number(dayRaw));
  const year = date.slice(0, 4);
  const monthNames = {
    "01": ["ENERO", "JANUARY"], "02": ["FEBRERO", "FEBRUARY"],
    "03": ["MARZO", "MARCH"], "04": ["ABRIL", "APRIL"],
    "05": ["MAYO", "MAY"], "06": ["JUNIO", "JUNE"],
    "07": ["JULIO", "JULY"], "08": ["AGOSTO", "AUGUST"],
    "09": ["SEPTIEMBRE", "SEPTEMBER"], "10": ["OCTUBRE", "OCTOBER"],
    "11": ["NOVIEMBRE", "NOVEMBER"], "12": ["DICIEMBRE", "DECEMBER"],
  }[month];

  const count = await page.evaluate(({ day, year, monthNames }) => {
    document.querySelectorAll('[data-bilky-target-day="true"]').forEach((el) => el.removeAttribute("data-bilky-target-day"));
    const labels = [...document.querySelectorAll("body *")].filter((el) => {
      const t = (el.textContent || "").trim();
      return t === "Primer turno" || t === "First shift";
    });
    const matches = [];
    for (const label of labels) {
      let el = label.parentElement;
      for (let depth = 0; el && depth < 10; depth += 1, el = el.parentElement) {
        const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
        if (
          text.includes(year) &&
          monthNames.some((m) => text.toUpperCase().includes(m)) &&
          new RegExp(`(^|\\s)${day}(\\s|$)`).test(text) &&
          /Primer turno|First shift/.test(text)
        ) {
          matches.push(el);
          break;
        }
      }
    }
    const unique = [...new Set(matches)];
    if (unique.length === 1) unique[0].setAttribute("data-bilky-target-day", "true");
    return unique.length;
  }, { day, year, monthNames });

  if (count !== 1) throw new Error(`Unable to identify exactly one day card for ${date}; matches=${count}`);
  const locator = page.locator('[data-bilky-target-day="true"]');
  await locator.waitFor({ state: "visible", timeout: 5000 });
  return { locator, mode: "card" };
}

async function readLegacy(container) {
  const row = container.locator("tr").filter({ hasText: /First shift|Primer turno/ }).first();
  if (!(await row.count())) throw new Error("Shift row not found");
  const cells = row.locator("td.hr-container");
  if ((await cells.count()) < 2) throw new Error("Morning/evening cells not found");

  async function cellState(cell) {
    let planned = null;
    const input = cell.locator("input.clockpicker").first();
    if (await input.count()) planned = await input.inputValue();
    else planned = (await cell.innerText()).match(/\b\d{2}:\d{2}\b/)?.[0] || null;

    const icon = cell.locator('i.fe-clock[data-original-title]').first();
    const fact = (await icon.count()) ? extractFact(await icon.getAttribute("data-original-title")) : null;
    const button = cell.locator("a.clock").first();
    return { planned, fact, button: (await button.count()) ? button : null };
  }

  const morning = await cellState(cells.nth(0));
  const evening = await cellState(cells.nth(1));
  const signed = (await container.locator(".badge-success").filter({ hasText: /Signed|Firmado/ }).count()) > 0;
  const signButton = container.locator("button#sign").first();
  return { mode: "legacy", container, morning, evening, signed, signButton: (await signButton.count()) ? signButton : null };
}

async function readCard(container) {
  const text = (await container.innerText()).replace(/\s+/g, " ").trim();
  const icons = container.locator('[data-original-title]');
  const facts = [];
  for (let i = 0; i < await icons.count(); i += 1) {
    const fact = extractFact(await icons.nth(i).getAttribute("data-original-title"));
    if (fact) facts.push(fact);
  }
  const buttons = container.getByText(/^(Fichar|Clock in|Clock out)$/i, { exact: true });
  const buttonCount = await buttons.count();
  const sign = container.getByText(/^(Firmar|Sign)$/i, { exact: true });
  return {
    mode: "card",
    container,
    morning: { planned: text.includes("08:00") ? "08:00" : null, fact: facts[0] || null },
    evening: { planned: text.includes("16:00") ? "16:00" : null, fact: facts[1] || null },
    clockButton: buttonCount === 1 ? buttons.first() : null,
    signed: /\bFirmado\b/i.test(text) || /\bSigned\b/i.test(text),
    signButton: (await sign.count()) === 1 ? sign.first() : null,
  };
}

async function readState(page) {
  const located = await locateDay(page, targetDate);
  return located.mode === "legacy" ? readLegacy(located.locator) : readCard(located.locator);
}

async function login(page) {
  log("Opening Bilky login.");
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  const visibleInputs = page.locator("input:visible");
  if ((await visibleInputs.count()) < 2) throw new Error("Bilky login fields not found");
  await visibleInputs.nth(0).fill(BILKY_NIF);
  await page.locator('input[type="password"]').first().fill(BILKY_PASSWORD);
  const submit = page.locator('button[type="submit"]').first();
  if (!(await submit.count())) throw new Error("Bilky login button not found");
  await submit.click();

  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    if (!page.url().includes("/auth/login")) break;
  }
  if (page.url().includes("/auth/login")) throw new Error("Bilky security verification/login did not clear within 25 seconds");

  await page.goto(WORKSHIFT_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1500);
  log(`Workshift opened: ${page.url()}`);
}

async function clickClock(page, state, mode) {
  const side = mode === "morning" ? state.morning : state.evening;
  const expected = mode === "morning" ? "08:00" : "16:00";
  if (side.planned !== expected) throw new Error(`${mode}: unexpected planned time ${side.planned}; expected ${expected}`);
  if (side.fact) return side.fact;
  if (mode === "evening" && !state.morning.fact) throw new Error("Evening blocked because morning fact is missing");

  let button = null;
  if (state.mode === "legacy") button = side.button;
  else button = state.clockButton;
  if (!button) throw new Error(`${mode}: Fichar button is not uniquely available`);

  const responsePromise = page.waitForResponse(
    (r) => r.url().includes("/employee/hour-registration/clock-hour") && r.request().method() === "POST",
    { timeout: 20000 }
  );
  await button.click();
  const response = await responsePromise;
  if (!response.ok()) throw new Error(`Bilky clock-hour returned HTTP ${response.status()}`);

  await page.waitForTimeout(1200);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1500);
  const after = await readState(page);
  const fact = mode === "morning" ? after.morning.fact : after.evening.fact;
  if (!fact) throw new Error(`${mode}: factual timestamp was not found after reload`);
  return fact;
}

async function signDay(page) {
  let state = await readState(page);
  if (!state.evening.fact) throw new Error("Refusing to sign: evening fact is missing");
  if (state.signed) return state;
  if (!state.signButton) throw new Error("Evening completed but Sign/Firmar button is unavailable");

  await state.signButton.click();
  const confirm = page.locator(".sweet-alert:visible button.confirm");
  await confirm.waitFor({ state: "visible", timeout: 10000 });
  const responsePromise = page.waitForResponse(
    (r) => r.url().includes("/employee/hour-registration/update-registration") && r.request().method() === "POST",
    { timeout: 20000 }
  );
  await confirm.click();
  const response = await responsePromise;
  if (!response.ok()) throw new Error(`Bilky Sign returned HTTP ${response.status()}`);

  await page.waitForTimeout(1200);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1500);
  state = await readState(page);
  if (!state.signed) throw new Error("Sign POST succeeded but SIGNED/FIRMADO status was not confirmed after reload");
  return state;
}

async function main() {
  fs.mkdirSync("diagnostics", { recursive: true });
  if (EXECUTE !== "true") throw new Error("Execution blocked by internal kill switch: EXECUTE must equal true");

  const browser = await chromium.connectOverCDP(`wss://production-ams.browserless.io/stealth?token=${BROWSERLESS_TOKEN}`);
  const context = browser.contexts()[0] || (await browser.newContext());
  const page = context.pages()[0] || (await context.newPage());

  try {
    await login(page);
    const state = await readState(page);

    if (ACTION === "morning") {
      const fact = await clickClock(page, state, "morning");
      await sendTelegram(`✅ Bilky for ${CLIENT_NAME} ${displayDate(targetDate)}: Morning. Fact: ${shortFact(fact)}`);
      return;
    }

    const fact = await clickClock(page, state, "evening");
    const finalState = await signDay(page);
    const duration = workday(finalState.morning.fact, finalState.evening.fact);
    if (!duration) throw new Error("Unable to calculate Workday from morning/evening facts");
    await sendTelegram(`✅ Bilky for ${CLIENT_NAME} ${displayDate(targetDate)}: Evening. Fact: ${shortFact(fact)}, Signed. Workday ${duration}`);
  } catch (error) {
    console.error(`FAILED: ${error.message}`);
    try { await page.screenshot({ path: "diagnostics/workshift-error.png", fullPage: true }); } catch {}
    try {
      const label = ACTION === "morning" ? "Morning" : "Evening";
      await sendTelegram(`❌ Bilky for ${CLIENT_NAME} ${displayDate(targetDate)}: ${label}. ERROR: ${error.message}`);
    } catch (telegramError) {
      console.error(`Telegram error notification failed: ${telegramError.message}`);
    }
    throw error;
  } finally {
    await browser.close();
  }
}

await main();
