import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

// Terminals inside the VS Code *snap* point these at the snap's own libraries, which makes
// WebKit's network process crash ("WebKit encountered an internal error"). Browsers launched
// by the tests inherit this environment, so drop snap-only values.
for (const key of ["GIO_MODULE_DIR", "GTK_PATH", "LOCPATH", "GTK_IM_MODULE_FILE", "GTK_EXE_PREFIX"]) {
  if (process.env[key]?.includes("/snap/")) delete process.env[key];
}

// Test servers use their own ports so they never clash with `npm start` / `npm run dev`.
export const BACKEND_PORT = 3101;
export const FRONTEND_PORT = 5174;
/** Same site, but served with the production Content-Security-Policy from netlify.toml. */
export const CSP_FRONTEND_PORT = 5175;

function writeCspServeConfig() {
  const toml = readFileSync(new URL("../netlify.toml", import.meta.url), "utf8");
  const csp = /Content-Security-Policy = "([^"]+)"/
    .exec(toml)[1]
    .replace(/https:\/\/[^\s;]+\.onrender\.com/g, `http://localhost:${BACKEND_PORT}`)
    .replace(/wss:\/\/[^\s;]+\.onrender\.com/g, `ws://localhost:${BACKEND_PORT}`);
  const base = JSON.parse(readFileSync(new URL("./serve.json", import.meta.url), "utf8"));
  const dir = new URL("./tests/e2e/.generated/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    new URL("serve-csp.json", dir),
    JSON.stringify({ ...base, headers: [{ source: "**", headers: [{ key: "Content-Security-Policy", value: csp }] }] }, null, 2),
  );
}
writeCspServeConfig();

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 2,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://localhost:${FRONTEND_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop-chrome", use: { ...devices["Desktop Chrome"] } },
    { name: "desktop-firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "android-pixel", use: { ...devices["Pixel 7"] } },
    { name: "iphone", use: { ...devices["iPhone 14"] } },
    { name: "ipad", use: { ...devices["iPad Pro 11"] } },
  ],
  webServer: [
    {
      command: "node server.js",
      cwd: "../syncvid-backend",
      env: { PORT: String(BACKEND_PORT), NODE_ENV: "test" },
      url: `http://localhost:${BACKEND_PORT}/health`,
      reuseExistingServer: false,
    },
    {
      command: `npx serve -c ../serve.json -l ${FRONTEND_PORT} public`,
      url: `http://localhost:${FRONTEND_PORT}`,
      reuseExistingServer: false,
    },
    {
      command: `npx serve -c ../tests/e2e/.generated/serve-csp.json -l ${CSP_FRONTEND_PORT} public`,
      url: `http://localhost:${CSP_FRONTEND_PORT}`,
      reuseExistingServer: false,
    },
  ],
});
