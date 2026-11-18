import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual as nodeTimingSafeEqual,
} from "node:crypto";
import { concat } from "./bytes.ts";
import type { CryptoProvider, HashAlgorithm } from "./crypto.ts";
import { hashLength } from "./crypto.ts";

function nodeAlgorithm(algorithm: HashAlgorithm): string {
  return algorithm === "SHA-256" ? "sha256" : "sha384";
}

export class NodeCryptoProvider implements CryptoProvider {
  readonly name = "node:crypto";

  randomBytes(length: number): Uint8Array {
    return new Uint8Array(randomBytes(length));
  }

  hash(algorithm: HashAlgorithm, data: Uint8Array): Uint8Array {
    return new Uint8Array(createHash(nodeAlgorithm(algorithm)).update(data).digest());
  }

  hmac(algorithm: HashAlgorithm, key: Uint8Array, data: Uint8Array): Uint8Array {
    return new Uint8Array(
      createHmac(nodeAlgorithm(algorithm), key).update(data).digest(),
    );
  }

  hkdfExtract(
    algorithm: HashAlgorithm,
    salt: Uint8Array,
    ikm: Uint8Array,
  ): Uint8Array {
    const effectiveSalt = salt.length === 0
      ? new Uint8Array(hashLength(algorithm))
      : salt;
    return this.hmac(algorithm, effectiveSalt, ikm);
  }

  hkdfExpand(
    algorithm: HashAlgorithm,
    prk: Uint8Array,
    info: Uint8Array,
    length: number,
  ): Uint8Array {
    const hashSize = hashLength(algorithm);
    if (length < 0 || length > 255 * hashSize) {
      throw new RangeError(`HKDF-Expand length out of range: ${length}`);
    }
    const blocks: Uint8Array[] = [];
    let previous: Uint8Array = new Uint8Array();
    let produced = 0;
    let counter = 1;
    while (produced < length) {
      previous = this.hmac(
        algorithm,
        prk,
        concat(previous, info, new Uint8Array([counter])),
      );
      blocks.push(previous);
      produced += previous.length;
      counter += 1;
    }
    const out = new Uint8Array(length);
    out.set(concat(...blocks).subarray(0, length));
    return out;
  }

  timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    return nodeTimingSafeEqual(a, b);
  }
}
