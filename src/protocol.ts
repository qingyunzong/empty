export const MESSAGE_CHANNEL = 'embedded-form-bridge';

export type MessagePhase = 'ready' | 'init' | 'fields-request' | 'complete';

export interface FieldSpec {
  name: string;
  label?: string;
  required?: boolean;
}

export type FieldValues = Record<string, unknown>;

export interface ReadyMessage {
  channel: typeof MESSAGE_CHANNEL;
  phase: 'ready';
  bootId: string;
}

export interface InitMessage {
  channel: typeof MESSAGE_CHANNEL;
  phase: 'init';
  bootId: string;
  nonce: string;
}

export interface FieldsRequestMessage {
  channel: typeof MESSAGE_CHANNEL;
  phase: 'fields-request';
  nonce: string;
  requestId: string;
  fields: FieldSpec[];
}

export interface CompleteMessage {
  channel: typeof MESSAGE_CHANNEL;
  phase: 'complete';
  nonce: string;
  requestId: string;
  values: FieldValues;
}

export type BridgeMessage =
  | ReadyMessage
  | InitMessage
  | FieldsRequestMessage
  | CompleteMessage;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function parseBridgeMessage(data: unknown): BridgeMessage | null {
  if (!isRecord(data)) return null;
  if (data.channel !== MESSAGE_CHANNEL) return null;

  switch (data.phase) {
    case 'ready':
      if (typeof data.bootId !== 'string') return null;
      return { channel: MESSAGE_CHANNEL, phase: 'ready', bootId: data.bootId };
    case 'init':
      if (typeof data.bootId !== 'string' || typeof data.nonce !== 'string') return null;
      return {
        channel: MESSAGE_CHANNEL,
        phase: 'init',
        bootId: data.bootId,
        nonce: data.nonce,
      };
    case 'fields-request':
      if (
        typeof data.nonce !== 'string' ||
        typeof data.requestId !== 'string' ||
        !Array.isArray(data.fields)
      )
        return null;
      return {
        channel: MESSAGE_CHANNEL,
        phase: 'fields-request',
        nonce: data.nonce,
        requestId: data.requestId,
        fields: data.fields as FieldSpec[],
      };
    case 'complete':
      if (
        typeof data.nonce !== 'string' ||
        typeof data.requestId !== 'string' ||
        !isRecord(data.values)
      )
        return null;
      return {
        channel: MESSAGE_CHANNEL,
        phase: 'complete',
        nonce: data.nonce,
        requestId: data.requestId,
        values: data.values,
      };
    default:
      return null;
  }
}
