import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

export function productionBackendUrl() {
  const match = /const PRODUCTION_BACKEND_URL = "([^"]+)"/.exec(read("../../public/js/config.js"));
  return match[1];
}

export function productionCsp() {
  return /Content-Security-Policy = "([^"]+)"/.exec(read("../../../netlify.toml"))[1];
}

describe("deploy config", () => {
  it("the CSP allows the production backend (https and wss)", () => {
    const url = new URL(productionBackendUrl());
    const csp = productionCsp();
    assert.ok(csp.includes(`https://${url.host}`), `connect-src must include https://${url.host}`);
    assert.ok(csp.includes(`wss://${url.host}`), `connect-src must include wss://${url.host}`);
  });

  it("the backend URL has no trailing slash or path", () => {
    assert.match(productionBackendUrl(), /^https:\/\/[^/]+$/);
  });

  it("Netlify publishes only the public folder", () => {
    const toml = read("../../../netlify.toml");
    assert.match(toml, /base = "syncvid-frontend"/);
    assert.match(toml, /publish = "public"/);
  });
});
