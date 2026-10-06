/**
 * 版本化状态仓库。
 * 每个动作产生一个新版本（不可变快照），旧版本全部保留，
 * 因此可以 fork 任意历史版本开分支；undo 即回到父版本——
 * 门恢复关闭、已消耗的钥匙自动返还。
 */
import { Level } from "./level";

export type Action = "up" | "down" | "left" | "right";
export const ACTIONS: readonly Action[] = ["up", "down", "left", "right"];

const DELTA: Record<Action, [number, number]> = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

export interface State {
  /** 版本号（在仓库内唯一，单调递增） */
  version: number;
  /** 父版本，根为 -1 */
  parent: number;
  /** 产生本版本的动作，根为 null */
  action: Action | null;
  /** 当前位置（格子索引） */
  pos: number;
  /** 已拾取钥匙位掩码（第 i 位 = 钥匙 i） */
  collected: number;
  /** 已打开门位掩码（第 i 位 = 门 i） */
  doorsOpen: number;
}

/** 当前持有的钥匙 = 已拾取且未被开门消耗（门 i 消耗钥匙 i） */
export function keysHeld(s: State): number {
  return s.collected & ~s.doorsOpen;
}

export function popcount(n: number): number {
  let c = 0;
  while (n) { n &= n - 1; c++; }
  return c;
}

export class StateStore {
  private versions: State[] = [];

  constructor(public readonly level: Level) {}

  /** 创建初始版本（version 0） */
  initial(): State {
    if (this.versions.length !== 0) throw new Error("initial state already exists");
    const s: State = {
      version: 0, parent: -1, action: null,
      pos: this.level.start, collected: 0, doorsOpen: 0,
    };
    this.versions.push(s);
    return s;
  }

  get(version: number): State {
    const s = this.versions[version];
    if (!s) throw new Error(`unknown version ${version}`);
    return s;
  }

  get size(): number {
    return this.versions.length;
  }

  /**
   * 应用一个动作，返回新版本；动作非法（撞墙/出界/无钥匙开门）返回 null。
   * 走进钥匙格自动拾取；走进关闭的门且持有对应钥匙时开门并消耗钥匙。
   */
  apply(from: State, action: Action): State | null {
    const L = this.level;
    const [dx, dy] = DELTA[action];
    const x = (from.pos % L.width) + dx;
    const y = Math.floor(from.pos / L.width) + dy;
    if (x < 0 || y < 0 || x >= L.width || y >= L.height) return null;
    const next = y * L.width + x;
    if (L.walls[next]) return null;

    let { collected, doorsOpen } = from;
    const doorId = L.doorAt.get(next);
    if (doorId !== undefined && !(doorsOpen & (1 << doorId))) {
      if (!(keysHeld(from) & (1 << doorId))) return null; // 没有对应钥匙
      doorsOpen |= 1 << doorId; // 开门，消耗钥匙（keysHeld 随之减少）
    }
    const keyId = L.keyAt.get(next);
    if (keyId !== undefined) collected |= 1 << keyId;

    const s: State = {
      version: this.versions.length,
      parent: from.version,
      action,
      pos: next,
      collected,
      doorsOpen,
    };
    this.versions.push(s);
    return s;
  }

  /** 撤销一步：返回父版本。门随之恢复关闭，已消耗的钥匙自动返还。 */
  undo(s: State): State | null {
    return s.parent < 0 ? null : this.get(s.parent);
  }

  /** 从任意历史版本分叉（版本不可变，直接取用即可继续 apply） */
  fork(version: number): State {
    return this.get(version);
  }

  /** 从 stopAt 版本（不含，默认根）到 s 的动作序列 */
  pathTo(s: State, stopAt = -1): Action[] {
    const out: Action[] = [];
    let cur: State = s;
    while (cur.parent >= 0 && cur.version !== stopAt) {
      out.push(cur.action!);
      cur = this.get(cur.parent);
    }
    return out.reverse();
  }
}

/** 全状态去重键：位置 + 已拾取钥匙 + 已开门 */
export function stateKey(s: Pick<State, "pos" | "collected" | "doorsOpen">): string {
  return `${s.pos}|${s.collected}|${s.doorsOpen}`;
}
