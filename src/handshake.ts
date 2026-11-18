import { cloneBytes, equalConstantTime } from "./bytes.ts";
import type { CertificateVerifier, CertificateVerificationContext } from "./certificate.ts";
import { RejectAllCertificateVerifier } from "./certificate.ts";
import type { CryptoProvider, HashAlgorithm } from "./crypto.ts";
import { defaultCryptoProvider } from "./crypto.ts";
import type {
  EarlyDataCheck,
  EarlyDataTicket,
  TicketStore,
} from "./early-data.ts";
import { EarlyDataReplayGuard } from "./early-data.ts";
import {
  CertificateVerificationError,
  EarlyDataRejectedError,
  EarlyDataReplayError,
  HandshakeError,
  IllegalTransitionError,
  InvalidMessageError,
  SecretUnavailableError,
} from "./errors.ts";
import type { KeyExchangeProvider } from "./key-exchange.ts";
import type {
  ClientHelloMessage,
  EncryptedExtensionsMessage,
  HandshakeMessage,
  HelloRetryRequestMessage,
  ServerHelloMessage,
} from "./messages.ts";
import {
  certificateVerifyContent,
  createCertificate,
  createCertificateVerify,
  createClientHello,
  createEncryptedExtensions,
  createEndOfEarlyData,
  createFinished,
  createHelloRetryRequest,
  createServerHello,
  HELLO_RETRY_REQUEST_RANDOM,
} from "./messages.ts";
import type {
  DerivationAuditEntry,
  KeyEpoch,
  SecretName,
  TrafficKeySet,
} from "./key-schedule.ts";
import { Tls13KeySchedule } from "./key-schedule.ts";
import {
  CLIENT_TRANSITIONS,
  ClientEvent,
  ClientState,
  SERVER_TRANSITIONS,
  ServerEvent,
  ServerState,
  transitionState,
  isFailedState,
} from "./state-machine.ts";
import type {
  ClientEvent as ClientEventValue,
  ClientState as ClientStateValue,
  ServerEvent as ServerEventValue,
  ServerState as ServerStateValue,
} from "./state-machine.ts";
import { Transcript } from "./transcript.ts";

export type EarlyDataStatus =
  | "not_offered"
  | "offered"
  | "accepted"
  | "rejected";

export interface EarlyDataRecord {
  readonly ticketId: string;
  readonly clientRandom: Uint8Array;
  readonly payload: Uint8Array;
}

export interface HandshakeBaseOptions {
  readonly crypto?: CryptoProvider;
  readonly algorithm?: HashAlgorithm;
  readonly keyExchange: KeyExchangeProvider;
  readonly clock?: () => number;
}

export interface ClientHandshakeOptions extends HandshakeBaseOptions {
  readonly serverName?: string;
  readonly certificateVerifier?: CertificateVerifier;
  readonly keyShareGroups?: readonly string[];
  readonly earlyData?: {
    readonly ticket: EarlyDataTicket;
    readonly ticketAge?: number;
  };
}

export interface ServerCredentials {
  readonly certificateChain: readonly Uint8Array[];
  signCertificateVerify(input: {
    readonly data: Uint8Array;
    readonly transcriptHash: Uint8Array;
    readonly serverName: string;
  }): { readonly algorithm: string; readonly signature: Uint8Array };
}

export interface ServerHandshakeOptions extends HandshakeBaseOptions {
  readonly credentials: ServerCredentials;
  readonly ticketStore?: TicketStore;
  readonly replayGuard?: EarlyDataReplayGuard;
  readonly requiredKeyShareGroup?: string;
  readonly cipherSuite?: string;
}

export interface HandshakeSnapshot {
  readonly role: "client" | "server";
  readonly state: string;
  readonly failed: boolean;
  readonly keyEpoch: KeyEpoch;
  readonly earlyDataStatus: EarlyDataStatus;
  readonly earlyDataRejectReason: string | undefined;
  readonly helloRetryCount: number;
  readonly secrets: readonly SecretName[];
  readonly audit: readonly DerivationAuditEntry[];
  readonly history: readonly { readonly state: string; readonly event: string; readonly at: number }[];
}

interface StateHistory {
  readonly state: string;
  readonly event: string;
  readonly at: number;
}

function defaultCipherSuite(algorithm: HashAlgorithm): string {
  return algorithm === "SHA-256"
    ? "TLS_AES_128_GCM_SHA256"
    : "TLS_AES_256_GCM_SHA384";
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return equalConstantTime(a, b);
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function allSecrets(): readonly SecretName[] {
  return [
    "early_secret",
    "client_early_traffic_secret",
    "early_exporter_master_secret",
    "handshake_secret",
    "client_handshake_traffic_secret",
    "server_handshake_traffic_secret",
    "master_secret",
    "client_application_traffic_secret_0",
    "server_application_traffic_secret_0",
    "exporter_master_secret",
    "resumption_master_secret",
  ];
}

export class ClientHandshake {
  readonly role = "client" as const;
  readonly algorithm: HashAlgorithm;
  readonly serverName: string;
  private readonly crypto: CryptoProvider;
  private readonly keyExchange: KeyExchangeProvider;
  private readonly verifier: CertificateVerifier;
  private readonly clock: () => number;
  private readonly keys: Tls13KeySchedule;
  private readonly transcript: Transcript;
  private readonly earlyTicket: EarlyDataTicket | undefined;
  private readonly ticketAge: number | undefined;
  private readonly keyShareGroups: readonly string[] | undefined;
  private readonly cipherSuite: string;
  private currentState: ClientStateValue;
  private history: StateHistory[];
  private failure: HandshakeError | undefined;
  private nextSequence: number;
  private lastOutboundFlight: HandshakeMessage[];
  private outboundById: Map<string, HandshakeMessage>;
  private confirmedIds: Set<string>;
  private lastReceivedId: string | undefined;
  private lastReceivedType: string | undefined;
  private receivedMessages: Map<string, { readonly type: string; readonly body: Uint8Array }>;
  private firstClientHello: ClientHelloMessage | undefined;
  private secondClientHello: ClientHelloMessage | undefined;
  private certificateIdentity: unknown;
  private earlyStatus: EarlyDataStatus;
  private earlyRejectReason: string | undefined;
  private earlyDataSentBytes: number;
  private retryCount: number;

  constructor(options: ClientHandshakeOptions) {
    this.crypto = options.crypto ?? defaultCryptoProvider;
    this.algorithm = options.algorithm ?? "SHA-256";
    this.serverName = options.serverName ?? "localhost";
    this.keyExchange = options.keyExchange;
    this.verifier = options.certificateVerifier ?? new RejectAllCertificateVerifier();
    this.clock = options.clock ?? (() => Date.now());
    this.keys = new Tls13KeySchedule(this.crypto, this.algorithm);
    this.transcript = new Transcript(this.crypto, this.algorithm);
    this.earlyTicket = options.earlyData?.ticket;
    this.ticketAge = options.earlyData?.ticketAge;
    this.keyShareGroups = options.keyShareGroups;
    this.cipherSuite = defaultCipherSuite(this.algorithm);
    this.currentState = ClientState.Start;
    this.history = [{ state: this.currentState, event: "INIT", at: this.clock() }];
    this.failure = undefined;
    this.nextSequence = 1;
    this.lastOutboundFlight = [];
    this.outboundById = new Map();
    this.confirmedIds = new Set();
    this.lastReceivedId = undefined;
    this.lastReceivedType = undefined;
    this.receivedMessages = new Map();
    this.firstClientHello = undefined;
    this.secondClientHello = undefined;
    this.certificateIdentity = undefined;
    this.earlyStatus = this.earlyTicket === undefined ? "not_offered" : "offered";
    this.earlyRejectReason = undefined;
    this.earlyDataSentBytes = 0;
    this.retryCount = 0;
  }

  get state(): ClientStateValue {
    return this.currentState;
  }

  get failed(): boolean {
    return isFailedState(this.currentState);
  }

  get keyEpoch(): KeyEpoch {
    return this.keys.epoch;
  }

  get earlyDataStatus(): EarlyDataStatus {
    return this.earlyStatus;
  }

  get earlyDataRejectReason(): string | undefined {
    return this.earlyRejectReason;
  }

  get helloRetryCount(): number {
    return this.retryCount;
  }

  get keySchedule(): Tls13KeySchedule {
    return this.keys;
  }

  get secretNames(): readonly SecretName[] {
    return allSecrets().filter((name) => this.keys.hasSecret(name));
  }

  start(): HandshakeMessage[] {
    this.guardFailed();
    if (this.currentState !== ClientState.Start) {
      this.failWith(new IllegalTransitionError(this.currentState, ClientEvent.Start));
    }
    try {
      const random = this.crypto.randomBytes(32);
      const sessionId = this.crypto.randomBytes(32);
      const groups = [...this.keyExchange.supportedGroups];
      if (groups.length === 0) throw new Error("key exchange provider has no groups");
      const offerGroups = this.keyShareGroups === undefined
        ? groups
        : [...this.keyShareGroups];
      if (offerGroups.length === 0
        || offerGroups.some((group) => !groups.includes(group))) {
        throw new Error("keyShareGroups must be a non-empty subset of supported groups");
      }
      const keyShares = offerGroups.map((group) => ({
        group,
        share: this.keyExchange.createOffer(group),
      }));
      const ticketAge = this.ticketAge
        ?? (this.earlyTicket === undefined ? undefined : Math.max(0, this.clock() - this.earlyTicket.issuedAt));
      const hello = createClientHello({
        id: this.nextMessageId("client_hello"),
        sequence: this.nextSequence - 1,
        random,
        sessionId,
        serverName: this.serverName,
        cipherSuites: [this.cipherSuite],
        supportedGroups: groups,
        keyShares,
        earlyData: this.earlyTicket === undefined
          ? undefined
          : { ticketId: this.earlyTicket.id, ticketAge: ticketAge ?? 0 },
      });
      this.firstClientHello = hello;
      this.transcript.add(hello);
      this.lastOutboundFlight = [hello];
      this.outboundById.set(hello.id, hello);
      this.advance(ClientEvent.Start);
      return [hello];
    } catch (error) {
      this.failWith(error);
    }
  }

  /**
   * Confirms that an outbound message reached the transport. Early traffic
   * keys become available only here, never when ClientHello is merely built.
   * Confirming Finished is the equivalent gate for the resumption secret.
   */
  confirmSent(messageId?: string): void {
    this.guardFailed();
    const message = messageId === undefined
      ? this.lastOutboundFlight[this.lastOutboundFlight.length - 1]
      : this.outboundById.get(messageId);
    if (message === undefined) {
      throw new InvalidMessageError(`unknown outbound message ${messageId ?? "<last>"}`, this.currentState);
    }
    if (this.confirmedIds.has(message.id)) return;

    if (message.type === "client_hello") {
      const isFirst = message === this.firstClientHello;
      if (isFirst && this.earlyTicket !== undefined) {
        if (this.currentState !== ClientState.InitialHelloSent) {
          throw new HandshakeError(
            "LATE_CONFIRMATION",
            "ClientHello confirmation arrived after the retry/handshake advanced; early keys were not derived",
            this.currentState,
          );
        }
        this.keys.deriveEarly(
          this.earlyTicket.psk,
          this.transcript.hash(),
          {
            trigger: `confirm:client_hello:${message.id}`,
            context: this.currentState,
          },
        );
      }
      this.confirmedIds.add(message.id);
      if (this.currentState === ClientState.InitialHelloSent
        || this.currentState === ClientState.RetryHelloSent) {
        this.advance(ClientEvent.ConfirmSent);
      }
      return;
    }

    if (message.type === "finished") {
      if (this.currentState !== ClientState.FinishedSent) {
        throw new HandshakeError(
          "LATE_CONFIRMATION",
          "Finished confirmation is not valid in the current state",
          this.currentState,
        );
      }
      this.keys.deriveResumption(this.transcript.hash(), {
        trigger: `confirm:client_finished:${message.id}`,
        context: this.currentState,
      });
      this.confirmedIds.add(message.id);
      this.advance(ClientEvent.ConfirmSent);
      return;
    }

    this.confirmedIds.add(message.id);
  }

  sendEarlyData(payload: Uint8Array = new Uint8Array()): EarlyDataRecord {
    this.guardFailed();
    if (this.earlyTicket === undefined || this.earlyStatus !== "offered") {
      throw new EarlyDataRejectedError("0-RTT was not offered");
    }
    if (this.currentState !== ClientState.InitialHelloSent) {
      throw new EarlyDataRejectedError("0-RTT is closed in the current state");
    }
    if (!this.keys.earlyTrafficUsable) {
      throw new SecretUnavailableError("client early traffic keys (confirm ClientHello first)");
    }
    if (this.earlyDataSentBytes + payload.length > this.earlyTicket.maxEarlyData) {
      throw new EarlyDataRejectedError("early data exceeds the ticket limit");
    }
    this.earlyDataSentBytes += payload.length;
    this.advance(ClientEvent.SendEarlyData);
    return {
      ticketId: this.earlyTicket.id,
      clientRandom: cloneBytes(this.firstClientHello?.random ?? new Uint8Array()),
      payload: cloneBytes(payload),
    };
  }

  earlyTrafficKeys(): TrafficKeySet {
    if (!this.keys.earlyTrafficUsable) {
      throw new SecretUnavailableError("client early traffic keys");
    }
    return this.keys.trafficKeys("early", "client");
  }

  receive(message: HandshakeMessage): HandshakeMessage[] {
    this.guardFailed();
    try {
      const prior = this.receivedMessages.get(message.id);
      if (prior !== undefined) {
        if (prior.type !== message.type
          || !sameBytes(prior.body, message.body)) {
          throw new InvalidMessageError(
            "retransmitted message changed its content",
            this.currentState,
          );
        }
        return [];
      }
      let responses: HandshakeMessage[] = [];
      switch (message.type) {
        case "hello_retry_request":
          responses = this.receiveHelloRetryRequest(message);
          break;
        case "server_hello":
          responses = this.receiveServerHello(message);
          break;
        case "encrypted_extensions":
          responses = this.receiveEncryptedExtensions(message);
          break;
        case "certificate":
          responses = this.receiveCertificate(message);
          break;
        case "certificate_verify":
          responses = this.receiveCertificateVerify(message);
          break;
        case "finished":
          responses = this.receiveServerFinished(message);
          break;
        case "new_session_ticket":
          this.requireState(ClientState.Connected);
          this.transcript.add(message);
          this.advance(ClientEvent.ReceiveNewSessionTicket);
          responses = [];
          break;
        default:
          throw new InvalidMessageError(
            `client cannot receive ${message.type}`,
            this.currentState,
          );
      }
      this.lastReceivedId = message.id;
      this.lastReceivedType = message.type;
      this.receivedMessages.set(message.id, {
        type: message.type,
        body: cloneBytes(message.body),
      });
      return responses;
    } catch (error) {
      this.failWith(error);
    }
  }

  resend(): HandshakeMessage[] {
    this.guardFailed();
    if (this.lastOutboundFlight.length === 0) {
      throw new IllegalTransitionError(this.currentState, ClientEvent.Resend);
    }
    try {
      this.advance(ClientEvent.Resend);
      return [...this.lastOutboundFlight];
    } catch (error) {
      this.failWith(error);
    }
  }

  snapshot(): HandshakeSnapshot {
    return {
      role: "client",
      state: this.currentState,
      failed: this.failed,
      keyEpoch: this.keys.epoch,
      earlyDataStatus: this.earlyStatus,
      earlyDataRejectReason: this.earlyRejectReason,
      helloRetryCount: this.retryCount,
      secrets: this.secretNames,
      audit: this.keys.audit,
      history: this.history.map((entry) => ({ ...entry })),
    };
  }

  secret(name: SecretName): Uint8Array {
    return this.keys.getSecret(name);
  }

  private receiveHelloRetryRequest(
    message: HelloRetryRequestMessage,
  ): HandshakeMessage[] {
    this.requireState(ClientState.InitialHelloSent);
    const first = this.firstClientHello;
    if (first === undefined) throw new InvalidMessageError("no ClientHello was sent");
    if (!sameBytes(message.random, HELLO_RETRY_REQUEST_RANDOM)) {
      throw new InvalidMessageError("HelloRetryRequest has the wrong special random");
    }
    if (!sameBytes(message.sessionIdEcho, first.sessionId)) {
      throw new InvalidMessageError("HelloRetryRequest session id does not match");
    }
    if (!first.supportedGroups.includes(message.selectedGroup)) {
      throw new InvalidMessageError("HelloRetryRequest selected a group that was not offered");
    }
    if (first.keyShares.some((entry) => entry.group === message.selectedGroup)) {
      throw new InvalidMessageError("HelloRetryRequest selected a group already present in key_share");
    }
    if (!first.cipherSuites.includes(message.cipherSuite)) {
      throw new InvalidMessageError("HelloRetryRequest selected an unoffered cipher suite");
    }
    if (this.retryCount >= 1) {
      throw new InvalidMessageError("a second HelloRetryRequest is forbidden");
    }

    this.retryCount += 1;
    if (this.earlyStatus === "offered" || this.earlyStatus === "accepted") {
      this.earlyStatus = "rejected";
      this.earlyRejectReason = "hello_retry";
      this.keys.invalidateEarlyTraffic();
    }
    this.transcript.foldClientHelloForHelloRetry(first);
    this.transcript.add(message);

    const share = this.keyExchange.createOffer(message.selectedGroup);
    const second = createClientHello({
      id: this.nextMessageId("client_hello"),
      sequence: this.nextSequence - 1,
      random: cloneBytes(first.random),
      sessionId: cloneBytes(first.sessionId),
      serverName: first.serverName,
      cipherSuites: first.cipherSuites,
      supportedGroups: first.supportedGroups,
      keyShares: [{ group: message.selectedGroup, share }],
      earlyData: undefined,
    });
    this.secondClientHello = second;
    this.transcript.add(second);
    this.lastOutboundFlight = [second];
    this.outboundById.set(second.id, second);
    this.advance(ClientEvent.ReceiveHelloRetryRequest);
    return [second];
  }

  private receiveServerHello(message: ServerHelloMessage): HandshakeMessage[] {
    if (this.currentState !== ClientState.InitialHelloSent
      && this.currentState !== ClientState.RetryHelloSent) {
      throw new IllegalTransitionError(
        this.currentState,
        ClientEvent.ReceiveServerHello,
      );
    }
    const hello = this.secondClientHello ?? this.firstClientHello;
    if (hello === undefined) throw new InvalidMessageError("no ClientHello was sent");
    if (!sameBytes(message.sessionIdEcho, hello.sessionId)) {
      throw new InvalidMessageError("ServerHello session id does not match");
    }
    if (!hello.cipherSuites.includes(message.cipherSuite)) {
      throw new InvalidMessageError("ServerHello selected an unoffered cipher suite");
    }
    if (!hello.supportedGroups.includes(message.keyShareGroup)) {
      throw new InvalidMessageError("ServerHello selected an unoffered group");
    }
    if (this.currentState === ClientState.RetryHelloSent) {
      const retryGroup = hello.keyShares[0]?.group;
      if (retryGroup !== message.keyShareGroup) {
        throw new InvalidMessageError("ServerHello did not use the retry group");
      }
    } else if (!hello.keyShares.some((entry) => entry.group === message.keyShareGroup)) {
      throw new InvalidMessageError("ServerHello group has no client key share");
    }

    this.transcript.add(message);
    if (message.selectedPskTicketId !== undefined
      && message.selectedPskTicketId !== this.earlyTicket?.id) {
      throw new InvalidMessageError(
        "ServerHello selected a PSK ticket that the client did not offer",
      );
    }
    if (message.selectedPskTicketId !== undefined
      && this.earlyTicket !== undefined
      && message.selectedPskTicketId === this.earlyTicket.id) {
      if (!this.keys.hasSecret("early_secret")) {
        this.keys.primeEarlySecret(this.earlyTicket.psk, {
          trigger: `receive:server_hello_psk:${message.id}`,
          context: this.currentState,
        });
      }
    } else {
      if (this.earlyStatus === "offered" || this.earlyStatus === "accepted") {
        this.earlyStatus = "rejected";
        this.earlyRejectReason = "psk_not_selected";
      }
      this.keys.resetEarlySecretForNonPsk();
    }
    const sharedSecret = this.keyExchange.acceptResponse(
      message.keyShareGroup,
      message.keyShare,
    );
    this.keys.deriveHandshake(sharedSecret, this.transcript.hash(), {
      trigger: `receive:server_hello:${message.id}`,
      context: this.currentState,
    });
    this.advance(ClientEvent.ReceiveServerHello);
    return [];
  }

  private receiveEncryptedExtensions(
    message: EncryptedExtensionsMessage,
  ): HandshakeMessage[] {
    this.requireState(ClientState.WaitEncryptedExtensions);
    if (this.earlyStatus === "not_offered" && message.earlyData !== "none") {
      throw new InvalidMessageError("server acknowledged 0-RTT that was not offered");
    }
    if (this.earlyStatus === "offered" || this.earlyStatus === "accepted") {
      if (message.earlyData === "accepted") {
        if (this.retryCount > 0) {
          throw new InvalidMessageError("server accepted 0-RTT after HelloRetryRequest");
        }
        this.earlyStatus = "accepted";
        this.earlyRejectReason = undefined;
      } else {
        this.earlyStatus = "rejected";
        this.earlyRejectReason = message.earlyDataRejectReason ?? "not_acknowledged";
        this.keys.invalidateEarlyTraffic();
      }
    } else if (this.earlyStatus === "rejected") {
      if (message.earlyData === "accepted") {
        throw new InvalidMessageError("server accepted 0-RTT after it was rejected");
      }
      this.earlyRejectReason = message.earlyDataRejectReason
        ?? this.earlyRejectReason
        ?? "not_acknowledged";
      this.keys.invalidateEarlyTraffic();
    }
    this.transcript.add(message);
    this.advance(ClientEvent.ReceiveEncryptedExtensions);
    return [];
  }

  private receiveCertificate(
    message: Extract<HandshakeMessage, { type: "certificate" }>,
  ): HandshakeMessage[] {
    this.requireState(ClientState.WaitCertificate);
    if (message.entries.length === 0) {
      throw new InvalidMessageError("server certificate chain is empty");
    }
    const context: CertificateVerificationContext = {
      serverName: this.serverName,
      now: this.clock(),
    };
    let result;
    try {
      result = this.verifier.verifyChain(message.entries, context);
    } catch (error) {
      throw new CertificateVerificationError(
        `certificate verifier threw: ${error instanceof Error ? error.message : String(error)}`,
        this.currentState,
      );
    }
    if (!result.trusted) {
      throw new CertificateVerificationError(
        `certificate chain rejected: ${result.reason ?? "unspecified"}`,
        this.currentState,
      );
    }
    this.certificateIdentity = result.identity;
    this.transcript.add(message);
    this.advance(ClientEvent.ReceiveCertificate);
    return [];
  }

  private receiveCertificateVerify(
    message: Extract<HandshakeMessage, { type: "certificate_verify" }>,
  ): HandshakeMessage[] {
    this.requireState(ClientState.WaitCertificateVerify);
    const content = certificateVerifyContent(
      "TLS 1.3, server CertificateVerify",
      this.transcript.hash(),
    );
    const verified = this.verifier.verifySignature({
      identity: this.certificateIdentity,
      algorithm: message.algorithm,
      data: content,
      signature: message.signature,
    });
    if (!verified) {
      throw new HandshakeError(
        "CERTIFICATE_SIGNATURE_REJECTED",
        "CertificateVerify signature was rejected",
        this.currentState,
      );
    }
    this.transcript.add(message);
    this.advance(ClientEvent.ReceiveCertificateVerify);
    return [];
  }

  private receiveServerFinished(
    message: Extract<HandshakeMessage, { type: "finished" }>,
  ): HandshakeMessage[] {
    this.requireState(ClientState.WaitServerFinished);
    const serverSecret = this.keys.getSecret("server_handshake_traffic_secret");
    const expected = this.keys.finishedVerifyData(
      serverSecret,
      this.transcript.hash(),
      { trigger: `verify:server_finished:${message.id}`, context: this.currentState },
    );
    if (!this.crypto.timingSafeEqual(expected, message.verifyData)) {
      throw new HandshakeError(
        "FINISHED_REJECTED",
        "server Finished verify_data does not match",
        this.currentState,
      );
    }
    this.transcript.add(message);
    this.keys.deriveApplication(this.transcript.hash(), {
      trigger: `receive:server_finished:${message.id}`,
      context: this.currentState,
    });
    this.advance(ClientEvent.ReceiveFinished);

    const clientSecret = this.keys.getSecret("client_handshake_traffic_secret");
    const outgoing: HandshakeMessage[] = [];
    if (this.earlyStatus === "accepted") {
      const endOfEarlyData = createEndOfEarlyData(
        this.nextMessageId("end_of_early_data"),
        this.nextSequence - 1,
      );
      this.transcript.add(endOfEarlyData);
      outgoing.push(endOfEarlyData);
    }
    const verifyData = this.keys.finishedVerifyData(
      clientSecret,
      this.transcript.hash(),
      { trigger: "send:client_finished", context: this.currentState },
    );
    const clientFinished = createFinished({
      id: this.nextMessageId("finished"),
      sequence: this.nextSequence - 1,
      verifyData,
    });
    this.transcript.add(clientFinished);
    outgoing.push(clientFinished);
    this.lastOutboundFlight = outgoing;
    for (const outbound of outgoing) this.outboundById.set(outbound.id, outbound);
    return outgoing;
  }

  private advance(event: ClientEventValue): void {
    const next = transitionState(
      CLIENT_TRANSITIONS,
      this.currentState,
      event,
      ClientState.Failed,
    );
    this.currentState = next;
    this.history.push({ state: next, event, at: this.clock() });
  }

  private requireState(expected: ClientStateValue): void {
    if (this.currentState !== expected) {
      throw new IllegalTransitionError(this.currentState, `expected:${expected}`);
    }
  }

  private nextMessageId(type: string): string {
    const sequence = this.nextSequence;
    this.nextSequence += 1;
    return `client-${type}-${sequence}`;
  }

  private guardFailed(): void {
    if (this.failed) {
      throw new IllegalTransitionError(ClientState.Failed, "ANY");
    }
  }

  private failWith(error: unknown): never {
    this.currentState = ClientState.Failed;
    const handshakeError = error instanceof HandshakeError
      ? error
      : new HandshakeError(
        "INVALID_STATE",
        error instanceof Error ? error.message : String(error),
        this.currentState,
      );
    this.failure = handshakeError;
    this.history.push({ state: ClientState.Failed, event: "FAIL", at: this.clock() });
    throw handshakeError;
  }
}

export class ServerHandshake {
  readonly role = "server" as const;
  readonly algorithm: HashAlgorithm;
  readonly cipherSuite: string;
  private readonly crypto: CryptoProvider;
  private readonly keyExchange: KeyExchangeProvider;
  private readonly clock: () => number;
  private readonly keys: Tls13KeySchedule;
  private readonly transcript: Transcript;
  private readonly credentials: ServerCredentials;
  private readonly ticketStore: TicketStore | undefined;
  private readonly replayGuard: EarlyDataReplayGuard;
  private readonly requiredGroup: string;
  private currentState: ServerStateValue;
  private history: StateHistory[];
  private failure: HandshakeError | undefined;
  private nextSequence: number;
  private lastFlight: HandshakeMessage[];
  private lastClientHello: ClientHelloMessage | undefined;
  private lastClientHelloId: string | undefined;
  private lastReceivedId: string | undefined;
  private lastReceivedType: string | undefined;
  private readonly receivedMessages: Map<string, { readonly type: string; readonly body: Uint8Array }>;
  private earlyStatus: EarlyDataStatus;
  private earlyRejectReason: string | undefined;
  private acceptedTicket: EarlyDataTicket | undefined;
  private earlyDataClosed: boolean;
  private earlyDataBytes: number;
  private retryCount: number;
  private selectedGroup: string | undefined;

  constructor(options: ServerHandshakeOptions) {
    this.crypto = options.crypto ?? defaultCryptoProvider;
    this.algorithm = options.algorithm ?? "SHA-256";
    this.cipherSuite = options.cipherSuite ?? defaultCipherSuite(this.algorithm);
    this.keyExchange = options.keyExchange;
    this.clock = options.clock ?? (() => Date.now());
    this.keys = new Tls13KeySchedule(this.crypto, this.algorithm);
    this.transcript = new Transcript(this.crypto, this.algorithm);
    this.credentials = options.credentials;
    this.ticketStore = options.ticketStore;
    this.replayGuard = options.replayGuard ?? new EarlyDataReplayGuard();
    this.requiredGroup = options.requiredKeyShareGroup
      ?? options.keyExchange.supportedGroups[0]
      ?? "";
    if (this.requiredGroup.length === 0) {
      throw new Error("server key exchange has no supported groups");
    }
    if (!options.keyExchange.supportedGroups.includes(this.requiredGroup)) {
      throw new Error(
        `required key share group ${this.requiredGroup} is not supported by the provider`,
      );
    }
    this.currentState = ServerState.Start;
    this.history = [{ state: this.currentState, event: "INIT", at: this.clock() }];
    this.failure = undefined;
    this.nextSequence = 1;
    this.lastFlight = [];
    this.lastClientHello = undefined;
    this.lastClientHelloId = undefined;
    this.lastReceivedId = undefined;
    this.lastReceivedType = undefined;
    this.receivedMessages = new Map();
    this.earlyStatus = "not_offered";
    this.earlyRejectReason = undefined;
    this.acceptedTicket = undefined;
    this.earlyDataClosed = false;
    this.earlyDataBytes = 0;
    this.retryCount = 0;
    this.selectedGroup = undefined;
  }

  get state(): ServerStateValue {
    return this.currentState;
  }

  get failed(): boolean {
    return isFailedState(this.currentState);
  }

  get keyEpoch(): KeyEpoch {
    return this.keys.epoch;
  }

  get earlyDataStatus(): EarlyDataStatus {
    return this.earlyStatus;
  }

  get earlyDataRejectReason(): string | undefined {
    return this.earlyRejectReason;
  }

  get helloRetryCount(): number {
    return this.retryCount;
  }

  get keySchedule(): Tls13KeySchedule {
    return this.keys;
  }

  get secretNames(): readonly SecretName[] {
    return allSecrets().filter((name) => this.keys.hasSecret(name));
  }

  start(): HandshakeMessage[] {
    this.guardFailed();
    if (this.currentState !== ServerState.Start) {
      throw new IllegalTransitionError(this.currentState, ServerEvent.Start);
    }
    this.advance(ServerEvent.Start);
    return [];
  }

  receive(message: HandshakeMessage): HandshakeMessage[] {
    this.guardFailed();
    try {
      if (message.type === "client_hello") {
        return this.receiveClientHello(message);
      }
      const prior = this.receivedMessages.get(message.id);
      if (prior !== undefined) {
        if (prior.type !== message.type
          || !sameBytes(prior.body, message.body)) {
          throw new InvalidMessageError(
            "retransmitted message changed its content",
            this.currentState,
          );
        }
        return [];
      }
      let responses: HandshakeMessage[] = [];
      switch (message.type) {
        case "end_of_early_data":
          responses = this.receiveEndOfEarlyData(message);
          break;
        case "finished":
          responses = this.receiveClientFinished(message);
          break;
        default:
          throw new InvalidMessageError(
            `server cannot receive ${message.type}`,
            this.currentState,
          );
      }
      this.lastReceivedId = message.id;
      this.lastReceivedType = message.type;
      this.receivedMessages.set(message.id, {
        type: message.type,
        body: cloneBytes(message.body),
      });
      return responses;
    } catch (error) {
      this.failWith(error);
    }
  }

  receiveEarlyData(record: EarlyDataRecord): Uint8Array {
    this.guardFailed();
    if (this.earlyStatus === "rejected") {
      if (this.earlyRejectReason === "replay") {
        throw new EarlyDataReplayError();
      }
      throw new EarlyDataRejectedError(this.earlyRejectReason ?? "rejected");
    }
    if (this.earlyStatus !== "accepted" || this.acceptedTicket === undefined) {
      throw new EarlyDataRejectedError("0-RTT was not accepted");
    }
    if (this.earlyDataClosed) {
      throw new EarlyDataRejectedError("early data is already closed");
    }
    if (this.lastClientHello === undefined
      || !sameBytes(record.clientRandom, this.lastClientHello.random)) {
      throw new EarlyDataReplayError();
    }
    if (record.ticketId !== this.acceptedTicket.id) {
      throw new EarlyDataReplayError();
    }
    if (this.earlyDataBytes + record.payload.length > this.acceptedTicket.maxEarlyData) {
      throw new EarlyDataRejectedError("early data exceeds the ticket limit");
    }
    this.earlyDataBytes += record.payload.length;
    this.advance(ServerEvent.ReceiveEarlyData);
    return cloneBytes(record.payload);
  }

  resend(): HandshakeMessage[] {
    this.guardFailed();
    if (this.lastFlight.length === 0) {
      throw new IllegalTransitionError(this.currentState, ServerEvent.Resend);
    }
    try {
      this.advance(ServerEvent.Resend);
      return [...this.lastFlight];
    } catch (error) {
      this.failWith(error);
    }
  }

  snapshot(): HandshakeSnapshot {
    return {
      role: "server",
      state: this.currentState,
      failed: this.failed,
      keyEpoch: this.keys.epoch,
      earlyDataStatus: this.earlyStatus,
      earlyDataRejectReason: this.earlyRejectReason,
      helloRetryCount: this.retryCount,
      secrets: this.secretNames,
      audit: this.keys.audit,
      history: this.history.map((entry) => ({ ...entry })),
    };
  }

  secret(name: SecretName): Uint8Array {
    return this.keys.getSecret(name);
  }

  private receiveClientHello(message: ClientHelloMessage): HandshakeMessage[] {
    if (this.currentState === ServerState.WaitSecondClientHello) {
      if (this.lastClientHelloId === message.id) {
        if (this.lastClientHello === undefined
          || !sameBytes(this.lastClientHello.body, message.body)) {
          throw new InvalidMessageError("retransmitted ClientHello changed its body");
        }
        this.advance(ServerEvent.ReceiveDuplicateClientHello);
        return [...this.lastFlight];
      }
      return this.receiveSecondClientHello(message);
    }
    if (this.currentState === ServerState.WaitClientFinished) {
      if (this.lastClientHelloId === message.id) {
        if (this.lastClientHello === undefined
          || !sameBytes(this.lastClientHello.body, message.body)) {
          throw new InvalidMessageError("retransmitted ClientHello changed its body");
        }
        this.advance(ServerEvent.ReceiveDuplicateClientHello);
        return [...this.lastFlight];
      }
      throw new IllegalTransitionError(this.currentState, ServerEvent.ReceiveClientHello);
    }
    if (this.currentState !== ServerState.WaitClientHello) {
      throw new IllegalTransitionError(this.currentState, ServerEvent.ReceiveClientHello);
    }
    this.validateClientHello(message);
    this.lastClientHello = message;
    this.lastClientHelloId = message.id;
    this.transcript.add(message);

    if (!message.keyShares.some((entry) => entry.group === this.requiredGroup)) {
      if (!message.supportedGroups.includes(this.requiredGroup)) {
        throw new InvalidMessageError(
          `client does not support the server's required group ${this.requiredGroup}`,
        );
      }
      this.retryCount += 1;
      this.selectedGroup = this.requiredGroup;
      if (message.earlyData !== undefined) {
        this.earlyStatus = "rejected";
        this.earlyRejectReason = "hello_retry";
      }
      this.transcript.foldClientHelloForHelloRetry(message);
      const retry = createHelloRetryRequest({
        id: this.nextMessageId("hello_retry_request"),
        sequence: this.nextSequence - 1,
        sessionIdEcho: cloneBytes(message.sessionId),
        cipherSuite: this.cipherSuite,
        selectedGroup: this.requiredGroup,
      });
      this.transcript.add(retry);
      this.lastFlight = [retry];
      this.advance(ServerEvent.ReceiveClientHelloRetry);
      return [retry];
    }

    const selected = message.keyShares.find((entry) => entry.group === this.requiredGroup)
      ?? message.keyShares.find((entry) => message.supportedGroups.includes(entry.group));
    if (selected === undefined) {
      throw new InvalidMessageError("ClientHello has no usable key share");
    }
    this.selectedGroup = selected.group;
    this.processEarlyData(message);
    this.lastFlight = this.buildServerFlight(message, selected.group, selected.share);
    this.advance(ServerEvent.ReceiveClientHello);
    return [...this.lastFlight];
  }

  private receiveSecondClientHello(message: ClientHelloMessage): HandshakeMessage[] {
    this.requireState(ServerState.WaitSecondClientHello);
    const first = this.lastClientHello;
    const retry = this.lastFlight[0];
    if (first === undefined || retry === undefined || retry.type !== "hello_retry_request") {
      throw new InvalidMessageError("no HelloRetryRequest is pending");
    }
    this.validateClientHello(message);
    if (!sameBytes(message.random, first.random)) {
      throw new InvalidMessageError("second ClientHello changed the client random");
    }
    if (!sameBytes(message.sessionId, first.sessionId)) {
      throw new InvalidMessageError("second ClientHello changed the session id");
    }
    if (!sameStrings(message.cipherSuites, first.cipherSuites)
      || !sameStrings(message.supportedGroups, first.supportedGroups)
      || message.serverName !== first.serverName) {
      throw new InvalidMessageError("second ClientHello changed negotiated parameters");
    }
    if (message.earlyData !== undefined) {
      throw new InvalidMessageError("0-RTT cannot be offered after HelloRetryRequest");
    }
    const selected = message.keyShares.find(
      (entry) => entry.group === retry.selectedGroup,
    );
    if (selected === undefined || message.keyShares.length !== 1) {
      throw new InvalidMessageError("second ClientHello must contain only the retry key share");
    }

    this.lastClientHello = message;
    this.lastClientHelloId = message.id;
    this.transcript.add(message);
    this.lastFlight = this.buildServerFlight(message, selected.group, selected.share);
    this.advance(ServerEvent.ReceiveSecondClientHello);
    return [...this.lastFlight];
  }

  private buildServerFlight(
    hello: ClientHelloMessage,
    group: string,
    clientShare: Uint8Array,
  ): HandshakeMessage[] {
    const reply = this.keyExchange.acceptOffer(group, clientShare);
    const serverHello = createServerHello({
      id: this.nextMessageId("server_hello"),
      sequence: this.nextSequence - 1,
      random: this.crypto.randomBytes(32),
      sessionIdEcho: cloneBytes(hello.sessionId),
      cipherSuite: this.cipherSuite,
      keyShareGroup: group,
      keyShare: reply.share,
      selectedPskTicketId: this.earlyStatus === "accepted"
        ? this.acceptedTicket?.id
        : undefined,
    });
    this.transcript.add(serverHello);
    this.keys.deriveHandshake(reply.sharedSecret, this.transcript.hash(), {
      trigger: `receive:server_hello_committed:${serverHello.id}`,
      context: this.currentState,
    });

    const encryptedExtensions = createEncryptedExtensions({
      id: this.nextMessageId("encrypted_extensions"),
      sequence: this.nextSequence - 1,
      earlyData: this.earlyStatus === "accepted"
        ? "accepted"
        : this.earlyStatus === "rejected" ? "rejected" : "none",
      earlyDataRejectReason: this.earlyRejectReason,
    });
    this.transcript.add(encryptedExtensions);

    const certificate = createCertificate({
      id: this.nextMessageId("certificate"),
      sequence: this.nextSequence - 1,
      entries: this.credentials.certificateChain,
    });
    this.transcript.add(certificate);

    const certificateData = certificateVerifyContent(
      "TLS 1.3, server CertificateVerify",
      this.transcript.hash(),
    );
    const signed = this.credentials.signCertificateVerify({
      data: certificateData,
      transcriptHash: this.transcript.hash(),
      serverName: hello.serverName,
    });
    const certificateVerify = createCertificateVerify({
      id: this.nextMessageId("certificate_verify"),
      sequence: this.nextSequence - 1,
      algorithm: signed.algorithm,
      signature: signed.signature,
    });
    this.transcript.add(certificateVerify);

    const serverSecret = this.keys.getSecret("server_handshake_traffic_secret");
    const verifyData = this.keys.finishedVerifyData(
      serverSecret,
      this.transcript.hash(),
      { trigger: "send:server_finished", context: this.currentState },
    );
    const serverFinished = createFinished({
      id: this.nextMessageId("finished"),
      sequence: this.nextSequence - 1,
      verifyData,
    });
    this.transcript.add(serverFinished);
    this.keys.deriveApplication(this.transcript.hash(), {
      trigger: `send:server_finished:${serverFinished.id}`,
      context: this.currentState,
    });

    return [
      serverHello,
      encryptedExtensions,
      certificate,
      certificateVerify,
      serverFinished,
    ];
  }

  private processEarlyData(hello: ClientHelloMessage): void {
    if (hello.earlyData === undefined) {
      this.earlyStatus = "not_offered";
      return;
    }
    const ticket = this.ticketStore?.get(hello.earlyData.ticketId);
    if (ticket === undefined) {
      this.earlyStatus = "rejected";
      this.earlyRejectReason = "unknown_ticket";
      return;
    }
    const now = this.clock();
    if (hello.earlyData.ticketAge > ticket.lifetimeMs) {
      this.earlyStatus = "rejected";
      this.earlyRejectReason = "expired";
      return;
    }
    const check: EarlyDataCheck = this.replayGuard.check(ticket, hello.random, now);
    if (!check.accepted) {
      this.earlyStatus = "rejected";
      this.earlyRejectReason = check.reason;
      if (check.replay) this.keys.invalidateEarlyTraffic();
      return;
    }
    this.earlyStatus = "accepted";
    this.earlyRejectReason = undefined;
    this.acceptedTicket = ticket;
    this.earlyDataClosed = false;
    this.keys.deriveEarly(ticket.psk, this.transcript.hash(), {
      trigger: `receive:client_hello:${hello.id}`,
      context: this.currentState,
    });
  }

  private receiveEndOfEarlyData(
    message: Extract<HandshakeMessage, { type: "end_of_early_data" }>,
  ): HandshakeMessage[] {
    this.requireState(ServerState.WaitClientFinished);
    if (this.earlyStatus !== "accepted") {
      throw new InvalidMessageError("EndOfEarlyData without accepted 0-RTT");
    }
    this.transcript.add(message);
    this.earlyDataClosed = true;
    this.advance(ServerEvent.ReceiveEndOfEarlyData);
    return [];
  }

  private receiveClientFinished(
    message: Extract<HandshakeMessage, { type: "finished" }>,
  ): HandshakeMessage[] {
    this.requireState(ServerState.WaitClientFinished);
    if (this.earlyStatus === "accepted" && !this.earlyDataClosed) {
      throw new InvalidMessageError("client Finished arrived while early data is open");
    }
    const clientSecret = this.keys.getSecret("client_handshake_traffic_secret");
    const expected = this.keys.finishedVerifyData(
      clientSecret,
      this.transcript.hash(),
      { trigger: `verify:client_finished:${message.id}`, context: this.currentState },
    );
    if (!this.crypto.timingSafeEqual(expected, message.verifyData)) {
      throw new HandshakeError(
        "FINISHED_REJECTED",
        "client Finished verify_data does not match",
        this.currentState,
      );
    }
    this.transcript.add(message);
    this.keys.deriveResumption(this.transcript.hash(), {
      trigger: `receive:client_finished:${message.id}`,
      context: this.currentState,
    });
    this.earlyDataClosed = true;
    this.advance(ServerEvent.ReceiveFinished);
    return [];
  }

  private validateClientHello(message: ClientHelloMessage): void {
    if (message.serverName.length === 0) {
      throw new InvalidMessageError("ClientHello has no server name");
    }
    if (!message.cipherSuites.includes(this.cipherSuite)) {
      throw new InvalidMessageError("ClientHello does not offer the server cipher suite");
    }
    if (message.keyShares.length === 0) {
      throw new InvalidMessageError("ClientHello has no key shares");
    }
  }

  private advance(event: ServerEventValue): void {
    const next = transitionState(
      SERVER_TRANSITIONS,
      this.currentState,
      event,
      ServerState.Failed,
    );
    this.currentState = next;
    this.history.push({ state: next, event, at: this.clock() });
  }

  private requireState(expected: ServerStateValue): void {
    if (this.currentState !== expected) {
      throw new IllegalTransitionError(this.currentState, `expected:${expected}`);
    }
  }

  private nextMessageId(type: string): string {
    const sequence = this.nextSequence;
    this.nextSequence += 1;
    return `server-${type}-${sequence}`;
  }

  private guardFailed(): void {
    if (this.failed) {
      throw new IllegalTransitionError(ServerState.Failed, "ANY");
    }
  }

  private failWith(error: unknown): never {
    this.currentState = ServerState.Failed;
    const handshakeError = error instanceof HandshakeError
      ? error
      : new HandshakeError(
        "INVALID_STATE",
        error instanceof Error ? error.message : String(error),
        this.currentState,
      );
    this.failure = handshakeError;
    this.history.push({ state: ServerState.Failed, event: "FAIL", at: this.clock() });
    throw handshakeError;
  }
}
