import { hashId, signData, verifyData } from './crypto.js';

export function certBody(cert) {
  return {
    issuer: cert.issuer,
    subject: cert.subject,
    maxAmount: cert.maxAmount,
    notBefore: cert.notBefore,
    notAfter: cert.notAfter,
  };
}

export function createCert({ issuerPrivateKey, issuerPublicKey, subjectPublicKey, maxAmount, notBefore, notAfter }) {
  const body = {
    issuer: issuerPublicKey,
    subject: subjectPublicKey,
    maxAmount,
    notBefore,
    notAfter,
  };
  const id = hashId(body);
  const signature = signData(issuerPrivateKey, { ...body, id });
  return { ...body, id, signature };
}

export function isWellFormedCert(cert) {
  return (
    cert !== null &&
    typeof cert === 'object' &&
    typeof cert.issuer === 'string' &&
    typeof cert.subject === 'string' &&
    typeof cert.maxAmount === 'number' &&
    typeof cert.notBefore === 'number' &&
    typeof cert.notAfter === 'number' &&
    typeof cert.id === 'string' &&
    typeof cert.signature === 'string'
  );
}

export function verifyCert(cert) {
  if (!isWellFormedCert(cert)) return false;
  const body = certBody(cert);
  if (hashId(body) !== cert.id) return false;
  return verifyData(cert.issuer, { ...body, id: cert.id }, cert.signature);
}
