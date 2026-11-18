import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConnectionPool } from "../src/pool.ts";
import { ReferencePool } from "./reference.ts";

const BACKOFF = { baseMs: 100, factor: 2, maxMs: 400 };
const IDS = ["a", "b"] as const;

type ActionKind =
  | "connectOk"
  | "connectFail"
  | "checkStart"
  | "checkOk"
  | "checkFail"
  | "checkOkStale"
  | "checkFailStale"
  | "advance50"
  | "advance100"
  | "advance300";

interface Action {
  readonly kind: ActionKind;
  readonly id?: string;
}

const ALPHABET: Action[] = [
  ...IDS.flatMap((id): Action[] => [
    { kind: "connectOk", id },
    { kind: "connectFail", id },
    { kind: "checkStart", id },
    { kind: "checkOk", id },
    { kind: "checkFail", id },
    { kind: "checkOkStale", id },
    { kind: "checkFailStale", id },
  ]),
  { kind: "advance50" },
  { kind: "advance100" },
  { kind: "advance300" },
];

interface MemberView {
  id: string;
  state: string;
  attempt: number;
  failures: number;
  retryAt: number | null;
  checking: boolean;
  checkToken: number;
}

function makePools(): { pool: ConnectionPool; reference: ReferencePool } {
  const pool = new ConnectionPool({ backoff: BACKOFF });
  const reference = new ReferencePool(BACKOFF);
  for (const id of IDS) {
    const p = pool.add(id);
    const r = reference.add(id);
    assert.deepEqual(r, p);
  }
  return { pool, reference };
}

function applyAction(
  pool: ConnectionPool,
  reference: ReferencePool,
  action: Action,
): void {
  const id = action.id;
  switch (action.kind) {
    case "connectOk": {
      const p = pool.attemptOf(id as string);
      const r = reference.attemptOf(id as string);
      assert.equal(r, p);
      if (p !== null) {
        assert.equal(
          reference.connected(id as string, r as number),
          pool.connected(id as string, p),
        );
      }
      break;
    }
    case "connectFail": {
      const p = pool.attemptOf(id as string);
      const r = reference.attemptOf(id as string);
      assert.equal(r, p);
      if (p !== null) {
        assert.equal(
          reference.failed(id as string, r as number),
          pool.failed(id as string, p),
        );
      }
      break;
    }
    case "checkStart": {
      const p = pool.beginHealthCheck(id as string);
      const r = reference.beginHealthCheck(id as string);
      assert.deepEqual(r, p);
      break;
    }
    case "checkOk":
    case "checkFail": {
      const p = pool.get(id as string);
      const r = reference.get(id as string);
      const pToken = p !== undefined && p.checking ? p.checkToken : -1;
      const rToken = r !== undefined && r.checking ? r.checkToken : -1;
      assert.equal(rToken, pToken);
      const healthy = action.kind === "checkOk";
      const pResult =
        p === undefined
          ? false
          : pool.completeHealthCheck(
              { id: p.id, attempt: p.attempt, token: pToken },
              healthy,
            );
      const rResult =
        r === undefined
          ? false
          : reference.completeHealthCheck(
              { id: r.id, attempt: r.attempt, token: rToken },
              healthy,
            );
      assert.equal(rResult, pResult);
      break;
    }
    case "checkOkStale":
    case "checkFailStale": {
      const p = pool.get(id as string);
      const r = reference.get(id as string);
      const pToken = (p?.checkToken ?? 0) - 1;
      const rToken = (r?.checkToken ?? 0) - 1;
      assert.equal(rToken, pToken);
      const healthy = action.kind === "checkOkStale";
      const pResult =
        p === undefined
          ? false
          : pool.completeHealthCheck(
              { id: p.id, attempt: p.attempt, token: pToken },
              healthy,
            );
      const rResult =
        r === undefined
          ? false
          : reference.completeHealthCheck(
              { id: r.id, attempt: r.attempt, token: rToken },
              healthy,
            );
      assert.equal(rResult, pResult);
      break;
    }
    case "advance50":
    case "advance100":
    case "advance300": {
      const ms =
        action.kind === "advance50"
          ? 50
          : action.kind === "advance100"
            ? 100
            : 300;
      assert.deepEqual(reference.advance(ms), pool.advance(ms));
      break;
    }
  }
}

function normalizeMembers(members: readonly MemberView[]): MemberView[] {
  return members.map((member) => ({
    id: member.id,
    state: member.state,
    attempt: member.attempt,
    failures: member.failures,
    retryAt: member.retryAt,
    checking: member.checking,
    checkToken: member.checkToken,
  }));
}

function assertEquivalent(
  pool: ConnectionPool,
  reference: ReferencePool,
  context: string,
): void {
  const actual = pool.snapshot();
  const expected = reference.snapshot();
  assert.equal(actual.now, expected.now, context);
  assert.deepEqual(actual.readyIds, expected.readyIds, context);
  assert.equal(actual.readyCount, expected.readyCount, context);
  assert.deepEqual(actual.availableIds, expected.availableIds, context);
  assert.deepEqual(
    normalizeMembers(actual.members),
    normalizeMembers(expected.members),
    context,
  );
  assert.equal(pool.select(), reference.select(), context);
  assert.equal(
    pool.selectForKey("load-key"),
    reference.selectForKey("load-key"),
    context,
  );
}

function checkInvariants(
  pool: ConnectionPool,
  reference: ReferencePool,
  previous: Map<string, MemberView> | null,
): Map<string, MemberView> {
  const snapshot = pool.snapshot();
  assert.equal(
    snapshot.readyCount,
    snapshot.readyIds.length,
    "readyCount must match readyIds",
  );
  assert.equal(
    snapshot.readyCount,
    snapshot.availableIds.length,
    "readyCount must match availableIds",
  );
  assert.deepEqual(snapshot.readyIds, snapshot.availableIds);

  const current = new Map<string, MemberView>();
  for (const member of snapshot.members) {
    current.set(member.id, member);
    if (member.state === "ready") {
      assert.ok(snapshot.readyIds.includes(member.id));
    } else {
      assert.ok(!snapshot.readyIds.includes(member.id));
    }
    if (member.state === "reconnecting") {
      assert.notEqual(member.retryAt, null);
      assert.ok((member.retryAt as number) > snapshot.now);
    } else {
      assert.equal(member.retryAt, null);
    }
    if (member.state === "closed") {
      assert.equal(member.retryAt, null);
      assert.equal(member.checking, false);
    }
  }

  const selected = pool.select();
  const referenceSelected = reference.select();
  assert.equal(referenceSelected, selected, "selection must be deterministic");
  if (snapshot.readyCount === 0) {
    assert.equal(selected, null);
  } else {
    assert.ok(selected !== null);
    assert.ok(snapshot.readyIds.includes(selected));
  }

  if (previous !== null) {
    for (const [id, member] of current) {
      const prior = previous.get(id);
      if (prior === undefined) continue;
      assert.ok(
        member.attempt >= prior.attempt,
        `attempt for ${id} must not decrease`,
      );
      assert.ok(
        member.checkToken >= prior.checkToken,
        `check token for ${id} must not decrease`,
      );
      assert.ok(
        !(prior.state === "ready" && member.state === "connecting"),
        `ready -> connecting must pass through reconnecting (${id})`,
      );
      if (prior.state === "closed") {
        assert.equal(member.state, "closed", "closed is terminal");
      }
      if (
        prior.state === "reconnecting" &&
        member.state === "reconnecting" &&
        prior.attempt === member.attempt
      ) {
        assert.equal(
          member.retryAt,
          prior.retryAt,
          `retry deadline for ${id} must not jitter`,
        );
        assert.equal(member.failures, prior.failures);
      }
    }
  }
  return current;
}

function* enumerateSequences(
  depth: number,
): Generator<readonly Action[]> {
  const total = ALPHABET.length ** depth;
  for (let encoded = 0; encoded < total; encoded += 1) {
    let value = encoded;
    const sequence: Action[] = [];
    for (let index = 0; index < depth; index += 1) {
      sequence.push(ALPHABET[value % ALPHABET.length]);
      value = Math.floor(value / ALPHABET.length);
    }
    yield sequence;
  }
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe("exhaustive event-sequence differential", () => {
  it("matches the naive model for every sequence of length up to four", () => {
    let sequences = 0;
    let events = 0;
    for (let depth = 0; depth <= 4; depth += 1) {
      for (const sequence of enumerateSequences(depth)) {
        sequences += 1;
        const { pool, reference } = makePools();
        assertEquivalent(pool, reference, `initial ${sequence.length}`);
        let prior = checkInvariants(pool, reference, null);

        for (let index = 0; index < sequence.length; index += 1) {
          events += 1;
          const action = sequence[index];
          const context = `depth=${depth} seq=${sequence
            .map((item) => `${item.kind}:${item.id ?? "-"}`)
            .join(",")} step=${index}`;
          applyAction(pool, reference, action);
          assertEquivalent(pool, reference, context);
          prior = checkInvariants(pool, reference, prior);
        }
      }
    }
    assert.equal(sequences, 1 + 17 + 289 + 4_913 + 83_521);
    assert.equal(events, 17 + 2 * 289 + 3 * 4_913 + 4 * 83_521);
  });

  it("matches deeper seeded sequences with interleaved reconnects and checks", () => {
    const random = mulberry32(0x5eed_10057);
    for (let run = 0; run < 2_000; run += 1) {
      const { pool, reference } = makePools();
      let prior = checkInvariants(pool, reference, null);
      for (let step = 0; step < 16; step += 1) {
        const action = ALPHABET[Math.floor(random() * ALPHABET.length)];
        applyAction(pool, reference, action);
        assertEquivalent(pool, reference, `run=${run} step=${step}`);
        prior = checkInvariants(pool, reference, prior);
      }
    }
  });
});
