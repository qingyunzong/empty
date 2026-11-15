import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createWebhookRequestHandler } from "../src/http/server.js";
import { WebhookIngestor } from "../src/ingestor.js";
import { MemoryIngestionStore } from "../src/memory-store.js";
import { bodyDigest, signDelivery } from "../src/crypto.js";
import { endpointA, rotationHeaders, signedHeaders } from "./helpers.js";

const now = 1_700_000_000_000;

class FakeRequest extends EventEmitter {
  method = "POST";
  url: string;
  headers: Record<string, string>;
  private readonly chunks: Buffer[];

  constructor(url: string, headers: Record<string, string>, body: Buffer) {
    super();
    this.url = url;
    this.chunks = body.length === 0 ? [] : [body];
    this.headers = Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
    );
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Buffer, void, unknown> {
    for (const chunk of this.chunks) {
      yield chunk;
    }
  }
}

class FakeResponse {
  statusCode = 200;
  headers = new Map<string, number | string>();
  body = "";
  ended = false;

  writeHead(statusCode: number, headers: Record<string, number | string>): this {
    this.statusCode = statusCode;
    for (const [name, value] of Object.entries(headers)) this.headers.set(name, value);
    return this;
  }

  end(chunk?: string): void {
    if (chunk !== undefined) this.body += chunk;
    this.ended = true;
  }

  json(): any {
    return JSON.parse(this.body) as any;
  }
}

function harness() {
  const store = new MemoryIngestionStore();
  const ingestor = new WebhookIngestor([endpointA], store, { nowMs: () => now });
  const handler = createWebhookRequestHandler(ingestor);
  return {
    store,
    async call(
      url: string,
      body: Buffer,
      headers: Record<string, string>,
      method = "POST",
    ): Promise<FakeResponse> {
      const req = new FakeRequest(url, headers, body) as unknown as IncomingMessage;
      req.method = method;
      const res = new FakeResponse() as unknown as ServerResponse & FakeResponse;
      await handler(req, res as unknown as ServerResponse);
      return res as unknown as FakeResponse;
    },
  };
}

test("POST returns a 200 receipt bound to the committed offset", async () => {
  const { call } = harness();
  const body = Buffer.from('{"hello":"world"}');
  const res = await call("/webhooks/endpoint-a", body, signedHeaders(endpointA.keys[0]!, "http-1", now, body));

  assert.equal(res.statusCode, 200);
  assert.equal(res.ended, true);
  assert.equal(res.json().status, "accepted");
  assert.equal(res.json().committedOffset, "0");
  assert.equal(res.json().bodyDigest, bodyDigest(body));
  assert.equal(res.json().deliveryId, "http-1");
});

test("a redelivered id returns duplicate with the same committed offset", async () => {
  const { call, store } = harness();
  const body = Buffer.from('{"hello":"world"}');
  const headers = signedHeaders(endpointA.keys[0]!, "http-1", now, body);
  await call("/webhooks/endpoint-a", body, headers);
  const res = await call("/webhooks/endpoint-a", body, headers);

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, "duplicate");
  assert.equal(res.json().committedOffset, "0");
  assert.equal(store.events(endpointA.id).length, 1);
});

test("a conflicting body is rejected with 409 and is marked non-retryable", async () => {
  const { call } = harness();
  const original = Buffer.from('{"hello":"world"}');
  await call(
    "/webhooks/endpoint-a",
    original,
    signedHeaders(endpointA.keys[0]!, "http-1", now, original),
  );
  const changed = Buffer.from('{"hello":"changed"}');
  const res = await call(
    "/webhooks/endpoint-a",
    changed,
    signedHeaders(endpointA.keys[0]!, "http-1", now, changed),
  );

  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error.code, "BODY_CONFLICT");
  assert.equal(res.json().error.retryable, false);
});

test("a rotation header signed with both generations is accepted only once", async () => {
  const { call } = harness();
  const body = Buffer.from('{"rotate":"now"}');
  const first = await call(
    "/webhooks/endpoint-a",
    body,
    rotationHeaders(endpointA.keys, "http-rotate", now, body),
  );
  const second = await call(
    "/webhooks/endpoint-a",
    body,
    signedHeaders(endpointA.keys[1]!, "http-rotate", now, body),
  );

  assert.equal(first.statusCode, 200);
  assert.equal(first.json().status, "accepted");
  assert.equal(second.json().status, "duplicate");
  assert.equal(second.json().committedOffset, first.json().committedOffset);
});

test("missing envelope headers are rejected with 401", async () => {
  const { call } = harness();
  const res = await call("/webhooks/endpoint-a", Buffer.from("x"), {});
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error.code, "MISSING_ENVELOPE");
});

test("an invalid signature is rejected with 401 and creates no stored event", async () => {
  const { call, store } = harness();
  const body = Buffer.from('{"bad":true}');
  const headers = signedHeaders(endpointA.keys[0]!, "http-bad", now, body);
  headers["webhook-signature"] = signDelivery(
    endpointA.keys[0]!,
    "http-bad",
    now,
    Buffer.from("different-body"),
  );
  const before = store.events(endpointA.id).length;
  const res = await call("/webhooks/endpoint-a", body, headers);
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error.code, "INVALID_SIGNATURE");
  assert.equal(store.events(endpointA.id).length, before);
});

test("skewed timestamps map to 401 even when the mac is otherwise valid", async () => {
  const { call } = harness();
  const body = Buffer.from("late");
  const stale = now - endpointA.timestampToleranceMs - 1;
  const res = await call(
    "/webhooks/endpoint-a",
    body,
    signedHeaders(endpointA.keys[0]!, "http-late", stale, body),
  );
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error.code, "TIMESTAMP_SKEW");
});

test("unknown routes and methods map to 404 and 405", async () => {
  const { call } = harness();
  const methodRes = await call("/webhooks/endpoint-a", Buffer.from(""), {}, "GET");
  assert.equal(methodRes.statusCode, 405);

  const routeRes = await call("/nope", Buffer.from(""), {});
  assert.equal(routeRes.statusCode, 404);
});

test("an unknown endpoint id inside the route returns 404", async () => {
  const { call } = harness();
  const body = Buffer.from("{}");
  const res = await call(
    "/webhooks/does-not-exist",
    body,
    signedHeaders(endpointA.keys[0]!, "http-x", now, body),
  );
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error.code, "UNKNOWN_ENDPOINT");
});

test("a storage failure surfaces as a retryable 503 and the next attempt commits", async () => {
  let failOnce = true;
  const store = new MemoryIngestionStore({
    beforeCommit: () => {
      if (failOnce) {
        failOnce = false;
        throw new Error("deadlock");
      }
    },
  });
  const ingestor = new WebhookIngestor([endpointA], store, { nowMs: () => now });
  const handler = createWebhookRequestHandler(ingestor);
  const body = Buffer.from('{"flaky":true}');
  const headers = signedHeaders(endpointA.keys[0]!, "http-flaky", now, body);

  const req1 = new FakeRequest("/webhooks/endpoint-a", headers, body);
  const res1 = new FakeResponse();
  await handler(req1 as unknown as IncomingMessage, res1 as unknown as ServerResponse);
  assert.equal(res1.statusCode, 503);
  assert.equal(res1.json().error.retryable, true);
  assert.equal(store.events(endpointA.id).length, 0);

  const req2 = new FakeRequest("/webhooks/endpoint-a", headers, body);
  const res2 = new FakeResponse();
  await handler(req2 as unknown as IncomingMessage, res2 as unknown as ServerResponse);
  assert.equal(res2.statusCode, 200);
  assert.equal(res2.json().status, "accepted");
  assert.equal(res2.json().committedOffset, "0");
  assert.equal(store.events(endpointA.id).length, 1);
});
