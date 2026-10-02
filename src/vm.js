// 字节码 VM：在 96 个 15 分钟离散槽上计算负荷/费用/碳排/峰值
// 带结果缓存；缓存支持保存点快照与回滚（回滚后缓存不污染后续结果）
import { OPS } from './compiler.js';
import { SLOTS_PER_DAY } from './types.js';

export class VM {
  constructor(slotCount = SLOTS_PER_DAY) {
    this.slotCount = slotCount;
    this.cache = new Map();
    this.keyOrder = [];
  }

  snapshot() {
    return this.keyOrder.length;
  }

  rollbackTo(marker) {
    while (this.keyOrder.length > marker) {
      const key = this.keyOrder.pop();
      this.cache.delete(key);
    }
  }

  run(program, cacheKey = null) {
    if (cacheKey !== null && this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }
    const load = new Float64Array(this.slotCount);
    let cost = 0;
    let carbon = 0;
    let peak = 0;
    let ok = true;
    const violations = [];
    let pc = 0;
    for (;;) {
      const ins = program[pc];
      if (!ins) throw new Error(`VM: pc 越界 (${pc})`);
      switch (ins.op) {
        case OPS.ADD:
          for (const s of ins.slots) {
            if (s < 0 || s >= this.slotCount) {
              ok = false;
              violations.push(`槽位 ${s} 越界`);
            } else {
              load[s] += ins.power;
            }
          }
          break;
        case OPS.ZERO:
          for (const s of ins.slots) {
            if (load[s] !== 0) {
              ok = false;
              violations.push(`维护槽 ${s} 负荷为 ${load[s]}`);
            }
          }
          break;
        case OPS.CAP:
          for (let s = 0; s < this.slotCount; s += 1) {
            if (load[s] > ins.cap + 1e-9) {
              ok = false;
              violations.push(`槽 ${s} 负荷 ${load[s]} 超过容量 ${ins.cap}`);
            }
          }
          break;
        case OPS.COST:
          for (let s = 0; s < this.slotCount; s += 1) cost += load[s] * ins.table[s] * 0.25;
          break;
        case OPS.CARBON:
          for (let s = 0; s < this.slotCount; s += 1) carbon += load[s] * ins.table[s] * 0.25;
          break;
        case OPS.PEAK:
          for (let s = 0; s < this.slotCount; s += 1) if (load[s] > peak) peak = load[s];
          break;
        case OPS.HALT: {
          const result = { ok, violations, load: Array.from(load), cost, carbon, peak };
          if (cacheKey !== null) {
            this.cache.set(cacheKey, result);
            this.keyOrder.push(cacheKey);
          }
          return result;
        }
        default:
          throw new Error(`VM: 未知指令 ${ins.op}`);
      }
      pc += 1;
    }
  }
}
