import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  createHash,
  sign,
  verify,
} from 'node:crypto';

export function generateKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

function importPrivate(privateKeyB64) {
  return createPrivateKey({ key: Buffer.from(privateKeyB64, 'base64'), type: 'pkcs8', format: 'der' });
}

function importPublic(publicKeyB64) {
  return createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), type: 'spki', format: 'der' });
}

export function publicKeyFromPrivate(privateKeyB64) {
  return createPublicKey(importPrivate(privateKeyB64))
    .export({ type: 'spki', format: 'der' })
    .toString('base64');
}

export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

export function hashId(obj) {
  return createHash('sha256').update(canonicalize(obj)).digest('hex');
}

export function signData(privateKeyB64, obj) {
  return sign(null, Buffer.from(canonicalize(obj)), importPrivate(privateKeyB64)).toString('base64');
}

export function verifyData(publicKeyB64, obj, signatureB64) {
  try {
    return verify(
      null,
      Buffer.from(canonicalize(obj)),
      importPublic(publicKeyB64),
      Buffer.from(signatureB64, 'base64'),
    );
  } catch {
    return false;
  }
}
