import type { EventTargetLike, LoadEventTargetLike, MessageEventLike, WindowLike } from './events.ts';
import {
  MESSAGE_CHANNEL,
  parseBridgeMessage,
  type FieldSpec,
  type FieldValues,
} from './protocol.ts';
import { BridgeDestroyedError, BridgeNavigationError, BridgeTimeoutError } from './errors.ts';

export interface FormBridgeHostOptions {
  eventTarget: EventTargetLike;
  getSourceWindow: () => WindowLike | null;
  expectedOrigin: string;
  iframe?: LoadEventTargetLike;
  timeoutMs?: number;
  generateId?: () => string;
}

interface Session {
  bootId: string;
  nonce: string;
}

interface PendingRequest {
  requestId: string;
  fields: FieldSpec[];
  sent: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  resolve: (values: FieldValues) => void;
  reject: (error: Error) => void;
}

const defaultGenerateId = (): string => {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  return `id-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
};

export class FormBridgeHost {
  private readonly eventTarget: EventTargetLike;
  private readonly getSourceWindow: () => WindowLike | null;
  private readonly expectedOrigin: string;
  private readonly iframe: LoadEventTargetLike | undefined;
  private readonly timeoutMs: number;
  private readonly generateId: () => string;

  private session: Session | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private destroyed = false;
  private started = false;

  private readonly onMessage = (event: MessageEventLike): void => {
    if (event.origin !== this.expectedOrigin) return;
    const sourceWindow = this.getSourceWindow();
    if (sourceWindow === null || event.source !== sourceWindow) return;

    const message = parseBridgeMessage(event.data);
    if (message === null) return;

    if (message.phase === 'ready') {
      this.handleReady(message.bootId);
      return;
    }
    if (message.phase === 'complete') {
      this.handleComplete(message.nonce, message.requestId, message.values);
    }
  };

  private readonly onLoad = (): void => {
    this.invalidateSession();
  };

  constructor(options: FormBridgeHostOptions) {
    this.eventTarget = options.eventTarget;
    this.getSourceWindow = options.getSourceWindow;
    this.expectedOrigin = options.expectedOrigin;
    this.iframe = options.iframe;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.generateId = options.generateId ?? defaultGenerateId;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.eventTarget.addEventListener('message', this.onMessage);
    this.iframe?.addEventListener('load', this.onLoad);
  }

  collect(fields: FieldSpec[]): Promise<FieldValues> {
    if (this.destroyed) {
      return Promise.reject(new BridgeDestroyedError('host has been destroyed'));
    }
    this.start();
    return new Promise<FieldValues>((resolve, reject) => {
      const request: PendingRequest = {
        requestId: this.generateId(),
        fields,
        sent: false,
        timer: setTimeout(() => {
          if (this.pending.delete(request.requestId)) {
            reject(
              new BridgeTimeoutError(`fields request ${request.requestId} timed out`),
            );
          }
        }, this.timeoutMs),
        resolve,
        reject,
      };
      this.pending.set(request.requestId, request);
      this.flush();
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.eventTarget.removeEventListener('message', this.onMessage);
    this.iframe?.removeEventListener('load', this.onLoad);
    this.session = null;
    for (const request of this.pending.values()) {
      this.settleRequest(request, () =>
        request.reject(new BridgeDestroyedError('host has been destroyed')),
      );
    }
    this.pending.clear();
  }

  private handleReady(bootId: string): void {
    if (this.session !== null && this.session.bootId === bootId) {
      this.sendInit();
      return;
    }
    this.session = { bootId, nonce: this.generateId() };
    this.sendInit();
    this.flush();
  }

  private handleComplete(nonce: string, requestId: string, values: FieldValues): void {
    if (this.session === null || nonce !== this.session.nonce) return;
    const request = this.pending.get(requestId);
    if (request === undefined || !request.sent) return;
    this.pending.delete(requestId);
    this.settleRequest(request, () => request.resolve(values));
  }

  private invalidateSession(): void {
    this.session = null;
    for (const request of this.pending.values()) {
      if (!request.sent) continue;
      this.pending.delete(request.requestId);
      this.settleRequest(request, () =>
        request.reject(new BridgeNavigationError('iframe navigated before completing')),
      );
    }
  }

  private flush(): void {
    if (this.session === null) return;
    for (const request of this.pending.values()) {
      if (request.sent) continue;
      const target = this.getSourceWindow();
      if (target === null) continue;
      request.sent = true;
      target.postMessage(
        {
          channel: MESSAGE_CHANNEL,
          phase: 'fields-request',
          nonce: this.session.nonce,
          requestId: request.requestId,
          fields: request.fields,
        },
        this.expectedOrigin,
      );
    }
  }

  private sendInit(): void {
    if (this.session === null) return;
    const target = this.getSourceWindow();
    if (target === null) return;
    target.postMessage(
      {
        channel: MESSAGE_CHANNEL,
        phase: 'init',
        bootId: this.session.bootId,
        nonce: this.session.nonce,
      },
      this.expectedOrigin,
    );
  }

  private settleRequest(request: PendingRequest, settle: () => void): void {
    if (request.timer !== null) {
      clearTimeout(request.timer);
      request.timer = null;
    }
    settle();
  }
}
