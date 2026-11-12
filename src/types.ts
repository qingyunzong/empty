/**
 * 下载生命周期事件与归档状态的类型定义。
 *
 * 每个事件同时携带：
 * - `eventId`  : 事件唯一 ID（同一事件重投时保持不变）。
 * - `seq`      : 全局唯一、单调语义的整数序号，决定同一下载内的重放顺序。
 * - `downloadId`: 事件所属下载（begin 事件中即下载 ID）。
 */

/** 下载的业务终态。 */
export type TerminalKind = 'complete' | 'cancel';

/** begin(id, url)：开始一个下载。 */
export interface BeginEvent {
  readonly kind: 'begin';
  readonly eventId: string;
  readonly seq: number;
  readonly downloadId: string;
  readonly url: string;
}

/** progress(id, received, total)：下载进度；total 未知时为 null。 */
export interface ProgressEvent {
  readonly kind: 'progress';
  readonly eventId: string;
  readonly seq: number;
  readonly downloadId: string;
  readonly received: number;
  /** 总字节数未知时为 null；一旦在重放中变为已知即固定。 */
  readonly total: number | null;
}

/** complete(id, 摘要)：下载完成，携带宿主可归档的摘要。 */
export interface CompleteEvent {
  readonly kind: 'complete';
  readonly eventId: string;
  readonly seq: number;
  readonly downloadId: string;
  readonly summary: string;
}

/** cancel(id)：下载取消。 */
export interface CancelEvent {
  readonly kind: 'cancel';
  readonly eventId: string;
  readonly seq: number;
  readonly downloadId: string;
}

/** 下载采集协议中的全部事件类型。 */
export type DownloadEvent =
  | BeginEvent
  | ProgressEvent
  | CompleteEvent
  | CancelEvent;

/** 已就绪（可被宿主归档）的下载。 */
export interface ArchivedDownload {
  readonly downloadId: string;
  readonly kind: TerminalKind;
  /** begin 事件给出的 URL。 */
  readonly url: string;
  /** complete 时的摘要；cancel 时为 null。 */
  readonly summary: string | null;
  /** 终态事件自身的序号。 */
  readonly terminalSeq: number;
  /** 终态就绪时累计的已接收字节。 */
  readonly received: number;
  /** 已知总字节；始终未知（cancel）时为 null。 */
  readonly total: number | null;
}

/** 一次 ingest 中单个受影响下载的归档净差。 */
export interface ArchiveDelta {
  readonly downloadId: string;
  /** 被新终态撤销的旧归档；此前未归档时为 null。 */
  readonly removed: ArchivedDownload | null;
  /** 新生成的归档；终态尚未就绪或归档不变时为 null。 */
  readonly added: ArchivedDownload | null;
}

/** 单次批次处理结果。 */
export interface BatchResult {
  /** 实际写入存储的事件数（不含重投忽略、不含回滚批次）。 */
  readonly accepted: number;
  /** 相同事件重投而被忽略的事件。 */
  readonly ignoredDuplicates: readonly DownloadEvent[];
  /** 本次批次中发生过重放的下载 ID。 */
  readonly affectedDownloads: readonly string[];
  /** 归档净差，按下载 ID 升序排列。 */
  readonly deltas: readonly ArchiveDelta[];
}

/** 下载当前阶段（不修改存储的查询视图）。 */
export interface DownloadView {
  readonly downloadId: string;
  /** begin 尚未到达，仅有暂存片段。 */
  readonly stage: 'staged' | 'active' | 'complete' | 'cancel';
  /** 是否已收到 begin 事件。 */
  readonly begun: boolean;
  readonly url: string | null;
  readonly received: number;
  readonly total: number | null;
  /** 终态事件已出现但 complete 尚未满足就绪条件时为 false。 */
  readonly terminalReady: boolean;
  /** 已归档时给出归档快照，否则为 null。 */
  readonly archive: ArchivedDownload | null;
}
