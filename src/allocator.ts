import { Rat } from './rational.ts';

/** 分摊输入:整数需求、正权重、每户上限(均为整数单位)。 */
export interface UserInput {
  id: string;
  demand: number;
  weight: number;
  cap: number;
}

interface UserState {
  id: string;
  demand: number;
  cap: number;
  weight: Rat;
  /** 有效需求 = min(demand, cap) */
  effective: number;
}

/** 一轮渐进注水(加权最大最小公平)的饱和证据。 */
export interface RoundEvidence {
  round: number;
  /** 本轮结束时的累计水位(每单位权重的应得量),精确分数 */
  level: string;
  levelValue: number;
  /** 本轮达到饱和(需求或上限被满足)的用户 */
  saturatedIds: string[];
  /** 本轮结束后的剩余容量,精确分数 */
  capacityRemaining: string;
  capacityRemainingValue: number;
  /** 截至本轮各用户的累计分数应得 */
  cumulativeFractional: Record<string, string>;
}

export interface AllocationResult {
  capacity: number;
  /** 最终整数分配(余数按 ID 顺序补分) */
  allocation: Record<string, number>;
  /** 精确分数应得(对照证据) */
  fractional: Record<string, string>;
  fractionalValue: Record<string, number>;
  /** 逐轮饱和证据 */
  rounds: RoundEvidence[];
  saturatedIds: string[];
  /** 用户 -> 饱和轮次 */
  saturationRound: Record<string, number>;
  /** 余数补分的接收者(按 ID 顺序) */
  remainderRecipients: string[];
  allocatedTotal: number;
  unservedCapacity: number;
}

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function validate(capacity: number, users: UserInput[]): UserState[] {
  if (!Number.isInteger(capacity) || capacity < 0) {
    throw new Error(`capacity 必须为非负整数,收到: ${capacity}`);
  }
  const seen = new Set<string>();
  return users.map((u) => {
    if (seen.has(u.id)) throw new Error(`重复的用户 ID: ${u.id}`);
    seen.add(u.id);
    if (!Number.isInteger(u.demand) || u.demand < 0) {
      throw new Error(`用户 ${u.id} 的 demand 必须为非负整数,收到: ${u.demand}`);
    }
    if (!Number.isInteger(u.cap) || u.cap < 0) {
      throw new Error(`用户 ${u.id} 的 cap 必须为非负整数,收到: ${u.cap}`);
    }
    if (!Number.isFinite(u.weight) || u.weight <= 0) {
      throw new Error(`用户 ${u.id} 的 weight 必须为正数,收到: ${u.weight}`);
    }
    return {
      id: u.id,
      demand: u.demand,
      cap: u.cap,
      weight: Rat.of(u.weight),
      effective: Math.min(u.demand, u.cap),
    };
  });
}

/**
 * 逐轮加权最大最小公平分摊(渐进注水)。
 * 水位按权重匀速上升;每轮记录达到 min(需求, 上限) 而饱和的用户;
 * 最终分数应得向下取整,剩余整数余数按用户 ID 顺序逐户补 1。
 */
export function allocate(capacity: number, users: UserInput[]): AllocationResult {
  const states = validate(capacity, users);
  const sorted = [...states].sort((a, b) => byId(a.id, b.id));

  let remaining = Rat.of(capacity);
  let level = Rat.zero();
  const saturated = new Set<string>();
  const saturationRound: Record<string, number> = {};
  const rounds: RoundEvidence[] = [];

  const shareOf = (s: UserState, lvl: Rat): Rat =>
    Rat.min(Rat.of(s.effective), lvl.mul(s.weight));

  const snapshot = (): Record<string, string> => {
    const snap: Record<string, string> = {};
    for (const s of sorted) snap[s.id] = shareOf(s, level).toString();
    return snap;
  };

  let round = 0;
  while (!remaining.isZero()) {
    const active = states.filter((s) => s.effective > 0 && !saturated.has(s.id));
    if (active.length === 0) break;

    // 最早饱和阈值: effective / weight 最小者
    let threshold: Rat | null = null;
    for (const s of active) {
      const t = Rat.of(s.effective).div(s.weight);
      if (threshold === null || t.cmp(threshold) < 0) threshold = t;
    }
    const cumWeight = active.reduce((acc, s) => acc.add(s.weight), Rat.zero());
    const cost = threshold!.sub(level).mul(cumWeight);

    round += 1;
    if (cost.cmp(remaining) <= 0) {
      // 容量足以把水位推到下一阈值:一批用户本轮饱和
      level = threshold!;
      remaining = remaining.sub(cost);
      const satIds = active
        .filter((s) => Rat.of(s.effective).div(s.weight).cmp(level) === 0)
        .map((s) => s.id)
        .sort(byId);
      for (const id of satIds) {
        saturated.add(id);
        saturationRound[id] = round;
      }
      rounds.push(makeRound(round, level, satIds, remaining, snapshot()));
    } else {
      // 容量在本轮耗尽:水位停在中间,无人饱和
      level = level.add(remaining.div(cumWeight));
      remaining = Rat.zero();
      rounds.push(makeRound(round, level, [], remaining, snapshot()));
    }
  }

  // 最终分数应得与整数取整
  const fractional: Record<string, string> = {};
  const fractionalValue: Record<string, number> = {};
  const allocation: Record<string, number> = {};
  let allocatedTotal = 0;
  for (const s of sorted) {
    const share = shareOf(s, level);
    fractional[s.id] = share.toString();
    fractionalValue[s.id] = share.toNumber();
    const units = Number(share.floor());
    allocation[s.id] = units;
    allocatedTotal += units;
  }

  // 余数处理:仅在容量成为约束时,把取整余数按 ID 顺序逐户补 1
  const remainderRecipients: string[] = [];
  let leftover = capacity - allocatedTotal;
  const totalEffective = states.reduce((acc, s) => acc + s.effective, 0);
  if (leftover > 0 && totalEffective > capacity) {
    for (const s of sorted) {
      if (leftover === 0) break;
      if (allocation[s.id] < s.effective) {
        allocation[s.id] += 1;
        leftover -= 1;
        allocatedTotal += 1;
        remainderRecipients.push(s.id);
      }
    }
  }

  return {
    capacity,
    allocation,
    fractional,
    fractionalValue,
    rounds,
    saturatedIds: [...saturated].sort(byId),
    saturationRound,
    remainderRecipients,
    allocatedTotal,
    unservedCapacity: leftover,
  };
}

function makeRound(
  round: number,
  level: Rat,
  saturatedIds: string[],
  remaining: Rat,
  cumulativeFractional: Record<string, string>,
): RoundEvidence {
  return {
    round,
    level: level.toString(),
    levelValue: level.toNumber(),
    saturatedIds,
    capacityRemaining: remaining.toString(),
    capacityRemainingValue: remaining.toNumber(),
    cumulativeFractional,
  };
}

/**
 * 分摊器:维护用户集合,支持需求撤销后重新分摊。
 */
export class Allocator {
  private readonly users = new Map<string, UserInput>();

  constructor(private readonly capacityValue: number) {
    if (!Number.isInteger(capacityValue) || capacityValue < 0) {
      throw new Error(`capacity 必须为非负整数,收到: ${capacityValue}`);
    }
  }

  get capacity(): number {
    return this.capacityValue;
  }

  addUser(user: UserInput): void {
    this.users.set(user.id, user);
  }

  /** 撤销某户需求;返回该户是否存在。 */
  revoke(id: string): boolean {
    return this.users.delete(id);
  }

  listUsers(): UserInput[] {
    return [...this.users.values()];
  }

  /** 按当前用户集合重新分摊。 */
  allocate(): AllocationResult {
    return allocate(this.capacityValue, this.listUsers());
  }
}
