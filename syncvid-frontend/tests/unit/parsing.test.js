import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateClientId, generateRoomId, normalizeRoomId, parseRoomInput, roomIdFromPath } from "../../public/js/ids.js";
import {
  buildVtt,
  decodeSubtitleBytes,
  formatVttTimestamp,
  parseSubtitles,
  parseTimestamp,
} from "../../public/js/subtitles-parse.js";

describe("room ids", () => {
  it("generates readable ids the server accepts", () => {
    for (let i = 0; i < 200; i++) {
      const id = generateRoomId();
      assert.match(id, /^[a-hj-km-np-z2-9]{5}-[a-hj-km-np-z2-9]{5}$/);
      assert.equal(normalizeRoomId(id), id);
    }
  });

  it("parses links and codes", () => {
    assert.equal(parseRoomInput("https://syncvid.netlify.app/room/ABCDE-fghij"), "abcde-fghij");
    assert.equal(parseRoomInput("  abcde-fghij "), "abcde-fghij");
    assert.equal(parseRoomInput("http://192.168.1.5:5173/room/abcd/"), "abcd");
    assert.equal(parseRoomInput("not a code!"), null);
    assert.equal(parseRoomInput(""), null);
  });

  it("reads the room from the path", () => {
    assert.equal(roomIdFromPath("/room/abcde-fghij"), "abcde-fghij");
    assert.equal(roomIdFromPath("/room/abcde-fghij/"), "abcde-fghij");
    assert.equal(roomIdFromPath("/"), null);
    assert.equal(roomIdFromPath("/room/"), null);
    assert.equal(roomIdFromPath("/room/a/b"), null);
  });

  it("generates client ids the server accepts", () => {
    assert.match(generateClientId(), /^[A-Za-z0-9_-]{16,64}$/);
  });
});

describe("subtitle parsing", () => {
  it("parses timestamps", () => {
    assert.equal(parseTimestamp("01:02:03,450"), 3723.45);
    assert.equal(parseTimestamp("02:03.4"), 123.4);
    assert.equal(parseTimestamp("00:00:01.5"), 1.5);
    assert.equal(formatVttTimestamp(3723.45), "01:02:03.450");
    assert.equal(formatVttTimestamp(-3), "00:00:00.000");
  });

  it("parses SRT, including CRLF, BOM and space-only separator lines", () => {
    const srt = "\uFEFF1\r\n00:00:01,000 --> 00:00:04,000\r\nHello\r\nthere\r\n \r\n2\r\n00:00:05,500 --> 00:00:07,000\r\n<i>Bye</i>\r\n";
    assert.deepEqual(parseSubtitles(srt), [
      { start: 1, end: 4, text: "Hello\nthere" },
      { start: 5.5, end: 7, text: "<i>Bye</i>" },
    ]);
  });

  it("parses WebVTT with ids, settings and NOTE blocks", () => {
    const vtt = "WEBVTT - film\n\nNOTE a comment\n\nintro\n00:01.000 --> 00:02.000 align:start\nHi\n\n00:00:03.000 --> 00:00:04.000\nThere\n";
    assert.deepEqual(parseSubtitles(vtt), [
      { start: 1, end: 2, text: "Hi" },
      { start: 3, end: 4, text: "There" },
    ]);
  });

  it("skips broken cues", () => {
    const srt = "1\n00:00:05,000 --> 00:00:04,000\nBackwards\n\n2\n00:00:06,000 --> 00:00:07,000\n\n3\nnot a time\ntext";
    assert.deepEqual(parseSubtitles(srt), []);
  });

  it("builds shifted WebVTT and drops cues that end before zero", () => {
    const cues = [
      { start: 1, end: 2, text: "gone" },
      { start: 2, end: 5, text: "a --> b" },
    ];
    assert.equal(
      buildVtt(cues, -2.5),
      "WEBVTT\n\n00:00:00.000 --> 00:00:02.500\na -> b\n",
    );
    assert.equal(parseSubtitles(buildVtt(cues, 1)).length, 2, "output round-trips");
  });

  it("decodes UTF-8, Windows-1256 Arabic and Windows-1252", () => {
    assert.equal(decodeSubtitleBytes(new TextEncoder().encode("héllo")), "héllo");
    // "مرحبا" in windows-1256
    assert.equal(decodeSubtitleBytes(new Uint8Array([0xe3, 0xd1, 0xcd, 0xc8, 0xc7])), "مرحبا");
    // "café" in windows-1252
    assert.equal(decodeSubtitleBytes(new Uint8Array([0x63, 0x61, 0x66, 0xe9])), "café");
    // UTF-16LE with BOM
    assert.equal(decodeSubtitleBytes(new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00])), "hi");
  });
});
