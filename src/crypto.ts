import { concat } from "./bytes.ts";

export type HashAlgorithm = "SHA-256" | "SHA-384";

export interface CryptoProvider {
  readonly name: string;
  randomBytes(length: number): Uint8Array;
  hash(algorithm: HashAlgorithm, data: Uint8Array): Uint8Array;
  hmac(algorithm: HashAlgorithm, key: Uint8Array, data: Uint8Array): Uint8Array;
  hkdfExtract(algorithm: HashAlgorithm, salt: Uint8Array, ikm: Uint8Array): Uint8Array;
  hkdfExpand(
    algorithm: HashAlgorithm,
    prk: Uint8Array,
    info: Uint8Array,
    length: number,
  ): Uint8Array;
  timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}

export function hashLength(algorithm: HashAlgorithm): number {
  return algorithm === "SHA-256" ? 32 : 48;
}

export function keyLength(algorithm: HashAlgorithm): number {
  return algorithm === "SHA-256" ? 16 : 32;
}

function blockLength(algorithm: HashAlgorithm): number {
  return algorithm === "SHA-256" ? 64 : 128;
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const SHA512_K = [
  0x428a2f98d728ae22n, 0x7137449123ef65cdn, 0xb5c0fbcfec4d3b2fn, 0xe9b5dba58189dbbcn,
  0x3956c25bf348b538n, 0x59f111f1b605d019n, 0x923f82a4af194f9bn, 0xab1c5ed5da6d8118n,
  0xd807aa98a3030242n, 0x12835b0145706fben, 0x243185be4ee4b28cn, 0x550c7dc3d5ffb4e2n,
  0x72be5d74f27b896fn, 0x80deb1fe3b1696b1n, 0x9bdc06a725c71235n, 0xc19bf174cf692694n,
  0xe49b69c19ef14ad2n, 0xefbe4786384f25e3n, 0x0fc19dc68b8cd5b5n, 0x240ca1cc77ac9c65n,
  0x2de92c6f592b0275n, 0x4a7484aa6ea6e483n, 0x5cb0a9dcbd41fbd4n, 0x76f988da831153b5n,
  0x983e5152ee66dfabn, 0xa831c66d2db43210n, 0xb00327c898fb213fn, 0xbf597fc7beef0ee4n,
  0xc6e00bf33da88fc2n, 0xd5a79147930aa725n, 0x06ca6351e003826fn, 0x142929670a0e6e70n,
  0x27b70a8546d22ffcn, 0x2e1b21385c26c926n, 0x4d2c6dfc5ac42aedn, 0x53380d139d95b3dfn,
  0x650a73548baf63den, 0x766a0abb3c77b2a8n, 0x81c2c92e47edaee6n, 0x92722c851482353bn,
  0xa2bfe8a14cf10364n, 0xa81a664bbc423001n, 0xc24b8b70d0f89791n, 0xc76c51a30654be30n,
  0xd192e819d6ef5218n, 0xd69906245565a910n, 0xf40e35855771202an, 0x106aa07032bbd1b8n,
  0x19a4c116b8d2d0c8n, 0x1e376c085141ab53n, 0x2748774cdf8eeb99n, 0x34b0bcb5e19b48a8n,
  0x391c0cb3c5c95a63n, 0x4ed8aa4ae3418acbn, 0x5b9cca4f7763e373n, 0x682e6ff3d6b2b8a3n,
  0x748f82ee5defb2fcn, 0x78a5636f43172f60n, 0x84c87814a1f0ab72n, 0x8cc702081a6439ecn,
  0x90befffa23631e28n, 0xa4506cebde82bde9n, 0xbef9a3f7b2c67915n, 0xc67178f2e372532bn,
  0xca273eceea26619cn, 0xd186b8c721c0c207n, 0xeada7dd6cde0eb1en, 0xf57d4f7fee6ed178n,
  0x06f067aa72176fban, 0x0a637dc5a2c898a6n, 0x113f9804bef90daen, 0x1b710b35131c471bn,
  0x28db77f523047d84n, 0x32caab7b40c72493n, 0x3c9ebe0a15c9bebcn, 0x431d67c49c100d4cn,
  0x4cc5d4becb3e42b6n, 0x597f299cfc657e2an, 0x5fcb6fab3ad6faecn, 0x6c44198c4a475817n,
] as const;

const MASK64 = (1n << 64n) - 1n;

function rotr32(value: number, count: number): number {
  return ((value >>> count) | (value << (32 - count))) >>> 0;
}

function rotr64(value: bigint, count: number): bigint {
  return ((value >> BigInt(count)) | (value << BigInt(64 - count))) & MASK64;
}

function sha256(data: Uint8Array): Uint8Array {
  const paddedLength = Math.ceil((data.length + 9) / 64) * 64;
  const block = new Uint8Array(paddedLength);
  block.set(data);
  block[data.length] = 0x80;
  const view = new DataView(block.buffer);
  const bitLength = data.length * 8;
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      w[index] = view.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotr32(w[index - 15], 7) ^ rotr32(w[index - 15], 18)
        ^ (w[index - 15] >>> 3);
      const s1 = rotr32(w[index - 2], 17) ^ rotr32(w[index - 2], 19)
        ^ (w[index - 2] >>> 10);
      w[index] = (w[index - 16] + s0 + w[index - 7] + s1) >>> 0;
    }

    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + s1 + ch + SHA256_K[index] + w[index]) >>> 0;
      const s0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let index = 0; index < 8; index += 1) {
    outView.setUint32(index * 4, h[index]);
  }
  return out;
}

function sha512Family(data: Uint8Array, sha384: boolean): Uint8Array {
  const paddedLength = Math.ceil((data.length + 17) / 128) * 128;
  const block = new Uint8Array(paddedLength);
  block.set(data);
  block[data.length] = 0x80;
  const view = new DataView(block.buffer);
  const bitLength = BigInt(data.length) * 8n;
  view.setBigUint64(paddedLength - 16, 0n);
  view.setBigUint64(paddedLength - 8, bitLength & MASK64);

  const h = sha384
    ? [
      0xcbbb9d5dc1059ed8n, 0x629a292a367cd507n,
      0x9159015a3070dd17n, 0x152fecd8f70e5939n,
      0x67332667ffc00b31n, 0x8eb44a8768581511n,
      0xdb0c2e0d64f98fa7n, 0x47b5481dbefa4fa4n,
    ]
    : [
      0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn,
      0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
      0x510e527fade682d1n, 0x9b05688c2b3e6c1fn,
      0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
    ];
  const w = new Array<bigint>(80).fill(0n);
  for (let offset = 0; offset < paddedLength; offset += 128) {
    for (let index = 0; index < 16; index += 1) {
      w[index] = view.getBigUint64(offset + index * 8);
    }
    for (let index = 16; index < 80; index += 1) {
      const s0 = rotr64(w[index - 15], 1) ^ rotr64(w[index - 15], 8)
        ^ (w[index - 15] >> 7n);
      const s1 = rotr64(w[index - 2], 19) ^ rotr64(w[index - 2], 61)
        ^ (w[index - 2] >> 6n);
      w[index] = (w[index - 16] + s0 + w[index - 7] + s1) & MASK64;
    }

    let [a, b, c, d, e, f, g, hh] = h;
    for (let index = 0; index < 80; index += 1) {
      const s1 = rotr64(e, 14) ^ rotr64(e, 18) ^ rotr64(e, 41);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + s1 + ch + SHA512_K[index] + w[index]) & MASK64;
      const s0 = rotr64(a, 28) ^ rotr64(a, 34) ^ rotr64(a, 39);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) & MASK64;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) & MASK64;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) & MASK64;
    }
    h[0] = (h[0] + a) & MASK64;
    h[1] = (h[1] + b) & MASK64;
    h[2] = (h[2] + c) & MASK64;
    h[3] = (h[3] + d) & MASK64;
    h[4] = (h[4] + e) & MASK64;
    h[5] = (h[5] + f) & MASK64;
    h[6] = (h[6] + g) & MASK64;
    h[7] = (h[7] + hh) & MASK64;
  }

  const full = new Uint8Array(64);
  const outView = new DataView(full.buffer);
  for (let index = 0; index < 8; index += 1) {
    outView.setBigUint64(index * 8, h[index]);
  }
  return sha384 ? full.slice(0, 48) : full;
}

/**
 * Dependency-free synchronous provider. It is suitable for runtimes that do
 * not expose node:crypto, including browsers. For high-volume deployments the
 * node:crypto adapter is faster and should be injected instead.
 */
export class PortableCryptoProvider implements CryptoProvider {
  readonly name = "portable";

  randomBytes(length: number): Uint8Array {
    const webCrypto = (globalThis as {
      crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array };
    }).crypto;
    if (webCrypto?.getRandomValues === undefined) {
      throw new Error("no cryptographic random source is available");
    }
    const out = new Uint8Array(length);
    webCrypto.getRandomValues(out);
    return out;
  }

  hash(algorithm: HashAlgorithm, data: Uint8Array): Uint8Array {
    return algorithm === "SHA-256"
      ? sha256(data)
      : sha512Family(data, true);
  }

  hmac(algorithm: HashAlgorithm, key: Uint8Array, data: Uint8Array): Uint8Array {
    const blockSize = blockLength(algorithm);
    const normalizedKey = key.length > blockSize
      ? this.hash(algorithm, key)
      : key;
    const innerPad = new Uint8Array(blockSize);
    const outerPad = new Uint8Array(blockSize);
    innerPad.fill(0x36);
    outerPad.fill(0x5c);
    for (let index = 0; index < normalizedKey.length; index += 1) {
      innerPad[index] ^= normalizedKey[index];
      outerPad[index] ^= normalizedKey[index];
    }
    const inner = this.hash(algorithm, concat(innerPad, data));
    return this.hash(algorithm, concat(outerPad, inner));
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
    let diff = 0;
    for (let index = 0; index < a.length; index += 1) {
      diff |= a[index] ^ b[index];
    }
    return diff === 0;
  }
}

export const defaultCryptoProvider: CryptoProvider = new PortableCryptoProvider();
