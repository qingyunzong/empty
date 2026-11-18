import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import { concat, fromHex, hex, utf8 } from "../src/bytes.ts";
import { PortableCryptoProvider, hashLength, keyLength } from "../src/crypto.ts";
import { NodeCryptoProvider } from "../src/node-crypto.ts";
import type { HashAlgorithm } from "../src/crypto.ts";
import { DerivationOrderError, SecretUnavailableError } from "../src/errors.ts";
import { Tls13KeySchedule } from "../src/key-schedule.ts";

const crypto = new NodeCryptoProvider();

function nodeHash(algorithm: HashAlgorithm, data: Uint8Array): Uint8Array {
  return new Uint8Array(
    createHash(algorithm === "SHA-256" ? "sha256" : "sha384").update(data).digest(),
  );
}

function nodeHmac(
  algorithm: HashAlgorithm,
  key: Uint8Array,
  data: Uint8Array,
): Uint8Array {
  return new Uint8Array(
    createHmac(algorithm === "SHA-256" ? "sha256" : "sha384", key).update(data).digest(),
  );
}

function refExtract(
  algorithm: HashAlgorithm,
  salt: Uint8Array,
  ikm: Uint8Array,
): Uint8Array {
  const effectiveSalt = salt.length === 0 ? new Uint8Array(hashLength(algorithm)) : salt;
  return nodeHmac(algorithm, effectiveSalt, ikm);
}

function refExpand(
  algorithm: HashAlgorithm,
  prk: Uint8Array,
  info: Uint8Array,
  length: number,
): Uint8Array {
  const blocks: Uint8Array[] = [];
  let previous: Uint8Array = new Uint8Array();
  let counter = 1;
  let produced = 0;
  while (produced < length) {
    previous = nodeHmac(
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

function refExpandLabel(
  algorithm: HashAlgorithm,
  secret: Uint8Array,
  label: string,
  context: Uint8Array,
  length: number,
): Uint8Array {
  const fullLabel = utf8(`tls13 ${label}`);
  const info = concat(
    new Uint8Array([(length >>> 8) & 0xff, length & 0xff]),
    new Uint8Array([fullLabel.length]),
    fullLabel,
    new Uint8Array([context.length]),
    context,
  );
  return refExpand(algorithm, secret, info, length);
}

function refDerive(
  algorithm: HashAlgorithm,
  secret: Uint8Array,
  label: string,
  transcriptHash: Uint8Array,
): Uint8Array {
  return refExpandLabel(
    algorithm,
    secret,
    label,
    transcriptHash,
    hashLength(algorithm),
  );
}

test("HKDF-Expand matches RFC 5869 test case 1", () => {
  const ikm = fromHex("0b".repeat(22));
  const salt = fromHex("000102030405060708090a0b0c");
  const info = fromHex("f0f1f2f3f4f5f6f7f8f9");
  const prk = crypto.hkdfExtract("SHA-256", salt, ikm);
  assert.equal(
    hex(prk),
    "077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5",
  );
  const okm = crypto.hkdfExpand("SHA-256", prk, info, 42);
  assert.equal(
    hex(okm),
    "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf"
      + "34007208d5b887185865",
  );
});

test("portable SHA/HMAC/HKDF matches node:crypto at padding boundaries", () => {
  const portable = new PortableCryptoProvider();
  const lengths = [0, 1, 2, 3, 55, 56, 63, 64, 65, 111, 112, 127, 128, 129, 255, 1000];
  for (const algorithm of ["SHA-256", "SHA-384"] as const) {
    for (const length of lengths) {
      const data = Uint8Array.from(
        { length },
        (_, index) => (index * 31 + 7) & 0xff,
      );
      assert.equal(
        hex(portable.hash(algorithm, data)),
        hex(crypto.hash(algorithm, data)),
        `hash ${algorithm} ${length}`,
      );
      const key = Uint8Array.from(
        { length: (length * 3) % 200 },
        (_, index) => (index * 17 + 11) & 0xff,
      );
      assert.equal(
        hex(portable.hmac(algorithm, key, data)),
        hex(crypto.hmac(algorithm, key, data)),
        `hmac ${algorithm} ${length}`,
      );
      assert.equal(
        hex(portable.hkdfExtract(algorithm, key, data)),
        hex(crypto.hkdfExtract(algorithm, key, data)),
        `extract ${algorithm} ${length}`,
      );
    }
    for (const length of [1, 16, 32, 42, 48, 64, 128]) {
      const prk = Uint8Array.from(
        { length: hashLength(algorithm) },
        (_, index) => index + 1,
      );
      const info = utf8(`info:${algorithm}:${length}`);
      assert.equal(
        hex(portable.hkdfExpand(algorithm, prk, info, length)),
        hex(crypto.hkdfExpand(algorithm, prk, info, length)),
        `expand ${algorithm} ${length}`,
      );
    }
  }
});

for (const algorithm of ["SHA-256", "SHA-384"] as const) {
  test(`key schedule matches an independent RFC 8446 schedule (${algorithm})`, () => {
    const hashSize = hashLength(algorithm);
    const keySize = keyLength(algorithm);
    const psk = Uint8Array.from({ length: hashSize }, (_, index) => index + 1);
    const ecdhe = Uint8Array.from(
      { length: hashSize },
      (_, index) => 0xa0 ^ index,
    );
    const earlyTranscript = nodeHash(algorithm, utf8("ClientHello"));
    const handshakeTranscript = nodeHash(algorithm, utf8("ClientHello..ServerHello"));
    const applicationTranscript = nodeHash(
      algorithm,
      utf8("ClientHello..server Finished"),
    );
    const resumptionTranscript = nodeHash(
      algorithm,
      utf8("ClientHello..client Finished"),
    );

    const schedule = new Tls13KeySchedule(crypto, algorithm);
    assert.equal(schedule.epoch, "none");
    assert.deepEqual(schedule.audit, []);
    schedule.deriveEarly(psk, earlyTranscript, {
      trigger: "confirm:client_hello",
      context: "initial_hello_sent",
    });
    assert.equal(schedule.epoch, "early");
    assert.equal(schedule.audit.every((entry) => entry.phase === "early"), true);

    const zeroSalt = new Uint8Array(hashSize);
    const earlySecret = refExtract(algorithm, zeroSalt, psk);
    const clientEarly = refDerive(algorithm, earlySecret, "c e traffic", earlyTranscript);
    const earlyExporter = refDerive(
      algorithm,
      earlySecret,
      "e exp master",
      earlyTranscript,
    );
    assert.equal(hex(schedule.getSecret("early_secret")), hex(earlySecret));
    assert.equal(
      hex(schedule.getSecret("client_early_traffic_secret")),
      hex(clientEarly),
    );
    assert.equal(
      hex(schedule.getSecret("early_exporter_master_secret")),
      hex(earlyExporter),
    );
    assert.equal(
      hex(schedule.trafficKeys("early", "client").key),
      hex(refExpandLabel(algorithm, clientEarly, "key", new Uint8Array(), keySize)),
    );
    assert.equal(
      hex(schedule.trafficKeys("early", "client").iv),
      hex(refExpandLabel(algorithm, clientEarly, "iv", new Uint8Array(), 12)),
    );

    const earlyDerived = refExpandLabel(
      algorithm,
      earlySecret,
      "derived",
      nodeHash(algorithm, new Uint8Array()),
      hashSize,
    );
    const handshakeSecret = refExtract(algorithm, earlyDerived, ecdhe);
    const clientHs = refDerive(
      algorithm,
      handshakeSecret,
      "c hs traffic",
      handshakeTranscript,
    );
    const serverHs = refDerive(
      algorithm,
      handshakeSecret,
      "s hs traffic",
      handshakeTranscript,
    );

    schedule.deriveHandshake(ecdhe, handshakeTranscript, {
      trigger: "receive:server_hello",
      context: "wait_encrypted_extensions",
    });
    assert.equal(schedule.epoch, "handshake");
    assert.equal(hex(schedule.getSecret("handshake_secret")), hex(handshakeSecret));
    assert.equal(
      hex(schedule.getSecret("client_handshake_traffic_secret")),
      hex(clientHs),
    );
    assert.equal(
      hex(schedule.getSecret("server_handshake_traffic_secret")),
      hex(serverHs),
    );
    assert.deepEqual(
      schedule.trafficKeys("handshake", "client"),
      {
        epoch: "handshake",
        direction: "client",
        secret: clientHs,
        key: refExpandLabel(algorithm, clientHs, "key", new Uint8Array(), keySize),
        iv: refExpandLabel(algorithm, clientHs, "iv", new Uint8Array(), 12),
      },
    );

    const masterDerived = refExpandLabel(
      algorithm,
      handshakeSecret,
      "derived",
      nodeHash(algorithm, new Uint8Array()),
      hashSize,
    );
    const masterSecret = refExtract(algorithm, masterDerived, new Uint8Array(hashSize));
    const clientApp = refDerive(
      algorithm,
      masterSecret,
      "c ap traffic",
      applicationTranscript,
    );
    const serverApp = refDerive(
      algorithm,
      masterSecret,
      "s ap traffic",
      applicationTranscript,
    );
    const exporter = refDerive(
      algorithm,
      masterSecret,
      "exp master",
      applicationTranscript,
    );

    schedule.deriveApplication(applicationTranscript, {
      trigger: "receive:server_finished",
      context: "wait_server_finished",
    });
    assert.equal(schedule.epoch, "application");
    assert.equal(hex(schedule.getSecret("master_secret")), hex(masterSecret));
    assert.equal(
      hex(schedule.getSecret("client_application_traffic_secret_0")),
      hex(clientApp),
    );
    assert.equal(
      hex(schedule.getSecret("server_application_traffic_secret_0")),
      hex(serverApp),
    );
    assert.equal(hex(schedule.getSecret("exporter_master_secret")), hex(exporter));

    const resumption = refDerive(
      algorithm,
      masterSecret,
      "res master",
      resumptionTranscript,
    );
    schedule.deriveResumption(resumptionTranscript, {
      trigger: "confirm:client_finished",
      context: "finished_sent",
    });
    assert.equal(schedule.epoch, "resumption");
    assert.equal(
      hex(schedule.getSecret("resumption_master_secret")),
      hex(resumption),
    );

    const finishedKey = refExpandLabel(
      algorithm,
      clientHs,
      "finished",
      new Uint8Array(),
      hashSize,
    );
    assert.equal(
      hex(schedule.finishedKey(clientHs, { trigger: "test:finished" })),
      hex(finishedKey),
    );

    const phases = schedule.audit.map((entry) => entry.phase);
    assert.deepEqual(
      phases,
      [
        "early", "early", "early",
        "handshake", "handshake", "handshake",
        "application", "application", "application", "application",
        "resumption",
        "handshake",
      ],
    );
    assert.equal(
      schedule.audit.find((entry) => entry.label === "c ap traffic")?.trigger,
      "receive:server_finished",
    );
  });
}

test("derivation order is enforced and retransmission cannot replay a phase", () => {
  const schedule = new Tls13KeySchedule(crypto, "SHA-256");
  const transcript = new Uint8Array(32).fill(9);
  assert.throws(
    () => schedule.deriveApplication(transcript, { trigger: "too-early" }),
    DerivationOrderError,
  );
  assert.equal(schedule.epoch, "none");

  schedule.deriveHandshake(new Uint8Array(32).fill(1), transcript, {
    trigger: "server_hello",
  });
  assert.throws(
    () => schedule.deriveHandshake(new Uint8Array(32).fill(1), transcript, {
      trigger: "duplicate-server-hello",
    }),
    DerivationOrderError,
  );
  schedule.deriveApplication(transcript, { trigger: "server_finished" });
  const auditLength = schedule.audit.length;
  assert.throws(
    () => schedule.deriveApplication(transcript, { trigger: "server_finished_again" }),
    DerivationOrderError,
  );
  assert.equal(schedule.audit.length, auditLength);
});

test("early traffic can be destroyed while retaining only the handshake PSK", () => {
  const schedule = new Tls13KeySchedule(crypto, "SHA-256");
  const transcript = new Uint8Array(32).fill(3);
  schedule.deriveEarly(new Uint8Array(32).fill(4), transcript, {
    trigger: "confirm:client_hello",
  });
  assert.equal(schedule.earlyTrafficUsable, true);
  schedule.invalidateEarlyTraffic();
  assert.equal(schedule.earlyTrafficUsable, false);
  assert.equal(schedule.epoch, "none");
  assert.throws(
    () => schedule.trafficKeys("early", "client"),
    SecretUnavailableError,
  );
  assert.equal(schedule.hasSecret("early_secret"), true);

  schedule.resetEarlySecretForNonPsk();
  assert.equal(schedule.hasSecret("early_secret"), false);
  assert.throws(
    () => schedule.getSecret("early_secret"),
    SecretUnavailableError,
  );
});
