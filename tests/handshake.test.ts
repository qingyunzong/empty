import assert from "node:assert/strict";
import test from "node:test";
import { concat, hex } from "../src/bytes.ts";
import {
  CertificateVerificationError,
  EarlyDataRejectedError,
  EarlyDataReplayError,
  HandshakeError,
  IllegalTransitionError,
  SecretUnavailableError,
} from "../src/errors.ts";
import {
  ClientHandshake,
  ServerHandshake,
} from "../src/handshake.ts";
import type {
  ClientHandshakeOptions,
  ServerHandshakeOptions,
} from "../src/handshake.ts";
import { InMemoryTicketStore, EarlyDataReplayGuard } from "../src/early-data.ts";
import type { EarlyDataTicket } from "../src/early-data.ts";
import {
  encodeHandshakeMessage,
  encodeMessageHash,
  createHelloRetryRequest,
  HELLO_RETRY_REQUEST_RANDOM,
} from "../src/messages.ts";
import type { HandshakeMessage } from "../src/messages.ts";
import { NodeCryptoProvider } from "../src/node-crypto.ts";
import { hashLength } from "../src/crypto.ts";
import { Tls13KeySchedule } from "../src/key-schedule.ts";
import { X25519KeyExchangeProvider } from "../src/key-exchange.ts";
import { Transcript } from "../src/transcript.ts";
import {
  FakeCertificateAuthority,
  FakeKeyExchange,
  FakeVerifier,
  makeTicket,
  sha256,
} from "./helpers.ts";

const crypto = new NodeCryptoProvider();
const NOW = 10_000;

interface SetupOptions {
  readonly groups?: readonly string[];
  readonly keyShareGroups?: readonly string[];
  readonly requiredGroup?: string;
  readonly earlyTicket?: EarlyDataTicket;
  readonly ticketStore?: InMemoryTicketStore;
  readonly replayGuard?: EarlyDataReplayGuard;
  readonly clock?: () => number;
}

function setup(options: SetupOptions = {}) {
  const groups = options.groups ?? ["x25519", "P-256"];
  const authority = new FakeCertificateAuthority();
  const verifier = new FakeVerifier(authority);
  const clock = options.clock ?? (() => NOW);

  const clientOptions: ClientHandshakeOptions = {
    crypto,
    keyExchange: new FakeKeyExchange(groups),
    keyShareGroups: options.keyShareGroups,
    certificateVerifier: verifier,
    serverName: "example.test",
    clock,
    earlyData: options.earlyTicket === undefined
      ? undefined
      : { ticket: options.earlyTicket },
  };
  const serverOptions: ServerHandshakeOptions = {
    crypto,
    keyExchange: new FakeKeyExchange(groups),
    requiredKeyShareGroup: options.requiredGroup,
    credentials: {
      certificateChain: authority.chain,
      signCertificateVerify: ({ data }) => ({
        algorithm: "test-hmac-sha256",
        signature: authority.sign(data),
      }),
    },
    ticketStore: options.ticketStore,
    replayGuard: options.replayGuard,
    clock,
  };

  const client = new ClientHandshake(clientOptions);
  const server = new ServerHandshake(serverOptions);
  server.start();
  return { client, server, verifier, authority };
}

function assertSecretsEqual(
  client: ClientHandshake,
  server: ServerHandshake,
  name:
    | "handshake_secret"
    | "client_handshake_traffic_secret"
    | "server_handshake_traffic_secret"
    | "master_secret"
    | "client_application_traffic_secret_0"
    | "server_application_traffic_secret_0"
    | "resumption_master_secret",
): void {
  assert.equal(hex(client.secret(name)), hex(server.secret(name)), name);
}

function completeClientFlight(
  client: ClientHandshake,
  flight: readonly HandshakeMessage[],
): HandshakeMessage[] {
  let outgoing: HandshakeMessage[] = [];
  for (const message of flight) {
    outgoing = client.receive(message);
  }
  return outgoing;
}

test("full certificate handshake advances states and key epochs in order", () => {
  const { client, server } = setup();
  assert.equal(client.state, "start");
  assert.equal(client.keyEpoch, "none");
  assert.deepEqual(client.snapshot().audit, []);

  const [clientHello] = client.start();
  assert.equal(clientHello.type, "client_hello");
  assert.equal(client.state, "initial_hello_sent");
  assert.equal(client.keyEpoch, "none");
  assert.deepEqual(client.snapshot().audit, []);

  const flight = server.receive(clientHello);
  assert.deepEqual(
    flight.map((message) => message.type),
    [
      "server_hello",
      "encrypted_extensions",
      "certificate",
      "certificate_verify",
      "finished",
    ],
  );
  assert.equal(server.state, "wait_client_finished");
  assert.equal(server.keyEpoch, "application");
  assert.equal(server.keySchedule.hasSecret("resumption_master_secret"), false);

  client.receive(flight[0]);
  assert.equal(client.state, "wait_encrypted_extensions");
  assert.equal(client.keyEpoch, "handshake");
  assert.equal(client.keySchedule.hasSecret("client_application_traffic_secret_0"), false);
  assertSecretsEqual(client, server, "handshake_secret");

  client.receive(flight[1]);
  assert.equal(client.state, "wait_certificate");
  assert.equal(client.earlyDataStatus, "not_offered");

  client.receive(flight[2]);
  assert.equal(client.state, "wait_certificate_verify");

  client.receive(flight[3]);
  assert.equal(client.state, "wait_server_finished");
  assert.equal(client.keySchedule.hasSecret("master_secret"), false);

  const clientFinished = client.receive(flight[4]);
  assert.equal(clientFinished.length, 1);
  assert.equal(clientFinished[0].type, "finished");
  assert.equal(client.state, "finished_sent");
  assert.equal(client.keyEpoch, "application");
  assert.equal(client.keySchedule.hasSecret("resumption_master_secret"), false);
  assertSecretsEqual(client, server, "client_application_traffic_secret_0");
  assertSecretsEqual(client, server, "server_application_traffic_secret_0");

  client.confirmSent();
  assert.equal(client.state, "connected");
  assert.equal(client.keyEpoch, "resumption");
  assert.equal(server.receive(clientFinished[0]).length, 0);
  assert.equal(server.state, "connected");
  assert.equal(server.keyEpoch, "resumption");
  assertSecretsEqual(client, server, "resumption_master_secret");

  const clientAudit = client.snapshot().audit;
  assert.equal(
    clientAudit.find((entry) => entry.label === "c hs traffic")?.trigger
      ?.startsWith("receive:server_hello:"),
    true,
  );
  assert.equal(
    clientAudit.find((entry) => entry.label === "c ap traffic")?.trigger
      ?.startsWith("receive:server_finished:"),
    true,
  );
  assert.equal(
    clientAudit.find((entry) => entry.label === "res master")?.trigger
      ?.startsWith("confirm:client_finished:"),
    true,
  );
});

test("retransmission and resend never re-run key derivation", () => {
  const { client, server } = setup();
  const [clientHello] = client.start();
  const auditBefore = client.snapshot().audit.length;
  const resentHello = client.resend();
  assert.equal(resentHello[0].id, clientHello.id);
  assert.equal(client.keyEpoch, "none");
  assert.equal(client.snapshot().audit.length, auditBefore);

  const flight = server.receive(clientHello);
  const serverAudit = server.snapshot().audit.length;
  const serverEpoch = server.keyEpoch;
  const resentFlight = server.receive(clientHello);
  assert.deepEqual(
    resentFlight.map((message) => message.id),
    flight.map((message) => message.id),
  );
  assert.equal(server.snapshot().audit.length, serverAudit);
  assert.equal(server.keyEpoch, serverEpoch);
  assert.equal(server.state, "wait_client_finished");

  completeClientFlight(client, flight);
  const clientAuditAfterFlight = client.snapshot().audit.length;
  const clientEpochAfterFlight = client.keyEpoch;
  assert.deepEqual(client.receive(flight[0]), []);
  assert.equal(client.snapshot().audit.length, clientAuditAfterFlight);
  assert.equal(client.keyEpoch, clientEpochAfterFlight);
});

test("HelloRetryRequest rejects 0-RTT and keeps handshake keys unset until CH2/SH2", () => {
  const ticket = makeTicket();
  const store = new InMemoryTicketStore([ticket]);
  const { client, server } = setup({
    groups: ["x25519", "P-256"],
    keyShareGroups: ["x25519"],
    requiredGroup: "P-256",
    earlyTicket: ticket,
    ticketStore: store,
  });

  const [clientHello] = client.start();
  assert.equal(clientHello.type, "client_hello");
  assert.equal(
    clientHello.type === "client_hello" ? clientHello.keyShares.length : -1,
    1,
  );
  client.confirmSent();
  assert.equal(client.keyEpoch, "early");
  assert.equal(client.keySchedule.earlyTrafficUsable, true);

  const [retry] = server.receive(clientHello);
  assert.equal(retry.type, "hello_retry_request");
  assert.equal(server.state, "wait_second_client_hello");
  assert.equal(server.keyEpoch, "none");
  assert.equal(server.earlyDataStatus, "rejected");
  assert.equal(server.earlyDataRejectReason, "hello_retry");
  assert.equal(server.keySchedule.hasSecret("handshake_secret"), false);
  assert.equal(server.keySchedule.hasSecret("client_early_traffic_secret"), false);

  const [secondHello] = client.receive(retry);
  assert.equal(secondHello.type, "client_hello");
  assert.equal(client.state, "retry_hello_sent");
  assert.equal(client.keyEpoch, "none");
  assert.equal(client.earlyDataStatus, "rejected");
  assert.equal(client.earlyDataRejectReason, "hello_retry");
  assert.equal(client.keySchedule.hasSecret("handshake_secret"), false);
  assert.throws(() => client.earlyTrafficKeys(), SecretUnavailableError);

  const serverAudit = server.snapshot().audit.length;
  const resentRetry = server.receive(clientHello);
  assert.equal(resentRetry[0].type, "hello_retry_request");
  assert.equal(server.snapshot().audit.length, serverAudit);
  assert.equal(server.helloRetryCount, 1);

  const resentSecond = client.resend();
  assert.equal(resentSecond[0].id, secondHello.id);
  assert.equal(client.keyEpoch, "none");
  assert.equal(client.keySchedule.hasSecret("handshake_secret"), false);

  const flight = server.receive(secondHello);
  assert.equal(server.keyEpoch, "application");
  const [serverHello] = flight;
  client.receive(serverHello);
  assert.equal(client.keyEpoch, "handshake");
  assertSecretsEqual(client, server, "handshake_secret");

  const folded = new Transcript(crypto, "SHA-256");
  folded.add(clientHello as Extract<HandshakeMessage, { type: "client_hello" }>);
  folded.foldClientHelloForHelloRetry(
    clientHello as Extract<HandshakeMessage, { type: "client_hello" }>,
  );
  folded.add(retry);
  folded.add(secondHello);
  folded.add(serverHello);
  const expectedHash = sha256(concat(
    encodeMessageHash(sha256(encodeHandshakeMessage(clientHello))),
    encodeHandshakeMessage(retry),
    encodeHandshakeMessage(secondHello),
    encodeHandshakeMessage(serverHello),
  ));
  assert.equal(hex(folded.hash()), hex(expectedHash));

  const ecdhe = new FakeKeyExchange(["P-256"]).acceptOffer(
    "P-256",
    ((secondHello as Extract<HandshakeMessage, { type: "client_hello" }>).keyShares[0].share),
  ).sharedSecret;
  const zero = new Uint8Array(hashLength("SHA-256"));
  const zeroPskEarly = new Tls13KeySchedule(crypto, "SHA-256");
  zeroPskEarly.deriveHandshake(ecdhe, expectedHash, { trigger: "reference" });
  assert.equal(
    hex(server.keySchedule.getSecret("handshake_secret")),
    hex(zeroPskEarly.getSecret("handshake_secret")),
  );

  const clientFinished = completeClientFlight(client, flight.slice(1));
  assert.equal(client.earlyDataStatus, "rejected");
  server.receive(clientFinished[0]);
  client.confirmSent();
  assert.equal(client.state, "connected");
  assert.equal(server.state, "connected");
  assertSecretsEqual(client, server, "resumption_master_secret");
});

test("accepted 0-RTT derives early keys only after ClientHello confirmation", () => {
  const ticket = makeTicket();
  const store = new InMemoryTicketStore([ticket]);
  const guard = new EarlyDataReplayGuard();
  const { client, server } = setup({
    earlyTicket: ticket,
    ticketStore: store,
    replayGuard: guard,
  });
  const [clientHello] = client.start();
  assert.equal(client.keyEpoch, "none");
  assert.equal(client.keySchedule.hasSecret("client_early_traffic_secret"), false);
  assert.throws(
    () => client.sendEarlyData(new Uint8Array([1])),
    SecretUnavailableError,
  );
  client.confirmSent();
  assert.equal(client.keyEpoch, "early");
  const record = client.sendEarlyData(new Uint8Array([1, 2, 3]));

  const flight = server.receive(clientHello);
  assert.equal(server.earlyDataStatus, "accepted");
  assert.equal(server.keySchedule.earlyTrafficUsable, true);
  assert.deepEqual(server.receiveEarlyData(record), new Uint8Array([1, 2, 3]));
  assert.equal(
    hex(server.secret("early_secret")),
    hex(client.secret("early_secret")),
  );

  const outgoing = completeClientFlight(client, flight);
  assert.deepEqual(
    outgoing.map((message) => message.type),
    ["end_of_early_data", "finished"],
  );
  assert.equal(client.earlyDataStatus, "accepted");
  server.receive(outgoing[0]);
  server.receive(outgoing[1]);
  client.confirmSent(outgoing[0].id);
  assert.equal(client.state, "finished_sent");
  assert.equal(client.keySchedule.hasSecret("resumption_master_secret"), false);
  client.confirmSent(outgoing[1].id);
  assert.equal(client.state, "connected");
  assert.equal(server.state, "connected");
  assertSecretsEqual(client, server, "handshake_secret");
  assertSecretsEqual(client, server, "client_application_traffic_secret_0");
  assertSecretsEqual(client, server, "resumption_master_secret");
});

test("a selected 0-RTT PSK still seeds the handshake when ClientHello was not confirmed", () => {
  const ticket = makeTicket();
  const { client, server } = setup({
    earlyTicket: ticket,
    ticketStore: new InMemoryTicketStore([ticket]),
  });
  const [hello] = client.start();
  assert.equal(client.keyEpoch, "none");
  const flight = server.receive(hello);
  assert.equal(server.earlyDataStatus, "accepted");
  assert.equal(
    (flight[0] as Extract<HandshakeMessage, { type: "server_hello" }>)
      .selectedPskTicketId,
    ticket.id,
  );

  client.receive(flight[0]);
  assert.equal(client.keyEpoch, "handshake");
  assert.equal(client.secretNames.includes("early_secret"), true);
  assert.equal(client.secretNames.includes("client_early_traffic_secret"), false);
  assertSecretsEqual(client, server, "handshake_secret");
  assertSecretsEqual(client, server, "server_handshake_traffic_secret");
});

test("a replayed ticket rejects 0-RTT data without aborting the handshake", () => {
  const ticket = makeTicket();
  const store = new InMemoryTicketStore([ticket]);
  const guard = new EarlyDataReplayGuard();

  const first = setup({ earlyTicket: ticket, ticketStore: store, replayGuard: guard });
  const [firstHello] = first.client.start();
  first.client.confirmSent();
  const firstRecord = first.client.sendEarlyData(new Uint8Array([7]));
  first.server.receive(firstHello);
  assert.deepEqual(first.server.receiveEarlyData(firstRecord), new Uint8Array([7]));

  const second = setup({ earlyTicket: ticket, ticketStore: store, replayGuard: guard });
  const [secondHello] = second.client.start();
  second.client.confirmSent();
  const secondRecord = second.client.sendEarlyData(new Uint8Array([8]));
  const flight = second.server.receive(secondHello);
  assert.equal(second.server.earlyDataStatus, "rejected");
  assert.equal(second.server.earlyDataRejectReason, "replay");
  assert.equal(
    second.server.keySchedule.hasSecret("client_early_traffic_secret"),
    false,
  );
  assert.throws(
    () => second.server.receiveEarlyData(secondRecord),
    (error: unknown) => {
      assert.equal(error instanceof EarlyDataReplayError, true);
      assert.equal((error as HandshakeError).code, "EARLY_DATA_REPLAY");
      return true;
    },
  );
  assert.equal(second.server.state, "wait_client_finished");
  assert.equal(second.server.failed, false);

  second.client.receive(flight[0]);
  assert.equal(second.client.earlyDataStatus, "rejected");
  assert.equal(second.client.earlyDataRejectReason, "psk_not_selected");
  assert.throws(
    () => second.client.earlyTrafficKeys(),
    SecretUnavailableError,
  );
  second.client.receive(flight[1]);
  assert.equal(second.client.earlyDataStatus, "rejected");
  assert.equal(second.client.earlyDataRejectReason, "replay");

  const outgoing = completeClientFlight(second.client, flight.slice(2));
  second.server.receive(outgoing[0]);
  second.client.confirmSent();
  assert.equal(second.client.state, "connected");
  assert.equal(second.server.state, "connected");
  assertSecretsEqual(second.client, second.server, "resumption_master_secret");
});

test("certificate chain and CertificateVerify failures stop before application keys", () => {
  for (const mode of ["chain", "signature"] as const) {
    const { client, server, verifier } = setup();
    const [hello] = client.start();
    const flight = server.receive(hello);
    client.receive(flight[0]);
    client.receive(flight[1]);
    if (mode === "chain") verifier.rejectChain = true;
    if (mode === "signature") verifier.rejectSignature = true;
    if (mode === "chain") {
      assert.throws(() => client.receive(flight[2]), CertificateVerificationError);
    } else {
      client.receive(flight[2]);
      assert.throws(
        () => client.receive(flight[3]),
        (error: unknown) => {
          assert.equal(error instanceof HandshakeError, true);
          assert.equal((error as HandshakeError).code, "CERTIFICATE_SIGNATURE_REJECTED");
          return true;
        },
      );
    }
    assert.equal(client.state, "failed");
    assert.equal(client.keyEpoch, "handshake");
    assert.equal(
      client.keySchedule.hasSecret("client_application_traffic_secret_0"),
      false,
    );
    assert.throws(() => client.receive(flight[4]), IllegalTransitionError);
  }
});

test("out-of-order messages and a second HRR fail closed", () => {
  const early = setup();
  assert.throws(
    () => early.client.receive({
      type: "finished",
      id: "bogus",
      sequence: 99,
      body: new Uint8Array(),
      verifyData: new Uint8Array(32),
    }),
    IllegalTransitionError,
  );
  assert.equal(early.client.state, "failed");
  assert.throws(
    () => early.server.receive({
      type: "finished",
      id: "bogus",
      sequence: 99,
      body: new Uint8Array(),
      verifyData: new Uint8Array(32),
    }),
    IllegalTransitionError,
  );
  assert.equal(early.server.state, "failed");

  const retry = setup({
    keyShareGroups: ["x25519"],
    requiredGroup: "P-256",
  });
  const [hello] = retry.client.start();
  const [firstRetry] = retry.server.receive(hello);
  retry.client.receive(firstRetry);
  assert.equal(retry.client.state, "retry_hello_sent");
  const secondRetry = createHelloRetryRequest({
    id: "server-hrr-2",
    sequence: 2,
    sessionIdEcho: (hello as Extract<HandshakeMessage, { type: "client_hello" }>).sessionId,
    cipherSuite: "TLS_AES_128_GCM_SHA256",
    selectedGroup: "P-256",
  });
  assert.throws(
    () => retry.client.receive(secondRetry),
    IllegalTransitionError,
  );
  assert.equal(retry.client.state, "failed");
});

test("late ClientHello confirmation cannot derive early keys", () => {
  const ticket = makeTicket();
  const { client, server } = setup({
    keyShareGroups: ["x25519"],
    requiredGroup: "P-256",
    earlyTicket: ticket,
    ticketStore: new InMemoryTicketStore([ticket]),
  });
  const [hello] = client.start();
  const [retry] = server.receive(hello);
  client.receive(retry);
  assert.equal(client.state, "retry_hello_sent");
  assert.equal(client.keySchedule.hasSecret("early_secret"), false);
  assert.throws(
    () => client.confirmSent(hello.id),
    (error: unknown) => {
      assert.equal(error instanceof HandshakeError, true);
      assert.equal((error as HandshakeError).code, "LATE_CONFIRMATION");
      return true;
    },
  );
  assert.equal(client.state, "retry_hello_sent");
  assert.equal(client.keyEpoch, "none");
  assert.equal(client.keySchedule.hasSecret("early_secret"), false);
  assert.equal(client.keySchedule.hasSecret("handshake_secret"), false);
});

test("rejected early data is reported to the client and its keys are destroyed", () => {
  const ticket = makeTicket();
  const store = new InMemoryTicketStore([ticket]);
  const { client, server } = setup({
    earlyTicket: ticket,
    ticketStore: store,
  });
  const [hello] = client.start();
  client.confirmSent();
  assert.equal(client.keyEpoch, "early");
  const flight = server.receive(hello);
  assert.equal(server.earlyDataStatus, "accepted");

  client.receive(flight[0]);
  const ee = flight[1];
  assert.equal(ee.type, "encrypted_extensions");
  if (ee.type === "encrypted_extensions") {
    const replaced = {
      ...ee,
      earlyData: "rejected" as const,
      earlyDataRejectReason: "replay",
    };
    client.receive(replaced);
  }
  assert.equal(client.earlyDataStatus, "rejected");
  assert.equal(client.earlyDataRejectReason, "replay");
  assert.throws(() => client.earlyTrafficKeys(), SecretUnavailableError);
});

test("a ticket older than its lifetime is rejected, not treated as a replay", () => {
  const ticket = makeTicket();
  const store = new InMemoryTicketStore([ticket]);
  const { client, server } = setup({
    earlyTicket: ticket,
    ticketStore: store,
    clock: () => NOW + ticket.lifetimeMs + 1,
  });
  const [hello] = client.start();
  client.confirmSent();
  const record = client.sendEarlyData(new Uint8Array([5]));
  server.receive(hello);
  assert.equal(server.earlyDataStatus, "rejected");
  assert.equal(server.earlyDataRejectReason, "expired");
  assert.throws(
    () => server.receiveEarlyData(record),
    (error: unknown) => {
      assert.equal(error instanceof EarlyDataRejectedError, true);
      assert.equal((error as EarlyDataRejectedError).reason, "expired");
      return true;
    },
  );
});

test("HelloRetryRequest message uses the RFC 8446 special random", () => {
  assert.equal(hex(HELLO_RETRY_REQUEST_RANDOM).length, 64);
  assert.equal(
    hex(HELLO_RETRY_REQUEST_RANDOM),
    "cf21ad74e59a6111be1d8c021e65b891c2a211167abb8c5e079e09e2c8a8339c",
  );
});

test("real X25519 provider completes a SHA-384 handshake", () => {
  const authority = new FakeCertificateAuthority();
  const verifier = new FakeVerifier(authority);
  const client = new ClientHandshake({
    crypto,
    algorithm: "SHA-384",
    keyExchange: new X25519KeyExchangeProvider(),
    certificateVerifier: verifier,
    serverName: "example.test",
  });
  const server = new ServerHandshake({
    crypto,
    algorithm: "SHA-384",
    keyExchange: new X25519KeyExchangeProvider(),
    credentials: {
      certificateChain: authority.chain,
      signCertificateVerify: ({ data }) => ({
        algorithm: "test-hmac-sha384",
        signature: authority.sign(data),
      }),
    },
  });
  server.start();
  const [hello] = client.start();
  const flight = server.receive(hello);
  const outgoing = completeClientFlight(client, flight);
  server.receive(outgoing[0]);
  client.confirmSent();
  assert.equal(client.state, "connected");
  assert.equal(server.state, "connected");
  assert.equal(client.keySchedule.keyLengthValue, 32);
  assertSecretsEqual(client, server, "resumption_master_secret");
});
