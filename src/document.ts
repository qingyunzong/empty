import { OpId, LamportClock, compareOpIds, formatOpId } from "./ids.js";

export interface InsertOp {
  kind: "insert";
  id: OpId;
  parent: OpId | null;
  char: string;
}

export interface DeleteOp {
  kind: "delete";
  id: OpId;
  target: OpId;
}

export type Op = InsertOp | DeleteOp;

export interface CharEntry {
  id: OpId;
  char: string;
  deleted: boolean;
}

interface CharNode extends CharEntry {
  children: OpId[];
}

function insertSorted(ids: OpId[], id: OpId): void {
  let lo = 0;
  let hi = ids.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compareOpIds(ids[mid], id) < 0) lo = mid + 1;
    else hi = mid;
  }
  ids.splice(lo, 0, id);
}

export function mergeOps(...logs: Op[][]): Op[] {
  const byId = new Map<string, Op>();
  for (const log of logs) {
    for (const op of log) byId.set(formatOpId(op.id), op);
  }
  return [...byId.values()].sort((a, b) => compareOpIds(a.id, b.id));
}

export class Document {
  readonly site: string;
  private clock: LamportClock;
  private nodes = new Map<string, CharNode>();
  private rootChildren: OpId[] = [];

  constructor(site: string) {
    this.site = site;
    this.clock = new LamportClock(site);
  }

  static replay(site: string, ops: Op[]): Document {
    const doc = new Document(site);
    for (const op of mergeOps(ops)) doc.apply(op);
    return doc;
  }

  apply(op: Op): void {
    this.clock.seen(op.id);
    if (op.kind === "insert") {
      const key = formatOpId(op.id);
      if (this.nodes.has(key)) return;
      this.nodes.set(key, {
        id: op.id,
        char: op.char,
        deleted: false,
        children: [],
      });
      if (op.parent === null) {
        insertSorted(this.rootChildren, op.id);
      } else {
        const parentNode = this.nodes.get(formatOpId(op.parent));
        if (!parentNode) {
          throw new Error(`missing parent ${formatOpId(op.parent)}`);
        }
        insertSorted(parentNode.children, op.id);
      }
    } else {
      const node = this.nodes.get(formatOpId(op.target));
      if (node) node.deleted = true;
    }
  }

  insert(parent: OpId | null, char: string): InsertOp {
    if ([...char].length !== 1) {
      throw new Error("insert expects a single character");
    }
    const op: InsertOp = { kind: "insert", id: this.clock.next(), parent, char };
    this.apply(op);
    return op;
  }

  delete(target: OpId): DeleteOp {
    const op: DeleteOp = { kind: "delete", id: this.clock.next(), target };
    this.apply(op);
    return op;
  }

  has(id: OpId): boolean {
    return this.nodes.has(formatOpId(id));
  }

  isDeleted(id: OpId): boolean {
    const node = this.nodes.get(formatOpId(id));
    return node === undefined ? false : node.deleted;
  }

  entries(): CharEntry[] {
    const out: CharEntry[] = [];
    const walk = (ids: OpId[]): void => {
      for (const id of ids) {
        const node = this.nodes.get(formatOpId(id));
        if (!node) continue;
        out.push({ id: node.id, char: node.char, deleted: node.deleted });
        walk(node.children);
      }
    };
    walk(this.rootChildren);
    return out;
  }

  visibleEntries(): CharEntry[] {
    return this.entries().filter((entry) => !entry.deleted);
  }

  text(): string {
    return this.visibleEntries().map((entry) => entry.char).join("");
  }

  idAtOffset(offset: number): OpId | null {
    const visible = this.visibleEntries();
    if (offset < 0 || offset >= visible.length) return null;
    return visible[offset].id;
  }
}
