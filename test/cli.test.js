import test from 'node:test';
import assert from 'node:assert/strict';
import { createCli } from '../src/cli-core.js';

// Exercises the exact NDJSON line processor the CLI entrypoint uses
// (src/cli.js wires process.stdin/stdout to createCli().processLine).
test('CLI: full NDJSON flow — keygen, add-root, issue chain, verify, revoke, restore, tamper', () => {
  const cli = createCli();
  const send = (msg) => cli.processLine(JSON.stringify(msg));

  const kRoot = send({ cmd: 'keygen' });
  const kA = send({ cmd: 'keygen' });
  const kB = send({ cmd: 'keygen' });
  const kPayer = send({ cmd: 'keygen' });
  for (const k of [kRoot, kA, kB, kPayer]) assert.ok(k.ok && k.publicKey && k.privateKey);

  assert.ok(send({ cmd: 'add-root', rootId: 'root-1', publicKey: kRoot.publicKey }).ok);

  const issue = (issuer, subject, maxAmount = 1000, notBefore = 0, notAfter = 1_000_000) =>
    send({
      cmd: 'issue-cert',
      issuerPrivateKey: issuer.privateKey,
      issuerPublicKey: issuer.publicKey,
      subjectPublicKey: subject.publicKey,
      maxAmount, notBefore, notAfter,
    });

  const c0 = issue(kRoot, kRoot);
  const c1 = issue(kRoot, kA);
  const c2 = issue(kA, kB);
  const c3 = issue(kB, kPayer);
  for (const c of [c0, c1, c2, c3]) assert.ok(c.ok && c.id && c.signature);

  const verify = (extra = {}) =>
    send({
      cmd: 'verify-payment',
      payerPublicKey: kPayer.publicKey,
      payerPrivateKey: kPayer.privateKey,
      payee: 'shop',
      amount: 100,
      time: 500_000,
      ...extra,
    });

  // 1) multi-level chain valid
  const ok1 = verify();
  assert.ok(ok1.ok, JSON.stringify(ok1));
  assert.equal(ok1.rootId, 'root-1');
  assert.equal(ok1.chain.length, 4);
  assert.ok(ok1.signature);

  // 2) revoke -> fail; restore -> valid again
  const rev = send({ cmd: 'revoke', certId: c2.id });
  assert.ok(rev.ok && rev.revokeId);
  const afterRevoke = verify();
  assert.equal(afterRevoke.ok, false);
  assert.equal(afterRevoke.error.code, 'ERR_REVOKED');
  assert.ok(send({ cmd: 'restore', revokeId: rev.revokeId }).ok);
  assert.ok(verify().ok);
  // restore must pair with a revoke event
  assert.equal(send({ cmd: 'restore', revokeId: 'rev-999' }).error.code, 'ERR_UNKNOWN_REVOCATION');
  assert.equal(send({ cmd: 'restore', revokeId: rev.revokeId }).error.code, 'ERR_ALREADY_RESTORED');

  // expired / amount exceeded
  assert.equal(verify({ time: 2_000_000 }).error.code, 'ERR_EXPIRED');
  assert.equal(verify({ amount: 100_001 }).error.code, 'ERR_AMOUNT_EXCEEDED');

  // 3) tampered signature field -> failure (replace c2 with a forged copy)
  const forged = { ...c2, maxAmount: c2.maxAmount + 1 };
  delete forged.ok;
  assert.ok(send({ cmd: 'admit-cert', cert: forged }).ok);
  const afterForgery = verify();
  assert.equal(afterForgery.ok, false);
  assert.equal(afterForgery.error.code, 'ERR_TAMPERED_SIGNATURE');

  // self-signed non-root rejected
  assert.equal(
    send({
      cmd: 'issue-cert',
      issuerPrivateKey: kA.privateKey,
      issuerPublicKey: kA.publicKey,
      subjectPublicKey: kA.publicKey,
      maxAmount: 1, notBefore: 0, notAfter: 1,
    }).error.code,
    'ERR_SELF_SIGNED_NON_ROOT',
  );

  // unknown root: payer with no chain to any trusted root
  const kForeign = send({ cmd: 'keygen' });
  assert.equal(
    send({
      cmd: 'verify-payment',
      payerPublicKey: kForeign.publicKey,
      payerPrivateKey: kForeign.privateKey,
      payee: 'shop', amount: 1, time: 1,
    }).error.code,
    'ERR_UNKNOWN_ROOT',
  );

  // unknown command and malformed JSON
  assert.equal(send({ cmd: 'nonsense' }).error.code, 'ERR_UNKNOWN_CMD');
  assert.equal(cli.processLine('{not json').error.code, 'ERR_INTERNAL');
});
