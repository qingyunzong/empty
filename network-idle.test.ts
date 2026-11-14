import assert from "node:assert/strict";
import test from "node:test";
import { NetworkIdleMonitor } from "./network-idle.js";

const QUIET = 40;

function makeMonitor(extra: Record<string, unknown> = {}) {
  return new NetworkIdleMonitor({ quietWindowMs: QUIET, ...extra });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("无请求时在静默窗口后判定为 idle", async () => {
  const monitor = makeMonitor();
  const result = await monitor.waitForIdle();
  assert.equal(result.status, "idle");
});

test("静默窗口从最后一个相关请求终态起算", async () => {
  const monitor = makeMonitor();
  monitor.requestStarted({ id: "r1", url: "https://a.test/api", resourceType: "xhr" });
  await sleep(10);
  monitor.requestSettled("r1", { reason: "finished" });
  const started = Date.now();
  const result = await monitor.waitForIdle();
  assert.equal(result.status, "idle");
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= QUIET - 5, `窗口应从终态起算，实际 ${elapsed}ms`);
  if (result.status === "idle") {
    assert.ok(result.idleSince <= Date.now());
  }
});

test("静默窗口内出现新请求会重置窗口", async () => {
  const monitor = makeMonitor();
  monitor.requestStarted({ id: "r1", url: "https://a.test/1", resourceType: "fetch" });
  monitor.requestSettled("r1", { reason: "finished" });
  const waiting = monitor.waitForIdle();
  await sleep(QUIET / 2);
  monitor.requestStarted({ id: "r2", url: "https://a.test/2", resourceType: "fetch" });
  await sleep(QUIET / 2);
  monitor.requestSettled("r2", { reason: "failed" });
  const beforeSecondSettle = Date.now();
  const result = await waiting;
  assert.equal(result.status, "idle");
  const elapsed = Date.now() - beforeSecondSettle;
  assert.ok(elapsed >= QUIET - 5, `窗口应被新请求重置，实际 ${elapsed}ms`);
});

test("持续连接（WebSocket / SSE）不阻塞静默，但单独可见", async () => {
  const monitor = makeMonitor();
  monitor.requestStarted({ id: "ws", url: "wss://a.test/socket", resourceType: "websocket" });
  monitor.requestStarted({ id: "sse", url: "https://a.test/events", resourceType: "eventsource" });
  const result = await monitor.waitForIdle();
  assert.equal(result.status, "idle");
  assert.deepEqual(
    monitor.openPersistentConnections.map((c) => c.id).sort(),
    ["sse", "ws"],
  );
  monitor.requestSettled("ws", { reason: "aborted" });
  assert.deepEqual(
    monitor.openPersistentConnections.map((c) => c.id),
    ["sse"],
  );
});

test("service worker 请求默认不阻塞，可配置为计入", async () => {
  const monitor = makeMonitor();
  monitor.requestStarted({
    id: "sw1",
    url: "https://a.test/cached",
    resourceType: "fetch",
    fromServiceWorker: true,
  });
  const result = await monitor.waitForIdle();
  assert.equal(result.status, "idle");

  const strict = makeMonitor({ countServiceWorkerRequests: true });
  strict.requestStarted({
    id: "sw2",
    url: "https://a.test/cached",
    resourceType: "fetch",
    fromServiceWorker: true,
  });
  const timed = await strict.waitForIdle({ timeoutMs: 30 });
  assert.equal(timed.status, "timeout");
  if (timed.status === "timeout") {
    assert.equal(timed.blocking.length, 1);
    assert.equal(timed.blocking[0].id, "sw2");
  }
});

test("预加载请求默认计入阻塞，可配置忽略", async () => {
  const monitor = makeMonitor();
  monitor.requestStarted({
    id: "p1",
    url: "https://a.test/hero.png",
    resourceType: "image",
    isPreload: true,
  });
  const timed = await monitor.waitForIdle({ timeoutMs: 30 });
  assert.equal(timed.status, "timeout");

  const relaxed = makeMonitor({ countPreloadRequests: false });
  relaxed.requestStarted({
    id: "p2",
    url: "https://a.test/hero.png",
    resourceType: "image",
    isPreload: true,
  });
  const result = await relaxed.waitForIdle();
  assert.equal(result.status, "idle");
});

test("用户配置的忽略规则命中后不参与判定", async () => {
  const monitor = makeMonitor({
    ignoreRules: [
      { url: /analytics/ },
      { url: "beacon" },
      { resourceType: "image" },
      { url: "https://a.test/api", method: "OPTIONS" },
    ],
  });
  assert.equal(
    monitor.requestStarted({ id: "i1", url: "https://a.test/analytics/x", resourceType: "xhr" }),
    false,
  );
  assert.equal(
    monitor.requestStarted({ id: "i2", url: "https://a.test/beacon", resourceType: "ping" }),
    false,
  );
  assert.equal(
    monitor.requestStarted({ id: "i3", url: "https://a.test/pic.png", resourceType: "image" }),
    false,
  );
  assert.equal(
    monitor.requestStarted({ id: "i4", url: "https://a.test/api", method: "OPTIONS", resourceType: "fetch" }),
    false,
  );
  assert.equal(
    monitor.requestStarted({ id: "r1", url: "https://a.test/api", resourceType: "fetch" }),
    true,
  );
  monitor.requestSettled("r1", { reason: "finished" });
  const result = await monitor.waitForIdle();
  assert.equal(result.status, "idle");
});

test("轮询端点达到阈值后不再阻塞静默", async () => {
  const monitor = makeMonitor({ pollingThreshold: 3, pollingWindowMs: 10_000 });
  for (let round = 0; round < 3; round += 1) {
    const id = `poll-${round}`;
    monitor.requestStarted({ id, url: "https://a.test/status", resourceType: "xhr" });
    monitor.requestSettled(id, { reason: "finished" });
  }
  assert.deepEqual(monitor.detectedPollingEndpoints, ["GET https://a.test/status"]);

  monitor.requestStarted({ id: "poll-3", url: "https://a.test/status", resourceType: "xhr" });
  const result = await monitor.waitForIdle();
  assert.equal(result.status, "idle");
});

test("导航切换清空旧请求并从头累计静默", async () => {
  const monitor = makeMonitor();
  monitor.requestStarted({ id: "old", url: "https://a.test/old", resourceType: "xhr" });
  assert.equal(monitor.getBlockingEvidence().length, 1);

  monitor.navigationCommitted();
  assert.equal(monitor.navigationGeneration, 1);
  assert.equal(monitor.getBlockingEvidence().length, 0);
  assert.equal(monitor.openPersistentConnections.length, 0);

  // 旧请求的迟到终态不应影响新页面。
  monitor.requestSettled("old", { reason: "aborted" });
  const result = await monitor.waitForIdle();
  assert.equal(result.status, "idle");
});

test("超时返回当前阻塞证据而非固定 sleep", async () => {
  const monitor = makeMonitor();
  monitor.requestStarted({ id: "slow", url: "https://a.test/slow", resourceType: "fetch" });
  const started = Date.now();
  const result = await monitor.waitForIdle({ timeoutMs: 50 });
  const elapsed = Date.now() - started;
  assert.equal(result.status, "timeout");
  assert.ok(elapsed < 200, `超时应按 deadline 触发，实际 ${elapsed}ms`);
  if (result.status === "timeout") {
    assert.equal(result.blocking.length, 1);
    assert.equal(result.blocking[0].id, "slow");
    assert.equal(result.blocking[0].reason, "in-flight");
    assert.ok(result.blocking[0].ageMs >= 0);
  }
});

test("取消返回当前阻塞证据", async () => {
  const monitor = makeMonitor();
  monitor.requestStarted({ id: "pending", url: "https://a.test/pending", resourceType: "xhr" });
  const controller = new AbortController();
  const waiting = monitor.waitForIdle({ signal: controller.signal });
  await sleep(5);
  controller.abort();
  const result = await waiting;
  assert.equal(result.status, "cancelled");
  if (result.status === "cancelled") {
    assert.equal(result.blocking.length, 1);
    assert.equal(result.blocking[0].id, "pending");
  }
});

test("已取消的信号立即返回取消证据", async () => {
  const monitor = makeMonitor();
  monitor.requestStarted({ id: "x", url: "https://a.test/x", resourceType: "fetch" });
  const controller = new AbortController();
  controller.abort();
  const result = await monitor.waitForIdle({ signal: controller.signal });
  assert.equal(result.status, "cancelled");
});

test("已静默足够久时立即判定 idle，不做固定 sleep", async () => {
  const monitor = makeMonitor();
  monitor.requestStarted({ id: "r1", url: "https://a.test/1", resourceType: "fetch" });
  monitor.requestSettled("r1", { reason: "finished" });
  await sleep(QUIET + 30);
  const started = Date.now();
  const result = await monitor.waitForIdle();
  assert.equal(result.status, "idle");
  assert.ok(Date.now() - started < 20, "已静默时应立即返回");
});
