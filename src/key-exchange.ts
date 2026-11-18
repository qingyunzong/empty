import {
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
} from "node:crypto";
import type { KeyObject } from "node:crypto";

export interface KeyExchangeReply {
  readonly share: Uint8Array;
  readonly sharedSecret: Uint8Array;
}

export interface KeyExchangeProvider {
  readonly supportedGroups: readonly string[];
  createOffer(group: string): Uint8Array;
  acceptOffer(group: string, peerShare: Uint8Array): KeyExchangeReply;
  acceptResponse(group: string, serverShare: Uint8Array): Uint8Array;
}

function publicShare(key: KeyObject): Uint8Array {
  return new Uint8Array(key.export({ type: "spki", format: "der" }));
}

function publicKeyFromShare(share: Uint8Array): KeyObject {
  return createPublicKey({ key: share, format: "der", type: "spki" });
}

export class X25519KeyExchangeProvider implements KeyExchangeProvider {
  readonly supportedGroups: readonly string[] = ["x25519"];
  private readonly offers: Map<string, KeyObject>;

  constructor() {
    this.offers = new Map();
  }

  createOffer(group: string): Uint8Array {
    this.requireGroup(group);
    const pair = generateKeyPairSync("x25519");
    this.offers.set(group, pair.privateKey);
    return publicShare(pair.publicKey);
  }

  acceptOffer(group: string, peerShare: Uint8Array): KeyExchangeReply {
    this.requireGroup(group);
    const pair = generateKeyPairSync("x25519");
    const secret = diffieHellman({
      privateKey: pair.privateKey,
      publicKey: publicKeyFromShare(peerShare),
    });
    return {
      share: publicShare(pair.publicKey),
      sharedSecret: new Uint8Array(secret),
    };
  }

  acceptResponse(group: string, serverShare: Uint8Array): Uint8Array {
    this.requireGroup(group);
    const privateKey = this.offers.get(group);
    if (privateKey === undefined) {
      throw new Error(`no client key share was created for group ${group}`);
    }
    const secret = diffieHellman({
      privateKey,
      publicKey: publicKeyFromShare(serverShare),
    });
    return new Uint8Array(secret);
  }

  private requireGroup(group: string): void {
    if (!this.supportedGroups.includes(group)) {
      throw new Error(`unsupported key exchange group ${group}`);
    }
  }
}

export function createX25519KeyExchange(): KeyExchangeProvider {
  return new X25519KeyExchangeProvider();
}
