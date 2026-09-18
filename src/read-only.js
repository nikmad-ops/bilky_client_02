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

function clean(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function madridDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const v = (type) => parts.find((p) => p.type === type)?.value;
  return v("year") + "-" + v("month") + "-" + v("day");
}

async function sendAdmin(message) {
  const r = await fetch(
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
  if (!r.ok) {
    throw new Error("Telegram failed: " + r.status + " " + await r.text());
  }
}

const targetDate = madridDate();
const [year, month, dayRaw] = targetDate.split("-");
const day = String(Number(dayRaw));
const monthNames = {
  "01": ["ENERO","JANUARY"],
  "02": ["FEBRERO","FEBRUARY"],
  "03": ["MARZO","MARCH"],
  "04": ["ABRIL","APRIL"],
  "05": ["MAYO","MAY"],
  "06": ["JUNIO","JUNE"],
  "07": ["JULIO","JULY"],
  "08": ["AGOSTO","AUGUST"],
  "09": ["SEPTIEMBRE","SEPTEMBER"],
  "10": ["OCTUBRE","OCTOBER"],
  "11": ["NOVIEMBRE","NOVEMBER"],
  "12": ["DICIEMBRE","DECEMBER"],
}[month];

const browser = await chromium.connectOverCDP(
  "wss://production-ams.browserless.io/stealth?token=" + BROWSERLESS_TOKEN
);
const context = browser.contexts()[0] || (await browser.newContext());
const page = context.pages()[0] || (await context.newPage());

try {
  console.log("READ ONLY: opening login");
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

  const inputs = page.locator("input:visible");
  if ((await inputs.count()) < 2) throw new Error("Bilky login fields not found");

  await inputs.nth(0).fill(BILKY_NIF);
  await page.locator('input[type="password"]').first().fill(BILKY_PASSWORD);
  await page.locator('button[type="submit"]').first().click();

  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    if (!page.url().includes("/auth/login")) break;
  }
  if (page.url().includes("/auth/login")) throw new Error("Login did not clear");

  console.log("READ ONLY: after login URL=" + page.url());

  await page.goto(WORKSHIFT_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2500);

  console.log("READ ONLY: workshift URL=" + page.url());
  console.log("READ ONLY: title=" + await page.title());

  const bodyText = clean(await page.locator("body").innerText());
  console.log("----- BODY START -----");
  console.log(bodyText.slice(0, 20000));
  console.log("----- BODY END -----");

  const probe = await page.evaluate(({ targetDate, year, day, monthNames }) => {
    const clean = (x) => String(x || "").replace(/\s+/g, " ").trim();
    const out = {
      exactContainerCount: 0,
      exactContainerHtml: null,
      shiftLabels: [],
      dateCandidates: [],
      interesting: [],
    };

    const exact = document.querySelectorAll("#container_" + targetDate);
    out.exactContainerCount = exact.length;
    if (exact[0]) out.exactContainerHtml = exact[0].outerHTML.slice(0, 12000);

    const all = [...document.querySelectorAll("body *")];

    for (const el of all) {
      const t = clean(el.textContent);
      if (!t) continue;

      if (t === "Primer turno" || t === "First shift") {
        const chain = [];
        let p = el;
        for (let depth = 0; p && depth < 8; depth++, p = p.parentElement) {
          chain.push({
            depth,
            tag: p.tagName,
            id: p.id || "",
            cls: typeof p.className === "string" ? p.className : "",
            text: clean(p.textContent).slice(0, 1000),
          });
        }
        out.shiftLabels.push(chain);
      }

      const upper = t.toUpperCase();
      const hasDate =
        t.includes(year) &&
        monthNames.some((m) => upper.includes(m)) &&
        new RegExp("(^|\\s)" + day + "(\\s|$)").test(t);

      if (hasDate && /Primer turno|First shift|Fichar|Clock in|Clock out|Firmar|Sign/i.test(t)) {
        out.dateCandidates.push({
          tag: el.tagName,
          id: el.id || "",
          cls: typeof el.className === "string" ? el.className : "",
          text: t.slice(0, 2000),
          html: el.outerHTML.slice(0, 8000),
        });
        if (out.dateCandidates.length >= 20) break;
      }
    }

    for (const el of all) {
      const t = clean(el.textContent);
      if (!t || t.length > 300) continue;
      if (/turno|shift|fichar|clock|firmar|signed|firmado|pendiente|september|septiembre|08:00|16:00/i.test(t)) {
        out.interesting.push({
          tag: el.tagName,
          id: el.id || "",
          cls: typeof el.className === "string" ? el.className : "",
          text: t,
        });
      }
      if (out.interesting.length >= 300) break;
    }

    return out;
  }, { targetDate, year, day, monthNames });

  console.log("----- PROBE JSON START -----");
  console.log(JSON.stringify(probe, null, 2));
  console.log("----- PROBE JSON END -----");

  await page.screenshot({
    path: "read-only-workshift.png",
    fullPage: true,
  });

  console.log("READ ONLY COMPLETE. NO FICHAR/SIGN ACTION WAS PERFORMED.");

  const summary = [
    "🔎 Bilky READ ONLY — " + CLIENT_NAME + " — " + targetDate,
    "",
    "Exact #container_" + targetDate + ": " + probe.exactContainerCount,
    "Shift labels found: " + probe.shiftLabels.length,
    "Date candidates found: " + probe.dateCandidates.length,
    "",
    "No Fichar/Sign action performed.",
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
