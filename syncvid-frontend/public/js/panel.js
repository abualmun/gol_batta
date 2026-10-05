/**
 * Side panel: Chat and Activity tabs.
 */

import { CHAT_MAX_LENGTH } from "./config.js";
import { $, formatClock, h, toast } from "./ui.js";

const GROUP_WINDOW_MS = 3 * 60 * 1000;
const MAX_ACTIVITY_ITEMS = 200;

function isNearBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 48;
}

function scrollToBottom(el) {
  el.scrollTop = el.scrollHeight;
}

/** True if the element is rendered and not visibility:hidden (works for position:fixed too). */
function isShown(el) {
  if (typeof el.checkVisibility === "function") return el.checkVisibility({ visibilityProperty: true });
  const style = getComputedStyle(el);
  return style.visibility !== "hidden" && el.getClientRects().length > 0;
}

export function createPanel({ conn, getMyId }) {
  const panel = $("#side-panel");
  const tabs = {
    chat: { tab: $("#tab-chat"), view: $("#panel-chat") },
    activity: { tab: $("#tab-activity"), view: $("#panel-activity") },
  };
  const badge = $("#chat-badge");
  const chatList = $("#chat-list");
  const chatEmpty = $("#chat-empty");
  const form = $("#chat-form");
  const input = $("#chat-input");
  const sendButton = $("#chat-send");
  const activityList = $("#activity-list");

  let current = "chat";
  let unread = 0;
  let lastMessage = null; // { fromId, at } for grouping

  // ─── Tabs ──────────────────────────────────────────────────────────────────
  function isChatVisible() {
    return current === "chat" && isShown(panel) && !document.hidden;
  }

  function setUnread(n) {
    unread = n;
    badge.hidden = n === 0;
    badge.textContent = n > 9 ? "9+" : String(n);
    tabs.chat.tab.setAttribute("aria-label", n ? `Chat, ${n} unread` : "Chat");
    document.dispatchEvent(new CustomEvent("syncvid:unread", { detail: n }));
  }

  function select(name, { focus = false } = {}) {
    current = name;
    for (const [key, { tab, view }] of Object.entries(tabs)) {
      const selected = key === name;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      view.hidden = !selected;
    }
    if (focus) tabs[name].tab.focus();
    if (name === "chat") {
      setUnread(0);
      scrollToBottom(chatList);
    } else {
      scrollToBottom(activityList);
    }
  }

  for (const [name, { tab }] of Object.entries(tabs)) {
    tab.addEventListener("click", () => select(name));
  }
  // Arrow keys move between tabs (WAI-ARIA tabs pattern).
  $("#panel-tabs").addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    select(current === "chat" ? "activity" : "chat", { focus: true });
  });

  // ─── Chat ──────────────────────────────────────────────────────────────────
  function renderMessage(message) {
    const mine = message.from.id === getMyId();
    const grouped =
      lastMessage &&
      lastMessage.fromId === message.from.id &&
      message.at - lastMessage.at < GROUP_WINDOW_MS;
    lastMessage = { fromId: message.from.id, at: message.at };

    const stick = isNearBottom(chatList);
    chatEmpty.hidden = true;
    chatList.append(
      h(
        "li",
        { class: `msg ${mine ? "msg-you" : "msg-peer"}${grouped ? " msg-grouped" : ""}` },
        grouped
          ? null
          : h(
              "p",
              { class: "msg-meta" },
              h("span", { class: "msg-name" }, mine ? "You" : message.from.name),
              " ",
              h("time", { datetime: new Date(message.at).toISOString() }, formatClock(message.at)),
            ),
        h("p", { class: "msg-text" }, message.text),
      ),
    );
    if (stick || mine) scrollToBottom(chatList);
  }

  function addChatNotice(text) {
    lastMessage = null;
    chatList.append(h("li", { class: "msg msg-notice" }, text));
    if (isNearBottom(chatList)) scrollToBottom(chatList);
  }

  function resizeInput() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  }

  async function send() {
    const text = input.value.trim();
    if (!text || sendButton.disabled) return;
    if (!conn.socket.connected) {
      toast("Not connected — your message wasn't sent.", { tone: "warn" });
      return;
    }
    sendButton.disabled = true;
    try {
      const reply = await conn.emitWithAck("chat:send", { text });
      if (reply?.ok) {
        input.value = "";
        resizeInput();
      } else if (reply?.error === "rate_limited") {
        toast("You're sending messages too fast. Wait a moment.", { tone: "warn" });
      } else {
        toast("Your message wasn't sent. Try again.", { tone: "warn" });
      }
    } catch {
      toast("Your message wasn't sent. Try again.", { tone: "warn" });
    } finally {
      sendButton.disabled = false;
    }
  }

  input.maxLength = CHAT_MAX_LENGTH;
  input.addEventListener("input", resizeInput);
  input.addEventListener("keydown", (e) => {
    // isComposing: don't send while an input method (e.g. Arabic, Japanese) is mid-word.
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    send();
  });

  // ─── Activity ──────────────────────────────────────────────────────────────
  /** kind: "you" | "peer" | "system" | "warn" */
  function log(kind, text) {
    const stick = isNearBottom(activityList);
    const now = Date.now();
    activityList.append(
      h(
        "li",
        { class: `activity activity-${kind}` },
        h("time", { datetime: new Date(now).toISOString() }, formatClock(now)),
        h("span", {}, text),
      ),
    );
    while (activityList.children.length > MAX_ACTIVITY_ITEMS) activityList.firstElementChild.remove();
    if (stick) scrollToBottom(activityList);
  }

  return {
    /** Replace chat with the room's history (on join / rejoin). */
    loadHistory(messages) {
      chatList.replaceChildren();
      lastMessage = null;
      chatEmpty.hidden = messages.length > 0;
      messages.forEach(renderMessage);
    },
    receive(message) {
      renderMessage(message);
      if (message.from.id !== getMyId() && !isChatVisible()) setUnread(unread + 1);
    },
    addChatNotice,
    log,
    select,
    /** Call when the panel becomes visible (e.g. drawer opened). */
    shown() {
      if (current === "chat") setUnread(0);
    },
    setPeerName(name) {
      input.placeholder = name ? `Message ${name}` : "Write a message";
    },
    focusInput() {
      select("chat");
      input.focus();
    },
    clear() {
      chatList.replaceChildren();
      activityList.replaceChildren();
      chatEmpty.hidden = false;
      lastMessage = null;
      setUnread(0);
    },
  };
}
