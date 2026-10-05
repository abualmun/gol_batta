import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { BACKEND_PORT } from "../../playwright.config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const fixture = (name) => path.join(here, "..", "fixtures", name);
export const BACKEND_QUERY = `?backend=http://localhost:${BACKEND_PORT}`;

/** A separate browser context = a separate person, with the project's device settings. */
export async function newPerson(browser, testInfo, name, { baseURL = testInfo.project.use.baseURL } = {}) {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, colorScheme } = testInfo.project.use;
  const context = await browser.newContext({
    viewport,
    userAgent,
    deviceScaleFactor,
    isMobile,
    hasTouch,
    colorScheme,
    baseURL,
  });
  if (name) {
    await context.addInitScript((n) => localStorage.setItem("syncvid:name", n), name);
  }
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  return { context, page, name, errors };
}

/** Alice creates a room from the home page. Returns the room path. */
export async function createRoom(page, name) {
  await page.goto(`/${BACKEND_QUERY}`);
  await page.locator("#name-input").fill(name);
  await page.getByRole("button", { name: "Create a room" }).click();
  await expect(page).toHaveURL(/\/room\/[a-z0-9]{5}-[a-z0-9]{5}$/);
  await expect(page.locator("#partner-status-text")).toHaveText("Waiting for your friend to join");
  return new URL(page.url()).pathname;
}

export async function joinRoom(page, roomPath) {
  await page.goto(`${roomPath}${BACKEND_QUERY}`);
}

/** Pick the video file and press "Start watching". */
export async function loadVideoAndStart(page, file = "movie-a.webm") {
  await page.locator("#video-input").setInputFiles(fixture(file));
  await expect(page.locator("#file-status")).toContainText("Ready", { timeout: 20_000 });
  await page.getByRole("button", { name: "Start watching" }).click();
  await expect(page.locator("#screen-theater")).toBeVisible();
}

export const video = (page) => page.locator("#video");

export function videoState(page) {
  return video(page).evaluate((v) => ({ time: v.currentTime, paused: v.paused, muted: v.muted }));
}

/** Start playback as the user would (muted, so no browser blocks it). */
export async function userPlay(page) {
  await video(page).evaluate((v) => {
    v.muted = true;
    return v.play();
  });
}

export async function userPause(page) {
  await video(page).evaluate((v) => v.pause());
}

export async function userSeek(page, seconds) {
  await video(page).evaluate((v, s) => {
    v.currentTime = s;
  }, seconds);
}

/**
 * Wait until the follower is playing. If the browser blocked autoplay, the
 * "Tap to play along" button appears; tap it like a real person would.
 */
export async function expectPlaying(page) {
  const tap = page.locator("#tap-to-sync");
  await expect
    .poll(
      async () => {
        if (await tap.isVisible()) await tap.click();
        return (await videoState(page)).paused;
      },
      { timeout: 15_000 },
    )
    .toBe(false);
}

export async function expectPaused(page) {
  await expect.poll(async () => (await videoState(page)).paused, { timeout: 10_000 }).toBe(true);
}

/** Positions of two players are within `tolerance` seconds. */
export async function expectInSync(a, b, tolerance = 1) {
  await expect
    .poll(
      async () => {
        const [sa, sb] = await Promise.all([videoState(a), videoState(b)]);
        return Math.abs(sa.time - sb.time);
      },
      { timeout: 10_000 },
    )
    .toBeLessThan(tolerance);
}

export async function expectNoHorizontalScroll(page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, "page must not scroll sideways").toBeLessThanOrEqual(0);
}

/** Open the chat if it's in a drawer (phone landscape), then send a message. */
export async function sendChat(page, text) {
  const toggle = page.locator("#chat-toggle");
  if (await toggle.isVisible()) await toggle.click();
  await page.locator("#tab-chat").click();
  await page.getByLabel("Message").fill(text);
  await page.getByLabel("Message").press("Enter");
}

/** Fail if any uncaught JavaScript error happened in the page. */
export function expectNoPageErrors(...people) {
  for (const person of people) expect(person.errors, `${person.name}'s page errors`).toEqual([]);
}
