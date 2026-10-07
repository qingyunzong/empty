import { publicKeyFromPrivate, signData, hashId } from './crypto.js';
import { createCert, verifyCert, isWellFormedCert } from './cert.js';

export class CertChainError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  throw new CertChainError(code, message);
}

export class Store {
  constructor() {
    this.roots = new Map(); // rootPublicKey -> rootId
    this.certs = new Map(); // certId -> cert
    this.revocations = new Map(); // revokeId -> { id, certId, restored }
    this.revokeCounter = 0;
  }

  addRoot(rootId, publicKey) {
    if (typeof rootId !== 'string' || !rootId) fail('ERR_BAD_INPUT', 'rootId must be a non-empty string');
    if (typeof publicKey !== 'string' || !publicKey) fail('ERR_BAD_INPUT', 'publicKey must be a non-empty string');
    this.roots.set(publicKey, rootId);
    return { rootId, publicKey };
  }

  issueCert({ issuerPrivateKey, issuerPublicKey, subjectPublicKey, maxAmount, notBefore, notAfter }) {
    if (publicKeyFromPrivate(issuerPrivateKey) !== issuerPublicKey) {
      fail('ERR_KEY_MISMATCH', 'issuerPrivateKey does not match issuerPublicKey');
    }
    if (issuerPublicKey === subjectPublicKey && !this.roots.has(issuerPublicKey)) {
      fail('ERR_SELF_SIGNED_NON_ROOT', 'self-signed certificate is only allowed for a trusted root');
    }
    if (typeof maxAmount !== 'number' || !(maxAmount >= 0)) fail('ERR_BAD_INPUT', 'maxAmount must be a non-negative number');
    if (typeof notBefore !== 'number' || typeof notAfter !== 'number' || notBefore > notAfter) {
      fail('ERR_BAD_INPUT', 'require notBefore <= notAfter (numeric timestamps)');
    }
    const cert = createCert({ issuerPrivateKey, issuerPublicKey, subjectPublicKey, maxAmount, notBefore, notAfter });
    this.certs.set(cert.id, cert);
    return cert;
  }

  admitCert(cert) {
    if (!isWellFormedCert(cert)) fail('ERR_BAD_INPUT', 'malformed certificate');
    this.certs.set(cert.id, cert);
    return cert;
  }

  revoke(certId) {
    if (!this.certs.has(certId)) fail('ERR_UNKNOWN_CERT', `unknown certificate: ${certId}`);
    const id = `rev-${++this.revokeCounter}`;
    this.revocations.set(id, { id, certId, restored: false });
    return { revokeId: id, certId };
  }

  restore(revokeId) {
    const event = this.revocations.get(revokeId);
    if (!event) fail('ERR_UNKNOWN_REVOCATION', `unknown revocation event: ${revokeId}`);
    if (event.restored) fail('ERR_ALREADY_RESTORED', `revocation ${revokeId} was already restored`);
    event.restored = true;
    return { restored: revokeId, certId: event.certId };
  }

  isRevoked(certId) {
    for (const event of this.revocations.values()) {
      if (event.certId === certId && !event.restored) return true;
    }
    return false;
  }

  // Enumerate every simple authorization chain (no repeated principals, no
  // repeated certs) that starts at a self-signed certificate and ends at
  // `subject`. Constraint checks are applied separately by checkChain.
  enumerateChains(subject) {
    const byIssuer = new Map();
    for (const cert of this.certs.values()) {
      if (!byIssuer.has(cert.issuer)) byIssuer.set(cert.issuer, []);
      byIssuer.get(cert.issuer).push(cert);
    }
    const results = [];
    const visit = (cert, chain, usedSubjects, usedCerts) => {
      chain.push(cert);
      usedCerts.add(cert.id);
      if (cert.subject === subject) {
        results.push([...chain]);
      } else {
        for (const next of byIssuer.get(cert.subject) ?? []) {
          if (next.issuer === next.subject) continue; // self-signed only allowed at chain start
          if (usedSubjects.has(next.subject) || usedCerts.has(next.id)) continue;
          usedSubjects.add(next.subject);
          visit(next, chain, usedSubjects, usedCerts);
          usedSubjects.delete(next.subject);
        }
      }
      chain.pop();
      usedCerts.delete(cert.id);
    };
    for (const cert of this.certs.values()) {
      if (cert.issuer === cert.subject) {
        visit(cert, [], new Set([cert.subject]), new Set());
      }
    }
    return results;
  }

  // Returns null when the chain is fully valid for (amount, time), otherwise
  // a { stage, error } failure. Higher stage means the chain got further.
  checkChain(chain, { amount, time }) {
    for (const cert of chain) {
      if (!verifyCert(cert)) {
        return { stage: 1, error: new CertChainError('ERR_TAMPERED_SIGNATURE', `invalid signature on certificate ${cert.id}`) };
      }
    }
    if (!this.roots.has(chain[0].issuer)) {
      return { stage: 2, error: new CertChainError('ERR_UNKNOWN_ROOT', `chain root ${chain[0].issuer} is not a trusted root`) };
    }
    for (const cert of chain) {
      if (this.isRevoked(cert.id)) {
        return { stage: 3, error: new CertChainError('ERR_REVOKED', `certificate ${cert.id} is revoked`) };
      }
    }
    for (const cert of chain) {
      if (time < cert.notBefore || time > cert.notAfter) {
        return { stage: 4, error: new CertChainError('ERR_EXPIRED', `certificate ${cert.id} is not valid at time ${time}`) };
      }
    }
    for (const cert of chain) {
      if (cert.maxAmount < amount) {
        return { stage: 5, error: new CertChainError('ERR_AMOUNT_EXCEEDED', `certificate ${cert.id} limit ${cert.maxAmount} < amount ${amount}`) };
      }
    }
    return null;
  }

  verifyPayment({ payerPublicKey, payerPrivateKey, payee, amount, time }) {
    if (publicKeyFromPrivate(payerPrivateKey) !== payerPublicKey) {
      fail('ERR_KEY_MISMATCH', 'payerPrivateKey does not match payerPublicKey');
    }
    if (typeof amount !== 'number' || !(amount >= 0)) fail('ERR_BAD_INPUT', 'amount must be a non-negative number');
    if (typeof time !== 'number') fail('ERR_BAD_INPUT', 'time must be a numeric timestamp');

    const chains = this.enumerateChains(payerPublicKey);
    if (chains.length === 0) {
      fail('ERR_UNKNOWN_ROOT', 'no authorization chain from any self-signed root to the payer');
    }
    const failures = [];
    for (const chain of chains) {
      const failure = this.checkChain(chain, { amount, time });
      if (failure === null) {
        const rootId = this.roots.get(chain[0].issuer);
        const payment = { payer: payerPublicKey, payee, amount, time };
        const chainHash = hashId(chain.map((c) => c.id));
        const signature = signData(payerPrivateKey, { payment, chainHash, rootId });
        return { rootId, chain, payment, chainHash, signature };
      }
      failures.push(failure);
    }
    failures.sort((a, b) => b.stage - a.stage);
    throw failures[0].error;
  }
}
