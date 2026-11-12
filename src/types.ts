/**
 * 虚拟列表采集组件的领域类型。
 *
 * 约定：
 * - 行具有稳定 ID、非负版本号与内容。
 * - 每一次可观察到的列表状态变化（滚动、重排、删除、版本更新等）都会产生
 *   一个严格递增的“滚动代数”（generation）。
 * - 同一代数内反复 read() 的结果保持不变。
 */

/** 虚拟列表中的一行。 */
export interface Row {
  /** 行的稳定标识，在列表生命周期内不随重排/滚动改变。 */
  readonly id: string;
  /** 非负版本号；同一 ID 的行内容更新时版本严格递增。 */
  readonly version: number;
  /** 行内容，版本相同的行内容必须一致。 */
  readonly content: string;
}

/** read() 的返回：当前视口内的有序行与当前滚动代数。 */
export interface Viewport {
  /** 视口内行，顺序即用户在宿主页面中看到的顺序。 */
  readonly rows: readonly Row[];
  /** 当前滚动代数（非负整数）。 */
  readonly generation: number;
}

/** move() 成功（列表实际发生滚动）的结果。 */
export interface MoveOk {
  readonly kind: "moved";
  /** 滚动之后的新代数，必须严格大于 move 前的已确认代数。 */
  readonly generation: number;
}

/**
 * move() 未滚动的结果：锚点已被移除（例如被删除），
 * 适配器保持在原代数不变，调用方需要重新 read() 后再试。
 */
export interface MoveStale {
  readonly kind: "stale";
  /** 未发生滚动，代数保持不变。 */
  readonly generation: number;
}

export type MoveResult = MoveOk | MoveStale;

/**
 * 虚拟列表适配器。由宿主（浏览器采集端）实现，采集组件只通过该接口驱动
 * 宿主页面，不直接接触 DOM 或网络。
 *
 * 两个方法都可能因宿主通信故障而 reject；其中 move() 允许“动作成功但
 * 响应丢失”，即列表已经滚动、代数已经增加，只是 Promise 失败了。
 */
export interface VirtualListAdapter {
  /** 读取当前视口的有序行与滚动代数。同一代数内结果不变。 */
  read(): Promise<Viewport>;
  /**
   * 以 anchorId 对应行为锚点、delta 为相对滚动量请求滚动。
   * 采集组件固定以当前视口最后一行为锚点、delta = 1 调用。
   */
  move(anchorId: string, delta: number): Promise<MoveResult>;
}

/** 采集结束时的状态机终止状态。 */
export type CollectStatus =
  /** 连续 K 次有效移动都没有带来新 ID 或更高版本，正常结束。 */
  | "completed"
  /** 移动预算耗尽，列表可能尚未读完。 */
  | "budget-exhausted"
  /** read() 失败。按协议必须先停止，不得继续滚动。 */
  | "read-failed"
  /** 适配器违反协议（代数非递增、同版本内容不一致等）。 */
  | "protocol-error";

/** 一次采集的结果。 */
export interface CollectResult {
  readonly status: CollectStatus;
  /** 已采集行，按首次见到该 ID 的顺序排列。 */
  readonly rows: readonly Row[];
  /** 结束时最后一次确认的滚动代数。 */
  readonly generation: number;
  /** 实际消耗的 move 调用次数（不含 read）。 */
  readonly movesUsed: number;
  /** 状态机终止原因的描述信息。 */
  readonly reason: string;
}

/** 采集参数。 */
export interface CollectOptions {
  /**
   * 连续多少次“有效移动”（不含 stale）没有发现新 ID 或更高版本后结束。
   * 必须为正整数。
   */
  readonly stableRounds: number;
  /** move 调用预算，正整数；耗尽后返回 budget-exhausted 与已采集数据。 */
  readonly moveBudget: number;
}

/** 采集过程中抛出的协议错误。 */
export class ProtocolError extends Error {
 constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}
