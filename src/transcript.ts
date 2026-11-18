import { concat } from "./bytes.ts";
import type { CryptoProvider, HashAlgorithm } from "./crypto.ts";
import {
  encodeHandshakeMessage,
  encodeMessageHash,
} from "./messages.ts";
import type {
  ClientHelloMessage,
  HandshakeMessage,
  MessageType,
} from "./messages.ts";
import { InvalidMessageError } from "./errors.ts";

export interface TranscriptEntry {
  readonly type: MessageType | "message_hash";
  readonly bytes: Uint8Array;
}

export class Transcript {
  readonly algorithm: HashAlgorithm;
  private readonly crypto: CryptoProvider;
  private entries: TranscriptEntry[];
  private clientHelloFolded: boolean;

  constructor(crypto: CryptoProvider, algorithm: HashAlgorithm) {
    this.crypto = crypto;
    this.algorithm = algorithm;
    this.entries = [];
    this.clientHelloFolded = false;
  }

  add(message: HandshakeMessage): void {
    this.entries.push({
      type: message.type,
      bytes: encodeHandshakeMessage(message),
    });
  }

  addRaw(type: MessageType | "message_hash", bytes: Uint8Array): void {
    this.entries.push({ type, bytes: new Uint8Array(bytes) });
  }

  /**
   * RFC 8446 section 4.1.4: after HelloRetryRequest the first ClientHello is
   * replaced by a synthetic message_hash entry before HRR and CH2 are added.
   */
  foldClientHelloForHelloRetry(clientHello: ClientHelloMessage): void {
    if (this.clientHelloFolded) {
      throw new InvalidMessageError("ClientHello transcript was already folded for HRR");
    }
    if (this.entries.length !== 1 || this.entries[0]?.type !== "client_hello") {
      throw new InvalidMessageError("HRR is only valid immediately after the first ClientHello");
    }
    const first = this.entries[0].bytes;
    const hash = this.crypto.hash(this.algorithm, first);
    this.entries = [{
      type: "message_hash",
      bytes: encodeMessageHash(hash),
    }];
    this.clientHelloFolded = true;
  }

  hash(): Uint8Array {
    return this.crypto.hash(this.algorithm, this.bytes());
  }

  bytes(): Uint8Array {
    return concat(...this.entries.map((entry) => entry.bytes));
  }

  snapshot(): readonly TranscriptEntry[] {
    return this.entries.map((entry) => ({
      type: entry.type,
      bytes: new Uint8Array(entry.bytes),
    }));
  }

  get wasFolded(): boolean {
    return this.clientHelloFolded;
  }
}
