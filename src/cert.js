// Hash-chained verifiable certificates.
import { hashObject } from "./stable.js";

export const GENESIS = "0".repeat(64);

export function makeCert(certs, type, payload) {
  const prev = certs.length ? certs[certs.length - 1].hash : GENESIS;
  const body = { seq: certs.length, type, payload, prev };
  return { ...body, hash: hashObject(body) };
}

export function verifyChain(certs) {
  let prev = GENESIS;
  for (let i = 0; i < certs.length; i++) {
    const c = certs[i];
    if (c.seq !== i || c.prev !== prev) return { ok: false, at: `certs[${i}]` };
    const body = { seq: c.seq, type: c.type, payload: c.payload, prev: c.prev };
    if (hashObject(body) !== c.hash) return { ok: false, at: `certs[${i}]` };
    prev = c.hash;
  }
  return { ok: true };
}
