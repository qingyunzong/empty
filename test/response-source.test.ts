import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyResponse,
  isFreshNetworkEvidence,
} from "../src/response-source.ts";

describe("classifyResponse 显式标志", () => {
  it("fromServiceWorker → service-worker", () => {
    const r = classifyResponse({ fromServiceWorker: true });
    assert.equal(r.source, "service-worker");
    assert.equal(r.basis, "explicit-flag");
  });

  it("fromDiskCache → disk-cache", () => {
    assert.equal(classifyResponse({ fromDiskCache: true }).source, "disk-cache");
  });

  it("fromMemoryCache → memory-cache", () => {
    assert.equal(
      classifyResponse({ fromMemoryCache: true }).source,
      "memory-cache",
    );
  });

  it("SW 标志优先于缓存标志", () => {
    const r = classifyResponse({ fromServiceWorker: true, fromDiskCache: true });
    assert.equal(r.source, "service-worker");
  });
});

describe("classifyResponse timing 字段", () => {
  it("workerStart > 0 → service-worker", () => {
    const r = classifyResponse({ workerStart: 12.5, transferSize: 300 });
    assert.equal(r.source, "service-worker");
    assert.equal(r.basis, "timing-field");
  });

  it("deliveryType=cache 且 transferSize=0 → memory-cache", () => {
    const r = classifyResponse({
      deliveryType: "cache",
      transferSize: 0,
      encodedBodySize: 1024,
    });
    assert.equal(r.source, "memory-cache");
  });

  it("deliveryType=cache 且 transferSize>0 → disk-cache", () => {
    const r = classifyResponse({
      deliveryType: "cache",
      transferSize: 145,
      encodedBodySize: 1024,
    });
    assert.equal(r.source, "disk-cache");
  });
});

describe("classifyResponse 启发式", () => {
  it("transferSize>0 → network", () => {
    const r = classifyResponse({ transferSize: 2048, encodedBodySize: 2000 });
    assert.equal(r.source, "network");
    assert.ok(isFreshNetworkEvidence(r));
  });

  it("304 再验证 → network", () => {
    const r = classifyResponse({ status: 304, transferSize: 0 });
    assert.equal(r.source, "network");
  });

  it("transferSize=0 且 body 非空 → memory-cache", () => {
    const r = classifyResponse({ transferSize: 0, encodedBodySize: 512 });
    assert.equal(r.source, "memory-cache");
    assert.ok(!isFreshNetworkEvidence(r));
  });

  it("无证据 → unknown", () => {
    const r = classifyResponse({});
    assert.equal(r.source, "unknown");
    assert.equal(r.basis, "insufficient-evidence");
  });
});
