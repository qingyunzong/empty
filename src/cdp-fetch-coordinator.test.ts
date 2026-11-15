import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  BodyStreamNotConsumedError,
  CaptureAlreadyConfirmedError,
  FetchInterceptionCoordinator,
  PausedRequestAlreadyResolvedError,
  StaleGenerationError,
  UnknownPausedRequestError,
  type BodyDigestRecord,
  type CaptureConfirmation,
  type RequestPausedEvent,
  type ResponseMetadata,
} from "./cdp-fetch-coordinator.ts";

class FakeConnection {
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  #handlers = new Map<string, (params: Record<string, unknown>) => unknown>();

  on(method: string, handler: (params: Record<string, unknown>) => unknown): void {
    this.#handlers.set(method, handler);
  }

  async send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params });
    const handler = this.#handlers.get(method);
    if (!handler) {
      throw new Error(`unexpected CDP call: ${method}`);
    }
    return handler(params) as T;
  }

  methods(): string[] {
    return this.calls.map((call) => call.method);
  }
}

class MemoryStore {
  order: string[] = [];
  metadata: ResponseMetadata[] = [];
  digests: BodyDigestRecord[] = [];
  confirmations: CaptureConfirmation[] = [];

  async persistResponseMetadata(metadata: ResponseMetadata): Promise<void> {
    this.order.push("metadata");
    this.metadata.push(metadata);
  }

  async persistBodyDigest(digest: BodyDigestRecord): Promise<void> {
    this.order.push("digest");
    this.digests.push(digest);
  }

  async confirmCapture(confirmation: CaptureConfirmation): Promise<void> {
    this.order.push("confirm");
    this.confirmations.push(confirmation);
  }
}

function pausedEvent(overrides: Partial<RequestPausedEvent> = {}): RequestPausedEvent {
  return {
    requestId: "interception-1",
    networkId: "network-1",
    requestStage: "Response",
    request: { url: "https://example.com/data", method: "GET" },
    responseStatusCode: 200,
    responseHeaders: [{ name: "content-type", value: "application/json" }],
    ...overrides,
  };
}

function setup() {
  const connection = new FakeConnection();
  const store = new MemoryStore();
  const coordinator = new FetchInterceptionCoordinator({ connection, store });
  return { connection, store, coordinator };
}

function scriptBodyStream(connection: FakeConnection, handle: string, body: Buffer, chunkSize = 4): void {
  connection.on("Fetch.takeResponseBodyAsStream", () => ({ stream: handle }));
  let offset = 0;
  connection.on("IO.read", () => {
    const slice = body.subarray(offset, offset + chunkSize);
    offset += slice.length;
    const eof = offset >= body.length;
    return { data: slice.toString("base64"), base64Encoded: true, eof };
  });
  connection.on("IO.close", () => ({}));
}

describe("FetchInterceptionCoordinator", () => {
  it("binds paused events to generation, network id, hop and stage", async () => {
    const { coordinator } = setup();
    await coordinator.beginNavigation();

    const first = coordinator.handleRequestPaused(
      pausedEvent({
        requestId: "i-1",
        requestStage: "Request",
        redirectResponse: { status: 302 },
      }),
    );
    const second = coordinator.handleRequestPaused(pausedEvent({ requestId: "i-2" }));

    assert.equal(first.generation, 1);
    assert.equal(first.networkRequestId, "network-1");
    assert.equal(first.redirectHop, 0);
    assert.equal(first.stage, "Request");
    assert.equal(second.redirectHop, 1);
    assert.equal(second.generation, 1);
  });

  it("resolves each paused event exactly once", async () => {
    const { connection, coordinator } = setup();
    connection.on("Fetch.continueRequest", () => ({}));
    connection.on("Fetch.fulfillRequest", () => ({}));
    connection.on("Fetch.failRequest", () => ({}));
    await coordinator.beginNavigation();
    coordinator.handleRequestPaused(pausedEvent());

    await coordinator.continueRequest("interception-1");
    await assert.rejects(coordinator.continueRequest("interception-1"), PausedRequestAlreadyResolvedError);
    await assert.rejects(
      coordinator.fulfillRequest("interception-1", { responseCode: 200 }),
      PausedRequestAlreadyResolvedError,
    );
    await assert.rejects(coordinator.failRequest("interception-1"), PausedRequestAlreadyResolvedError);
    assert.deepEqual(
      connection.methods().filter((method) => method.startsWith("Fetch.")),
      ["Fetch.continueRequest"],
    );
  });

  it("fulfills and fails distinct paused events once each", async () => {
    const { connection, coordinator } = setup();
    connection.on("Fetch.fulfillRequest", () => ({}));
    connection.on("Fetch.failRequest", () => ({}));
    await coordinator.beginNavigation();
    coordinator.handleRequestPaused(pausedEvent({ requestId: "i-a" }));
    coordinator.handleRequestPaused(pausedEvent({ requestId: "i-b" }));

    await coordinator.fulfillRequest("i-a", { responseCode: 204 });
    await coordinator.failRequest("i-b", "Failed");

    assert.deepEqual(connection.methods(), ["Fetch.fulfillRequest", "Fetch.failRequest"]);
    assert.equal(connection.calls[0].params.responseCode, 204);
    assert.equal(connection.calls[1].params.errorReason, "Failed");
  });

  it("rejects operations from stale navigation generations", async () => {
    const { connection, coordinator } = setup();
    connection.on("Fetch.continueRequest", () => ({}));
    connection.on("Fetch.failRequest", () => ({}));
    await coordinator.beginNavigation();
    coordinator.handleRequestPaused(pausedEvent());

    await coordinator.beginNavigation();

    await assert.rejects(coordinator.continueRequest("interception-1"), StaleGenerationError);
    await assert.rejects(coordinator.openBodyStream("interception-1"), StaleGenerationError);
    await assert.rejects(coordinator.finalizeCapture("interception-1"), StaleGenerationError);
    await assert.rejects(coordinator.continueRequest("never-seen"), UnknownPausedRequestError);
  });

  it("persists metadata and digest before confirming the capture", async () => {
    const { connection, store, coordinator } = setup();
    const body = Buffer.from(JSON.stringify({ ok: true, items: [1, 2, 3] }));
    scriptBodyStream(connection, "stream-1", body);
    connection.on("Fetch.continueRequest", () => ({}));
    await coordinator.beginNavigation();
    coordinator.handleRequestPaused(pausedEvent());
    await coordinator.continueRequest("interception-1");

    const stream = await coordinator.openBodyStream("interception-1");
    let received = 0;
    for await (const chunk of stream) {
      received += chunk.length;
    }
    assert.equal(received, body.length);
    assert.equal(stream.consumed, true);
    assert.equal(stream.closed, true);

    const confirmation = await coordinator.finalizeCapture("interception-1");

    assert.deepEqual(store.order, ["metadata", "digest", "confirm"]);
    assert.equal(store.digests[0].sha256, createHash("sha256").update(body).digest("hex"));
    assert.equal(store.digests[0].bytes, body.length);
    assert.equal(store.metadata[0].status, 200);
    assert.equal(store.metadata[0].responseHeaders["content-type"], "application/json");
    assert.equal(store.metadata[0].generation, 1);
    assert.equal(confirmation.interceptionId, "interception-1");
    assert.equal(confirmation.networkRequestId, "network-1");
  });

  it("refuses to confirm before the body stream is fully consumed", async () => {
    const { connection, store, coordinator } = setup();
    scriptBodyStream(connection, "stream-1", Buffer.from("partial-body"));
    await coordinator.beginNavigation();
    coordinator.handleRequestPaused(pausedEvent());

    await assert.rejects(coordinator.finalizeCapture("interception-1"), BodyStreamNotConsumedError);

    const stream = await coordinator.openBodyStream("interception-1");
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    await assert.rejects(coordinator.finalizeCapture("interception-1"), BodyStreamNotConsumedError);
    assert.deepEqual(store.order, []);
  });

  it("confirms a capture only once", async () => {
    const { connection, coordinator } = setup();
    scriptBodyStream(connection, "stream-1", Buffer.from("body"));
    await coordinator.beginNavigation();
    coordinator.handleRequestPaused(pausedEvent());
    const stream = await coordinator.openBodyStream("interception-1");
    for await (const chunk of stream) {
      void chunk;
    }

    await coordinator.finalizeCapture("interception-1");
    await assert.rejects(coordinator.finalizeCapture("interception-1"), CaptureAlreadyConfirmedError);
  });

  it("closes unconsumed streams and fails pending requests on cancel", async () => {
    const { connection, coordinator } = setup();
    scriptBodyStream(connection, "stream-open", Buffer.from("unconsumed-body"));
    connection.on("Fetch.failRequest", () => ({}));
    await coordinator.beginNavigation();
    coordinator.handleRequestPaused(pausedEvent({ requestId: "i-open" }));
    coordinator.handleRequestPaused(pausedEvent({ requestId: "i-pending", networkId: "network-2" }));
    const stream = await coordinator.openBodyStream("i-open");

    await coordinator.cancelGeneration();

    assert.equal(stream.closed, true);
    assert.deepEqual(
      connection.methods().filter((method) => method === "IO.close"),
      ["IO.close"],
    );
    const failCalls = connection.calls.filter((call) => call.method === "Fetch.failRequest");
    assert.deepEqual(
      failCalls.map((call) => call.params.requestId).sort(),
      ["i-open", "i-pending"],
    );
  });

  it("does not re-close fully consumed streams on cancel", async () => {
    const { connection, coordinator } = setup();
    scriptBodyStream(connection, "stream-1", Buffer.from("done"));
    connection.on("Fetch.failRequest", () => ({}));
    await coordinator.beginNavigation();
    coordinator.handleRequestPaused(pausedEvent());
    const stream = await coordinator.openBodyStream("interception-1");
    for await (const chunk of stream) {
      void chunk;
    }
    const closesAfterConsume = connection.calls.filter((call) => call.method === "IO.close").length;

    await coordinator.cancelGeneration();

    const closesAfterCancel = connection.calls.filter((call) => call.method === "IO.close").length;
    assert.equal(closesAfterConsume, 1);
    assert.equal(closesAfterCancel, 1);
  });
});
