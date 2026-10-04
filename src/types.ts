/** 一条字幕：半开显示区间 [start, end)，priority 为显示收益。 */
export interface Item {
  id: number;
  start: number;
  end: number;
  priority: number;
}

/** 时码更正：按 id 覆盖 start/end/priority。 */
export interface Correction {
  id: number;
  start?: number;
  end?: number;
  priority?: number;
}

/** 层分配证书中的一条：字幕 id 分到第 layer 层（0 起）。 */
export interface Assignment {
  id: number;
  layer: number;
}

/** 求解输出的层分配证书。 */
export interface Certificate {
  k: number;
  profit: number;
  count: number;
  /** 选中字幕 id，升序。 */
  selected: number[];
  /** 每条选中字幕的层号。 */
  assignment: Assignment[];
}

export const MAX_ITEMS = 20;
