/**
 * 结构化执行事件模型。
 * 分类只依据 kind / status 两个结构化枚举字段；
 * name / message 仅用于人类阅读，绝不参与分类（不从文字猜身份）。
 */

export const EVENT_KINDS = [
  "precondition_check",
  "communication",
  "assertion",
  "lifecycle",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const EVENT_STATUSES = [
  "ok",
  "failed",
  "timeout",
  "interrupted",
  "skipped",
] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export interface ExecutionEvent {
  /** 单调递增的执行序号，是“最早”判定的唯一依据。 */
  readonly seq: number;
  readonly kind: EventKind;
  readonly status: EventStatus;
  /** 结构化标识符，仅供展示，不参与分类。 */
  readonly name: string;
  /** 人类可读描述，仅供展示，不参与分类。 */
  readonly message?: string;
  /** 指向因果前驱事件的 seq 列表，用于重建因果链。 */
  readonly causedBy?: readonly number[];
}

const KIND_SET: ReadonlySet<string> = new Set(EVENT_KINDS);
const STATUS_SET: ReadonlySet<string> = new Set(EVENT_STATUSES);

export class EventValidationError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`invalid execution events: ${problems.join("; ")}`);
    this.name = "EventValidationError";
    this.problems = problems;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 严格校验输入结构。任何字段缺失或越出有限枚举表都报错，
 * 不做任何基于字符串内容的猜测或修补。
 */
export function parseEvents(input: unknown): ExecutionEvent[] {
  if (!Array.isArray(input)) {
    throw new EventValidationError(["input must be an array of events"]);
  }
  const problems: string[] = [];
  const events: ExecutionEvent[] = [];
  const seenSeq = new Set<number>();

  input.forEach((raw, index) => {
    const where = `events[${index}]`;
    const problemsBefore = problems.length;
    if (!isRecord(raw)) {
      problems.push(`${where} must be an object`);
      return;
    }
    const { seq, kind, status, name, message, causedBy } = raw;

    if (typeof seq !== "number" || !Number.isInteger(seq)) {
      problems.push(`${where}.seq must be an integer`);
    } else if (seenSeq.has(seq)) {
      problems.push(`${where}.seq ${seq} is duplicated`);
    } else {
      seenSeq.add(seq);
    }
    if (typeof kind !== "string" || !KIND_SET.has(kind)) {
      problems.push(`${where}.kind must be one of ${EVENT_KINDS.join("|")}`);
    }
    if (typeof status !== "string" || !STATUS_SET.has(status)) {
      problems.push(`${where}.status must be one of ${EVENT_STATUSES.join("|")}`);
    }
    if (typeof name !== "string" || name.length === 0) {
      problems.push(`${where}.name must be a non-empty string`);
    }
    if (message !== undefined && typeof message !== "string") {
      problems.push(`${where}.message must be a string when present`);
    }
    if (
      causedBy !== undefined &&
      (!Array.isArray(causedBy) ||
        causedBy.some((s) => typeof s !== "number" || !Number.isInteger(s)))
    ) {
      problems.push(`${where}.causedBy must be an array of integer seq values`);
    }
    if (problems.length > problemsBefore) return;

    const event: ExecutionEvent = { seq: seq as number, kind: kind as EventKind, status: status as EventStatus, name: name as string };
    if (message !== undefined) (event as { message?: string }).message = message as string;
    if (causedBy !== undefined) (event as { causedBy?: readonly number[] }).causedBy = causedBy as number[];
    events.push(event);
  });

  if (problems.length > 0) {
    throw new EventValidationError(problems);
  }
  return events;
}
