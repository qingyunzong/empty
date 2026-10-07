/**
 * exact-pivot: 多层行列键透视库。
 *
 * - 精确整数：所有金额以 BigInt 累加，超出 Number.MAX_SAFE_INTEGER 也不失真。
 * - NULL 独立分类：键段为 null 时是独立的“NULL 类别”，与字符串 "null" 等互不相同。
 * - 小计不重复计算：每个节点的 subtotal 由叶单元格自底向上恰好累加一次。
 * - 更正带事件 ID：同一 eventId 重复提交会被去重（幂等），correctionOf 串起更正链。
 * - 核对：reconcile() 用事件日志独立做全表分组，与透视树逐格比对，
 *   并专门报告空组（净额为 0 的组）与跨组迁移（更正链触及多个组）。
 */

export type Key = string | null;

export interface PivotEvent {
  eventId: string;
  rowPath: Key[];
  colPath: Key[];
  delta: bigint | number | string;
  /** 若本事件是对之前事件的更正，填被更正事件的 eventId。 */
  correctionOf?: string;
}

interface StoredEvent {
  eventId: string;
  rowPath: Key[];
  colPath: Key[];
  delta: bigint;
  correctionOf?: string;
}

export interface PivotNode {
  kind: 'root' | 'category';
  /** 类别键；null 表示 NULL 类别（root 节点上无意义）。 */
  key: Key;
  /** 从根到本节点的完整路径。 */
  path: Key[];
  /** 路径恰好等于本节点路径的叶单元格之和（不含后代）。 */
  direct: bigint;
  /** 本节点全部后代叶单元格之和（含 direct），每片叶恰好计入一次。 */
  subtotal: bigint;
  leaf: boolean;
  children: PivotNode[];
}

export interface PivotCell {
  rowPath: Key[];
  colPath: Key[];
  value: bigint;
}

export interface PivotOutput {
  rows: PivotNode;
  columns: PivotNode;
  /** 叶级单元格（净额为 0 的空组不出现）。 */
  cells: PivotCell[];
  grandTotal: bigint;
}

export interface GroupRef {
  rowPath: Key[];
  colPath: Key[];
}

export interface CellMismatch extends GroupRef {
  tree: bigint;
  grouped: bigint;
}

export interface Migration {
  /** 更正链根事件 ID。 */
  chainId: string;
  /** 链上每个组（行路径 × 列路径）的净变动。 */
  groups: (GroupRef & { net: bigint })[];
  /** 全链净额（跨组迁移守恒时应等于留在链内的金额变化）。 */
  total: bigint;
}

export interface ReconcileReport {
  ok: boolean;
  grandTotal: { tree: bigint; eventSum: bigint; grouped: bigint };
  cellCounts: { tree: number; grouped: number };
  /** 透视树与独立全表分组不一致的单元格。 */
  mismatches: CellMismatch[];
  /** 有事件但净额为 0 的组；已验证其不出现在树中。 */
  emptyGroups: GroupRef[];
  /** 触及多个组的更正链（跨组迁移）。 */
  migrations: Migration[];
}

const PATH_SEP = '\u001f';
const CELL_SEP = '\u001e';

function encodeKey(key: Key): string {
  return key === null ? '["n"]' : JSON.stringify(['s', key]);
}

function encodePath(path: readonly Key[]): string {
  return path.map(encodeKey).join(PATH_SEP);
}

function cellKeyOf(rowPath: readonly Key[], colPath: readonly Key[]): string {
  return encodePath(rowPath) + CELL_SEP + encodePath(colPath);
}

function compareKeys(a: Key, b: Key): number {
  if (a === null) return b === null ? 0 : -1; // NULL 类别排在最前
  if (b === null) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePaths(a: readonly Key[], b: readonly Key[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = compareKeys(a[i] as Key, b[i] as Key);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

function toBigInt(value: bigint | number | string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new TypeError(`delta 必须是整数，收到 number: ${value}`);
    }
    return BigInt(value);
  }
  if (typeof value === 'string') {
    try {
      return BigInt(value);
    } catch {
      throw new TypeError(`delta 必须是整数字符串，收到: ${value}`);
    }
  }
  throw new TypeError(`delta 类型不支持: ${typeof value}`);
}

function assertPath(path: Key[], name: string): void {
  if (!Array.isArray(path)) throw new TypeError(`${name} 必须是数组`);
  for (const k of path) {
    if (k !== null && typeof k !== 'string') {
      throw new TypeError(`${name} 的键段只能是 string 或 null，收到: ${String(k)}`);
    }
  }
}

function makeRoot(): PivotNode {
  return { kind: 'root', key: null, path: [], direct: 0n, subtotal: 0n, leaf: true, children: [] };
}

/** 由 (路径, 值) 列表构建轴树；每个值沿路径向上恰好传播一次。 */
function buildAxis(entries: { path: Key[]; value: bigint }[]): PivotNode {
  const root = makeRoot();
  const byPath = new Map<string, PivotNode>([['', root]]);
  for (const { path, value } of entries) {
    for (let depth = 1; depth <= path.length; depth++) {
      const enc = encodePath(path.slice(0, depth));
      if (!byPath.has(enc)) {
        const parent = byPath.get(encodePath(path.slice(0, depth - 1)));
        if (!parent) throw new Error('内部错误：父节点缺失');
        const node: PivotNode = {
          kind: 'category',
          key: path[depth - 1] as Key,
          path: path.slice(0, depth),
          direct: 0n,
          subtotal: 0n,
          leaf: true,
          children: [],
        };
        parent.children.push(node);
        parent.leaf = false;
        byPath.set(enc, node);
      }
    }
    for (let depth = 0; depth <= path.length; depth++) {
      const node = byPath.get(encodePath(path.slice(0, depth)));
      if (!node) throw new Error('内部错误：节点缺失');
      node.subtotal += value;
    }
    const self = byPath.get(encodePath(path));
    if (!self) throw new Error('内部错误：节点缺失');
    self.direct += value;
  }
  const sortRec = (node: PivotNode): void => {
    node.children.sort((a, b) => compareKeys(a.key, b.key));
    node.children.forEach(sortRec);
  };
  sortRec(root);
  return root;
}

export class PivotTable {
  private readonly events = new Map<string, StoredEvent>();
  private readonly cells = new Map<string, bigint>();
  private readonly cellPaths = new Map<string, GroupRef>();

  /** 应用一条事件；同一 eventId 重复提交返回 'duplicate' 且不影响结果。 */
  apply(event: PivotEvent): 'applied' | 'duplicate' {
    if (typeof event.eventId !== 'string' || event.eventId.length === 0) {
      throw new TypeError('eventId 必须是非空字符串');
    }
    if (this.events.has(event.eventId)) return 'duplicate';
    assertPath(event.rowPath, 'rowPath');
    assertPath(event.colPath, 'colPath');
    const stored: StoredEvent = {
      eventId: event.eventId,
      rowPath: [...event.rowPath],
      colPath: [...event.colPath],
      delta: toBigInt(event.delta),
    };
    if (event.correctionOf !== undefined) stored.correctionOf = event.correctionOf;
    this.events.set(stored.eventId, stored);
    const key = cellKeyOf(stored.rowPath, stored.colPath);
    this.cells.set(key, (this.cells.get(key) ?? 0n) + stored.delta);
    if (!this.cellPaths.has(key)) {
      this.cellPaths.set(key, { rowPath: stored.rowPath, colPath: stored.colPath });
    }
    return 'applied';
  }

  /** 构建树状行、树状列、叶单元格与总计。净额为 0 的空组不进入树。 */
  build(): PivotOutput {
    const cells: PivotCell[] = [];
    for (const [key, value] of this.cells) {
      if (value === 0n) continue;
      const paths = this.cellPaths.get(key);
      if (!paths) throw new Error('内部错误：单元格路径缺失');
      cells.push({ rowPath: [...paths.rowPath], colPath: [...paths.colPath], value });
    }
    cells.sort(
      (a, b) => comparePaths(a.rowPath, b.rowPath) || comparePaths(a.colPath, b.colPath),
    );
    const rows = buildAxis(cells.map((c) => ({ path: c.rowPath, value: c.value })));
    const columns = buildAxis(cells.map((c) => ({ path: c.colPath, value: c.value })));
    return { rows, columns, cells, grandTotal: rows.subtotal };
  }

  /**
   * 与全表分组核对：从事件日志独立重算分组，与透视树逐格比对；
   * 核对空组（净额 0，不得出现在树中）与跨组迁移（更正链触及多个组）。
   */
  reconcile(): ReconcileReport {
    // 独立全表分组：只依赖事件日志，不经过 this.cells。
    const grouped = new Map<string, bigint>();
    const groupedPaths = new Map<string, GroupRef>();
    let eventSum = 0n;
    for (const e of this.events.values()) {
      const key = cellKeyOf(e.rowPath, e.colPath);
      grouped.set(key, (grouped.get(key) ?? 0n) + e.delta);
      if (!groupedPaths.has(key)) groupedPaths.set(key, { rowPath: e.rowPath, colPath: e.colPath });
      eventSum += e.delta;
    }

    const output = this.build();
    const treeCells = new Map<string, bigint>();
    for (const c of output.cells) treeCells.set(cellKeyOf(c.rowPath, c.colPath), c.value);

    const mismatches: CellMismatch[] = [];
    const emptyGroups: GroupRef[] = [];
    let groupedSum = 0n;
    let groupedNonZero = 0;
    for (const [key, value] of grouped) {
      const paths = groupedPaths.get(key);
      if (!paths) throw new Error('内部错误：分组路径缺失');
      groupedSum += value;
      if (value === 0n) {
        // 空组：必须不出现在树中。
        if (treeCells.has(key)) {
          mismatches.push({ ...paths, tree: treeCells.get(key) as bigint, grouped: 0n });
        } else {
          emptyGroups.push({ rowPath: [...paths.rowPath], colPath: [...paths.colPath] });
        }
        continue;
      }
      groupedNonZero++;
      const treeValue = treeCells.get(key);
      if (treeValue === undefined || treeValue !== value) {
        mismatches.push({ ...paths, tree: treeValue ?? 0n, grouped: value });
      }
    }
    for (const [key, value] of treeCells) {
      if (!grouped.has(key)) {
        const paths = this.cellPaths.get(key);
        if (!paths) throw new Error('内部错误：单元格路径缺失');
        mismatches.push({ rowPath: [...paths.rowPath], colPath: [...paths.colPath], tree: value, grouped: 0n });
      }
    }

    // 跨组迁移：按更正链（correctionOf 链根）聚类，触及多个组即为迁移。
    const chains = new Map<string, StoredEvent[]>();
    for (const e of this.events.values()) {
      const root = e.correctionOf ?? e.eventId;
      const list = chains.get(root);
      if (list) list.push(e);
      else chains.set(root, [e]);
    }
    const migrations: Migration[] = [];
    for (const [chainId, chainEvents] of chains) {
      const perGroup = new Map<string, { ref: GroupRef; net: bigint }>();
      let total = 0n;
      for (const e of chainEvents) {
        const key = cellKeyOf(e.rowPath, e.colPath);
        const slot = perGroup.get(key);
        if (slot) slot.net += e.delta;
        else perGroup.set(key, { ref: { rowPath: e.rowPath, colPath: e.colPath }, net: e.delta });
        total += e.delta;
      }
      if (perGroup.size > 1) {
        migrations.push({
          chainId,
          groups: [...perGroup.values()].map((g) => ({ ...g.ref, net: g.net })),
          total,
        });
      }
    }
    migrations.sort((a, b) => (a.chainId < b.chainId ? -1 : 1));

    const ok =
      mismatches.length === 0 &&
      output.grandTotal === eventSum &&
      eventSum === groupedSum &&
      output.cells.length === groupedNonZero;

    return {
      ok,
      grandTotal: { tree: output.grandTotal, eventSum, grouped: groupedSum },
      cellCounts: { tree: output.cells.length, grouped: groupedNonZero },
      mismatches,
      emptyGroups,
      migrations,
    };
  }
}

function formatPath(path: readonly Key[]): string {
  if (path.length === 0) return '(根)';
  return path.map((k) => (k === null ? 'NULL' : JSON.stringify(k))).join(' / ');
}

/** 把透视输出渲染为树状文本（行树、列树、单元格、总计）。 */
export function renderPivot(output: PivotOutput): string {
  const lines: string[] = [];
  const walk = (node: PivotNode, indent: string): void => {
    const label =
      node.kind === 'root' ? '(根)' : node.key === null ? 'NULL' : JSON.stringify(node.key);
    lines.push(`${indent}${label} = ${node.subtotal}`);
    for (const child of node.children) walk(child, indent + '  ');
  };
  lines.push('行树:');
  walk(output.rows, '  ');
  lines.push('列树:');
  walk(output.columns, '  ');
  lines.push('单元格:');
  for (const c of output.cells) {
    lines.push(`  ${formatPath(c.rowPath)} × ${formatPath(c.colPath)} = ${c.value}`);
  }
  lines.push(`总计: ${output.grandTotal}`);
  return lines.join('\n');
}
