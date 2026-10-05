import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { fingerprintFile, sha256Fallback } from "../../public/js/hash.js";

const nodeHex = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hex = (bytes) => Buffer.from(bytes).toString("hex");

describe("sha256Fallback", () => {
  it("matches Node's SHA-256 for every padding edge case", () => {
    for (const len of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 100_003]) {
      const bytes = randomBytes(len);
      assert.equal(hex(sha256Fallback(new Uint8Array(bytes))), nodeHex(bytes), `length ${len}`);
    }
  });

  it("matches the known digest of 'abc'", () => {
    assert.equal(
      hex(sha256Fallback(new TextEncoder().encode("abc"))),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("fingerprintFile", () => {
  it("hashes only the first sampleBytes", async () => {
    const bytes = randomBytes(5000);
    const file = new Blob([bytes]);
    assert.equal(await fingerprintFile(file, 1000), nodeHex(bytes.subarray(0, 1000)));
    assert.equal(await fingerprintFile(file, 1e9), nodeHex(bytes));
  });
});
