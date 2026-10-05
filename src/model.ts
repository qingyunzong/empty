/** 字幕条目：半开显示区间 [start, end)，priority 为显示收益。 */
export interface SubtitleItem {
  id: string;
  start: number;
  end: number;
  priority: number;
}

/** 层分配证书。 */
export interface Certificate {
  k: number;
  profit: number;
  /** 选中条目 ID，按 ID 字典序升序。 */
  selected: string[];
  /** 每层分配的条目 ID（按开始时间升序）。 */
  layers: string[][];
}

/** 半开区间重叠判定：端点相接不算重叠。 */
export function overlaps(a: SubtitleItem, b: SubtitleItem): boolean {
  return a.start < b.end && b.start < a.end;
}

export function validateItems(items: SubtitleItem[], k: number): void {
  if (!Number.isInteger(k) || k < 1) {
    throw new Error(`k 必须为 >= 1 的整数，收到: ${k}`);
  }
  if (items.length > 20) {
    throw new Error(`条目数至多为 20，收到: ${items.length}`);
  }
  const seen = new Set<string>();
  for (const it of items) {
    if (typeof it.id !== "string" || it.id.length === 0) {
      throw new Error(`非法 id: ${JSON.stringify(it)}`);
    }
    if (seen.has(it.id)) {
      throw new Error(`id 重复: ${it.id}`);
    }
    seen.add(it.id);
    for (const key of ["start", "end", "priority"] as const) {
      if (!Number.isFinite(it[key])) {
        throw new Error(`条目 ${it.id} 的 ${key} 非有限数: ${it[key]}`);
      }
    }
    if (!(it.start < it.end)) {
      throw new Error(`条目 ${it.id} 时码非法（需 start < end）: [${it.start}, ${it.end})`);
    }
  }
}

/** 校验证书：选中集合与分层合法、同层不重叠、收益一致。 */
export function verifyCertificate(
  items: SubtitleItem[],
  k: number,
  cert: Certificate,
): void {
  const byId = new Map(items.map((it) => [it.id, it]));
  const assigned: string[] = [];
  if (cert.layers.length > k) {
    throw new Error(`证书层数 ${cert.layers.length} 超过 k=${k}`);
  }
  for (const layer of cert.layers) {
    let prevEnd = -Infinity;
    let prevId = "";
    for (const id of layer) {
      const it = byId.get(id);
      if (!it) throw new Error(`证书含未知条目: ${id}`);
      if (it.start < prevEnd) {
        throw new Error(`同层重叠: ${prevId} 与 ${id}`);
      }
      prevEnd = it.end;
      prevId = id;
      assigned.push(id);
    }
  }
  const sortedAssigned = [...assigned].sort();
  const sortedSelected = [...cert.selected].sort();
  if (JSON.stringify(sortedAssigned) !== JSON.stringify(sortedSelected)) {
    throw new Error("证书分层与选中集合不一致");
  }
  const profit = assigned.reduce((sum, id) => sum + (byId.get(id)?.priority ?? 0), 0);
  if (profit !== cert.profit) {
    throw new Error(`证书收益不符: 声明 ${cert.profit}，实算 ${profit}`);
  }
}
