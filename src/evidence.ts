export type EvidenceNodeKind = "source" | "transform" | "label" | "drop";

export interface EvidenceNode {
  id: string;
  kind: EvidenceNodeKind;
  /** 节点摘要，例如标签 id 或变换名。 */
  title: string;
  attrs: Record<string, unknown>;
}

export interface EvidenceEdge {
  from: string;
  to: string;
  /** 例如 "feeds" | "produces" | "downgraded-by" | "dropped-by"。 */
  relation: string;
}

/** 有向无环的推导证据图：source 标签节点 → 变换节点 → 输出标签节点。 */
export class EvidenceGraph {
  readonly nodes = new Map<string, EvidenceNode>();
  readonly edges: EvidenceEdge[] = [];

  addNode(kind: EvidenceNodeKind, title: string, attrs: Record<string, unknown> = {}): string {
    const id = `n${this.nodes.size}`;
    this.nodes.set(id, { id, kind, title, attrs });
    return id;
  }

  addEdge(from: string, to: string, relation: string): void {
    if (!this.nodes.has(from)) throw new Error(`unknown node ${from}`);
    if (!this.nodes.has(to)) throw new Error(`unknown node ${to}`);
    this.edges.push({ from, to, relation });
  }

  /** 沿边反向遍历，返回 root 的全部祖先（含 root）。 */
  ancestors(root: string): Set<string> {
    const incoming = new Map<string, EvidenceEdge[]>();
    for (const e of this.edges) {
      const list = incoming.get(e.to) ?? [];
      list.push(e);
      incoming.set(e.to, list);
    }
    const seen = new Set<string>([root]);
    const stack = [root];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const e of incoming.get(cur) ?? []) {
        if (!seen.has(e.from)) {
          seen.add(e.from);
          stack.push(e.from);
        }
      }
    }
    return seen;
  }

  /** 抽取以 root 为汇点的祖先子图，即某个输出标签的完整推导证据。 */
  subgraph(root: string): EvidenceGraph {
    if (!this.nodes.has(root)) throw new Error(`unknown node ${root}`);
    const keep = this.ancestors(root);
    const sub = new EvidenceGraph();
    const remap = new Map<string, string>();
    for (const id of keep) {
      const node = this.nodes.get(id)!;
      remap.set(id, sub.addNode(node.kind, node.title, { ...node.attrs }));
    }
    for (const e of this.edges) {
      if (keep.has(e.from) && keep.has(e.to)) {
        sub.addEdge(remap.get(e.from)!, remap.get(e.to)!, e.relation);
      }
    }
    return sub;
  }

  toDot(): string {
    const lines = ["digraph evidence {"];
    for (const node of this.nodes.values()) {
      const shape =
        node.kind === "transform" ? "box" : node.kind === "drop" ? "octagon" : "ellipse";
      lines.push(`  ${node.id} [label=${JSON.stringify(node.title)}, shape=${shape}];`);
    }
    for (const e of this.edges) {
      lines.push(`  ${e.from} -> ${e.to} [label=${JSON.stringify(e.relation)}];`);
    }
    lines.push("}");
    return lines.join("\n");
  }
}
