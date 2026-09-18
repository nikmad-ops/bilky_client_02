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
const WORKSHIFT_URL =
  "https://panel.bilky.es/employee/hour-registration/hour-registration/show/ekzv7lndr9eqy5da";
const TIMEZONE = "Europe/Madrid";

const required = {
  BILKY_NIF,
  BILKY_PASSWORD,
  BROWSERLESS_TOKEN,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  ADMIN_TELEGRAM_BOT_TOKEN,
  ADMIN_TELEGRAM_CHAT_ID,
  ACTION,
  EXECUTE,
};

for (const [name, value] of Object.entries(required)) {
  if (!value) throw new Error(`Missing environment variable: ${name}`);
}

if (!["morning", "evening"].includes(ACTION)) {
  throw new Error(`ACTION must be morning or evening. Got: ${ACTION}`);
}

function getMadridDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const value = (type) => parts.find((part) => part.type === type)?.value;

  return `${value("year")}-${value("month")}-${value("day")}`;
}

const targetDate = getMadridDate();

function displayDate(date) {
  const [y, m, d] = date.split("-");
  return `${d}.${m}.${y}`;
}

function shortFact(time) {
  return time ? time.slice(0, 5) : "--:--";
}

function minutesFromTime(time) {
  if (!time) return null;

  const [h, m] = time
    .slice(0, 5)
    .split(":")
    .map(Number);

  return h * 60 + m;
}

function formatDuration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;

  return `${h}:${String(m).padStart(2, "0")}`;
}

function dayDuration(morningFact, eveningFact) {
  const start = minutesFromTime(morningFact);
  const end = minutesFromTime(eveningFact);

  if (start == null || end == null || end < start) return null;

  return formatDuration(end - start);
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

async function sendTelegramTo(botToken, chatId, message, label) {
  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
      }),
    }
  );

  if (!response.ok) {
    throw new Error(
      `${label} Telegram failed: ${response.status} ${await response.text()}`
    );
  }
}

async function sendTelegram(message) {
  await sendTelegramTo(
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID,
    message,
    "Client"
  );

  await sendTelegramTo(
    ADMIN_TELEGRAM_BOT_TOKEN,
    ADMIN_TELEGRAM_CHAT_ID,
    message,
    "Admin"
  );
}

function extractTime(text) {
  const match = String(text || "").match(/\b\d{2}:\d{2}\b/);
  return match ? match[0] : null;
}

function extractFactTime(value) {
  if (!value) return null;

  const match = value.match(
    /^\d{2}\/\d{2}\/\d{4}\s+(\d{2}:\d{2}:\d{2})$/
  );

  return match ? match[1] : null;
}

async function readShiftCell(cell) {
  let planned = null;

  const input = cell.locator("input.clockpicker").first();

  if (await input.count()) {
    planned = await input.inputValue();
  } else {
    planned = extractTime(await cell.innerText());
  }

  let fact = null;
  let factRaw = null;

  const factIcon = cell
    .locator('i.fe-clock[data-original-title]')
    .first();

  if (await factIcon.count()) {
    factRaw = await factIcon.getAttribute("data-original-title");
    fact = extractFactTime(factRaw);
  }

  const clockButton = cell.locator("a.clock").first();
  const buttonExists = (await clockButton.count()) > 0;

  let buttonEnabled = false;
  let buttonId = null;

  if (buttonExists) {
    const className =
      (await clockButton.getAttribute("class")) || "";

    buttonEnabled =
      !className.split(/\s+/).includes("disabled");

    buttonId =
      await clockButton.getAttribute("id");
  }

  return {
    planned,
    fact,
    factRaw,
    buttonExists,
    buttonEnabled,
    buttonId,
  };
}

async function readDayState(page, date) {
  const containerSelector = `#container_${date}`;
  const container = page.locator(containerSelector);

  await container.waitFor({
    state: "visible",
    timeout: 15000,
  });

  const row = container
    .locator("tr")
    .filter({ hasText: /First shift|Primer turno/ })
    .first();

  if (!(await row.count())) {
    throw new Error(
      `First shift row not found for ${date}`
    );
  }

  const shiftCells =
    row.locator("td.hr-container");

  if ((await shiftCells.count()) < 2) {
    throw new Error(
      `Expected morning and evening cells for ${date}`
    );
  }

  const morning =
    await readShiftCell(shiftCells.nth(0));

  const evening =
    await readShiftCell(shiftCells.nth(1));

  const signed =
    (await container
      .locator(".badge-success")
      .filter({ hasText: /Signed|Firmado/ })
      .count()) > 0;

  const signAvailable =
    (await container
      .locator("button#sign")
      .count()) > 0;

  const text =
    await container.innerText();

  const pendingSignature =
    /pending signature|pendiente de firmar/i.test(text);

  return {
    containerSelector,
    morning,
    evening,
    signed,
    signAvailable,
    pendingSignature,
  };
}

function printState(state) {
  log("----- DAY STATE -----");

  log(
    `Morning: plan=${state.morning.planned ?? "NONE"} ` +
      `fact=${state.morning.fact ?? "NONE"} ` +
      `button=${state.morning.buttonExists ? "YES" : "NO"} ` +
      `enabled=${state.morning.buttonEnabled}`
  );

  log(
    `Evening: plan=${state.evening.planned ?? "NONE"} ` +
      `fact=${state.evening.fact ?? "NONE"} ` +
      `button=${state.evening.buttonExists ? "YES" : "NO"} ` +
      `enabled=${state.evening.buttonEnabled}`
  );

  log(
    `Signed=${state.signed} ` +
      `SignAvailable=${state.signAvailable} ` +
      `PendingSignature=${state.pendingSignature}`
  );

  log("---------------------");
}

async function loginAndOpenWorkshift(page) {
  log("Opening Bilky login.");

  await page.goto(LOGIN_URL, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  const visibleInputs =
    page.locator("input:visible");

  if ((await visibleInputs.count()) < 2) {
    throw new Error(
      "Bilky login fields not found"
    );
  }

  await visibleInputs
    .nth(0)
    .fill(BILKY_NIF);

  await page
    .locator('input[type="password"]')
    .first()
    .fill(BILKY_PASSWORD);

  const submit =
    page
      .locator('button[type="submit"]')
      .first();

  if (!(await submit.count())) {
    throw new Error(
      "Bilky login button not found"
    );
  }

  await submit.click();

  const deadline =
    Date.now() + 25000;

  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);

    if (!page.url().includes("/auth/login")) {
      break;
    }
  }

  if (page.url().includes("/auth/login")) {
    throw new Error(
      "Bilky security verification/login did not clear within 25 seconds"
    );
  }

  log(`Login OK. Current URL: ${page.url()}`);

  await page.goto(WORKSHIFT_URL, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  await page.waitForTimeout(1200);

  log(`Workshift opened: ${page.url()}`);
}

async function clock(page, state, mode) {
  const side =
    mode === "morning"
      ? state.morning
      : state.evening;

  const expectedPlan =
    mode === "morning"
      ? "08:00"
      : "16:00";

  if (side.planned !== expectedPlan) {
    throw new Error(
      `${mode}: unexpected planned time ${side.planned}; expected ${expectedPlan}`
    );
  }

  if (side.fact) {
    log(
      `${mode}: already clocked at ${side.fact}. No duplicate click.`
    );

    return {
      alreadyDone: true,
      fact: side.fact,
    };
  }

  if (!side.buttonExists) {
    throw new Error(
      `${mode}: Clock in/out button does not exist`
    );
  }

  if (!side.buttonEnabled) {
    throw new Error(
      `${mode}: Clock in/out button is disabled`
    );
  }

  if (
    mode === "evening" &&
    !state.morning.fact
  ) {
    throw new Error(
      "Evening blocked because morning fact is missing"
    );
  }

  const container =
    page.locator(state.containerSelector);

  const row = container
    .locator("tr")
    .filter({ hasText: /First shift|Primer turno/ })
    .first();

  const cells =
    row.locator("td.hr-container");

  const cell =
    mode === "morning"
      ? cells.nth(0)
      : cells.nth(1);

  const button =
    cell.locator("a.clock").first();

  log(
    `CLICK ${mode}: ${side.buttonId}`
  );

  const responsePromise =
    page.waitForResponse(
      (response) =>
        response
          .url()
          .includes(
            "/employee/hour-registration/clock-hour"
          ) &&
        response
          .request()
          .method() === "POST",
      { timeout: 20000 }
    );

  await button.click();

  const response =
    await responsePromise;

  log(
    `clock-hour HTTP ${response.status()}`
  );

  if (!response.ok()) {
    throw new Error(
      `Bilky clock-hour returned HTTP ${response.status()}`
    );
  }

  await page.waitForTimeout(1200);

  await page.reload({
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  await page.waitForTimeout(1200);

  const newState =
    await readDayState(
      page,
      targetDate
    );

  printState(newState);

  const newSide =
    mode === "morning"
      ? newState.morning
      : newState.evening;

  if (!newSide.fact) {
    throw new Error(
      `${mode}: POST succeeded but factual timestamp was not found after reload`
    );
  }

  log(
    `${mode}: FACT CONFIRMED ${newSide.fact}`
  );

  return {
    alreadyDone: false,
    fact: newSide.fact,
    state: newState,
  };
}

async function signDay(page) {
  let state =
    await readDayState(
      page,
      targetDate
    );

  if (!state.evening.fact) {
    throw new Error(
      "Refusing to sign: evening fact is missing"
    );
  }

  if (state.signed) {
    log("Day already SIGNED.");
    return state;
  }

  if (!state.signAvailable) {
    throw new Error(
      "Evening completed but Sign button is unavailable"
    );
  }

  const signButton =
    page
      .locator(state.containerSelector)
      .locator("button#sign");

  log("Clicking Sign.");

  await signButton.click();

  const confirmButton =
    page.locator(
      ".sweet-alert:visible button.confirm"
    );

  await confirmButton.waitFor({
    state: "visible",
    timeout: 10000,
  });

  const responsePromise =
    page.waitForResponse(
      (response) =>
        response
          .url()
          .includes(
            "/employee/hour-registration/update-registration"
          ) &&
        response
          .request()
          .method() === "POST",
      { timeout: 20000 }
    );

  log("Confirming Sign.");

  await confirmButton.click();

  const response =
    await responsePromise;

  log(
    `update-registration HTTP ${response.status()}`
  );

  if (!response.ok()) {
    throw new Error(
      `Bilky Sign returned HTTP ${response.status()}`
    );
  }

  await page.waitForTimeout(1200);

  await page.reload({
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  await page.waitForTimeout(1200);

  state =
    await readDayState(
      page,
      targetDate
    );

  printState(state);

  if (!state.signed) {
    throw new Error(
      "Sign POST succeeded but SIGNED status was not confirmed after reload"
    );
  }

  log("SIGNED CONFIRMED.");

  return state;
}


async function securityVerificationDetected(page) {
  let title = "";
  let body = "";

  try {
    title = await page.title();
  } catch {}

  try {
    body = await page.locator("body").innerText();
  } catch {}

  const frameUrls = page
    .frames()
    .map((frame) => frame.url())
    .join(" ");

  const signal = [
    page.url(),
    title,
    body,
    frameUrls,
  ]
    .join(" ")
    .toLowerCase();

  return (
    signal.includes("performing security verification") ||
    signal.includes("verify you are human") ||
    signal.includes("security verification") ||
    signal.includes("just a moment") ||
    signal.includes("cdn-cgi/challenge-platform") ||
    signal.includes("challenges.cloudflare.com")
  );
}

function cloudflareVerificationError() {
  const error = new Error(
    "Cloudflare security verification blocked Bilky page"
  );

  error.code =
    "CLOUDFLARE_SECURITY_VERIFICATION";

  return error;
}

function isRetryableTransientError(error) {
  const message =
    String(error?.message || "");

  return (
    error?.code ===
      "CLOUDFLARE_SECURITY_VERIFICATION" ||
    message.includes(
      "locator.waitFor: Timeout 15000ms exceeded"
    ) ||
    message.includes(
      "Bilky login fields not found"
    ) ||
    message.includes(
      "Bilky security verification/login did not clear within 25 seconds"
    )
  );
}

async function assertNoSecurityVerification(page) {
  if (
    await securityVerificationDetected(
      page
    )
  ) {
    throw cloudflareVerificationError();
  }
}

async function waitBeforeCloudflareRetry() {
  const delayMs =
    3 * 60 * 1000;

  log(
    "Cloudflare verification detected. Waiting 3 minutes before a completely new Browserless session."
  );

  await new Promise(
    (resolve) =>
      setTimeout(
        resolve,
        delayMs
      )
  );
}

async function runWorkshiftAttempt(attempt) {
  log(
    `Starting Browserless attempt ${attempt}/2`
  );

  const browser =
    await chromium.connectOverCDP(
      `wss://production-ams.browserless.io/stealth?token=${BROWSERLESS_TOKEN}`
    );

  const context =
    browser.contexts()[0] ||
    (await browser.newContext());

  const page =
    context.pages()[0] ||
    (await context.newPage());

  try {
    await loginAndOpenWorkshift(
      page
    );

    await page.waitForTimeout(
      1500
    );

    await assertNoSecurityVerification(
      page
    );

    let state;

    try {
      state =
        await readDayState(
          page,
          targetDate
        );
    } catch (error) {
      if (
        await securityVerificationDetected(
          page
        )
      ) {
        throw cloudflareVerificationError();
      }

      throw error;
    }

    printState(state);

    if (
      ACTION ===
      "morning"
    ) {
      const result =
        await clock(
          page,
          state,
          "morning"
        );

      await sendTelegram(
        `✅ Bilky for ${CLIENT_NAME} ${displayDate(targetDate)}: Morning. Fact: ${shortFact(result.fact)}`
      );

      log(
        "MORNING SUCCESS"
      );

      return;
    }

    const result =
      await clock(
        page,
        state,
        "evening"
      );

    const finalState =
      await signDay(
        page
      );

    const duration =
      dayDuration(
        finalState.morning.fact,
        finalState.evening.fact
      );

    if (!duration) {
      throw new Error(
        "Unable to calculate DAY from morning/evening facts"
      );
    }

    await sendTelegram(
      `✅ Bilky for ${CLIENT_NAME} ${displayDate(targetDate)}: Evening. Fact: ${shortFact(result.fact)}, Signed. Workday ${duration}`
    );

    log(
      "EVENING SUCCESS"
    );
  } finally {
    await browser.close();
  }
}

async function main() {
  fs.mkdirSync(
    "diagnostics",
    { recursive: true }
  );

  log(
    `TARGET_DATE=${targetDate}`
  );

  log(
    `ACTION=${ACTION}`
  );

  log(
    `EXECUTE=${EXECUTE}`
  );

  if (
    EXECUTE !==
    "true"
  ) {
    throw new Error(
      "Execution blocked by internal kill switch: EXECUTE must equal true"
    );
  }

  let lastError = null;

  for (
    let attempt = 1;
    attempt <= 2;
    attempt += 1
  ) {
    try {
      await runWorkshiftAttempt(
        attempt
      );

      return;
    } catch (error) {
      lastError =
        error;

      console.error(
        `Attempt ${attempt} failed: ${error.message}`
      );

      if (
        isRetryableTransientError(error) &&
        attempt === 1
      ) {
        log(
          "Transient Bilky/Cloudflare page failure detected. Retrying from a completely new Browserless session."
        );

        await waitBeforeCloudflareRetry();
        continue;
      }

      break;
    }
  }

  const label =
    ACTION === "morning"
      ? "Morning"
      : "Evening";

  try {
    await sendTelegram(
      `❌ Bilky for ${CLIENT_NAME} ${displayDate(targetDate)}: ${label}. ERROR: ${lastError?.message || "Unknown error"}`
    );
  } catch (telegramError) {
    console.error(
      `Telegram error notification failed: ${telegramError.message}`
    );
  }

  throw lastError ||
    new Error(
      "Bilky workshift failed"
    );
}

await main();
