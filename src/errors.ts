import type { DownloadEvent } from './types.js';

/** 批次被拒绝的原因码。 */
export type RejectCode =
  | 'MALFORMED_EVENT'
  | 'CONFLICT_EVENT_ID'
  | 'CONFLICT_SEQ'
  | 'DUPLICATE_BEGIN'
  | 'BEGIN_NOT_FIRST'
  | 'RECEIVED_DECREASED'
  | 'TOTAL_CHANGED'
  | 'RECEIVED_EXCEEDS_TOTAL';

export interface RejectContext {
  readonly downloadId?: string;
  readonly eventId?: string;
  readonly seq?: number;
}

/**
 * 整个批次被拒绝时抛出。调用方捕获后可视为该批次没有任何副作用：
 * 存储内部已完成回滚，归档与已接受事件集合保持批次前状态。
 */
export class BatchRejectedError extends Error {
  readonly code: RejectCode;
  readonly context: RejectContext;

  constructor(code: RejectCode, message: string, context: RejectContext = {}) {
    super(message);
    this.name = 'BatchRejectedError';
    this.code = code;
    this.context = context;
  }
}

function reject(
  code: RejectCode,
  message: string,
  event: DownloadEvent | undefined,
): never {
  throw new BatchRejectedError(
    code,
    message,
    event
      ? { downloadId: event.downloadId, eventId: event.eventId, seq: event.seq }
      : {},
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * 结构校验：事件字段必须类型正确、序号为安全非负整数。
 * 非法结构与语义冲突一样会令整批回滚。
 */
export function assertWellFormed(event: DownloadEvent): void {
  if (event === null || typeof event !== 'object') {
    reject('MALFORMED_EVENT', 'event must be an object', undefined);
  }
  if (!isNonEmptyString(event.eventId)) {
    reject('MALFORMED_EVENT', 'eventId must be a non-empty string', event);
  }
  if (!isNonNegativeInteger(event.seq)) {
    reject('MALFORMED_EVENT', 'seq must be a safe non-negative integer', event);
  }
  if (!isNonEmptyString(event.downloadId)) {
    reject('MALFORMED_EVENT', 'downloadId must be a non-empty string', event);
  }

  switch (event.kind) {
    case 'begin':
      if (!isNonEmptyString(event.url)) {
        reject('MALFORMED_EVENT', 'begin.url must be a non-empty string', event);
      }
      break;
    case 'progress':
      if (!isNonNegativeInteger(event.received)) {
        reject(
          'MALFORMED_EVENT',
          'progress.received must be a safe non-negative integer',
          event,
        );
      }
      if (event.total !== null && !isNonNegativeInteger(event.total)) {
        reject(
          'MALFORMED_EVENT',
          'progress.total must be null or a safe non-negative integer',
          event,
        );
      }
      break;
    case 'complete':
      if (typeof event.summary !== 'string') {
        reject('MALFORMED_EVENT', 'complete.summary must be a string', event);
      }
      break;
    case 'cancel':
      break;
    default:
      reject('MALFORMED_EVENT', `unknown event kind: ${String((event as { kind: unknown }).kind)}`, event);
  }
}

/** 深度结构相等，用于判定相同事件重投。 */
export function eventsEqual(a: DownloadEvent, b: DownloadEvent): boolean {
  if (a === b) {
    return true;
  }
  if (a.kind !== b.kind || a.eventId !== b.eventId || a.seq !== b.seq ||
      a.downloadId !== b.downloadId) {
    return false;
  }
  switch (a.kind) {
    case 'begin':
      return a.url === (b as typeof a).url;
    case 'progress': {
      const other = b as typeof a;
      return a.received === other.received && a.total === other.total;
    }
    case 'complete':
      return a.summary === (b as typeof a).summary;
    case 'cancel':
      return true;
    default:
      return false;
  }
}

/** 内部重放阶段抛出语义错误的统一入口。 */
export function semanticReject(
  code: RejectCode,
  message: string,
  event: DownloadEvent,
): never {
  reject(code, message, event);
}
