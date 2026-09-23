import fs from "node:fs";
import {
  createBilkyCore,
  getMadridDate,
  log,
} from "./bilky-core.js";

const {
  BILKY_NIF,
  BILKY_PASSWORD,
  BROWSERLESS_TOKEN,
} = process.env;

for (const [name, value] of Object.entries({
  BILKY_NIF,
  BILKY_PASSWORD,
  BROWSERLESS_TOKEN,
})) {
  if (!value) throw new Error(`Missing environment variable: ${name}`);
}

const targetDate = getMadridDate();

const bilky = createBilkyCore({
  nif: BILKY_NIF,
  password: BILKY_PASSWORD,
  browserlessToken: BROWSERLESS_TOKEN,
});

async function main() {
  log(`PREFLIGHT TARGET_DATE=${targetDate}`);
  log("PREFLIGHT MODE=READ-ONLY; CLOCK BUTTON WILL NOT BE CLICKED");

  const result = await bilky.runWithRetries(
    "Bilky preflight",
    async ({ page, setStage }) => {
      setStage("read-current-state");
      const state = await bilky.readDayState(page, targetDate);
      bilky.printState(state);

      const checks = {
        morningFactPresent: Boolean(state.morning.fact),
        eveningPlanIs1600: state.evening.planned === "16:00",
        eveningButtonExists: Boolean(state.evening.buttonExists),
        eveningButtonEnabled: Boolean(state.evening.buttonEnabled),
      };

      log(`PREFLIGHT CHECKS ${JSON.stringify(checks)}`);

      if (!checks.morningFactPresent) {
        throw new Error("Preflight failed: morning fact is missing");
      }
      if (!checks.eveningPlanIs1600) {
        throw new Error(`Preflight failed: evening plan is ${state.evening.planned}`);
      }
      if (!checks.eveningButtonExists) {
        throw new Error("Preflight failed: evening Clock button does not exist");
      }
      if (!checks.eveningButtonEnabled) {
        throw new Error("Preflight failed: evening Clock button is disabled");
      }

      return {
        date: targetDate,
        morningFact: state.morning.fact,
        eveningPlan: state.evening.planned,
        eveningButtonExists: state.evening.buttonExists,
        eveningButtonEnabled: state.evening.buttonEnabled,
      };
    }
  );

  fs.writeFileSync("preflight-result.json", JSON.stringify(result, null, 2), "utf8");
  log("PREFLIGHT SUCCESS — NO CLOCK CLICK PERFORMED");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
