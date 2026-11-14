import assert from "node:assert/strict";
import { test } from "node:test";

import {
  NavigationTracker,
  replayNavigationEvents,
  type NavigationEventInput,
  type NavigationSnapshot,
} from "../index.js";

function event(
  type: string,
  timestamp: number,
  fields: Record<string, unknown> = {},
): NavigationEventInput {
  return { type, timestamp, ...fields };
}

function nav(
  frameId: string,
  loaderId: string,
  url: string,
  timestamp: number,
  parentId?: string,
): NavigationEventInput {
  return event("frameNavigated", timestamp, { frameId, loaderId, url, parentId });
}

function request(
  frameId: string,
  loaderId: string,
  requestId: string,
  url: string,
  timestamp: number,
): NavigationEventInput {
  return event("request", timestamp, { frameId, loaderId, requestId, url });
}

function response(
  frameId: string,
  loaderId: string,
  requestId: string,
  url: string,
  status: number,
  timestamp: number,
): NavigationEventInput {
  return event("response", timestamp, { frameId, loaderId, requestId, url, status });
}

test("binds requests, redirects, same-document navigation and lifecycle to one generation", () => {
  const tracker = new NavigationTracker();
  tracker.onFrameNavigated(nav("main", "doc-1", "https://example.test/", 1));
  tracker.onLifecycle({ frameId: "main", loaderId: "doc-1", name: "init", timestamp: 1.1 });
  tracker.onRequestWillBeSent(request("main", "doc-1", "r1", "https://example.test/a", 2));
  tracker.onRequestWillBeSent({
    type: "redirect",
    frameId: "main",
    loaderId: "doc-1",
    requestId: "r1",
    url: "https://example.test/b",
    status: 302,
    fromUrl: "https://example.test/a",
    timestamp: 2.5,
  });
  tracker.onResponseReceived(response("main", "doc-1", "r1", "https://example.test/b", 200, 3));
  tracker.onNavigatedWithinDocument({ frameId: "main", url: "https://example.test/b#details", timestamp: 4 });
  tracker.onLifecycleEvent({ frameId: "main", loaderId: "doc-1", name: "load", timestamp: 5 });

  const generation = tracker.getGeneration("main");
  if (!generation) throw new Error("generation was not created");
  assert.equal(generation.id, "doc-1");
  assert.equal(generation.active, true);
  assert.equal(generation.requests.length, 1);
  assert.equal(generation.requests[0].url, "https://example.test/b");
  assert.equal(generation.requests[0].redirects.length, 1);
  assert.equal(generation.requests[0].response?.status, 200);
  assert.equal(generation.sameDocumentNavigations.length, 1);
  assert.equal(generation.currentUrl, "https://example.test/b#details");
  assert.equal(generation.lifecycle.load?.name, "load");
  assert.equal(tracker.requestTree.length, 1);
  assert.equal(tracker.requestTree[0].requests.length, 1);
});

test("a late response stays in its old generation and never enters the new page result", () => {
  const events: NavigationEventInput[] = [
    nav("main", "doc-1", "https://example.test/a", 1),
    request("main", "doc-1", "r1", "https://example.test/a/data", 2),
    nav("main", "doc-2", "https://example.test/b", 3),
    response("main", "doc-1", "r1", "https://example.test/a/data", 200, 4),
  ];
  const snapshot = replayNavigationEvents(events);

  assert.deepEqual(
    snapshot.activeGenerations.map((generation) => generation.id),
    ["doc-2"],
  );
  assert.equal(snapshot.requestTree.length, 1);
  assert.deepEqual(snapshot.requestTree[0].requests, []);
  assert.equal(snapshot.lateResponses.length, 1);
  assert.equal(snapshot.lateResponses[0].requestGenerationId, "doc-1");
  assert.equal(snapshot.lateResponses[0].currentGenerationId, "doc-2");

  const oldRequest = snapshot.allRequests.find((entry) => entry.requestId === "r1");
  if (!oldRequest) throw new Error("old request was not recorded");
  assert.equal(oldRequest.generationId, "doc-1");
  assert.equal(oldRequest.lateResponse, true);
  assert.equal(oldRequest.active, false);
});

test("a reused request id cannot route an old-loader response into the new page", () => {
  const events: NavigationEventInput[] = [
    nav("main", "doc-1", "https://example.test/a", 1),
    request("main", "doc-1", "shared", "https://example.test/a/data", 1.5),
    nav("main", "doc-2", "https://example.test/b", 2),
    request("main", "doc-2", "shared", "https://example.test/b/data", 2.5),
    response("main", "doc-1", "shared", "https://example.test/a/data", 200, 3),
    response("main", "doc-2", "shared", "https://example.test/b/data", 201, 4),
  ];
  const tracker = new NavigationTracker(events);
  const active = tracker.getRequests("main");
  assert.equal(active.length, 1);
  assert.equal(active[0].generationId, "doc-2");
  assert.equal(active[0].response?.status, 201);

  const old = tracker.getRequestsForGeneration("doc-1");
  assert.equal(old.length, 1);
  assert.equal(old[0].response?.status, 200);
  assert.equal(old[0].lateResponse, true);
});

test("an independently navigating child revokes only its own subtree", () => {
  const events: NavigationEventInput[] = [
    nav("main", "m1", "https://example.test/main", 1),
    nav("child", "c1", "https://example.test/child", 2, "main"),
    nav("grandchild", "g1", "https://example.test/grandchild", 3, "child"),
    nav("sibling", "s1", "https://example.test/sibling", 4, "main"),
    request("main", "m1", "rm", "https://example.test/main/r", 5),
    request("child", "c1", "rc", "https://example.test/child/r", 5.1),
    request("grandchild", "g1", "rg", "https://example.test/grandchild/r", 5.2),
    request("sibling", "s1", "rs", "https://example.test/sibling/r", 5.3),
    nav("child", "c2", "https://example.test/child-2", 6, "main"),
  ];
  const snapshot = replayNavigationEvents(events);

  assert.deepEqual(
    snapshot.activeGenerations.map((generation) => generation.id).sort(),
    ["c2", "m1", "s1"],
  );
  assert.deepEqual(
    snapshot.activeRequests.map((entry) => entry.requestId).sort(),
    ["rm", "rs"],
  );

  const oldChild = snapshot.generations.find((generation) => generation.id === "c1");
  const oldGrandchild = snapshot.generations.find((generation) => generation.id === "g1");
  assert.equal(oldChild?.revokedReason, "navigation");
  assert.equal(oldGrandchild?.revokedReason, "ancestor-navigation");

  const main = snapshot.generations.find((generation) => generation.id === "m1");
  const sibling = snapshot.generations.find((generation) => generation.id === "s1");
  assert.equal(main?.active, true);
  assert.equal(sibling?.active, true);
});

test("frame detach revokes that frame and descendants but leaves ancestors and siblings alone", () => {
  const events: NavigationEventInput[] = [
    nav("main", "m1", "https://example.test/main", 1),
    nav("child", "c1", "https://example.test/child", 2, "main"),
    nav("grandchild", "g1", "https://example.test/grandchild", 3, "child"),
    nav("sibling", "s1", "https://example.test/sibling", 4, "main"),
    request("main", "m1", "rm", "https://example.test/main/r", 5),
    request("child", "c1", "rc", "https://example.test/child/r", 5.1),
    request("grandchild", "g1", "rg", "https://example.test/grandchild/r", 5.2),
    request("sibling", "s1", "rs", "https://example.test/sibling/r", 5.3),
    event("frameDetached", 6, { frameId: "child", reason: "remove" }),
  ];
  const snapshot = replayNavigationEvents(events);

  assert.deepEqual(
    snapshot.activeGenerations.map((generation) => generation.id).sort(),
    ["m1", "s1"],
  );
  assert.deepEqual(
    snapshot.activeRequests.map((entry) => entry.requestId).sort(),
    ["rm", "rs"],
  );
  const detachedChild = snapshot.generations.find((generation) => generation.id === "c1");
  assert.equal(detachedChild?.state, "detached");
  assert.equal(snapshot.frames.find((frame) => frame.frameId === "child")?.detached, true);
});

test("same-document navigation keeps the document generation and both request islands", () => {
  const events: NavigationEventInput[] = [
    nav("main", "doc-1", "https://example.test/a", 1),
    request("main", "doc-1", "r1", "https://example.test/a/data", 2),
    event("sameDocumentNavigation", 3, {
      frameId: "main",
      url: "https://example.test/b",
      navigationType: "historyApi",
    }),
    request("main", "doc-1", "r2", "https://example.test/b/data", 4),
  ];
  const tracker = new NavigationTracker(events);
  assert.equal(tracker.activeGenerations.length, 1);
  assert.equal(tracker.getGeneration("main")?.id, "doc-1");
  assert.deepEqual(
    tracker.getRequests("main").map((entry) => entry.requestId),
    ["r1", "r2"],
  );
  assert.equal(tracker.getGeneration("main")?.sameDocumentNavigations.length, 1);
  assert.equal(tracker.getGeneration("main")?.currentUrl, "https://example.test/b");
});

test("late lifecycle events from an old loader do not mark the new generation loaded", () => {
  const events: NavigationEventInput[] = [
    nav("main", "doc-1", "https://example.test/a", 1),
    nav("main", "doc-2", "https://example.test/b", 2),
    { type: "lifecycle", frameId: "main", loaderId: "doc-1", name: "load", timestamp: 3 },
    { type: "lifecycle", frameId: "main", loaderId: "doc-2", name: "init", timestamp: 2.5 },
  ];
  const snapshot = replayNavigationEvents(events);
  const oldGeneration = snapshot.generations.find((generation) => generation.id === "doc-1");
  const newGeneration = snapshot.generations.find((generation) => generation.id === "doc-2");
  assert.equal(oldGeneration?.lifecycle.load?.stale, true);
  assert.equal(newGeneration?.lifecycle.load, undefined);
  assert.equal(newGeneration?.lifecycle.init?.stale, false);
});

test("accepts raw CDP event envelopes and keeps the redirect in one request node", () => {
  const tracker = new NavigationTracker();
  tracker.ingest({
    method: "Page.frameNavigated",
    params: {
      frame: { id: "main", loaderId: "doc-1", url: "https://example.test/" },
    },
  });
  tracker.ingest({
    method: "Network.requestWillBeSent",
    params: {
      requestId: "r1",
      loaderId: "doc-1",
      frameId: "main",
      request: { url: "https://example.test/a", method: "GET" },
      type: "Document",
      timestamp: 2,
    },
  });
  tracker.ingest({
    method: "Network.requestWillBeSent",
    params: {
      requestId: "r1",
      loaderId: "doc-1",
      frameId: "main",
      request: { url: "https://example.test/b", method: "GET" },
      type: "Document",
      redirectResponse: {
        url: "https://example.test/a",
        status: 302,
        headers: { location: "https://example.test/b" },
      },
      timestamp: 3,
    },
  });
  tracker.ingest({
    method: "Network.responseReceived",
    params: {
      requestId: "r1",
      loaderId: "doc-1",
      frameId: "main",
      response: { url: "https://example.test/b", status: 200 },
      timestamp: 4,
    },
  });
  tracker.ingest({
    method: "Page.lifecycleEvent",
    params: { frameId: "main", loaderId: "doc-1", name: "load", timestamp: 5 },
  });

  const generation = tracker.getGeneration("main");
  if (!generation) throw new Error("generation was not created");
  assert.equal(generation.requests.length, 1);
  assert.equal(generation.requests[0].method, "GET");
  assert.equal(generation.requests[0].resourceType, "Document");
  assert.equal(generation.requests[0].redirects.length, 1);
  assert.equal(generation.requests[0].response?.status, 200);
  assert.equal(generation.lifecycle.load?.stale, false);
});

function shuffleDeterministically<T>(entries: T[]): T[] {
  const result = [...entries];
  let seed = 1234567;
  for (let index = result.length - 1; index > 0; index -= 1) {
    seed = (seed * 48271) % 2147483647;
    const target = seed % (index + 1);
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

test("replaying the same events in any order produces an identical request tree", () => {
  const events: NavigationEventInput[] = [
    nav("main", "m1", "https://example.test/main", 1),
    { type: "lifecycle", frameId: "main", loaderId: "m1", name: "init", timestamp: 1.2 },
    nav("child", "c1", "https://example.test/child", 2, "main"),
    nav("grandchild", "g1", "https://example.test/grandchild", 3, "child"),
    request("main", "m1", "r1", "https://example.test/main/a", 4),
    request("main", "m1", "r2", "https://example.test/main/a2", 4.2),
    request("child", "c1", "rc", "https://example.test/child/a", 4.4),
    {
      type: "redirect",
      frameId: "main",
      loaderId: "m1",
      requestId: "r1",
      url: "https://example.test/main/b",
      status: 302,
      timestamp: 5,
    },
    response("main", "m1", "r1", "https://example.test/main/b", 200, 6),
    response("main", "m1", "r2", "https://example.test/main/a2", 204, 6.2),
    event("sameDocumentNavigation", 6.5, { frameId: "main", url: "https://example.test/main#x" }),
    nav("child", "c2", "https://example.test/child-2", 7, "main"),
    response("child", "c1", "rc", "https://example.test/child/a", 200, 8),
    { type: "lifecycle", frameId: "main", loaderId: "m1", name: "load", timestamp: 8.5 },
  ];

  const canonical = replayNavigationEvents(events);
  const reversed = replayNavigationEvents([...events].reverse());
  const shuffled = replayNavigationEvents(shuffleDeterministically(events));
  const shuffledAgain = replayNavigationEvents(shuffleDeterministically(events));

  assert.deepEqual(reversed, canonical);
  assert.deepEqual(shuffled, canonical);
  assert.deepEqual(shuffledAgain, canonical);
  assert.deepEqual(
    snapshotShape(shuffled.requestTree),
    snapshotShape(canonical.requestTree),
  );
});

test("replay is stable even when callers provide no timestamps", () => {
  const events: NavigationEventInput[] = [
    { type: "frameNavigated", frameId: "main", loaderId: "doc-1", url: "https://example.test/a" },
    { type: "request", frameId: "main", loaderId: "doc-1", requestId: "r1", url: "https://example.test/a/data" },
    { type: "frameNavigated", frameId: "main", loaderId: "doc-2", url: "https://example.test/b" },
    { type: "response", frameId: "main", loaderId: "doc-1", requestId: "r1", status: 200 },
  ];
  const canonical = replayNavigationEvents(events);
  const reversed = replayNavigationEvents([...events].reverse());
  assert.deepEqual(reversed, canonical);
  assert.deepEqual(canonical.activeGenerations.map((generation) => generation.id), ["doc-2"]);
  assert.equal(canonical.requestTree[0].requests.length, 0);
});

function snapshotShape(tree: NavigationSnapshot["requestTree"]): unknown[] {
  return tree.map((node) => ({
    generationId: node.generationId,
    frameId: node.frameId,
    requests: node.requests.map((entry) => ({
      requestId: entry.requestId,
      url: entry.url,
      redirects: entry.redirects,
    })),
    children: snapshotShape(node.children),
  }));
}
