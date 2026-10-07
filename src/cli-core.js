import { Store, CertChainError } from './store.js';
import { generateKeyPair } from './crypto.js';

// NDJSON command processor shared by the CLI entrypoint and tests.
export function createCli() {
  const store = new Store();

  function handle(msg) {
    switch (msg.cmd) {
      case 'keygen':
        return generateKeyPair();
      case 'add-root':
        return store.addRoot(msg.rootId, msg.publicKey);
      case 'issue-cert':
        return store.issueCert({
          issuerPrivateKey: msg.issuerPrivateKey,
          issuerPublicKey: msg.issuerPublicKey,
          subjectPublicKey: msg.subjectPublicKey,
          maxAmount: msg.maxAmount,
          notBefore: msg.notBefore,
          notAfter: msg.notAfter,
        });
      case 'admit-cert':
        return store.admitCert(msg.cert);
      case 'revoke':
        return store.revoke(msg.certId);
      case 'restore':
        return store.restore(msg.revokeId);
      case 'verify-payment':
        return store.verifyPayment({
          payerPublicKey: msg.payerPublicKey,
          payerPrivateKey: msg.payerPrivateKey,
          payee: msg.payee,
          amount: msg.amount,
          time: msg.time,
        });
      default:
        throw new CertChainError('ERR_UNKNOWN_CMD', `unknown command: ${msg.cmd}`);
    }
  }

  function processLine(line) {
    try {
      return { ok: true, ...handle(JSON.parse(line)) };
    } catch (err) {
      return { ok: false, error: { code: err.code ?? 'ERR_INTERNAL', message: String(err.message ?? err) } };
    }
  }

  return { processLine, store };
}
