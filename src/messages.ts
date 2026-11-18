import { concat, lengthPrefixed16, uint8, uint24, utf8 } from "./bytes.ts";

export type MessageType =
  | "client_hello"
  | "server_hello"
  | "hello_retry_request"
  | "encrypted_extensions"
  | "certificate"
  | "certificate_verify"
  | "finished"
  | "end_of_early_data"
  | "new_session_ticket";

export interface MessageBase {
  readonly type: MessageType;
  readonly id: string;
  readonly sequence: number;
  readonly body: Uint8Array;
}

export interface KeyShareEntry {
  readonly group: string;
  readonly share: Uint8Array;
}

export interface EarlyDataOffer {
  readonly ticketId: string;
  readonly ticketAge: number;
}

export interface ClientHelloMessage extends MessageBase {
  readonly type: "client_hello";
  readonly random: Uint8Array;
  readonly sessionId: Uint8Array;
  readonly serverName: string;
  readonly cipherSuites: readonly string[];
  readonly supportedGroups: readonly string[];
  readonly keyShares: readonly KeyShareEntry[];
  readonly earlyData: EarlyDataOffer | undefined;
}

export interface ServerHelloMessage extends MessageBase {
  readonly type: "server_hello";
  readonly random: Uint8Array;
  readonly sessionIdEcho: Uint8Array;
  readonly cipherSuite: string;
  readonly keyShareGroup: string;
  readonly keyShare: Uint8Array;
  readonly selectedPskTicketId: string | undefined;
}

export interface HelloRetryRequestMessage extends MessageBase {
  readonly type: "hello_retry_request";
  readonly random: Uint8Array;
  readonly sessionIdEcho: Uint8Array;
  readonly cipherSuite: string;
  readonly selectedGroup: string;
}

export type EarlyDataExtensionStatus = "none" | "accepted" | "rejected";

export interface EncryptedExtensionsMessage extends MessageBase {
  readonly type: "encrypted_extensions";
  readonly earlyData: EarlyDataExtensionStatus;
  readonly earlyDataRejectReason: string | undefined;
  readonly alpn: string | undefined;
}

export interface CertificateMessage extends MessageBase {
  readonly type: "certificate";
  readonly entries: readonly Uint8Array[];
}

export interface CertificateVerifyMessage extends MessageBase {
  readonly type: "certificate_verify";
  readonly algorithm: string;
  readonly signature: Uint8Array;
}

export interface FinishedMessage extends MessageBase {
  readonly type: "finished";
  readonly verifyData: Uint8Array;
}

export interface EndOfEarlyDataMessage extends MessageBase {
  readonly type: "end_of_early_data";
}

export interface NewSessionTicketMessage extends MessageBase {
  readonly type: "new_session_ticket";
  readonly ticketId: string;
  readonly ticketLifetimeMs: number;
  readonly maxEarlyData: number;
}

export type HandshakeMessage =
  | ClientHelloMessage
  | ServerHelloMessage
  | HelloRetryRequestMessage
  | EncryptedExtensionsMessage
  | CertificateMessage
  | CertificateVerifyMessage
  | FinishedMessage
  | EndOfEarlyDataMessage
  | NewSessionTicketMessage;

export const HELLO_RETRY_REQUEST_RANDOM = new Uint8Array([
  0xcf, 0x21, 0xad, 0x74, 0xe5, 0x9a, 0x61, 0x11,
  0xbe, 0x1d, 0x8c, 0x02, 0x1e, 0x65, 0xb8, 0x91,
  0xc2, 0xa2, 0x11, 0x16, 0x7a, 0xbb, 0x8c, 0x5e,
  0x07, 0x9e, 0x09, 0xe2, 0xc8, 0xa8, 0x33, 0x9c,
]);

const WIRE_TYPE: Readonly<Record<MessageType, number>> = {
  client_hello: 1,
  server_hello: 2,
  hello_retry_request: 2,
  encrypted_extensions: 8,
  certificate: 11,
  certificate_verify: 15,
  finished: 20,
  end_of_early_data: 5,
  new_session_ticket: 4,
};

export function encodeHandshakeMessage(message: HandshakeMessage): Uint8Array {
  return concat(
    uint8(WIRE_TYPE[message.type]),
    uint24(message.body.length),
    message.body,
  );
}

export function encodeMessageHash(hash: Uint8Array): Uint8Array {
  return concat(uint8(254), uint24(hash.length), hash);
}

function encodeStringList(values: readonly string[]): Uint8Array {
  const encoded = values.map((value) => lengthPrefixed16(utf8(value)));
  return lengthPrefixed16(concat(...encoded));
}

function encodeKeyShares(values: readonly KeyShareEntry[]): Uint8Array {
  const encoded = values.map((entry) => concat(
    lengthPrefixed16(utf8(entry.group)),
    lengthPrefixed16(entry.share),
  ));
  return lengthPrefixed16(concat(...encoded));
}

function encodeEarlyDataOffer(offer: EarlyDataOffer | undefined): Uint8Array {
  if (offer === undefined) return concat(uint8(0));
  return concat(
    uint8(1),
    lengthPrefixed16(utf8(offer.ticketId)),
    uint8(offer.ticketAge & 0xff),
    uint8((offer.ticketAge >>> 8) & 0xff),
    uint8((offer.ticketAge >>> 16) & 0xff),
    uint8((offer.ticketAge >>> 24) & 0xff),
  );
}

export interface CreateClientHelloInput {
  readonly id: string;
  readonly sequence: number;
  readonly random: Uint8Array;
  readonly sessionId: Uint8Array;
  readonly serverName: string;
  readonly cipherSuites: readonly string[];
  readonly supportedGroups: readonly string[];
  readonly keyShares: readonly KeyShareEntry[];
  readonly earlyData?: EarlyDataOffer;
}

export function createClientHello(input: CreateClientHelloInput): ClientHelloMessage {
  const body = concat(
    input.random,
    lengthPrefixed16(input.sessionId),
    lengthPrefixed16(utf8(input.serverName)),
    encodeStringList(input.cipherSuites),
    encodeStringList(input.supportedGroups),
    encodeKeyShares(input.keyShares),
    encodeEarlyDataOffer(input.earlyData),
  );
  return {
    type: "client_hello",
    id: input.id,
    sequence: input.sequence,
    body,
    random: input.random,
    sessionId: input.sessionId,
    serverName: input.serverName,
    cipherSuites: [...input.cipherSuites],
    supportedGroups: [...input.supportedGroups],
    keyShares: input.keyShares.map((entry) => ({
      group: entry.group,
      share: new Uint8Array(entry.share),
    })),
    earlyData: input.earlyData,
  };
}

export interface CreateServerHelloInput {
  readonly id: string;
  readonly sequence: number;
  readonly random: Uint8Array;
  readonly sessionIdEcho: Uint8Array;
  readonly cipherSuite: string;
  readonly keyShareGroup: string;
  readonly keyShare: Uint8Array;
  readonly selectedPskTicketId?: string;
}

export function createServerHello(input: CreateServerHelloInput): ServerHelloMessage {
  const body = concat(
    input.random,
    lengthPrefixed16(input.sessionIdEcho),
    lengthPrefixed16(utf8(input.cipherSuite)),
    lengthPrefixed16(utf8(input.keyShareGroup)),
    lengthPrefixed16(input.keyShare),
    uint8(input.selectedPskTicketId === undefined ? 0 : 1),
    input.selectedPskTicketId === undefined
      ? new Uint8Array()
      : lengthPrefixed16(utf8(input.selectedPskTicketId)),
  );
  return {
    type: "server_hello",
    id: input.id,
    sequence: input.sequence,
    body,
    random: input.random,
    sessionIdEcho: input.sessionIdEcho,
    cipherSuite: input.cipherSuite,
    keyShareGroup: input.keyShareGroup,
    keyShare: new Uint8Array(input.keyShare),
    selectedPskTicketId: input.selectedPskTicketId,
  };
}

export interface CreateHelloRetryRequestInput {
  readonly id: string;
  readonly sequence: number;
  readonly sessionIdEcho: Uint8Array;
  readonly cipherSuite: string;
  readonly selectedGroup: string;
}

export function createHelloRetryRequest(
  input: CreateHelloRetryRequestInput,
): HelloRetryRequestMessage {
  const random = new Uint8Array(HELLO_RETRY_REQUEST_RANDOM);
  const body = concat(
    random,
    lengthPrefixed16(input.sessionIdEcho),
    lengthPrefixed16(utf8(input.cipherSuite)),
    lengthPrefixed16(utf8(input.selectedGroup)),
  );
  return {
    type: "hello_retry_request",
    id: input.id,
    sequence: input.sequence,
    body,
    random,
    sessionIdEcho: input.sessionIdEcho,
    cipherSuite: input.cipherSuite,
    selectedGroup: input.selectedGroup,
  };
}

export interface CreateEncryptedExtensionsInput {
  readonly id: string;
  readonly sequence: number;
  readonly earlyData: EarlyDataExtensionStatus;
  readonly earlyDataRejectReason?: string;
  readonly alpn?: string;
}

export function createEncryptedExtensions(
  input: CreateEncryptedExtensionsInput,
): EncryptedExtensionsMessage {
  const body = concat(
    uint8(input.earlyData === "none" ? 0 : input.earlyData === "accepted" ? 1 : 2),
    lengthPrefixed16(utf8(input.earlyDataRejectReason ?? "")),
    uint8(input.alpn === undefined ? 0 : 1),
    input.alpn === undefined ? new Uint8Array() : lengthPrefixed16(utf8(input.alpn)),
  );
  return {
    type: "encrypted_extensions",
    id: input.id,
    sequence: input.sequence,
    body,
    earlyData: input.earlyData,
    earlyDataRejectReason: input.earlyDataRejectReason,
    alpn: input.alpn,
  };
}

export interface CreateCertificateInput {
  readonly id: string;
  readonly sequence: number;
  readonly entries: readonly Uint8Array[];
}

export function createCertificate(input: CreateCertificateInput): CertificateMessage {
  const encoded = input.entries.map((entry) => lengthPrefixed16(entry));
  return {
    type: "certificate",
    id: input.id,
    sequence: input.sequence,
    body: lengthPrefixed16(concat(...encoded)),
    entries: input.entries.map((entry) => new Uint8Array(entry)),
  };
}

export interface CreateCertificateVerifyInput {
  readonly id: string;
  readonly sequence: number;
  readonly algorithm: string;
  readonly signature: Uint8Array;
}

export function createCertificateVerify(
  input: CreateCertificateVerifyInput,
): CertificateVerifyMessage {
  return {
    type: "certificate_verify",
    id: input.id,
    sequence: input.sequence,
    body: concat(
      lengthPrefixed16(utf8(input.algorithm)),
      lengthPrefixed16(input.signature),
    ),
    algorithm: input.algorithm,
    signature: new Uint8Array(input.signature),
  };
}

export interface CreateFinishedInput {
  readonly id: string;
  readonly sequence: number;
  readonly verifyData: Uint8Array;
}

export function createFinished(input: CreateFinishedInput): FinishedMessage {
  return {
    type: "finished",
    id: input.id,
    sequence: input.sequence,
    body: lengthPrefixed16(input.verifyData),
    verifyData: new Uint8Array(input.verifyData),
  };
}

export function createEndOfEarlyData(
  id: string,
  sequence: number,
): EndOfEarlyDataMessage {
  return {
    type: "end_of_early_data",
    id,
    sequence,
    body: new Uint8Array(),
  };
}

export function createNewSessionTicket(input: {
  readonly id: string;
  readonly sequence: number;
  readonly ticketId: string;
  readonly ticketLifetimeMs: number;
  readonly maxEarlyData: number;
}): NewSessionTicketMessage {
  return {
    type: "new_session_ticket",
    id: input.id,
    sequence: input.sequence,
    body: concat(
      lengthPrefixed16(utf8(input.ticketId)),
      uint8(input.ticketLifetimeMs & 0xff),
      uint8((input.ticketLifetimeMs >>> 8) & 0xff),
      uint8((input.ticketLifetimeMs >>> 16) & 0xff),
      uint8((input.ticketLifetimeMs >>> 24) & 0xff),
      uint8(input.maxEarlyData & 0xff),
      uint8((input.maxEarlyData >>> 8) & 0xff),
      uint8((input.maxEarlyData >>> 16) & 0xff),
      uint8((input.maxEarlyData >>> 24) & 0xff),
    ),
    ticketId: input.ticketId,
    ticketLifetimeMs: input.ticketLifetimeMs,
    maxEarlyData: input.maxEarlyData,
  };
}

export function certificateVerifyContent(
  context: string,
  transcriptHash: Uint8Array,
): Uint8Array {
  return concat(
    new Uint8Array(64).fill(0x20),
    utf8(context),
    uint8(0),
    transcriptHash,
  );
}
