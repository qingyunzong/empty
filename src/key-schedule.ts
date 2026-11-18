import { cloneBytes, concat, hex, uint8, uint16, utf8, wipe } from "./bytes.ts";
import type { CryptoProvider, HashAlgorithm } from "./crypto.ts";
import { hashLength, keyLength } from "./crypto.ts";
import { DerivationOrderError, SecretUnavailableError } from "./errors.ts";

export type KeyEpoch = "none" | "early" | "handshake" | "application" | "resumption";
export type KeyDirection = "client" | "server";
export type SecretName =
  | "early_secret"
  | "client_early_traffic_secret"
  | "early_exporter_master_secret"
  | "handshake_secret"
  | "client_handshake_traffic_secret"
  | "server_handshake_traffic_secret"
  | "master_secret"
  | "client_application_traffic_secret_0"
  | "server_application_traffic_secret_0"
  | "exporter_master_secret"
  | "resumption_master_secret";

export interface TrafficKeySet {
  readonly epoch: Exclude<KeyEpoch, "none" | "resumption">;
  readonly direction: KeyDirection;
  readonly secret: Uint8Array;
  readonly key: Uint8Array;
  readonly iv: Uint8Array;
}

export interface DerivationAuditEntry {
  readonly index: number;
  readonly phase: Exclude<KeyEpoch, "none">;
  readonly label: string;
  readonly trigger: string;
  readonly context: string | undefined;
}

export interface DerivationInput {
  readonly trigger: string;
  readonly context?: string;
}

interface StoredTrafficKeys {
  readonly secret: Uint8Array;
  readonly key: Uint8Array;
  readonly iv: Uint8Array;
}

interface TrafficKeyBucket {
  client?: StoredTrafficKeys;
  server?: StoredTrafficKeys;
}

interface SecretStore {
  early_secret?: Uint8Array;
  client_early_traffic_secret?: Uint8Array;
  early_exporter_master_secret?: Uint8Array;
  handshake_secret?: Uint8Array;
  client_handshake_traffic_secret?: Uint8Array;
  server_handshake_traffic_secret?: Uint8Array;
  master_secret?: Uint8Array;
  client_application_traffic_secret_0?: Uint8Array;
  server_application_traffic_secret_0?: Uint8Array;
  exporter_master_secret?: Uint8Array;
  resumption_master_secret?: Uint8Array;
}

const SECRET_PHASE: Readonly<Record<SecretName, Exclude<KeyEpoch, "none">>> = {
  early_secret: "early",
  client_early_traffic_secret: "early",
  early_exporter_master_secret: "early",
  handshake_secret: "handshake",
  client_handshake_traffic_secret: "handshake",
  server_handshake_traffic_secret: "handshake",
  master_secret: "application",
  client_application_traffic_secret_0: "application",
  server_application_traffic_secret_0: "application",
  exporter_master_secret: "application",
  resumption_master_secret: "resumption",
};

/**
 * RFC 8446 section 7.1 key schedule.
 *
 * All public derivation methods require an explicit trigger. The handshake
 * drivers only call them after the message that confirms the input has been
 * validated and committed to the transcript. This makes early derivation
 * observable and testable instead of an implicit constructor side effect.
 */
export class Tls13KeySchedule {
  readonly algorithm: HashAlgorithm;
  readonly hashLengthValue: number;
  readonly keyLengthValue: number;
  private readonly crypto: CryptoProvider;
  private readonly secrets: SecretStore;
  private readonly auditEntries: DerivationAuditEntry[];
  private readonly earlyKeys: TrafficKeyBucket;
  private readonly handshakeKeys: TrafficKeyBucket;
  private readonly applicationKeys: TrafficKeyBucket;
  private earlyTrafficActive: boolean;
  private finishedKeys: Map<string, Uint8Array>;

  constructor(crypto: CryptoProvider, algorithm: HashAlgorithm = "SHA-256") {
    this.crypto = crypto;
    this.algorithm = algorithm;
    this.hashLengthValue = hashLength(algorithm);
    this.keyLengthValue = keyLength(algorithm);
    this.secrets = {};
    this.auditEntries = [];
    this.earlyKeys = {};
    this.handshakeKeys = {};
    this.applicationKeys = {};
    this.earlyTrafficActive = false;
    this.finishedKeys = new Map();
  }

  get audit(): readonly DerivationAuditEntry[] {
    return this.auditEntries.map((entry) => ({ ...entry }));
  }

  get epoch(): KeyEpoch {
    if (this.secrets.resumption_master_secret !== undefined) return "resumption";
    if (this.secrets.master_secret !== undefined
      && this.secrets.client_application_traffic_secret_0 !== undefined) {
      return "application";
    }
    if (this.secrets.handshake_secret !== undefined
      && this.secrets.client_handshake_traffic_secret !== undefined) {
      return "handshake";
    }
    if (this.earlyTrafficActive
      && this.secrets.client_early_traffic_secret !== undefined) {
      return "early";
    }
    return "none";
  }

  emptyTranscriptHash(): Uint8Array {
    return this.crypto.hash(this.algorithm, new Uint8Array());
  }

  deriveEarly(
    psk: Uint8Array,
    transcriptHash: Uint8Array,
    input: DerivationInput,
  ): void {
    this.requireTrigger(input.trigger);
    this.requireHashLength(transcriptHash);
    if (this.secrets.client_early_traffic_secret !== undefined) {
      throw new DerivationOrderError("early traffic secret was already derived");
    }
    const earlySecret = this.primeEarlySecret(psk, input);

    const clientEarly = this.deriveSecret(
      earlySecret,
      "c e traffic",
      transcriptHash,
      "early",
      "client_early_traffic_secret",
      input,
    );
    const earlyExporter = this.deriveSecret(
      earlySecret,
      "e exp master",
      transcriptHash,
      "early",
      "early_exporter_master_secret",
      input,
    );
    this.earlyKeys.client = this.makeTrafficKeys("early", clientEarly);
    this.earlyTrafficActive = true;
    this.secrets.early_exporter_master_secret = earlyExporter;
  }

  /**
   * Installs the PSK-based early secret without making early traffic keys
   * available. This is used for a rejected 0-RTT attempt where the PSK may
   * still be selected for the 1-RTT handshake, and for accepted 0-RTT before
   * its traffic keys are derived.
   */
  primeEarlySecret(psk: Uint8Array, input: DerivationInput): Uint8Array {
    this.requireTrigger(input.trigger);
    const existing = this.secrets.early_secret;
    if (existing !== undefined) return existing;
    const zeroSalt = new Uint8Array(this.hashLengthValue);
    const earlySecret = this.crypto.hkdfExtract(this.algorithm, zeroSalt, psk);
    this.store("early_secret", earlySecret);
    this.record("early", "early_secret", input);
    return earlySecret;
  }

  /**
   * The server did not select the 0-RTT PSK. RFC 8446 then uses a zero PSK in
   * the handshake key schedule, so the PSK-based early secret must not leak
   * into handshake_secret.
   */
  resetEarlySecretForNonPsk(): void {
    this.invalidateEarlyTraffic();
    wipe(this.secrets.early_secret);
    delete this.secrets.early_secret;
    wipe(this.secrets.early_exporter_master_secret);
    delete this.secrets.early_exporter_master_secret;
  }

  deriveHandshake(
    ecdhe: Uint8Array,
    transcriptHash: Uint8Array,
    input: DerivationInput,
  ): void {
    this.requireTrigger(input.trigger);
    this.requireHashLength(transcriptHash);
    if (this.secrets.handshake_secret !== undefined
      || this.secrets.client_handshake_traffic_secret !== undefined) {
      throw new DerivationOrderError("handshake secret was already derived");
    }
    if (ecdhe.length === 0) {
      throw new DerivationOrderError("cannot derive handshake keys without ECDHE input");
    }

    let earlySecret = this.secrets.early_secret;
    if (earlySecret === undefined) {
      earlySecret = this.crypto.hkdfExtract(
        this.algorithm,
        new Uint8Array(this.hashLengthValue),
        new Uint8Array(this.hashLengthValue),
      );
      this.store("early_secret", earlySecret);
      this.record("early", "early_secret", input);
    }

    const derived = this.hkdfExpandLabel(
      earlySecret,
      "derived",
      this.emptyTranscriptHash(),
      this.hashLengthValue,
    );
    const handshakeSecret = this.crypto.hkdfExtract(this.algorithm, derived, ecdhe);
    this.store("handshake_secret", handshakeSecret);
    this.record("handshake", "handshake_secret", input);

    const clientHs = this.deriveSecret(
      handshakeSecret,
      "c hs traffic",
      transcriptHash,
      "handshake",
      "client_handshake_traffic_secret",
      input,
    );
    const serverHs = this.deriveSecret(
      handshakeSecret,
      "s hs traffic",
      transcriptHash,
      "handshake",
      "server_handshake_traffic_secret",
      input,
    );
    this.handshakeKeys.client = this.makeTrafficKeys("handshake", clientHs);
    this.handshakeKeys.server = this.makeTrafficKeys("handshake", serverHs);
  }

  deriveApplication(transcriptHash: Uint8Array, input: DerivationInput): void {
    this.requireTrigger(input.trigger);
    this.requireHashLength(transcriptHash);
    if (this.secrets.handshake_secret === undefined) {
      throw new DerivationOrderError("application keys require a handshake secret");
    }
    if (this.secrets.master_secret !== undefined
      || this.secrets.client_application_traffic_secret_0 !== undefined) {
      throw new DerivationOrderError("application secret was already derived");
    }
    const derived = this.hkdfExpandLabel(
      this.secrets.handshake_secret,
      "derived",
      this.emptyTranscriptHash(),
      this.hashLengthValue,
    );
    const masterSecret = this.crypto.hkdfExtract(
      this.algorithm,
      derived,
      new Uint8Array(this.hashLengthValue),
    );
    this.store("master_secret", masterSecret);
    this.record("application", "master_secret", input);

    const clientApp = this.deriveSecret(
      masterSecret,
      "c ap traffic",
      transcriptHash,
      "application",
      "client_application_traffic_secret_0",
      input,
    );
    const serverApp = this.deriveSecret(
      masterSecret,
      "s ap traffic",
      transcriptHash,
      "application",
      "server_application_traffic_secret_0",
      input,
    );
    const exporter = this.deriveSecret(
      masterSecret,
      "exp master",
      transcriptHash,
      "application",
      "exporter_master_secret",
      input,
    );
    this.applicationKeys.client = this.makeTrafficKeys("application", clientApp);
    this.applicationKeys.server = this.makeTrafficKeys("application", serverApp);
    this.secrets.exporter_master_secret = exporter;
  }

  deriveResumption(transcriptHash: Uint8Array, input: DerivationInput): void {
    this.requireTrigger(input.trigger);
    this.requireHashLength(transcriptHash);
    if (this.secrets.master_secret === undefined) {
      throw new DerivationOrderError("resumption secret requires the master secret");
    }
    if (this.secrets.resumption_master_secret !== undefined) {
      throw new DerivationOrderError("resumption secret was already derived");
    }
    const resumption = this.deriveSecret(
      this.secrets.master_secret,
      "res master",
      transcriptHash,
      "resumption",
      "resumption_master_secret",
      input,
    );
    this.secrets.resumption_master_secret = resumption;
  }

  finishedKey(baseSecret: Uint8Array, input: DerivationInput): Uint8Array {
    this.requireTrigger(input.trigger);
    const cacheKey = `${input.trigger}:${hex(baseSecret)}`;
    const cached = this.finishedKeys.get(cacheKey);
    if (cached !== undefined) return cloneBytes(cached);
    const key = this.hkdfExpandLabel(
      baseSecret,
      "finished",
      new Uint8Array(),
      this.hashLengthValue,
    );
    this.finishedKeys.set(cacheKey, cloneBytes(key));
    this.record("handshake", "finished", input);
    return key;
  }

  finishedVerifyData(
    baseSecret: Uint8Array,
    transcriptHash: Uint8Array,
    input: DerivationInput,
  ): Uint8Array {
    const key = this.finishedKey(baseSecret, input);
    return this.crypto.hmac(this.algorithm, key, transcriptHash);
  }

  hkdfExpandLabel(
    secret: Uint8Array,
    label: string,
    context: Uint8Array,
    length: number,
  ): Uint8Array {
    const fullLabel = utf8(`tls13 ${label}`);
    if (fullLabel.length > 0xff) throw new RangeError("TLS label is too long");
    if (context.length > 0xff) throw new RangeError("TLS label context is too long");
    const info = concat(
      uint16(length),
      uint8(fullLabel.length),
      fullLabel,
      uint8(context.length),
      context,
    );
    return this.crypto.hkdfExpand(this.algorithm, secret, info, length);
  }

  getSecret(name: SecretName): Uint8Array {
    const value = this.secrets[name];
    if (value === undefined) {
      throw new SecretUnavailableError(name);
    }
    return cloneBytes(value);
  }

  hasSecret(name: SecretName): boolean {
    return this.secrets[name] !== undefined;
  }

  trafficKeys(
    epoch: Exclude<KeyEpoch, "none" | "resumption">,
    direction: KeyDirection,
  ): TrafficKeySet {
    const bucket: TrafficKeyBucket = epoch === "early"
      ? this.earlyKeys
      : epoch === "handshake"
        ? this.handshakeKeys
        : this.applicationKeys;
    const keys = direction === "client" ? bucket.client : bucket.server;
    if (keys === undefined) {
      throw new SecretUnavailableError(`${epoch} ${direction} traffic keys`);
    }
    return {
      epoch,
      direction,
      secret: cloneBytes(keys.secret),
      key: cloneBytes(keys.key),
      iv: cloneBytes(keys.iv),
    };
  }

  /**
   * 0-RTT can be refused after ClientHello retransmission/replay or after HRR.
   * The early traffic secret and traffic keys are destroyed; the early secret
   * itself remains only as the RFC 8446 input to the handshake secret.
   */
  invalidateEarlyTraffic(): void {
    this.earlyTrafficActive = false;
    wipe(this.earlyKeys.client?.secret);
    wipe(this.earlyKeys.client?.key);
    wipe(this.earlyKeys.client?.iv);
    delete this.earlyKeys.client;
    wipe(this.secrets.client_early_traffic_secret);
    delete this.secrets.client_early_traffic_secret;
    wipe(this.secrets.early_exporter_master_secret);
    delete this.secrets.early_exporter_master_secret;
  }

  get earlyTrafficUsable(): boolean {
    return this.earlyTrafficActive
      && this.secrets.client_early_traffic_secret !== undefined;
  }

  private deriveSecret(
    secret: Uint8Array,
    label: string,
    transcriptHash: Uint8Array,
    phase: Exclude<KeyEpoch, "none">,
    secretName: SecretName,
    input: DerivationInput,
  ): Uint8Array {
    const value = this.hkdfExpandLabel(
      secret,
      label,
      transcriptHash,
      this.hashLengthValue,
    );
    this.store(secretName, value);
    this.record(phase, label, input);
    return value;
  }

  private makeTrafficKeys(
    epoch: Exclude<KeyEpoch, "none" | "resumption">,
    secret: Uint8Array,
  ): StoredTrafficKeys {
    return {
      secret: cloneBytes(secret),
      key: this.hkdfExpandLabel(
        secret,
        "key",
        new Uint8Array(),
        this.keyLengthValue,
      ),
      iv: this.hkdfExpandLabel(
        secret,
        "iv",
        new Uint8Array(),
        12,
      ),
    };
  }

  private store(name: SecretName, value: Uint8Array): void {
    if (this.secrets[name] !== undefined) {
      throw new DerivationOrderError(`secret ${name} was already stored`);
    }
    this.secrets[name] = cloneBytes(value);
  }

  private record(
    phase: Exclude<KeyEpoch, "none">,
    label: string,
    input: DerivationInput,
  ): void {
    if (SECRET_PHASE[label as SecretName] !== undefined) {
      // Keep the declared phase of standard secrets. The fallback below is
      // only used for labels that are not direct key-schedule outputs.
      phase = SECRET_PHASE[label as SecretName];
    }
    this.auditEntries.push({
      index: this.auditEntries.length,
      phase,
      label,
      trigger: input.trigger,
      context: input.context,
    });
  }

  private requireTrigger(trigger: string): void {
    if (trigger.trim().length === 0) {
      throw new DerivationOrderError("key derivation requires a confirmation trigger");
    }
  }

  private requireHashLength(value: Uint8Array): void {
    if (value.length !== this.hashLengthValue) {
      throw new RangeError(
        `transcript hash must be ${this.hashLengthValue} bytes, got ${value.length}`,
      );
    }
  }
}
