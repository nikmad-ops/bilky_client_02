import { chromium } from "playwright-core";

const {
  BILKY_NIF,
  BILKY_PASSWORD,
  BROWSERLESS_TOKEN,
} = process.env;

const LOGIN_URL = "https://panel.bilky.es/auth/login";
const WORKSHIFT_URL = "https://panel.bilky.es/employee/hour-registration/hour-registration/show/ekzv7lndr9eqy5da";

for (const [name, value] of Object.entries({
  BILKY_NIF,
  BILKY_PASSWORD,
  BROWSERLESS_TOKEN,
})) {
  if (!value) throw new Error(`Missing environment variable: ${name}`);
}

function clean(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

const browser = await chromium.connectOverCDP(
  `wss://production-ams.browserless.io/stealth?token=${BROWSERLESS_TOKEN}`
);
const context = browser.contexts()[0] || (await browser.newContext());
const page = context.pages()[0] || (await context.newPage());

try {
  console.log("Opening login...");
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

  const visibleInputs = page.locator("input:visible");
  console.log(`Visible login inputs: ${await visibleInputs.count()}`);

  await visibleInputs.nth(0).fill(BILKY_NIF);
  await page.locator('input[type="password"]').first().fill(BILKY_PASSWORD);
  await page.locator('button[type="submit"]').first().click();

  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    if (!page.url().includes("/auth/login")) break;
  }

  console.log(`After login URL: ${page.url()}`);

  if (page.url().includes("/auth/login")) {
    throw new Error("Login did not clear");
  }

  await page.goto(WORKSHIFT_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1500);

  console.log(`Workshift URL: ${page.url()}`);
  console.log(`Page title: ${await page.title()}`);

  const bodyText = clean(await page.locator("body").innerText());
  console.log("----- BODY START -----");
  console.log(bodyText.slice(0, 12000));
  console.log("----- BODY END -----");

  const candidates = await page.evaluate(() => {
    const els = [...document.querySelectorAll("body *")];
    const out = [];
    for (const el of els) {
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (!t || t.length > 240) continue;
      if (/turno|shift|fichar|clock|firmar|signed|pendiente|september|septiembre|2026|08:00|16:00/i.test(t)) {
        out.push({
          tag: el.tagName,
          id: el.id || "",
          cls: typeof el.className === "string" ? el.className : "",
          text: t,
        });
      }
      if (out.length >= 250) break;
    }
    return out;
  });

  console.log("----- CANDIDATES START -----");
  console.log(JSON.stringify(candidates, null, 2));
  console.log("----- CANDIDATES END -----");

  await page.screenshot({ path: "irakli-workshift.png", fullPage: true });
  console.log("Diagnostic completed. No Bilky click action was performed.");
} finally {
  await browser.close();
}
