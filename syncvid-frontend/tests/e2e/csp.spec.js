import { expect, test } from "@playwright/test";
import { CSP_FRONTEND_PORT } from "../../playwright.config.js";
import {
  BACKEND_QUERY,
  createRoom,
  expectNoPageErrors,
  expectPlaying,
  fixture,
  joinRoom,
  loadVideoAndStart,
  newPerson,
  sendChat,
  userPlay,
} from "./helpers.js";

// This server sends the exact Content-Security-Policy from netlify.toml
// (backend URL swapped for the test backend). See playwright.config.js.
const cspSite = { baseURL: `http://localhost:${CSP_FRONTEND_PORT}` };

async function recordViolations(person) {
  person.violations = [];
  await person.page.exposeFunction("__cspViolation", (v) => person.violations.push(v));
  await person.context.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) =>
      window.__cspViolation(`${e.violatedDirective} ${e.blockedURI}`),
    );
  });
}

test("the app works under the production Content-Security-Policy", async ({ browser }, testInfo) => {
  test.skip(!["desktop-chrome", "desktop-firefox", "iphone"].includes(testInfo.project.name), "one run per engine");
  const alice = await newPerson(browser, testInfo, "Alice", cspSite);
  const bob = await newPerson(browser, testInfo, "Bob", cspSite);
  await recordViolations(alice);
  await recordViolations(bob);

  const response = await alice.page.goto(`/${BACKEND_QUERY}`);
  expect(response.headers()["content-security-policy"]).toContain("default-src 'self'");

  const roomPath = await createRoom(alice.page, "Alice");
  await alice.page.locator("summary", { hasText: "Add subtitles" }).click();
  await alice.page.locator("#room-setup .subs-file-input").setInputFiles(fixture("subs.srt"));
  await loadVideoAndStart(alice.page);
  await joinRoom(bob.page, roomPath);
  await loadVideoAndStart(bob.page);
  await sendChat(bob.page, "csp ok?");
  await expect(alice.page.locator("#chat-list")).toContainText("csp ok?");
  await userPlay(alice.page);
  await expectPlaying(bob.page);
  await expect
    .poll(() => alice.page.locator("#video").evaluate((v) => v.textTracks[0]?.cues?.length ?? 0))
    .toBe(2);

  expect(alice.violations, "Alice's CSP violations").toEqual([]);
  expect(bob.violations, "Bob's CSP violations").toEqual([]);
  expectNoPageErrors(alice, bob);
  await alice.context.close();
  await bob.context.close();
});
