import { expect, test } from "@playwright/test";
import {
  BACKEND_QUERY,
  createRoom,
  expectInSync,
  expectNoHorizontalScroll,
  expectNoPageErrors,
  expectPaused,
  expectPlaying,
  fixture,
  joinRoom,
  loadVideoAndStart,
  newPerson,
  sendChat,
  userPause,
  userPlay,
  userSeek,
  videoState,
} from "./helpers.js";

test.describe("watching together", () => {
  let alice;
  let bob;

  test.beforeEach(async ({ browser }, testInfo) => {
    alice = await newPerson(browser, testInfo, "Alice");
    bob = await newPerson(browser, testInfo, "Bob");
  });

  test.afterEach(async () => {
    await alice.context.close();
    await bob.context.close();
  });

  test("play, pause and seek follow each other both ways", async () => {
    const roomPath = await createRoom(alice.page, "Alice");
    await loadVideoAndStart(alice.page);

    await joinRoom(bob.page, roomPath);
    await expect(bob.page.locator("#partner-status-text")).toHaveText("Alice is here");
    await expect(alice.page.locator("#bar-partner-text")).toHaveText("Bob is here");
    await loadVideoAndStart(bob.page);

    // Alice plays → Bob plays
    await userPlay(alice.page);
    await expectPlaying(bob.page);
    await expectInSync(alice.page, bob.page);
    await expect(bob.page.locator("#activity-list")).toContainText("Alice pressed play");

    // Alice pauses → Bob pauses at the same spot
    await userPause(alice.page);
    await expectPaused(bob.page);
    await expectInSync(alice.page, bob.page, 0.6);

    // Alice jumps while paused → Bob jumps, stays paused
    await userSeek(alice.page, 30);
    await expect.poll(async () => (await videoState(bob.page)).time, { timeout: 10_000 }).toBeGreaterThan(29);
    expect((await videoState(bob.page)).paused).toBe(true);

    // Bob plays, then jumps while playing → Alice follows and keeps playing (spec bug #3)
    await userPlay(bob.page);
    await expectPlaying(alice.page);
    await userSeek(bob.page, 10);
    await expect
      .poll(async () => (await videoState(alice.page)).time, { timeout: 10_000 })
      .toBeLessThan(15);
    expect((await videoState(alice.page)).paused).toBe(false);
    await expectInSync(alice.page, bob.page);

    await expect(alice.page.locator("#strip-status")).toHaveText(/In sync/, { timeout: 15_000 });
    expectNoPageErrors(alice, bob);
  });

  test("someone who joins late starts at the right place (spec bug #2)", async () => {
    const roomPath = await createRoom(alice.page, "Alice");
    await loadVideoAndStart(alice.page);
    await userSeek(alice.page, 20);
    await userPlay(alice.page);
    await alice.page.waitForTimeout(2000);

    await joinRoom(bob.page, roomPath);
    await loadVideoAndStart(bob.page);
    await expectPlaying(bob.page);
    await expectInSync(alice.page, bob.page);
    expect((await videoState(bob.page)).time).toBeGreaterThan(21);
    expectNoPageErrors(alice, bob);
  });

  test("the player that drifts ahead steps back (never forward)", async () => {
    const roomPath = await createRoom(alice.page, "Alice");
    await loadVideoAndStart(alice.page);
    await joinRoom(bob.page, roomPath);
    await loadVideoAndStart(bob.page);

    await userPlay(alice.page);
    await expectPlaying(bob.page);
    await expectInSync(alice.page, bob.page);

    // Make Alice run fast without telling anyone (like a stalled partner).
    await alice.page.locator("#video").evaluate((v) => {
      v.playbackRate = 2;
    });
    await expect(alice.page.locator("#activity-list")).toContainText("stepped back to match", {
      timeout: 20_000,
    });
    await alice.page.locator("#video").evaluate((v) => {
      v.playbackRate = 1;
    });
    await expectInSync(alice.page, bob.page, 1.6);
    // Bob was behind: his player must not have jumped (no forward skipping).
    await expect(bob.page.locator("#activity-list")).not.toContainText("stepped back");
    expectNoPageErrors(alice, bob);
  });

  test("chat messages reach the partner, with unread count", async () => {
    const roomPath = await createRoom(alice.page, "Alice");
    await loadVideoAndStart(alice.page);
    await joinRoom(bob.page, roomPath);
    await loadVideoAndStart(bob.page);

    await bob.page.locator("#tab-activity").click();
    await sendChat(alice.page, "Hi Bob <b>not bold</b>");
    await expect(alice.page.locator("#chat-list")).toContainText("Hi Bob <b>not bold</b>");
    await expect(bob.page.locator("#chat-badge")).toHaveText("1");

    await bob.page.locator("#tab-chat").click();
    await expect(bob.page.locator("#chat-badge")).toBeHidden();
    const message = bob.page.locator("#chat-list .msg-peer").last();
    await expect(message).toContainText("Alice");
    await expect(message).toContainText("Hi Bob <b>not bold</b>");
    // Shown as text, never as HTML.
    await expect(bob.page.locator("#chat-list b")).toHaveCount(0);
    expectNoPageErrors(alice, bob);
  });

  test("different files show a warning that names both files", async () => {
    const roomPath = await createRoom(alice.page, "Alice");
    await loadVideoAndStart(alice.page, "movie-a.webm");
    await joinRoom(bob.page, roomPath);
    await loadVideoAndStart(bob.page, "movie-b.webm");

    for (const [page, other] of [
      [alice.page, "Bob"],
      [bob.page, "Alice"],
    ]) {
      await expect(page.locator("#mismatch-banner")).toBeVisible();
      await expect(page.locator("#mismatch-detail")).toContainText(`${other} has`);
      await expect(page.locator("#mismatch-detail")).toContainText("different lengths");
    }
    await alice.page.getByRole("button", { name: "Dismiss warning" }).click();
    await expect(alice.page.locator("#mismatch-banner")).toBeHidden();
    expectNoPageErrors(alice, bob);
  });

  test("partner leaving is reported after a short grace period", async () => {
    const roomPath = await createRoom(alice.page, "Alice");
    await joinRoom(bob.page, roomPath);
    await expect(alice.page.locator("#partner-status-text")).toHaveText("Bob is here");

    await bob.page.goto("about:blank");
    await expect(alice.page.locator("#partner-status-text")).toHaveText("Bob lost connection…");
    await expect(alice.page.locator("#partner-status-text")).toHaveText("Waiting for your friend to join", {
      timeout: 10_000,
    });
    expectNoPageErrors(alice);
  });
});

test.describe("rooms", () => {
  test("a third person sees that the room is full", async ({ browser }, testInfo) => {
    const people = await Promise.all(
      ["Alice", "Bob", "Eve"].map((n) => newPerson(browser, testInfo, n)),
    );
    const [alice, bob, eve] = people;
    const roomPath = await createRoom(alice.page, "Alice");
    await joinRoom(bob.page, roomPath);
    await expect(bob.page.locator("#partner-status-text")).toHaveText("Alice is here");

    await joinRoom(eve.page, roomPath);
    await expect(eve.page.getByRole("heading", { name: "This room is full" })).toBeVisible();
    await eve.page.getByRole("button", { name: "Create a new room" }).click();
    await expect(eve.page).not.toHaveURL(new RegExp(roomPath));
    await expect(eve.page.locator("#partner-status-text")).toHaveText("Waiting for your friend to join");
    expectNoPageErrors(...people);
    await Promise.all(people.map((p) => p.context.close()));
  });

  test("joining with a code, and helpful errors", async ({ browser }, testInfo) => {
    const alice = await newPerson(browser, testInfo, null);
    const page = alice.page;
    await page.goto(`/${BACKEND_QUERY}`);

    await page.getByRole("button", { name: "Join" }).click();
    await expect(page.locator("#name-error")).toContainText("Enter your name");

    await page.locator("#name-input").fill("Alice");
    await page.locator("#join-input").fill("not valid!");
    await page.getByRole("button", { name: "Join" }).click();
    await expect(page.locator("#join-error")).toContainText("doesn't look like a room link");

    await page.locator("#join-input").fill("https://example.com/room/ABCDE-fghij");
    await page.getByRole("button", { name: "Join" }).click();
    await expect(page).toHaveURL(/\/room\/abcde-fghij$/);
    await expect(page.locator("#partner-status-text")).toHaveText("Waiting for your friend to join");

    // Name is remembered for next time.
    await page.goto(`/${BACKEND_QUERY}`);
    await expect(page.locator("#name-input")).toHaveValue("Alice");
    expectNoPageErrors(alice);
    await alice.context.close();
  });

  test("opening a shared link without a saved name asks for one", async ({ browser }, testInfo) => {
    const guest = await newPerson(browser, testInfo, null);
    await guest.page.goto(`/room/abcde-23456${BACKEND_QUERY}`);
    await expect(guest.page.locator("#partner-status-text")).toHaveText("Enter your name to join");
    await guest.page.locator("#room-name-input").fill("Guest");
    await guest.page.getByRole("button", { name: "Join room" }).click();
    await expect(guest.page.locator("#partner-status-text")).toHaveText("Waiting for your friend to join");
    expectNoPageErrors(guest);
    await guest.context.close();
  });

  test("rejects files that aren't videos", async ({ browser }, testInfo) => {
    const alice = await newPerson(browser, testInfo, "Alice");
    await createRoom(alice.page, "Alice");
    await alice.page.locator("#video-input").setInputFiles(fixture("subs.srt"));
    await expect(alice.page.locator("#file-status")).toContainText("isn't a video file");
    await expect(alice.page.getByRole("button", { name: "Start watching" })).toBeDisabled();
    await alice.context.close();
  });
});

test.describe("subtitles", () => {
  test("load, shift and hide subtitles", async ({ browser }, testInfo) => {
    const alice = await newPerson(browser, testInfo, "Alice");
    const page = alice.page;
    await createRoom(page, "Alice");

    await page.locator("summary", { hasText: "Add subtitles" }).click();
    await page.locator("#room-setup .subs-file-input").setInputFiles(fixture("subs.srt"));
    await expect(page.locator("#room-setup .subs-status")).toHaveText("subs.srt (2 lines)");
    await loadVideoAndStart(page);

    const cues = () =>
      page.locator("#video").evaluate((v) => {
        const track = [...v.textTracks].find((t) => t.mode !== "disabled");
        return track ? { mode: track.mode, first: track.cues?.[0]?.startTime ?? null } : null;
      });
    await expect.poll(async () => (await cues())?.first).toBe(1);
    expect((await cues()).mode).toBe("showing");

    await page.locator("#subs-btn").click();
    const dialog = page.getByRole("dialog", { name: "Subtitles" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Show later" }).click();
    await expect(dialog.locator("#subs-offset")).toHaveText("0.5 s later");
    await expect.poll(async () => (await cues())?.first).toBe(1.5);

    await dialog.getByLabel("Show subtitles").uncheck();
    await expect.poll(async () => (await cues())?.mode).toBe("hidden");
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toBeHidden();
    expectNoPageErrors(alice);
    await alice.context.close();
  });
});

test.describe("layout", () => {
  test("every screen fits the device without sideways scrolling", async ({ browser }, testInfo) => {
    const alice = await newPerson(browser, testInfo, "Alice");
    const bob = await newPerson(browser, testInfo, "Bob");
    const page = alice.page;
    const shot = async (name) => {
      const file = testInfo.outputPath(`${name}.png`);
      await page.screenshot({ path: file });
      await testInfo.attach(name, { path: file, contentType: "image/png" });
    };

    await page.goto(`/${BACKEND_QUERY}`);
    await expectNoHorizontalScroll(page);
    await shot("home");

    const roomPath = await createRoom(page, "Alice");
    await expectNoHorizontalScroll(page);
    await shot("room");

    await joinRoom(bob.page, roomPath);
    await loadVideoAndStart(page);
    await loadVideoAndStart(bob.page);
    await sendChat(bob.page, "Ready when you are!");
    await expect(page.locator("#chat-list")).toContainText("Ready when you are!");
    await expectNoHorizontalScroll(page);

    // The video and the bar must both be fully on screen.
    const viewport = page.viewportSize();
    for (const selector of ["#stage", ".theater-bar"]) {
      const box = await page.locator(selector).boundingBox();
      expect(box.y, `${selector} top`).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height, `${selector} bottom`).toBeLessThanOrEqual(viewport.height + 1);
    }
    // The bar sits on the bottom edge and stays compact (no stretched rows).
    const bar = await page.locator(".theater-bar").boundingBox();
    expect(Math.abs(bar.y + bar.height - viewport.height)).toBeLessThanOrEqual(1);
    expect(bar.height).toBeLessThan(100);
    await shot("theater");
    expectNoPageErrors(alice, bob);
    await alice.context.close();
    await bob.context.close();
  });
});

test.describe("phone in landscape", () => {
  test("video fills the screen and chat opens as a drawer", async ({ browser }, testInfo) => {
    const shortSide = Math.min(testInfo.project.use.viewport.width, testInfo.project.use.viewport.height);
    test.skip(!testInfo.project.use.isMobile || shortSide > 540, "phones only (tablets keep the side panel)");
    const alice = await newPerson(browser, testInfo, "Alice");
    const bob = await newPerson(browser, testInfo, "Bob");
    const page = alice.page;
    const { width, height } = testInfo.project.use.viewport;
    await page.setViewportSize({ width: height, height: width });

    const roomPath = await createRoom(page, "Alice");
    await joinRoom(bob.page, roomPath);
    await loadVideoAndStart(page);
    await loadVideoAndStart(bob.page);
    await expectNoHorizontalScroll(page);

    const stage = await page.locator("#stage").boundingBox();
    expect(stage.height, "video uses most of the screen height").toBeGreaterThan(width * 0.6);
    await expect(page.locator("#side-panel")).toBeHidden();

    // A message while the drawer is closed: badge on the Chat button.
    await sendChat(bob.page, "Look at this part");
    await expect(page.locator("#chat-toggle-badge")).toHaveText("1");

    await page.locator("#chat-toggle").click();
    await expect(page.locator("#side-panel")).toBeVisible();
    await expect(page.locator("#chat-list")).toContainText("Look at this part");
    await expect(page.locator("#chat-toggle-badge")).toBeHidden();
    await expect(page.getByLabel("Message")).toBeFocused();
    await testInfo.attach("landscape-drawer", { body: await page.screenshot(), contentType: "image/png" });

    await page.getByRole("button", { name: "Close chat" }).click();
    await expect(page.locator("#side-panel")).toBeHidden();
    expectNoPageErrors(alice, bob);
    await alice.context.close();
    await bob.context.close();
  });
});
