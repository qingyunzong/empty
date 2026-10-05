import {
  ExecutionEvent,
  EventKind,
  EventStatus,
  parseEvents,
} from "./events.js";

export const DIAGNOSIS_CATEGORIES = [
  "missing_precondition",
  "communication_interruption",
  "assertion_failure",
  "unknown",
] as const;
export type DiagnosisCategory = (typeof DIAGNOSIS_CATEGORIES)[number];

/**
 * 有限分类表：kind × status → 诊断类别。
 * 这是唯一的分类依据，测试对该表做全组合穷举核对。
 * 未列出的组合一律返回 null（非终止原因）。
 */
export const CLASSIFICATION_TABLE: Readonly<
  Record<EventKind, Readonly<Partial<Record<EventStatus, Exclude<DiagnosisCategory, "unknown">>>>>
> = {
  precondition_check: {
    failed: "missing_precondition",
  },
  communication: {
    failed: "communication_interruption",
    timeout: "communication_interruption",
    interrupted: "communication_interruption",
  },
  assertion: {
    failed: "assertion_failure",
  },
  lifecycle: {},
};

/** 单个事件是否为直接致终止原因；是则返回其类别，否则 null。 */
export function classifyEvent(
  event: Pick<ExecutionEvent, "kind" | "status">,
): DiagnosisCategory | null {
  return CLASSIFICATION_TABLE[event.kind][event.status] ?? null;
}

export type DiagnosisReason =
  | "no_execution_evidence"
  | "no_terminating_event"
  | "earliest_terminating_event";

export interface ChainLink {
  readonly seq: number;
  readonly kind: EventKind;
  readonly status: EventStatus;
  readonly name: string;
  /** 该环节自身的分类；非致终止环节为 null。 */
  readonly category: DiagnosisCategory | null;
}

export interface Diagnosis {
  readonly category: DiagnosisCategory;
  readonly reason: DiagnosisReason;
  /** 最早直接致终止事件；category 为 unknown 时为 null。 */
  readonly rootCause: ExecutionEvent | null;
  /** 完整因果链，按执行顺序从起源排列到致终止事件。 */
  readonly causalChain: readonly ChainLink[];
}

function toLink(event: ExecutionEvent): ChainLink {
  return {
    seq: event.seq,
    kind: event.kind,
    status: event.status,
    name: event.name,
    category: classifyEvent(event),
  };
}

/**
 * 重建因果链：
 * - 若事件带有 causedBy 结构化因果引用，从致终止事件沿引用回溯全部祖先，
 *   再按 seq 升序排列（起源 → 致终止事件）；
 * - 否则退化为致终止事件之前（含）的全部已观察事件，按 seq 升序。
 */
function buildCausalChain(
  ordered: readonly ExecutionEvent[],
  rootCause: ExecutionEvent,
): ChainLink[] {
  const bySeq = new Map<number, ExecutionEvent>();
  for (const event of ordered) bySeq.set(event.seq, event);

  const hasLinks = ordered.some((e) => e.causedBy !== undefined && e.causedBy.length > 0);
  if (!hasLinks) {
    return ordered.filter((e) => e.seq <= rootCause.seq).map(toLink);
  }

  const ancestors = new Map<number, ExecutionEvent>();
  const stack: ExecutionEvent[] = [rootCause];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (ancestors.has(current.seq)) continue;
    ancestors.set(current.seq, current);
    for (const parentSeq of current.causedBy ?? []) {
      const parent = bySeq.get(parentSeq);
      if (parent !== undefined) stack.push(parent);
    }
  }
  return [...ancestors.values()]
    .sort((a, b) => a.seq - b.seq)
    .map(toLink);
}

/**
 * 诊断入口：
 * 1. 无事件 → 没有执行证据 → unknown；
 * 2. 有事件但无任何直接致终止事件 → unknown；
 * 3. 多个候选原因 → 取 seq 最小（最早）的直接致终止事件。
 */
export function diagnose(input: unknown): Diagnosis {
  const events = parseEvents(input);

  if (events.length === 0) {
    return {
      category: "unknown",
      reason: "no_execution_evidence",
      rootCause: null,
      causalChain: [],
    };
  }

  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  let rootCause: ExecutionEvent | null = null;
  let rootCategory: DiagnosisCategory | null = null;
  for (const event of ordered) {
    const category = classifyEvent(event);
    if (category !== null) {
      rootCause = event;
      rootCategory = category;
      break;
    }
  }

  if (rootCause === null || rootCategory === null) {
    return {
      category: "unknown",
      reason: "no_terminating_event",
      rootCause: null,
      causalChain: [],
    };
  }

  return {
    category: rootCategory,
    reason: "earliest_terminating_event",
    rootCause,
    causalChain: buildCausalChain(ordered, rootCause),
  };
}
