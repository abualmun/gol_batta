/**
 * Small DOM helpers. Text is always inserted with textContent — never as HTML.
 */

export const $ = (selector, root = document) => root.querySelector(selector);

/** Create an element with properties/attributes and children (strings become text). */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "dataset") Object.assign(el.dataset, value);
    else if (key in el && typeof value !== "string") el[key] = value;
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** 75.4 → "1:15", 3725 → "1:02:05" */
export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "–:––";
  const total = Math.floor(seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, "0");
  return hrs > 0 ? `${hrs}:${String(mins).padStart(2, "0")}:${secs}` : `${mins}:${secs}`;
}

/** "14:05" in the user's locale. */
export function formatClock(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ─── Toasts ──────────────────────────────────────────────────────────────────
const TOAST_MS = 3200;

export function toast(message, { tone = "neutral" } = {}) {
  const region = $("#toasts");
  const item = h("div", { class: `toast toast-${tone}` }, message);
  region.append(item);
  // Keep at most 3 on screen.
  while (region.children.length > 3) region.firstElementChild.remove();
  setTimeout(() => {
    item.classList.add("leaving");
    setTimeout(() => item.remove(), 250);
  }, TOAST_MS);
}

// ─── Copy & share ────────────────────────────────────────────────────────────
function legacyCopy(text) {
  const area = h("textarea", { readonly: true });
  // Set through the style object: a style="" attribute would be blocked by the CSP.
  Object.assign(area.style, { position: "fixed", opacity: "0", top: "0", left: "0" });
  area.value = text;
  document.body.append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied etc. — try the old way.
  }
  return legacyCopy(text);
}

/** Phones/tablets: whether the native share sheet should be used. */
export function canNativeShare() {
  return typeof navigator.share === "function" && matchMedia("(pointer: coarse)").matches;
}

/**
 * Share a link with the native share sheet on touch devices, otherwise copy it.
 * @returns {"shared" | "copied" | "cancelled" | "failed"}
 */
export async function shareLink(url, title) {
  if (canNativeShare()) {
    try {
      await navigator.share({ title, url });
      return "shared";
    } catch (err) {
      if (err?.name === "AbortError") return "cancelled";
      // Fall back to copying.
    }
  }
  return (await copyText(url)) ? "copied" : "failed";
}

// ─── Storage (never throws) ──────────────────────────────────────────────────
export const storage = {
  get(area, key) {
    try {
      return window[area].getItem(key);
    } catch {
      return null;
    }
  },
  set(area, key, value) {
    try {
      window[area].setItem(key, value);
    } catch {
      // Private mode / blocked storage: the app still works, it just won't remember.
    }
  },
};

/** Announce a message to screen readers without showing it. */
export function announce(message) {
  const region = $("#sr-announcer");
  region.textContent = "";
  // A separate frame makes screen readers notice repeated identical messages.
  requestAnimationFrame(() => {
    region.textContent = message;
  });
}
