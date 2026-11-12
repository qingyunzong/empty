import { semanticReject } from './errors.js';
import type {
  ArchivedDownload,
  BeginEvent,
  CancelEvent,
  CompleteEvent,
  DownloadEvent,
  ProgressEvent,
  TerminalKind,
} from './types.js';

/** 单个下载按序号重放后的状态。 */
export interface ReplayOutput {
  /** 是否存在 begin 事件。 */
  readonly begun: boolean;
  readonly url: string | null;
  readonly received: number;
  readonly total: number | null;
  /** 首个终态（序号最小的 complete/cancel）；无终态时为 null。 */
  readonly terminal:
    | { readonly kind: TerminalKind; readonly event: CompleteEvent | CancelEvent }
    | null;
  /** 终态是否满足归档就绪条件。 */
  readonly terminalReady: boolean;
  /** 就绪终态对应的归档；未就绪或无终态时为 null。 */
  readonly archive: ArchivedDownload | null;
}

function buildArchive(
  terminalKind: TerminalKind,
  terminalEvent: CompleteEvent | CancelEvent,
  begin: BeginEvent,
  received: number,
  total: number | null,
): ArchivedDownload {
  return {
    downloadId: begin.downloadId,
    kind: terminalKind,
    url: begin.url,
    summary: terminalKind === 'complete' ? (terminalEvent as CompleteEvent).summary : null,
    terminalSeq: terminalEvent.seq,
    received,
    total,
  };
}

/**
 * 按全局序号重放同一下载的全部已知事件（含此前暂存的片段）。
 *
 * 规则：
 * - begin 必须唯一，且是序号最小的事件；begin 尚未到达时只返回未开始视图，
 *   由存储层暂存；一旦 begin 存在，任何序号更小的非 begin 事件即非法。
 * - 首个终态（序号最小的 complete/cancel）之后的事件一律忽略。
 * - progress 的 received 单调非降；total 只能由未知变已知一次，之后不可变；
 *   received 不得超过已知 total。
 * - complete 仅当 total 已知且 received === total 时就绪，否则保留等待更早的
 *   progress 到达后再次重放；cancel 立即就绪。
 *
 * 任何规则违例都抛出 BatchRejectedError，由上层整批回滚。
 */
export function replayDownload(downloadId: string, events: readonly DownloadEvent[]): ReplayOutput {
  const ordered = [...events].sort((left, right) => left.seq - right.seq);

  let begin: BeginEvent | null = null;
  let received = 0;
  let total: number | null = null;
  let terminal: ReplayOutput['terminal'] = null;

  const beginIndex = ordered.findIndex((event) => event.kind === 'begin');
  // 首个终态 = 序号最小的 complete/cancel，与到达顺序无关。
  const firstTerminal = ordered.find(
    (event) => event.kind === 'complete' || event.kind === 'cancel',
  );

  // begin 完全缺失：整桶仍是暂存片段（progress 与终态都暂存），不产生任何归档；
  // begin 到达后再次重放时由顺序规则统一裁决。
  if (beginIndex === -1) {
    for (const event of ordered) {
      if (event.downloadId !== downloadId) {
        semanticReject('MALFORMED_EVENT', 'replay bucket contains events of another download', event);
      }
      if (event.kind === 'progress') {
        applyProgress(event, received, total);
        received = event.received;
        if (event.total !== null) {
          total = event.total;
        }
      }
    }
    return {
      begun: false,
      url: null,
      received,
      total,
      terminal: null,
      terminalReady: false,
      archive: null,
    };
  }

  for (let index = 0; index < ordered.length; index += 1) {
    const event = ordered[index]!;
    if (event.downloadId !== downloadId) {
      semanticReject(
        'MALFORMED_EVENT',
        'replay bucket contains events of another download',
        event,
      );
    }

    if (event.kind === 'begin') {
      if (index !== beginIndex) {
        semanticReject('DUPLICATE_BEGIN', 'a download may only have one begin event', event);
      }
      begin = event;
      continue;
    }

    // begin 存在时，任何序号排在它前面的非 begin 事件都是非法顺序。
    if (begin === null) {
      semanticReject(
        'BEGIN_NOT_FIRST',
        'begin event must precede all other events in replay order',
        event,
      );
    }

    if (event.kind === 'progress') {
      // 序号晚于首个终态的 progress 属于“首个终态之后的事件”，忽略。
      if (firstTerminal !== undefined && event.seq > firstTerminal.seq) {
        continue;
      }
      applyProgress(event, received, total);
      received = event.received;
      if (event.total !== null) {
        total = event.total;
      }
      continue;
    }

    // complete / cancel：只吸收序号最小的首个终态，其后的第二个终态忽略。
    // 注意不能按位置整体截断——首个终态之后、更晚终态之前到达的 progress
    // 只要序号早于首个终态，仍需参与 received/total 累计。
    if (firstTerminal !== undefined && event.seq > firstTerminal.seq) {
      continue;
    }
    terminal = { kind: event.kind, event };
  }

  let terminalReady = false;
  let archive: ArchivedDownload | null = null;

  if (terminal !== null && begin !== null) {
    if (terminal.kind === 'cancel') {
      // cancel 立即就绪，不依赖 progress。
      terminalReady = true;
    } else {
      // complete 必须已知 total 且最终 received 恰好等于 total。
      terminalReady = total !== null && received === total;
    }
    if (terminalReady) {
      archive = buildArchive(
        terminal.kind,
        terminal.event,
        begin,
        received,
        total,
      );
    }
  }

  return {
    begun: begin !== null,
    url: begin?.url ?? null,
    received,
    total,
    terminal,
    terminalReady,
    archive,
  };
}

function applyProgress(
  event: ProgressEvent,
  previousReceived: number,
  knownTotal: number | null,
): void {
  if (event.received < previousReceived) {
    semanticReject(
      'RECEIVED_DECREASED',
      `progress.received moved backwards: ${previousReceived} -> ${event.received}`,
      event,
    );
  }
  if (event.total !== null) {
    if (knownTotal !== null && event.total !== knownTotal) {
      semanticReject(
        'TOTAL_CHANGED',
        `progress.total changed after becoming known: ${knownTotal} -> ${event.total}`,
        event,
      );
    }
    if (event.received > event.total) {
      semanticReject(
        'RECEIVED_EXCEEDS_TOTAL',
        `progress.received ${event.received} exceeds total ${event.total}`,
        event,
      );
    }
  } else if (knownTotal !== null && event.received > knownTotal) {
    // total 已由更早的 progress 确定，本条未再携带 total 也要受其约束。
    semanticReject(
      'RECEIVED_EXCEEDS_TOTAL',
      `progress.received ${event.received} exceeds known total ${knownTotal}`,
      event,
    );
  }
}
