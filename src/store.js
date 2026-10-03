import { createHash } from 'node:crypto';
import { canonicalize } from './canonical.js';
import { generateKeyPair, signData, verifyData } from './keys.js';

export class CertError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CertError';
    this.code = code;
  }
}

// When every candidate chain fails, report the most meaningful cause.
const ERROR_PRIORITY = [
  'CERT_REVOKED',
  'CERT_EXPIRED',
  'CERT_NOT_YET_VALID',
  'AMOUNT_EXCEEDED',
  'BAD_SIGNATURE',
  'SELF_SIGNED_NON_ROOT',
  'BROKEN_CHAIN',
  'UNKNOWN_ROOT',
];

function parseTime(value, field) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new CertError('INVALID_TIME', `${field} must be a date string, got: ${value}`);
  }
  const t = Date.parse(value);
  if (Number.isNaN(t)) {
    throw new CertError('INVALID_TIME', `invalid ${field}: ${value}`);
  }
  return t;
}

function checkAmount(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CertError('INVALID_AMOUNT', `${field} must be a non-negative safe integer, got: ${value}`);
  }
}

// The payload a certificate signature commits to.
function signedPayload(cert) {
  return {
    id: cert.id,
    issuer: cert.issuer,
    subject: cert.subject,
    maxAmount: cert.maxAmount,
    notBefore: cert.notBefore,
    notAfter: cert.notAfter,
  };
}

export function certIdFor(base) {
  return createHash('sha256').update(canonicalize(base)).digest('hex');
}

// Compressed chain: the issuer field is dropped because it is implied
// (first cert is issued by rootId, each next cert by the previous subject).
export function compressChain(chain) {
  return chain.map(({ issuer, ...rest }) => rest);
}

export function decompressChain(compressed, rootId) {
  let issuer = rootId;
  return compressed.map((cert) => {
    const full = { ...cert, issuer };
    issuer = cert.subject;
    return full;
  });
}

export class CertStore {
  constructor() {
    this.keys = new Map(); // subject -> { publicKeyPem, privateKeyPem }
    this.certs = new Map(); // certId -> cert
    this.trustedRoots = new Set(); // subject ids
    this.events = []; // revoke/restore ledger, in insertion order
    this.revocations = new Map(); // revocation event id -> event
    this.eventCounter = 0;
  }

  ensureKey(subject) {
    if (!this.keys.has(subject)) {
      this.keys.set(subject, generateKeyPair());
    }
    return this.keys.get(subject);
  }

  getPublicKeyPem(subject) {
    const key = this.keys.get(subject);
    return key ? key.publicKeyPem : null;
  }

  issueCert({ issuer, subject, maxAmount, notBefore, notAfter, root = false }) {
    if (typeof issuer !== 'string' || issuer.length === 0) {
      throw new CertError('INVALID_CERT', 'issuer is required');
    }
    if (typeof subject !== 'string' || subject.length === 0) {
      throw new CertError('INVALID_CERT', 'subject is required');
    }
    checkAmount(maxAmount, 'maxAmount');
    const from = parseTime(notBefore, 'notBefore');
    const until = parseTime(notAfter, 'notAfter');
    if (from > until) {
      throw new CertError('INVALID_CERT', 'notBefore is after notAfter');
    }
    if (root && issuer !== subject) {
      throw new CertError('INVALID_CERT', 'a root certificate must be self-signed');
    }
    if (issuer === subject && !root) {
      throw new CertError(
        'SELF_SIGNED_NON_ROOT',
        `self-signed certificate for "${subject}" is not a trusted root`,
      );
    }
    const key = this.ensureKey(issuer);
    const base = { issuer, subject, maxAmount, notBefore, notAfter };
    const id = certIdFor(base);
    if (this.certs.has(id)) {
      throw new CertError('CERT_EXISTS', `certificate already exists: ${id}`);
    }
    const signature = signData(key.privateKeyPem, canonicalize({ id, ...base }));
    const cert = { id, ...base, signature };
    this.certs.set(id, cert);
    if (root) {
      this.trustedRoots.add(subject);
    }
    return cert;
  }

  revoke({ certId, time }) {
    if (!this.certs.has(certId)) {
      throw new CertError('UNKNOWN_CERT', `unknown certificate: ${certId}`);
    }
    const at = time === undefined ? new Date().toISOString() : time;
    parseTime(at, 'time');
    if (this.openRevocation(certId)) {
      throw new CertError('ALREADY_REVOKED', `certificate is already revoked: ${certId}`);
    }
    const event = {
      id: `rev-${++this.eventCounter}`,
      type: 'revoke',
      certId,
      time: at,
      pairedWith: null,
    };
    this.events.push(event);
    this.revocations.set(event.id, event);
    return event;
  }

  restore({ certId, revocationId, time }) {
    let revocation = null;
    if (revocationId !== undefined) {
      revocation = this.revocations.get(revocationId) ?? null;
      if (!revocation) {
        throw new CertError('UNKNOWN_REVOCATION', `unknown revocation: ${revocationId}`);
      }
      if (certId !== undefined && certId !== revocation.certId) {
        throw new CertError(
          'RESTORE_WITHOUT_REVOKE',
          `revocation ${revocationId} does not belong to certificate ${certId}`,
        );
      }
    } else if (certId !== undefined) {
      revocation = this.openRevocation(certId);
    } else {
      throw new CertError('INVALID_RESTORE', 'certId or revocationId is required');
    }
    if (!revocation || revocation.pairedWith) {
      throw new CertError(
        'RESTORE_WITHOUT_REVOKE',
        'restore must be paired with an open revocation event',
      );
    }
    const at = time === undefined ? new Date().toISOString() : time;
    parseTime(at, 'time');
    const event = {
      id: `rst-${++this.eventCounter}`,
      type: 'restore',
      certId: revocation.certId,
      time: at,
      pairs: revocation.id,
    };
    revocation.pairedWith = event.id;
    this.events.push(event);
    return event;
  }

  // The most recent event for certId, if it is an unpaired revoke.
  openRevocation(certId) {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const event = this.events[i];
      if (event.certId === certId) {
        return event.type === 'revoke' ? event : null;
      }
    }
    return null;
  }

  isRevokedAt(certId, time) {
    const at = parseTime(time, 'time');
    let revoked = false;
    for (const event of this.events) {
      if (event.certId !== certId) continue;
      if (Date.parse(event.time) > at) continue;
      revoked = event.type === 'revoke';
    }
    return revoked;
  }

  // Enumerate every simple chain (no repeated subjects) from any trusted
  // root to payer. First cert of each chain is issued directly by the root.
  *enumerateChains(payer) {
    const byIssuer = new Map();
    for (const cert of this.certs.values()) {
      const list = byIssuer.get(cert.issuer);
      if (list) list.push(cert);
      else byIssuer.set(cert.issuer, [cert]);
    }
    const self = this;
    function* dfs(rootId, current, path, seen) {
      for (const cert of byIssuer.get(current) ?? []) {
        if (seen.has(cert.subject)) continue;
        const nextPath = [...path, cert];
        if (cert.subject === payer) {
          yield { rootId, chain: nextPath };
        } else {
          const nextSeen = new Set(seen);
          nextSeen.add(cert.subject);
          yield* dfs(rootId, cert.subject, nextPath, nextSeen);
        }
      }
    }
    for (const rootId of self.trustedRoots) {
      yield* dfs(rootId, rootId, [], new Set([rootId]));
    }
  }

  validateChain(chain, rootId, amount, time) {
    if (!this.trustedRoots.has(rootId)) {
      throw new CertError('UNKNOWN_ROOT', `unknown trusted root: ${rootId}`);
    }
    const at = parseTime(time, 'time');
    let expectedIssuer = rootId;
    for (const cert of chain) {
      if (cert.issuer !== expectedIssuer) {
        throw new CertError(
          'BROKEN_CHAIN',
          `certificate ${cert.id} is issued by ${cert.issuer}, expected ${expectedIssuer}`,
        );
      }
      if (cert.issuer === cert.subject) {
        throw new CertError(
          'SELF_SIGNED_NON_ROOT',
          `self-signed certificate ${cert.id} is not a trusted root`,
        );
      }
      const publicKeyPem = this.getPublicKeyPem(cert.issuer);
      if (!publicKeyPem) {
        throw new CertError('UNKNOWN_ROOT', `no key known for issuer: ${cert.issuer}`);
      }
      if (!verifyData(publicKeyPem, canonicalize(signedPayload(cert)), cert.signature)) {
        throw new CertError('BAD_SIGNATURE', `invalid signature on certificate ${cert.id}`);
      }
      if (at < Date.parse(cert.notBefore)) {
        throw new CertError(
          'CERT_NOT_YET_VALID',
          `certificate ${cert.id} is not valid before ${cert.notBefore}`,
        );
      }
      if (at > Date.parse(cert.notAfter)) {
        throw new CertError('CERT_EXPIRED', `certificate ${cert.id} expired at ${cert.notAfter}`);
      }
      if (cert.maxAmount < amount) {
        throw new CertError(
          'AMOUNT_EXCEEDED',
          `certificate ${cert.id} allows at most ${cert.maxAmount}, requested ${amount}`,
        );
      }
      if (this.isRevokedAt(cert.id, time)) {
        throw new CertError('CERT_REVOKED', `certificate ${cert.id} is revoked`);
      }
      expectedIssuer = cert.subject;
    }
    return true;
  }

  verifyPayment({ payer, payee, amount, time }) {
    if (typeof payer !== 'string' || payer.length === 0) {
      throw new CertError('INVALID_PAYMENT', 'payer is required');
    }
    if (typeof payee !== 'string' || payee.length === 0) {
      throw new CertError('INVALID_PAYMENT', 'payee is required');
    }
    checkAmount(amount, 'amount');
    if (amount === 0) {
      throw new CertError('INVALID_AMOUNT', 'amount must be positive');
    }
    parseTime(time, 'time');

    let found = null;
    if (this.trustedRoots.has(payer)) {
      found = { rootId: payer, chain: [] };
    } else {
      const failures = [];
      let sawCandidate = false;
      for (const candidate of this.enumerateChains(payer)) {
        sawCandidate = true;
        try {
          this.validateChain(candidate.chain, candidate.rootId, amount, time);
          found = candidate;
          break;
        } catch (err) {
          if (!(err instanceof CertError)) throw err;
          failures.push(err);
        }
      }
      if (!found) {
        if (!sawCandidate) {
          throw new CertError(
            'UNKNOWN_ROOT',
            `no certificate chain from any trusted root to "${payer}"`,
          );
        }
        failures.sort(
          (a, b) => ERROR_PRIORITY.indexOf(a.code) - ERROR_PRIORITY.indexOf(b.code),
        );
        throw failures[0];
      }
    }

    const payload = {
      payer,
      payee,
      amount,
      time,
      rootId: found.rootId,
      chain: compressChain(found.chain),
    };
    const signature = signData(this.ensureKey(payer).privateKeyPem, canonicalize(payload));
    return { ...payload, signature };
  }

  // Re-verify a payment authorization produced by verifyPayment:
  // payment signature, chain linkage, cert signatures, limits, time,
  // revocation status as of the payment time.
  verifyAuthorization(auth) {
    if (auth === null || typeof auth !== 'object') {
      throw new CertError('INVALID_AUTH', 'authorization must be an object');
    }
    const { signature, ...payload } = auth;
    const { payer, payee, amount, time, rootId, chain } = payload;
    if (typeof signature !== 'string') {
      throw new CertError('BAD_SIGNATURE', 'missing payment signature');
    }
    if (!Array.isArray(chain)) {
      throw new CertError('INVALID_AUTH', 'chain must be an array');
    }
    const publicKeyPem = typeof payer === 'string' ? this.getPublicKeyPem(payer) : null;
    if (!publicKeyPem) {
      throw new CertError('UNKNOWN_ROOT', `unknown payer: ${payer}`);
    }
    if (!verifyData(publicKeyPem, canonicalize(payload), signature)) {
      throw new CertError('BAD_SIGNATURE', 'payment authorization signature mismatch');
    }
    const full = decompressChain(chain, rootId);
    if (full.length === 0) {
      if (payer !== rootId) {
        throw new CertError('BROKEN_CHAIN', 'empty chain but payer is not the root');
      }
    } else if (full[full.length - 1].subject !== payer) {
      throw new CertError('BROKEN_CHAIN', 'chain does not terminate at the payer');
    }
    this.validateChain(full, rootId, amount, time);
    return true;
  }
}
