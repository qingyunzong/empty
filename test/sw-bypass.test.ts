import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BypassError,
  verifyFreshNetworkEvidence,
  waitForSwLoseControl,
  type BrowserEnv,
} from "../src/sw-bypass.ts";
import type { ResponseEvidence } from "../src/response-source.ts";

interface FakeEnvConfig {
  /** 失控前需要经历的轮询次数；Infinity 表示永不失控 */
  pollsUntilLoseControl?: number;
  /** 导航是否推进世代 */
  advanceGeneration?: boolean;
  evidence: ResponseEvidence;
}

function makeFakeEnv(config: FakeEnvConfig): BrowserEnv & {
  unregisterCalls: number;
  navigateCalls: number;
} {
  let controller: string | null = "https://example.com/sw.js";
  let generation = 1;
  let polls = 0;
  const pollsNeeded = config.pollsUntilLoseControl ?? 1;
  const env = {
    unregisterCalls: 0,
    navigateCalls: 0,
    async getSwController() {
      polls += 1;
      if (polls > pollsNeeded) controller = null;
      return controller;
    },
    async unregisterAllServiceWorkers() {
      env.unregisterCalls += 1;
      return 1;
    },
    async navigateNewDocument() {
      env.navigateCalls += 1;
      if (config.advanceGeneration !== false) generation += 1;
      return generation;
    },
    async getDocumentGeneration() {
      return generation;
    },
    async collectEvidence() {
      return config.evidence;
    },
  };
  return env;
}

const fast = { swLoseControlTimeoutMs: 200, pollIntervalMs: 5 };

describe("waitForSwLoseControl", () => {
  it("轮询直至 controller 为 null", async () => {
    const env = makeFakeEnv({
      pollsUntilLoseControl: 3,
      evidence: { transferSize: 100 },
    });
    const n = await waitForSwLoseControl(env, fast);
    assert.equal(n, 1);
    assert.equal(env.unregisterCalls, 1);
  });

  it("永不失控时抛出 BypassError", async () => {
    const env = makeFakeEnv({
      pollsUntilLoseControl: Number.POSITIVE_INFINITY,
      evidence: {},
    });
    await assert.rejects(waitForSwLoseControl(env, fast), BypassError);
  });
});

describe("verifyFreshNetworkEvidence", () => {
  it("失控 + 新世代 + network 来源 → ok", async () => {
    const env = makeFakeEnv({
      evidence: { transferSize: 4096, encodedBodySize: 4000, status: 200 },
    });
    const r = await verifyFreshNetworkEvidence(env, "https://example.com/", fast);
    assert.equal(r.ok, true);
    assert.equal(r.unregisteredCount, 1);
    assert.equal(r.generationBefore, 1);
    assert.equal(r.generationAfter, 2);
    assert.equal(r.classification.source, "network");
  });

  it("导航未推进世代 → 抛错，不宣称成功", async () => {
    const env = makeFakeEnv({
      advanceGeneration: false,
      evidence: { transferSize: 100 },
    });
    await assert.rejects(
      verifyFreshNetworkEvidence(env, "https://example.com/", fast),
      BypassError,
    );
  });

  it("旁路后仍是 disk cache → ok=false 且给出原因", async () => {
    const env = makeFakeEnv({ evidence: { fromDiskCache: true } });
    const r = await verifyFreshNetworkEvidence(env, "https://example.com/", fast);
    assert.equal(r.ok, false);
    assert.equal(r.classification.source, "disk-cache");
    assert.match(r.failureReason ?? "", /disk-cache/);
  });

  it("旁路后仍由 SW 提供 → ok=false", async () => {
    const env = makeFakeEnv({ evidence: { fromServiceWorker: true } });
    const r = await verifyFreshNetworkEvidence(env, "https://example.com/", fast);
    assert.equal(r.ok, false);
    assert.equal(r.classification.source, "service-worker");
  });

  it("SW 未失控 → 抛错且不导航", async () => {
    const env = makeFakeEnv({
      pollsUntilLoseControl: Number.POSITIVE_INFINITY,
      evidence: { transferSize: 100 },
    });
    await assert.rejects(
      verifyFreshNetworkEvidence(env, "https://example.com/", fast),
      BypassError,
    );
    assert.equal(env.navigateCalls, 0);
  });
});
