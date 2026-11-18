import { createHash, createHmac } from "node:crypto";
import { concat, hex, utf8 } from "../src/bytes.ts";
import type {
  CertificateChainResult,
  CertificateSignatureInput,
  CertificateVerificationContext,
} from "../src/certificate.ts";
import type { KeyExchangeProvider, KeyExchangeReply } from "../src/key-exchange.ts";
import type { EarlyDataTicket } from "../src/early-data.ts";
import type { HandshakeMessage } from "../src/messages.ts";
import type { ClientHandshake, ServerHandshake } from "../src/handshake.ts";

export class FakeKeyExchange implements KeyExchangeProvider {
  readonly supportedGroups: readonly string[];

  constructor(groups: readonly string[] = ["x25519", "P-256"]) {
    this.supportedGroups = groups;
  }

  createOffer(group: string): Uint8Array {
    this.require(group);
    return sha256(utf8(`client-share:${group}`));
  }

  acceptOffer(group: string, peerShare: Uint8Array): KeyExchangeReply {
    this.require(group);
    const share = sha256(utf8(`server-share:${group}`));
    return {
      share,
      sharedSecret: sha256(utf8(`shared:${group}:${hex(peerShare)}:${hex(share)}`)),
    };
  }

  acceptResponse(group: string, serverShare: Uint8Array): Uint8Array {
    this.require(group);
    const clientShare = this.createOffer(group);
    return sha256(utf8(`shared:${group}:${hex(clientShare)}:${hex(serverShare)}`));
  }

  private require(group: string): void {
    if (!this.supportedGroups.includes(group)) {
      throw new Error(`unsupported test group ${group}`);
    }
  }
}

export function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(data).digest());
}

export function hmac256(key: Uint8Array, data: Uint8Array): Uint8Array {
  return new Uint8Array(createHmac("sha256", key).update(data).digest());
}

export class FakeCertificateAuthority {
  readonly chain: readonly Uint8Array[];
  readonly secret: Uint8Array;

  constructor(secret: Uint8Array = new Uint8Array(32).fill(0x42)) {
    this.secret = secret;
    this.chain = [utf8("test-certificate")];
  }

  sign(data: Uint8Array): Uint8Array {
    return hmac256(this.secret, data);
  }
}

export class FakeVerifier {
  readonly authority: FakeCertificateAuthority;
  rejectChain: boolean;
  rejectSignature: boolean;

  constructor(authority: FakeCertificateAuthority) {
    this.authority = authority;
    this.rejectChain = false;
    this.rejectSignature = false;
  }

  verifyChain(
    entries: readonly Uint8Array[],
    _context: CertificateVerificationContext,
  ): CertificateChainResult {
    if (this.rejectChain) return { trusted: false, reason: "test rejection" };
    const valid = entries.length === this.authority.chain.length
      && entries.every((entry, index) => hex(entry) === hex(this.authority.chain[index]));
    if (!valid) return { trusted: false, reason: "unknown chain" };
    return { trusted: true, identity: { name: "test" } };
  }

  verifySignature(input: CertificateSignatureInput): boolean {
    if (this.rejectSignature) return false;
    const expected = this.authority.sign(input.data);
    return hex(expected) === hex(input.signature);
  }
}

export function makeTicket(overrides: Partial<EarlyDataTicket> = {}): EarlyDataTicket {
  return {
    id: "ticket-1",
    psk: new Uint8Array(32).fill(0x5a),
    issuedAt: 1_000,
    lifetimeMs: 60_000,
    maxEarlyData: 4096,
    ...overrides,
  };
}

export function deliver(
  client: ClientHandshake,
  messages: readonly HandshakeMessage[],
): HandshakeMessage[] {
  let out: HandshakeMessage[] = [];
  for (const message of messages) {
    out = client.receive(message);
  }
  return out;
}

export function deliverToServer(
  server: ServerHandshake,
  messages: readonly HandshakeMessage[],
): HandshakeMessage[] {
  let out: HandshakeMessage[] = [];
  for (const message of messages) {
    out = server.receive(message);
  }
  return out;
}

export function largeTranscriptHash(label: string): Uint8Array {
  return sha256(concat(utf8(label), new Uint8Array([0, 1, 2, 3])));
}
