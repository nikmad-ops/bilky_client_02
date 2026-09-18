import { chromium } from "playwright-core";

const {
  BILKY_NIF,
  BILKY_PASSWORD,
  BROWSERLESS_TOKEN,
  ADMIN_TELEGRAM_BOT_TOKEN,
  ADMIN_TELEGRAM_CHAT_ID,
} = process.env;

const CLIENT_NAME = "Irakli";
const LOGIN_URL = "https://panel.bilky.es/auth/login";
const WORKSHIFT_URL =
  "https://panel.bilky.es/employee/hour-registration/hour-registration/show/ekzv7lndr9eqy5da";
const TIMEZONE = "Europe/Madrid";

for (const [name, value] of Object.entries({
  BILKY_NIF,
  BILKY_PASSWORD,
  BROWSERLESS_TOKEN,
  ADMIN_TELEGRAM_BOT_TOKEN,
  ADMIN_TELEGRAM_CHAT_ID,
})) {
  if (!value) throw new Error("Missing environment variable: " + name);
}

function log(message) {
  console.log("[" + new Date().toISOString() + "] " + message);
}

function getMadridDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const value = (type) =>
    parts.find((part) => part.type === type)?.value;

  return value("year") + "-" + value("month") + "-" + value("day");
}

const targetDate = getMadridDate();

function extractVisibleTime(text) {
  const match = String(text || "").match(/\b\d{2}:\d{2}\b/);
  return match ? match[0] : null;
}

function extractFactTime(value) {
  if (!value) return null;
  const match = String(value).match(
    /^\d{2}\/\d{2}\/\d{4}\s+(\d{2}:\d{2}:\d{2})$/
  );
  return match ? match[1] : null;
}

async function sendAdmin(message) {
  const response = await fetch(
    "https://api.telegram.org/bot" + ADMIN_TELEGRAM_BOT_TOKEN + "/sendMessage",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: ADMIN_TELEGRAM_CHAT_ID,
        text: message,
      }),
    }
  );

  if (!response.ok) {
    throw new Error(
      "Admin Telegram failed: " + response.status + " " + await response.text()
    );
  }
}

async function loginAndOpenWorkshift(page) {
  log("READ ONLY: opening Bilky login.");

  await page.goto(LOGIN_URL, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

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
    throw new Error(
      "Bilky security verification/login did not clear within 25 seconds"
    );
  }

  log("READ ONLY: login OK. Current URL: " + page.url());

  await page.goto(WORKSHIFT_URL, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  log("READ ONLY: workshift opened: " + page.url());
}

async function inspectCell(cell, label) {
  const text = (await cell.innerText()).replace(/\s+/g, " ").trim();

  const inputs = cell.locator("input.clockpicker");
  const inputValues = [];

  for (let i = 0; i < (await inputs.count()); i += 1) {
    inputValues.push(await inputs.nth(i).inputValue());
  }

  const titled = cell.locator("[data-original-title]");
  const titles = [];

  for (let i = 0; i < (await titled.count()); i += 1) {
    const raw = await titled.nth(i).getAttribute("data-original-title");
    if (raw) titles.push(raw);
  }

  const fact =
    titles
      .map(extractFactTime)
      .find(Boolean) || null;

  const clockButtons = cell.locator("a.clock");
  const buttons = [];

  for (let i = 0; i < (await clockButtons.count()); i += 1) {
    const button = clockButtons.nth(i);

    buttons.push({
      id: await button.getAttribute("id"),
      class: await button.getAttribute("class"),
      text: (await button.innerText()).replace(/\s+/g, " ").trim(),
      visible: await button.isVisible(),
    });
  }

  const planned =
    inputValues.find(Boolean) ||
    extractVisibleTime(text);

  const result = {
    label,
    text,
    planned,
    fact,
    inputValues,
    titles,
    clockButtonCount: buttons.length,
    buttons,
  };

  log(label.toUpperCase() + " JSON: " + JSON.stringify(result));

  return result;
}

async function main() {
  const browser = await chromium.connectOverCDP(
    "wss://production-ams.browserless.io/stealth?token=" + BROWSERLESS_TOKEN
  );

  const context =
    browser.contexts()[0] ||
    (await browser.newContext());

  const page =
    context.pages()[0] ||
    (await context.newPage());

  try {
    await loginAndOpenWorkshift(page);

    const containerSelector = "#container_" + targetDate;
    const container = page.locator(containerSelector).first();

    await container.waitFor({
      state: "visible",
      timeout: 15000,
    });

    const pageText = (await page.locator("body").innerText())
      .replace(/\s+/g, " ")
      .trim();

    const cardText = (await container.innerText())
      .replace(/\s+/g, " ")
      .trim();

    const cardHtml = await container.evaluate((el) => el.outerHTML);

    log("===== READ ONLY CURRENT CARD =====");
    log("CLIENT=" + CLIENT_NAME);
    log("TARGET_DATE=" + targetDate);
    log("CONTAINER=" + containerSelector);
    log("CARD TEXT: " + cardText);

    const row = container
      .locator("tr")
      .filter({ hasText: /First shift|Primer turno/ })
      .first();

    if (!(await row.count())) {
      throw new Error("First shift / Primer turno row not found");
    }

    const rowText = (await row.innerText())
      .replace(/\s+/g, " ")
      .trim();

    log("SHIFT ROW TEXT: " + rowText);

    const cells = row.locator("td.hr-container");
    const cellCount = await cells.count();

    log("SHIFT CELL COUNT: " + cellCount);

    if (cellCount < 2) {
      throw new Error(
        "Expected at least 2 hr-container cells; found " + cellCount
      );
    }

    const morning = await inspectCell(cells.nth(0), "morning");
    const evening = await inspectCell(cells.nth(1), "evening");

    const signed =
      (await container
        .locator(".badge-success")
        .filter({ hasText: /Signed|Firmado/ })
        .count()) > 0;

    const signButtonCount = await container.locator("button#sign").count();

    const pendingSignature =
      /Pending signature|Pendiente de firmar/i.test(cardText);

    const ficharCount =
      await container
        .getByText(/^(Fichar|Clock in|Clock out)$/i, {
          exact: true,
        })
        .count();

    const identityMatch = pageText.match(
      /ID\s+(.+?)(?=\s+Entidad|\s+Portal Empleado|\s+Panel de control)/i
    );

    const recognized = {
      client: CLIENT_NAME,
      targetDate,
      identity: identityMatch ? identityMatch[1].trim() : null,
      signed,
      pendingSignature,
      signButtonCount,
      ficharCount,
      morning,
      evening,
    };

    log("RECOGNIZED JSON: " + JSON.stringify(recognized));
    log("===== RAW CARD HTML START =====");
    console.log(cardHtml);
    log("===== RAW CARD HTML END =====");
    log("READ ONLY COMPLETE. NO FICHAR/SIGN ACTION WAS PERFORMED.");

    const summary = [
      "🔎 Bilky READ ONLY — " + CLIENT_NAME + " — " + targetDate,
      "",
      "Card: FOUND",
      "Identity: " + (recognized.identity || "not parsed"),
      "Morning: plan=" + (morning.planned || "NONE") +
        ", fact=" + (morning.fact || "NONE") +
        ", clockButtons=" + morning.clockButtonCount,
      "Evening: plan=" + (evening.planned || "NONE") +
        ", fact=" + (evening.fact || "NONE") +
        ", clockButtons=" + evening.clockButtonCount,
      "Signed: " + signed,
      "Sign button count: " + signButtonCount,
      "Pending signature: " + pendingSignature,
      "Fichar count in card: " + ficharCount,
      "",
      "Card text: " + cardText,
      "",
      "READ ONLY. No Fichar/Sign action performed.",
    ].join("\n");

    await sendAdmin(summary);
  } catch (error) {
    console.error("READ ONLY FAILED: " + error.message);

    try {
      await sendAdmin(
        "❌ Bilky READ ONLY — " + CLIENT_NAME + " — " + targetDate +
        ". ERROR: " + error.message +
        ". No Fichar/Sign action was performed."
      );
    } catch {}

    throw error;
  } finally {
    await browser.close();
  }
}

await main();
