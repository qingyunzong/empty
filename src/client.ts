import type { EventTargetLike, MessageEventLike, WindowLike } from './events.ts';
import {
  MESSAGE_CHANNEL,
  parseBridgeMessage,
  type FieldSpec,
  type FieldValues,
} from './protocol.ts';

export interface FormBridgeClientOptions {
  eventTarget: EventTargetLike;
  getParentWindow: () => WindowLike | null;
  parentOrigin: string;
  onFields: (fields: FieldSpec[]) => FieldValues | Promise<FieldValues>;
  bootId?: string;
  generateId?: () => string;
}

const defaultGenerateId = (): string => {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  return `id-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
};

export class FormBridgeClient {
  private readonly eventTarget: EventTargetLike;
  private readonly getParentWindow: () => WindowLike | null;
  private readonly parentOrigin: string;
  private readonly onFields: (fields: FieldSpec[]) => FieldValues | Promise<FieldValues>;
  private readonly bootId: string;

  private nonce: string | null = null;
  private readonly answered = new Map<string, FieldValues>();
  private readonly inflight = new Set<string>();
  private started = false;

  private readonly onMessage = (event: MessageEventLike): void => {
    if (event.origin !== this.parentOrigin) return;
    const parent = this.getParentWindow();
    if (parent === null || event.source !== parent) return;

    const message = parseBridgeMessage(event.data);
    if (message === null) return;

    if (message.phase === 'init') {
      if (message.bootId !== this.bootId) return;
      this.nonce = message.nonce;
      return;
    }
    if (message.phase === 'fields-request') {
      void this.handleFieldsRequest(message.nonce, message.requestId, message.fields);
    }
  };

  constructor(options: FormBridgeClientOptions) {
    this.eventTarget = options.eventTarget;
    this.getParentWindow = options.getParentWindow;
    this.parentOrigin = options.parentOrigin;
    this.onFields = options.onFields;
    this.bootId = options.bootId ?? (options.generateId ?? defaultGenerateId)();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.eventTarget.addEventListener('message', this.onMessage);
    this.announceReady();
  }

  announceReady(): void {
    const parent = this.getParentWindow();
    if (parent === null) return;
    parent.postMessage(
      { channel: MESSAGE_CHANNEL, phase: 'ready', bootId: this.bootId },
      this.parentOrigin,
    );
  }

  destroy(): void {
    this.eventTarget.removeEventListener('message', this.onMessage);
    this.started = false;
    this.nonce = null;
    this.answered.clear();
    this.inflight.clear();
  }

  private async handleFieldsRequest(
    nonce: string,
    requestId: string,
    fields: FieldSpec[],
  ): Promise<void> {
    if (this.nonce === null || nonce !== this.nonce) return;

    const cached = this.answered.get(requestId);
    if (cached !== undefined) {
      this.sendComplete(requestId, cached);
      return;
    }
    if (this.inflight.has(requestId)) return;

    this.inflight.add(requestId);
    try {
      const values = await this.onFields(fields);
      this.inflight.delete(requestId);
      if (this.nonce === null || nonce !== this.nonce) return;
      this.answered.set(requestId, values);
      this.sendComplete(requestId, values);
    } catch {
      this.inflight.delete(requestId);
    }
  }

  private sendComplete(requestId: string, values: FieldValues): void {
    const parent = this.getParentWindow();
    if (parent === null || this.nonce === null) return;
    parent.postMessage(
      {
        channel: MESSAGE_CHANNEL,
        phase: 'complete',
        nonce: this.nonce,
        requestId,
        values,
      },
      this.parentOrigin,
    );
  }
}
