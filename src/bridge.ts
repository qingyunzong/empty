import type { IncomingMessage, WindowAdapter } from './adapter.js';
import { toHex, type RandomSource } from './random.js';

export const PROTOCOL_VERSION = 1;

export const MESSAGE_KIND = {
  handshake: 'bridge.handshake',
  handshakeAck: 'bridge.handshake.ack',
  op: 'bridge.op',
  result: 'bridge.result',
} as const;

export type BridgeErrorCode =
  | 'bad-message'
  | 'no-session'
  | 'bad-nonce'
  | 'unknown-op'
  | 'invalid-params'
  | 'seq-replay-conflict'
  | 'seq-out-of-window'
  | 'op-error';

export interface OperationContext {
  readonly nonce: string;
  readonly seq: number;
  isSessionCurrent(): boolean;
}

export interface OperationDefinition<P = unknown, R = unknown> {
  validate(params: unknown): P;
  execute(params: P, context: OperationContext): R | Promise<R>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OperationMap = Record<string, OperationDefinition<any, any>>;

export interface BridgeOptions {
  allowedOrigin: string;
  adapter: WindowAdapter;
  random: RandomSource;
  operations: OperationMap;
  windowSize?: number;
  nonceBytes?: number;
}

interface OpRequest {
  readonly op: string;
  readonly params: unknown;
}

interface ResultMessage {
  readonly kind: typeof MESSAGE_KIND.result;
  readonly protocol: number;
  readonly nonce: string;
  readonly seq: number;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: { code: BridgeErrorCode; message: string };
}

interface CacheEntry {
  readonly fingerprint: string;
  done: boolean;
  result?: ResultMessage;
}

interface Session {
  readonly nonce: string;
  readonly window: unknown;
  nextSeq: number;
  readonly cache: Map<number, CacheEntry>;
  readonly buffer: Map<number, OpRequest & { fingerprint: string }>;
}

const DEFAULT_WINDOW_SIZE = 8;
const DEFAULT_NONCE_BYTES = 16;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalize(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const body = keys
    .map((key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`)
    .join(',');
  return `{${body}}`;
}

function fingerprintOf(op: string, params: unknown): string {
  return canonicalize({ op, params });
}

class BridgeFailure extends Error {
  constructor(
    readonly code: BridgeErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export class MessageBridge {
  private readonly adapter: WindowAdapter;
  private readonly allowedOrigin: string;
  private readonly random: RandomSource;
  private readonly operations: OperationMap;
  private readonly windowSize: number;
  private readonly nonceBytes: number;

  private session: Session | null = null;
  private destroyed = false;

  private readonly messageListener = (event: IncomingMessage): void => {
    this.onMessage(event);
  };

  private readonly windowChangeListener = (): void => {
    this.invalidateSession();
  };

  constructor(options: BridgeOptions) {
    if (!Number.isSafeInteger(options.windowSize ?? DEFAULT_WINDOW_SIZE)) {
      throw new Error('windowSize must be an integer');
    }
    this.adapter = options.adapter;
    this.allowedOrigin = options.allowedOrigin;
    this.random = options.random;
    this.operations = options.operations;
    this.windowSize = Math.max(1, options.windowSize ?? DEFAULT_WINDOW_SIZE);
    this.nonceBytes = Math.max(8, options.nonceBytes ?? DEFAULT_NONCE_BYTES);

    this.adapter.addMessageListener(this.messageListener);
    this.adapter.onWindowChange(this.windowChangeListener);
  }

  destroy(): void {
    this.destroyed = true;
    this.adapter.removeMessageListener(this.messageListener);
    this.invalidateSession();
  }

  private invalidateSession(): void {
    this.session = null;
  }

  private onMessage(event: IncomingMessage): void {
    if (this.destroyed) return;
    if (event.origin !== this.allowedOrigin) return;
    if (event.source !== this.adapter.getCurrentWindow()) return;

    const data = event.data;
    if (!isRecord(data) || typeof data.kind !== 'string') return;

    if (data.kind === MESSAGE_KIND.handshake) {
      this.onHandshake(event.source);
      return;
    }
    if (data.kind === MESSAGE_KIND.op) {
      this.onOp(event.source, data);
      return;
    }
  }

  private onHandshake(source: unknown): void {
    const nonce = toHex(this.random.randomBytes(this.nonceBytes));
    this.session = {
      nonce,
      window: source,
      nextSeq: 1,
      cache: new Map(),
      buffer: new Map(),
    };
    this.send(source, {
      kind: MESSAGE_KIND.handshakeAck,
      protocol: PROTOCOL_VERSION,
      nonce,
      windowSize: this.windowSize,
    });
  }

  private onOp(source: unknown, data: Record<string, unknown>): void {
    const session = this.session;
    if (!session || source !== session.window) {
      this.sendError(source, typeof data.nonce === 'string' ? data.nonce : null,
        typeof data.seq === 'number' ? data.seq : null, 'no-session', 'no active session for this window');
      return;
    }
    if (typeof data.nonce !== 'string' || data.nonce !== session.nonce) {
      this.sendError(source, null, null, 'bad-nonce', 'nonce does not match the active session');
      return;
    }
    if (!Number.isSafeInteger(data.seq) || (data.seq as number) < 1) {
      this.sendError(source, session.nonce, null, 'bad-message', 'seq must be a positive integer');
      return;
    }
    if (typeof data.op !== 'string' || data.op.length === 0) {
      this.sendError(source, session.nonce, null, 'bad-message', 'op must be a non-empty string');
      return;
    }

    const seq = data.seq as number;
    const op = data.op;
    const params = data.params;
    const fingerprint = fingerprintOf(op, params);

    if (seq < session.nextSeq) {
      this.onReplay(session, seq, fingerprint);
      return;
    }
    if (seq === session.nextSeq) {
      this.accept(session, seq, op, params, fingerprint);
      this.drainBuffer(session);
      return;
    }
    if (seq < session.nextSeq + this.windowSize) {
      const buffered = session.buffer.get(seq);
      if (buffered) {
        if (buffered.fingerprint !== fingerprint) {
          this.sendError(source, session.nonce, seq, 'seq-replay-conflict',
            'sequence already buffered with different content');
        }
        return;
      }
      session.buffer.set(seq, { op, params, fingerprint });
      return;
    }
    this.sendError(source, session.nonce, seq, 'seq-out-of-window',
      `seq ${seq} is beyond the receive window (next=${session.nextSeq}, size=${this.windowSize})`);
  }

  private onReplay(session: Session, seq: number, fingerprint: string): void {
    const entry = session.cache.get(seq);
    if (!entry || entry.fingerprint !== fingerprint) {
      this.sendError(session.window, session.nonce, seq, 'seq-replay-conflict',
        'sequence was already used with different content');
      return;
    }
    if (entry.done && entry.result) {
      this.send(session.window, entry.result);
    }
  }

  private accept(session: Session, seq: number, op: string, params: unknown, fingerprint: string): void {
    const entry: CacheEntry = { fingerprint, done: false };
    session.cache.set(seq, entry);
    session.nextSeq = seq + 1;

    const context: OperationContext = {
      nonce: session.nonce,
      seq,
      isSessionCurrent: () => this.session === session,
    };

    void Promise.resolve()
      .then(() => {
        const definition = this.operations[op];
        if (!definition) {
          throw new BridgeFailure('unknown-op', `unknown operation: ${op}`);
        }
        let validated: unknown;
        try {
          validated = definition.validate(params);
        } catch (cause) {
          throw new BridgeFailure(
            'invalid-params',
            cause instanceof Error ? cause.message : String(cause),
          );
        }
        return definition.execute(validated, context);
      })
      .then(
      (value) => this.settle(session, seq, entry, { ok: true, value }),
      (cause: unknown) =>
        this.settle(session, seq, entry, {
          ok: false,
          error: cause instanceof BridgeFailure
            ? { code: cause.code, message: cause.message }
            : { code: 'op-error', message: cause instanceof Error ? cause.message : String(cause) },
        }),
    );
  }

  private settle(
    session: Session,
    seq: number,
    entry: CacheEntry,
    outcome: { ok: true; value: unknown } | { ok: false; error: { code: BridgeErrorCode; message: string } },
  ): void {
    const result: ResultMessage = {
      kind: MESSAGE_KIND.result,
      protocol: PROTOCOL_VERSION,
      nonce: session.nonce,
      seq,
      ok: outcome.ok,
      ...(outcome.ok ? { value: outcome.value } : { error: outcome.error }),
    };
    entry.done = true;
    entry.result = result;
    if (this.destroyed || this.session !== session) return;
    this.send(session.window, result);
  }

  private drainBuffer(session: Session): void {
    for (;;) {
      const buffered = session.buffer.get(session.nextSeq);
      if (!buffered) return;
      session.buffer.delete(session.nextSeq);
      this.accept(session, session.nextSeq, buffered.op, buffered.params, buffered.fingerprint);
    }
  }

  private sendError(
    target: unknown,
    nonce: string | null,
    seq: number | null,
    code: BridgeErrorCode,
    message: string,
  ): void {
    this.send(target, {
      kind: MESSAGE_KIND.result,
      protocol: PROTOCOL_VERSION,
      nonce,
      seq,
      ok: false,
      error: { code, message },
    });
  }

  private send(target: unknown, message: unknown): void {
    this.adapter.postMessage(target, message, this.allowedOrigin);
  }
}
