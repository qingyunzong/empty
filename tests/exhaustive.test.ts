import assert from "node:assert/strict";
import test from "node:test";
import {
  CLIENT_TRANSITIONS,
  SERVER_TRANSITIONS,
  ClientEvent,
  ClientState,
  ServerEvent,
  ServerState,
  transitionState,
} from "../src/state-machine.ts";
import type { ClientEvent as ClientEventValue, ClientState as ClientStateValue } from "../src/state-machine.ts";
import type { ServerEvent as ServerEventValue, ServerState as ServerStateValue } from "../src/state-machine.ts";

const CLIENT_EVENTS: readonly ClientEventValue[] = Object.values(ClientEvent);
const SERVER_EVENTS: readonly ServerEventValue[] = Object.values(ServerEvent);

function oracleClient(
  state: ClientStateValue,
  event: ClientEventValue,
): ClientStateValue | undefined {
  if (event === "FAIL") return ClientState.Failed;
  if (state === ClientState.Failed) return undefined;
  if (state === ClientState.Start) {
    return event === "START" ? ClientState.InitialHelloSent : undefined;
  }
  if (state === ClientState.InitialHelloSent) {
    if (event === "CONFIRM_SENT" || event === "SEND_EARLY_DATA" || event === "RESEND") {
      return ClientState.InitialHelloSent;
    }
    if (event === "RECEIVE_HELLO_RETRY_REQUEST") return ClientState.RetryHelloSent;
    if (event === "RECEIVE_SERVER_HELLO") return ClientState.WaitEncryptedExtensions;
    return undefined;
  }
  if (state === ClientState.RetryHelloSent) {
    if (event === "CONFIRM_SENT" || event === "RESEND") return ClientState.RetryHelloSent;
    if (event === "RECEIVE_SERVER_HELLO") return ClientState.WaitEncryptedExtensions;
    return undefined;
  }
  if (state === ClientState.WaitEncryptedExtensions) {
    if (event === "CONFIRM_SENT") return state;
    if (event === "RECEIVE_ENCRYPTED_EXTENSIONS") return ClientState.WaitCertificate;
    return undefined;
  }
  if (state === ClientState.WaitCertificate) {
    if (event === "CONFIRM_SENT") return state;
    if (event === "RECEIVE_CERTIFICATE") return ClientState.WaitCertificateVerify;
    return undefined;
  }
  if (state === ClientState.WaitCertificateVerify) {
    if (event === "CONFIRM_SENT") return state;
    if (event === "RECEIVE_CERTIFICATE_VERIFY") return ClientState.WaitServerFinished;
    return undefined;
  }
  if (state === ClientState.WaitServerFinished) {
    if (event === "CONFIRM_SENT") return state;
    if (event === "RECEIVE_FINISHED") return ClientState.FinishedSent;
    return undefined;
  }
  if (state === ClientState.FinishedSent) {
    if (event === "CONFIRM_SENT") return ClientState.Connected;
    if (event === "RESEND") return state;
    return undefined;
  }
  if (state === ClientState.Connected) {
    if (event === "CONFIRM_SENT" || event === "RESEND"
      || event === "RECEIVE_NEW_SESSION_TICKET") {
      return state;
    }
    return undefined;
  }
  return undefined;
}

function oracleServer(
  state: ServerStateValue,
  event: ServerEventValue,
): ServerStateValue | undefined {
  if (event === "FAIL") return ServerState.Failed;
  if (state === ServerState.Failed) return undefined;
  if (state === ServerState.Start) {
    return event === "START" ? ServerState.WaitClientHello : undefined;
  }
  if (state === ServerState.WaitClientHello) {
    if (event === "CONFIRM_SENT" || event === "RESEND") return state;
    if (event === "RECEIVE_CLIENT_HELLO") return ServerState.WaitClientFinished;
    if (event === "RECEIVE_CLIENT_HELLO_RETRY") return ServerState.WaitSecondClientHello;
    return undefined;
  }
  if (state === ServerState.WaitSecondClientHello) {
    if (event === "CONFIRM_SENT" || event === "RESEND"
      || event === "RECEIVE_DUPLICATE_CLIENT_HELLO") {
      return state;
    }
    if (event === "RECEIVE_SECOND_CLIENT_HELLO") return ServerState.WaitClientFinished;
    return undefined;
  }
  if (state === ServerState.WaitClientFinished) {
    if (event === "CONFIRM_SENT" || event === "RESEND"
      || event === "RECEIVE_DUPLICATE_CLIENT_HELLO"
      || event === "RECEIVE_EARLY_DATA"
      || event === "RECEIVE_END_OF_EARLY_DATA") {
      return state;
    }
    if (event === "RECEIVE_FINISHED") return ServerState.Connected;
    return undefined;
  }
  if (state === ServerState.Connected) {
    if (event === "CONFIRM_SENT" || event === "RESEND"
      || event === "RECEIVE_EARLY_DATA"
      || event === "RECEIVE_END_OF_EARLY_DATA") {
      return state;
    }
    return undefined;
  }
  return undefined;
}

function walkClient(sequence: readonly ClientEventValue[]): {
  readonly state: ClientStateValue;
  readonly failedAt: number | undefined;
} {
  let state: ClientStateValue = ClientState.Start;
  for (let index = 0; index < sequence.length; index += 1) {
    try {
      state = transitionState(
        CLIENT_TRANSITIONS,
        state,
        sequence[index],
        ClientState.Failed,
      );
    } catch {
      return { state: ClientState.Failed, failedAt: index };
    }
  }
  return { state, failedAt: undefined };
}

function walkServer(sequence: readonly ServerEventValue[]): {
  readonly state: ServerStateValue;
  readonly failedAt: number | undefined;
} {
  let state: ServerStateValue = ServerState.Start;
  for (let index = 0; index < sequence.length; index += 1) {
    try {
      state = transitionState(
        SERVER_TRANSITIONS,
        state,
        sequence[index],
        ServerState.Failed,
      );
    } catch {
      return { state: ServerState.Failed, failedAt: index };
    }
  }
  return { state, failedAt: undefined };
}

function* sequences<T>(alphabet: readonly T[], length: number): Generator<T[]> {
  if (length === 0) {
    yield [];
    return;
  }
  for (const prefix of sequences(alphabet, length - 1)) {
    for (const symbol of alphabet) yield [...prefix, symbol];
  }
}

test("exhaustive client event sequences match the independent oracle", () => {
  const depth = 5;
  let count = 0;
  const reached = new Set<string>();
  for (const sequence of sequences(CLIENT_EVENTS, depth)) {
    count += 1;
    let tableState: ClientStateValue = ClientState.Start;
    let oracleState: ClientStateValue = ClientState.Start;
    let tableFailedAt: number | undefined;
    let oracleFailedAt: number | undefined;
    for (let index = 0; index < sequence.length; index += 1) {
      if (tableFailedAt === undefined) {
        try {
          tableState = transitionState(
            CLIENT_TRANSITIONS,
            tableState,
            sequence[index],
            ClientState.Failed,
          );
        } catch {
          tableFailedAt = index;
          tableState = ClientState.Failed;
        }
      }
      if (oracleFailedAt === undefined) {
        const next = oracleClient(oracleState, sequence[index]);
        if (next === undefined) {
          oracleFailedAt = index;
          oracleState = ClientState.Failed;
        } else {
          oracleState = next;
        }
      }
      assert.equal(
        tableState,
        oracleState,
        `state mismatch for ${sequence.slice(0, index + 1).join(",")}`,
      );
      assert.equal(
        tableFailedAt,
        oracleFailedAt,
        `failure position mismatch for ${sequence.join(",")}`,
      );
    }
    reached.add(tableState);
    assert.deepEqual(walkClient(sequence), {
      state: tableState,
      failedAt: tableFailedAt,
    });
  }
  assert.equal(count, CLIENT_EVENTS.length ** depth);
  assert.equal(reached.has(ClientState.Failed), true);
  assert.equal(reached.has(ClientState.WaitCertificate), true);
  assert.equal(reached.has(ClientState.WaitCertificateVerify), true);

  const fullPath: ClientEventValue[] = [
    "START",
    "RECEIVE_SERVER_HELLO",
    "RECEIVE_ENCRYPTED_EXTENSIONS",
    "RECEIVE_CERTIFICATE",
    "RECEIVE_CERTIFICATE_VERIFY",
    "RECEIVE_FINISHED",
    "CONFIRM_SENT",
  ];
  assert.deepEqual(walkClient(fullPath), {
    state: ClientState.Connected,
    failedAt: undefined,
  });

  const retryPath: ClientEventValue[] = [
    "START",
    "RECEIVE_HELLO_RETRY_REQUEST",
    "RESEND",
    "RECEIVE_SERVER_HELLO",
    "RECEIVE_ENCRYPTED_EXTENSIONS",
  ];
  assert.deepEqual(walkClient(retryPath), {
    state: ClientState.WaitCertificate,
    failedAt: undefined,
  });
});

test("exhaustive server event sequences match the independent oracle", () => {
  const depth = 5;
  let count = 0;
  const reached = new Set<string>();
  for (const sequence of sequences(SERVER_EVENTS, depth)) {
    count += 1;
    let tableState: ServerStateValue = ServerState.Start;
    let oracleState: ServerStateValue = ServerState.Start;
    let tableFailedAt: number | undefined;
    let oracleFailedAt: number | undefined;
    for (let index = 0; index < sequence.length; index += 1) {
      if (tableFailedAt === undefined) {
        try {
          tableState = transitionState(
            SERVER_TRANSITIONS,
            tableState,
            sequence[index],
            ServerState.Failed,
          );
        } catch {
          tableFailedAt = index;
          tableState = ServerState.Failed;
        }
      }
      if (oracleFailedAt === undefined) {
        const next = oracleServer(oracleState, sequence[index]);
        if (next === undefined) {
          oracleFailedAt = index;
          oracleState = ServerState.Failed;
        } else {
          oracleState = next;
        }
      }
      assert.equal(
        tableState,
        oracleState,
        `state mismatch for ${sequence.slice(0, index + 1).join(",")}`,
      );
      assert.equal(
        tableFailedAt,
        oracleFailedAt,
        `failure position mismatch for ${sequence.join(",")}`,
      );
    }
    reached.add(tableState);
    assert.deepEqual(walkServer(sequence), {
      state: tableState,
      failedAt: tableFailedAt,
    });
  }
  assert.equal(count, SERVER_EVENTS.length ** depth);
  assert.equal(reached.has(ServerState.Connected), true);
  assert.equal(reached.has(ServerState.WaitSecondClientHello), true);
  assert.equal(reached.has(ServerState.Failed), true);
});

test("resend is a self-loop in every retransmittable state", () => {
  for (const state of Object.values(ClientState)) {
    if (state === ClientState.Failed) continue;
    const next = CLIENT_TRANSITIONS[state].RESEND;
    if (next !== undefined) assert.equal(next, state, `client ${state}`);
  }
  for (const state of Object.values(ServerState)) {
    if (state === ServerState.Failed) continue;
    const next = SERVER_TRANSITIONS[state].RESEND;
    if (next !== undefined) assert.equal(next, state, `server ${state}`);
  }
});

test("state reachability implies a monotonic key-phase floor", () => {
  const phaseRank: Record<ClientStateValue, number> = {
    start: 0,
    initial_hello_sent: 0,
    retry_hello_sent: 0,
    wait_encrypted_extensions: 1,
    wait_certificate: 1,
    wait_certificate_verify: 1,
    wait_server_finished: 1,
    finished_sent: 2,
    connected: 3,
    failed: -1,
  };
  for (const sequence of sequences(CLIENT_EVENTS, 4)) {
    let state: ClientStateValue = ClientState.Start;
    let previousRank = 0;
    for (const event of sequence) {
      try {
        state = transitionState(CLIENT_TRANSITIONS, state, event, ClientState.Failed);
      } catch {
        state = ClientState.Failed;
      }
      if (state === ClientState.Failed) break;
      const rank = phaseRank[state];
      assert.ok(rank >= previousRank, `${sequence.join(",")} went backwards`);
      previousRank = rank;
    }
  }
});
