/** 数量表：物料编码/设备编码 -> 数量 */
export type MaterialQty = Record<string, number>;

/** 阶段定义：每次尝试需要的原料、占用设备，以及失败时按阶段决定的可回收原料 */
export interface StageSpec {
  stageId: string;
  materials: MaterialQty;
  equipment: MaterialQty;
  /** 失败时可回收（保留给重试）的原料数量，未列出的物料视为全部损耗 */
  recovery: MaterialQty;
}

export interface JobSpec {
  jobId: string;
  stages: StageSpec[];
}

export interface ActiveStage {
  stageId: string;
  attempt: number;
}

export type JobStatus = 'pending' | 'in-progress' | 'failed' | 'completed' | 'cancelled';

export interface JobState {
  jobId: string;
  orderId: string;
  stages: StageSpec[];
  nextStage: number;
  attempt: number;
  status: JobStatus;
  /** 已提交给当前阶段的原料（在制） */
  held: MaterialQty;
  /** 上次失败按阶段回收、保留给重试的原料（重试时不得再次消耗） */
  retained: MaterialQty;
  /** 已完成阶段累计消耗 */
  consumed: MaterialQty;
  /** 当前占用的设备 */
  heldEquipment: MaterialQty;
  activeStage: ActiveStage | null;
}

export type OrderStatus = 'open' | 'completed' | 'cancelled';

export interface OrderState {
  orderId: string;
  jobIds: string[];
  status: OrderStatus;
}

export interface MaterialState {
  onHand: number;
  reserved: number;
}

export interface EquipmentState {
  capacity: number;
  inUse: number;
}

export interface State {
  materials: Record<string, MaterialState>;
  equipment: Record<string, EquipmentState>;
  orders: Record<string, OrderState>;
  jobs: Record<string, JobState>;
  /** 失败损耗累计 */
  scrapped: MaterialQty;
}

export function initialState(): State {
  return { materials: {}, equipment: {}, orders: {}, jobs: {}, scrapped: {} };
}

export function addQty(target: MaterialQty, items: MaterialQty, sign: 1 | -1 = 1): void {
  for (const [key, qty] of Object.entries(items)) {
    target[key] = (target[key] ?? 0) + sign * qty;
    if (target[key] === 0) delete target[key];
  }
}

export function mergeQty(a: MaterialQty, b: MaterialQty): MaterialQty {
  const out: MaterialQty = { ...a };
  addQty(out, b);
  return out;
}

export function isEmptyQty(items: MaterialQty): boolean {
  return Object.keys(items).length === 0;
}

export function cloneQty(items: MaterialQty): MaterialQty {
  return { ...items };
}
