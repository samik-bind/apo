// PROTOTYPE — throwaway screenshot runner for the System settings IA
// prototype (see ./NOTES.md). Shoots every ?variant= rendering with an
// injected admin session cookie. Dies with the prototype.
//
//   node src/app/settings/system/_prototype/screenshot.mjs http://localhost:3300
//
// Session token comes from PROTO_SESSION_TOKEN (raw JWT value).

import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const base = process.argv[2] ?? "http://localhost:3300";
const token = process.env.PROTO_SESSION_TOKEN;
if (!token) {
  console.error("PROTO_SESSION_TOKEN (authjs.session-token value) required");
  process.exit(1);
}

const outDir = new URL("./shots/", import.meta.url);
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  // Local cache has full-chromium builds from other Playwright versions;
  // point at one instead of downloading the matching headless shell.
  executablePath:
    process.env.PLAYWRIGHT_CHROMIUM ??
    `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  colorScheme: "dark",
});
await context.addCookies([
  { name: "authjs.session-token", value: token, url: base },
]);

for (const [key, name] of [
  ["current", "current"],
  ["a", "variant-a"],
  ["b", "variant-b"],
  ["c", "variant-c"],
]) {
  const page = await context.newPage();
  await page.goto(`${base}/settings/system?variant=${key}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(1500);
  await page.screenshot({
    path: new URL(`${name}.png`, outDir).pathname,
    fullPage: true,
  });
  await page.close();
  console.log(`shot ${name}`);
}

await browser.close();
