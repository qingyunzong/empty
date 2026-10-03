import { generateKeyPairSync, sign, verify } from 'node:crypto';

export function generateKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

export function signData(privateKeyPem, data) {
  return sign(null, Buffer.from(data, 'utf8'), privateKeyPem).toString('base64');
}

export function verifyData(publicKeyPem, data, signatureB64) {
  try {
    return verify(null, Buffer.from(data, 'utf8'), publicKeyPem, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}
