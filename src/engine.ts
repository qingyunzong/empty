import { compareAddrStr, formatAddr, normAddr } from './address.js';
import { Ast, evaluate, parse } from './formula.js';
import { Value, errVal, intVal } from './value.js';

interface Cell {
  formula: string;
  ast: Ast | null;
  parseError: boolean;
  value: Value;
  deps: Set<string>;
  /** 最近一次完成求值的时钟值；-1 表示脏（需要重算）。 */
  clean: number;
}

/**
 * 增量电子表格引擎。
 *
 * - 单元格引用构成 DAG（动态意义下允许暂时成环，求值时检测并报 #CYCLE!）。
 * - IF 为动态条件：只依赖被选中分支。
 * - setFormula 后沿反向依赖边做失效标记，只重算受影响单元格；
 *   重算按地址序进行，求值过程中按需递归并更新依赖边。
 */
export class Engine {
  private cells = new Map<string, Cell>();
  private rdeps = new Map<string, Set<string>>();
  private clock = 0;
  private stack: string[] = [];

  private ensure(key: string): Cell {
    let c = this.cells.get(key);
    if (!c) {
      c = { formula: '', ast: null, parseError: false, value: intVal(0), deps: new Set(), clean: -1 };
      this.cells.set(key, c);
    }
    return c;
  }

  /** 设置/清除公式（空字符串表示清除）。公式相同则为 no-op。 */
  setFormula(addrText: string, formula: string): void {
    const key = normAddr(addrText);
    const text = formula.trim();
    const cell = this.ensure(key);
    if (cell.formula === text) return;

    this.clock++;
    cell.formula = text;
    if (text === '') {
      cell.ast = null;
      cell.parseError = false;
    } else {
      try {
        cell.ast = parse(text);
        cell.parseError = false;
      } catch {
        cell.ast = null;
        cell.parseError = true;
      }
    }

    // 失效：从被修改单元格沿反向依赖边可达的全部单元格。
    const affected: string[] = [];
    const seen = new Set<string>([key]);
    const queue = [key];
    while (queue.length > 0) {
      const cur = queue.pop() as string;
      affected.push(cur);
      const c = this.cells.get(cur);
      if (c) c.clean = -1;
      const outs = this.rdeps.get(cur);
      if (outs) {
        for (const d of outs) {
          if (!seen.has(d)) { seen.add(d); queue.push(d); }
        }
      }
    }

    // 按地址序重算；compute 内部按需递归，未受影响的单元格直接命中缓存。
    affected.sort(compareAddrStr);
    for (const a of affected) this.compute(a);
  }

  private compute(key: string): Value {
    const cell = this.ensure(key);
    if (cell.clean !== -1) return cell.value;

    const at = this.stack.indexOf(key);
    if (at >= 0) {
      // 环：来源取环上最小地址，保证与求值入口无关的确定性。
      let min = key;
      for (let i = at; i < this.stack.length; i++) {
        if (compareAddrStr(this.stack[i], min) < 0) min = this.stack[i];
      }
      return errVal('#CYCLE!', min);
    }

    this.stack.push(key);
    let value: Value;
    const newDeps = new Set<string>();
    if (cell.parseError) {
      value = errVal('#ERROR!', key);
    } else if (cell.ast === null) {
      value = intVal(0);
    } else {
      value = evaluate(cell.ast, key, (addr) => {
        const depKey = formatAddr(addr);
        newDeps.add(depKey);
        return this.compute(depKey);
      });
    }
    this.stack.pop();

    cell.value = value;
    cell.clean = this.clock;

    for (const d of cell.deps) {
      if (!newDeps.has(d)) {
        const s = this.rdeps.get(d);
        if (s) {
          s.delete(key);
          if (s.size === 0) this.rdeps.delete(d);
        }
      }
    }
    for (const d of newDeps) {
      if (!cell.deps.has(d)) {
        let s = this.rdeps.get(d);
        if (!s) { s = new Set(); this.rdeps.set(d, s); }
        s.add(key);
      }
    }
    cell.deps = newDeps;
    return value;
  }

  getValue(addrText: string): Value {
    const key = normAddr(addrText);
    const cell = this.ensure(key);
    if (cell.clean === -1) this.compute(key);
    return cell.value;
  }

  /** 当前（动态）依赖，按地址序返回。 */
  getDeps(addrText: string): string[] {
    const key = normAddr(addrText);
    const cell = this.cells.get(key);
    if (!cell) return [];
    return [...cell.deps].sort(compareAddrStr);
  }

  /** 当前有公式或被引用过的全部地址。 */
  addresses(): string[] {
    return [...this.cells.keys()].sort(compareAddrStr);
  }
}
