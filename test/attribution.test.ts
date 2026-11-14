import assert from "node:assert/strict";
import test from "node:test";

import {
  attributeDownloads,
  BrowserDownloadCollector,
  computeDigest,
  computeSha256,
} from "../index.ts";

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function sha256Base64(hex: string): string {
  const binary = hex
    .match(/.{2}/g)!
    .map((pair) => String.fromCharCode(Number.parseInt(pair, 16)))
    .join("");
  return btoa(binary);
}

function makeCollector(): BrowserDownloadCollector {
  return new BrowserDownloadCollector({ now: () => 10_000 });
}

test("associates action, popup, redirect, Content-Disposition, download and file", async () => {
  const collector = makeCollector();
  const payload = bytes("hello world!");
  const sha256 = await computeSha256(payload);

  collector.trackAction({
    id: "a1",
    at: 100,
    kind: "click",
    url: "https://shop.example/download",
    tabId: 7,
  });
  collector.trackPopup({
    id: "p1",
    at: 105,
    actionId: "a1",
    url: "https://shop.example/file.zip",
    tabId: 8,
    openerTabId: 7,
  });
  collector.trackResponse({
    id: "net-1",
    requestId: "r1",
    at: 121,
    startedAt: 106,
    url: "https://shop.example/file.zip",
    finalUrl: "https://cdn.example/objects/report.zip?sig=abc",
    status: 200,
    redirectChain: [
      { url: "https://shop.example/file.zip", at: 106, status: 302 },
      {
        url: "https://cdn.example/objects/report.zip?sig=abc",
        at: 110,
        status: 200,
      },
    ],
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(payload.byteLength),
      "Content-Disposition": "attachment; filename=\"report.zip\"",
      "Content-Digest": `sha-256=:${sha256Base64(sha256)}:`,
    },
    requestInitiator: "https://shop.example/download",
    tabId: 7,
  });
  collector.trackDownload({
    id: "d1",
    at: 130,
    url: "https://cdn.example/objects/report.zip?sig=abc",
    filename: "report.zip",
    mime: "application/zip",
    totalBytes: payload.byteLength,
    tabId: 7,
  });

  const result = await collector.completeFile({
    downloadId: "d1",
    bytes: payload,
  });

  assert.equal(result.state, "verified");
  assert.equal(result.verified, true);
  assert.equal(result.finalized, true);
  assert.equal(result.response?.requestId, "r1");
  assert.equal(result.action?.id, "a1");
  assert.equal(result.popup?.id, "p1");
  assert.equal(result.filename, "report.zip");
  assert.equal(result.size, payload.byteLength);
  assert.equal(result.sha256, sha256);
  assert.equal(result.file?.status, "verified");
  assert.equal(result.file?.sizeMatches, true);
  assert.equal(result.file?.digestMatches["sha-256"], true);
  assert.ok(result.matchedBy.includes("url-exact"));
  assert.ok(result.matchedBy.includes("popup-url-exact"));
});

test("a response only claims a download when URL and causal time constraints hold", () => {
  const collector = makeCollector();

  collector.trackAction({
    id: "a1",
    at: 1_000,
    url: "https://files.example/wanted.zip",
  });
  collector.trackResponse({
    requestId: "unrelated",
    at: 1_010,
    url: "https://files.example/other.zip",
  });
  const result = collector.trackDownload({
    id: "d1",
    at: 1_020,
    url: "https://files.example/wanted.zip",
    filename: "wanted.zip",
  });

  assert.equal(result.state, "pending");
  assert.equal(result.response, undefined);
  assert.equal(result.determined, false);
  const candidates = collector.candidatesForAction("a1");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.eligible, false);
  assert.ok(candidates[0]?.rejections.includes("action-url-mismatch"));
});

test("a response observed before the user action cannot claim", () => {
  const collector = makeCollector();

  collector.trackAction({
    id: "a1",
    at: 300,
    url: "https://files.example/later.zip",
  });
  collector.trackResponse({
    requestId: "early",
    at: 250,
    url: "https://files.example/later.zip",
  });
  const result = collector.trackDownload({
    id: "d1",
    at: 400,
    url: "https://files.example/later.zip",
  });

  assert.equal(result.state, "pending");
  assert.equal(result.response, undefined);
  assert.ok(
    collector
      .candidatesForAction("a1")
      .some((candidate) =>
        candidate.rejections.includes("response-before-action"),
      ),
  );
});

test("one action can produce multiple download candidates", () => {
  const collector = makeCollector();

  collector.trackAction({
    id: "a1",
    at: 500,
    url: "https://files.example/bundle.zip",
  });
  collector.trackResponse({
    requestId: "r1",
    at: 510,
    url: "https://files.example/bundle.zip",
  });
  collector.trackResponse({
    requestId: "r2",
    at: 511,
    url: "https://files.example/bundle.zip",
  });

  const first = collector.trackDownload({
    id: "d1",
    at: 520,
    requestId: "r1",
    url: "https://files.example/bundle.zip",
  });
  const second = collector.trackDownload({
    id: "d2",
    at: 530,
    requestId: "r2",
    url: "https://files.example/bundle.zip",
  });

  assert.equal(first.response?.requestId, "r1");
  assert.equal(second.response?.requestId, "r2");
  assert.deepEqual(
    collector.attributionsForAction("a1").map((item) => item.downloadId).sort(),
    ["d1", "d2"],
  );
  const candidates = collector.candidatesForAction("a1");
  assert.equal(candidates.length, 2);
  assert.ok(candidates.every((candidate) => candidate.eligible));
});

test("Content-Disposition filename* participates in association", async () => {
  const collector = makeCollector();
  const payload = bytes("payload");

  collector.trackAction({
    id: "a1",
    at: 600,
    url: "https://files.example/export",
    documentUrl: "https://files.example/export",
  });
  collector.trackResponse({
    requestId: "r1",
    at: 610,
    startedAt: 605,
    url: "https://files.example/export",
    requestInitiator: "https://files.example/export",
    headers: {
      "Content-Length": String(payload.byteLength),
      "Content-Disposition":
        "attachment; filename=\"fallback.zip\"; filename*=UTF-8''%E4%B8%AD%E6%96%87.zip",
    },
  });
  collector.trackDownload({
    id: "d1",
    at: 620,
    url: "https://files.example/export",
    filename: "中文.zip",
    totalBytes: payload.byteLength,
  });

  const result = await collector.completeFile({
    downloadId: "d1",
    bytes: payload,
  });

  assert.equal(result.response?.requestId, "r1");
  assert.equal(result.disposition?.filename, "中文.zip");
  assert.equal(result.filename, "中文.zip");
  assert.ok(result.matchedBy.includes("disposition-filename-match"));
  assert.equal(result.state, "verified");
});

test("a size mismatch fails verification", async () => {
  const collector = makeCollector();
  const payload = bytes("twelve bytes");

  collector.trackAction({
    id: "a1",
    at: 700,
    url: "https://files.example/a.bin",
  });
  collector.trackResponse({
    requestId: "r1",
    at: 710,
    url: "https://files.example/a.bin",
    headers: { "Content-Length": "1" },
  });
  collector.trackDownload({
    id: "d1",
    at: 720,
    url: "https://files.example/a.bin",
    totalBytes: 1,
  });

  const result = await collector.completeFile({
    downloadId: "d1",
    bytes: payload,
  });

  assert.equal(result.state, "failed");
  assert.equal(result.verified, false);
  assert.equal(result.file?.status, "size-mismatch");
  assert.equal(result.file?.sizeMatches, false);
});

test("a digest mismatch fails verification even when the length matches", async () => {
  const collector = makeCollector();
  const declared = bytes("hello world!");
  const written = bytes("hello world?");
  const declaredSha = await computeSha256(declared);

  collector.trackAction({
    id: "a1",
    at: 800,
    url: "https://files.example/a.bin",
  });
  collector.trackResponse({
    requestId: "r1",
    at: 810,
    url: "https://files.example/a.bin",
    headers: {
      "Content-Length": String(declared.byteLength),
      "Content-Digest": `sha-256=:${sha256Base64(declaredSha)}:`,
    },
  });
  collector.trackDownload({
    id: "d1",
    at: 820,
    url: "https://files.example/a.bin",
    totalBytes: declared.byteLength,
  });

  const result = await collector.completeFile({
    downloadId: "d1",
    bytes: written,
  });

  assert.equal(result.state, "failed");
  assert.equal(result.file?.status, "digest-mismatch");
  assert.equal(result.file?.sizeMatches, true);
  assert.equal(result.file?.digestMatches["sha-256"], false);
});

test("a late response does not replace an already determined response", async () => {
  const collector = makeCollector();
  const payload = bytes("locked");

  collector.trackAction({
    id: "a1",
    at: 900,
    url: "https://files.example/locked.bin",
  });
  collector.trackResponse({
    requestId: "first",
    at: 910,
    url: "https://files.example/locked.bin",
    headers: { "Content-Length": String(payload.byteLength) },
  });
  collector.trackDownload({
    id: "d1",
    at: 920,
    url: "https://files.example/locked.bin",
    totalBytes: payload.byteLength,
  });
  const verified = await collector.completeFile({
    downloadId: "d1",
    bytes: payload,
  });
  assert.equal(verified.response?.requestId, "first");
  assert.equal(verified.state, "verified");

  collector.trackResponse({
    id: "late",
    requestId: "late",
    at: 915,
    url: "https://files.example/locked.bin",
    headers: { "Content-Length": String(payload.byteLength) },
  });

  const result = collector.require("d1");
  assert.equal(result.response?.requestId, "first");
  assert.equal(result.state, "verified");
  assert.equal(result.revision, verified.revision);
  assert.ok(
    result.ignored.some(
      (event) =>
        event.kind === "response" &&
        event.reason.includes("late-response-ignored"),
    ),
  );
});

test("late download and file events cannot overwrite a verified result", async () => {
  const collector = makeCollector();
  const payload = bytes("original");
  const sha256 = await computeSha256(payload);

  collector.trackAction({
    id: "a1",
    at: 1_000,
    url: "https://files.example/original.bin",
  });
  collector.trackResponse({
    requestId: "r1",
    at: 1_010,
    url: "https://files.example/original.bin",
    headers: { "Content-Length": String(payload.byteLength) },
  });
  collector.trackDownload({
    id: "d1",
    at: 1_020,
    url: "https://files.example/original.bin",
    filename: "original.bin",
    totalBytes: payload.byteLength,
  });
  const verified = await collector.completeFile({
    downloadId: "d1",
    bytes: payload,
  });

  collector.trackDownload({
    id: "d1",
    at: 2_000,
    url: "https://files.example/swapped.bin",
    filename: "swapped.bin",
    totalBytes: 999,
  });
  const afterLateDownload = collector.require("d1");
  assert.equal(afterLateDownload.filename, "original.bin");
  assert.equal(afterLateDownload.download?.url, "https://files.example/original.bin");
  assert.equal(afterLateDownload.download?.totalBytes, payload.byteLength);
  assert.equal(afterLateDownload.sha256, sha256);
  assert.equal(afterLateDownload.state, "verified");
  assert.ok(
    afterLateDownload.ignored.some(
      (event) =>
        event.kind === "download" &&
        event.reason.includes("late-download-ignored-fields"),
    ),
  );

  const afterLateFile = await collector.completeFile({
    downloadId: "d1",
    bytes: bytes("tampered"),
  });
  assert.equal(afterLateFile.sha256, verified.sha256);
  assert.equal(afterLateFile.size, verified.size);
  assert.equal(afterLateFile.state, "verified");
  assert.ok(
    afterLateFile.ignored.some((event) => event.kind === "file"),
  );
});

test("a file may complete before the download event and later gain its metadata", async () => {
  const collector = makeCollector();
  const payload = bytes("file-first");

  collector.trackAction({
    id: "a1",
    at: 1_100,
    url: "https://files.example/first.bin",
  });
  collector.trackResponse({
    requestId: "r1",
    at: 1_110,
    url: "https://files.example/first.bin",
    headers: { "Content-Length": String(payload.byteLength) },
  });
  const fileFirst = await collector.completeFile({
    responseId: "r1",
    bytes: payload,
  });
  assert.equal(fileFirst.state, "verified");
  assert.equal(fileFirst.response?.requestId, "r1");

  const adopted = collector.trackDownload({
    id: "d-late",
    at: 1_120,
    requestId: "r1",
    url: "https://files.example/first.bin",
    filename: "first.bin",
    totalBytes: payload.byteLength,
  });
  assert.equal(adopted.downloadId, "d-late");
  assert.equal(adopted.response?.requestId, "r1");
  assert.equal(adopted.filename, "first.bin");
  assert.equal(adopted.state, "verified");
  assert.equal(collector.require("d-late").sha256, fileFirst.sha256);
});

test("multiple actions and popups are evaluated independently", () => {
  const collector = makeCollector();

  collector.trackAction({
    id: "a1",
    at: 1_200,
    url: "https://shop.example/product/1",
  });
  collector.trackPopup({
    id: "p1",
    at: 1_205,
    actionId: "a1",
    url: "https://cdn.example/one.zip",
  });
  collector.trackAction({
    id: "a2",
    at: 1_300,
    url: "https://shop.example/product/2",
  });
  collector.trackPopup({
    id: "p2",
    at: 1_305,
    actionId: "a2",
    url: "https://cdn.example/two.zip",
  });

  collector.trackResponse({
    requestId: "r1",
    at: 1_210,
    url: "https://cdn.example/one.zip",
  });
  collector.trackResponse({
    requestId: "r2",
    at: 1_310,
    url: "https://cdn.example/two.zip",
  });

  const result = collector.trackDownload({
    id: "d2",
    at: 1_320,
    url: "https://cdn.example/two.zip",
  });

  assert.equal(result.response?.requestId, "r2");
  assert.equal(result.action?.id, "a2");
  assert.equal(result.popup?.id, "p2");
});

test("a disposition filename difference is a soft signal, not a URL rejection", async () => {
  const collector = makeCollector();
  const payload = bytes("named");

  collector.trackAction({
    id: "a1",
    at: 1_400,
    url: "https://files.example/download",
  });
  collector.trackResponse({
    requestId: "r1",
    at: 1_410,
    url: "https://files.example/download",
    headers: {
      "Content-Length": String(payload.byteLength),
      "Content-Disposition": 'attachment; filename="server-name.bin"',
    },
  });
  collector.trackDownload({
    id: "d1",
    at: 1_420,
    url: "https://files.example/download",
    filename: "renamed-by-browser.bin",
    totalBytes: payload.byteLength,
  });

  const result = await collector.completeFile({
    downloadId: "d1",
    bytes: payload,
  });

  assert.equal(result.response?.requestId, "r1");
  assert.equal(result.state, "verified");
  assert.ok(result.matchedBy.includes("disposition-filename-differs"));
});

test("an action delivered after finalization cannot change the result", async () => {
  const collector = makeCollector();
  const payload = bytes("late");

  collector.trackResponse({
    requestId: "r1",
    at: 1_500,
    url: "https://files.example/late.bin",
    headers: { "Content-Length": String(payload.byteLength) },
  });
  collector.trackDownload({
    id: "d1",
    at: 1_510,
    url: "https://files.example/late.bin",
    totalBytes: payload.byteLength,
  });
  const verified = await collector.completeFile({
    downloadId: "d1",
    bytes: payload,
  });
  assert.equal(verified.action, undefined);

  collector.trackAction({
    id: "late-action",
    at: 1_490,
    url: "https://files.example/late.bin",
  });

  assert.equal(collector.require("d1").action, undefined);
});

test("file bytes are hashed even when a pre-computed digest is also supplied", async () => {
  const collector = makeCollector();
  const declared = bytes("good!");
  const written = bytes("evil!");
  const declaredSha = await computeSha256(declared);

  collector.trackAction({
    id: "a1",
    at: 1_600,
    url: "https://files.example/trust.bin",
  });
  collector.trackResponse({
    requestId: "r1",
    at: 1_610,
    url: "https://files.example/trust.bin",
    headers: {
      "Content-Length": String(declared.byteLength),
      "Content-Digest": `sha-256=:${sha256Base64(declaredSha)}:`,
    },
  });
  collector.trackDownload({
    id: "d1",
    at: 1_620,
    url: "https://files.example/trust.bin",
    totalBytes: declared.byteLength,
  });

  const result = await collector.completeFile({
    downloadId: "d1",
    bytes: written,
    sha256: declaredSha,
  });

  assert.equal(result.file?.sizeMatches, true);
  assert.equal(result.file?.digestMatches["sha-256"], false);
  assert.equal(result.state, "failed");
  assert.ok(
    result.file?.reasons.includes("supplied-digest-conflict: sha-256"),
  );
});

test("declared SHA-512 digests are computed from the written bytes", async () => {
  const collector = makeCollector();
  const payload = bytes("sha512 payload");
  const sha512 = await computeDigest(payload, "sha-512");

  collector.trackAction({
    id: "a1",
    at: 1_700,
    url: "https://files.example/sha512.bin",
  });
  collector.trackResponse({
    requestId: "r1",
    at: 1_710,
    url: "https://files.example/sha512.bin",
    headers: {
      "Content-Length": String(payload.byteLength),
      "Content-Digest": `sha-512=:${sha256Base64(sha512)}:`,
    },
  });
  collector.trackDownload({
    id: "d1",
    at: 1_720,
    url: "https://files.example/sha512.bin",
    totalBytes: payload.byteLength,
  });

  const result = await collector.completeFile({
    downloadId: "d1",
    bytes: payload,
  });

  assert.equal(result.state, "verified");
  assert.equal(result.file?.digestMatches["sha-512"], true);
});

test("buffered browser capture events can be attributed in one batch", async () => {
  const payload = bytes("batch");
  const results = await attributeDownloads([
    {
      type: "action",
      id: "a1",
      at: 1_800,
      url: "https://files.example/batch.bin",
    },
    {
      type: "response",
      requestId: "r1",
      at: 1_810,
      url: "https://files.example/batch.bin",
      headers: { "Content-Length": String(payload.byteLength) },
    },
    {
      type: "download",
      id: "d1",
      at: 1_820,
      url: "https://files.example/batch.bin",
      totalBytes: payload.byteLength,
    },
    {
      type: "file",
      downloadId: "d1",
      bytes: payload,
    },
  ]);

  assert.equal(results.length, 1);
  assert.equal(results[0]?.downloadId, "d1");
  assert.equal(results[0]?.state, "verified");
});
