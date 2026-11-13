import {
  type DeclassifyRule,
  type Label,
  type TransformKind,
  levelRank,
  mergeDuplicate,
  resolveConflicts,
} from "./label.ts";
import { EvidenceGraph } from "./evidence.ts";

export interface FieldSet {
  name: string;
  labels: Label[];
}

export interface PropagatorOptions {
  /** hash 后无显式降敏规则时的默认置信度系数，默认 0.8。 */
  hashConfidenceFactor?: number;
  /** aggregate 时 record 级标签无显式规则的默认动作，默认 "drop"。 */
  defaultAggregateAction?: "drop" | "keep";
}

interface DroppedRecord {
  labelId: string;
  reason: string;
}

/**
 * 标签传播器。每种变换有独立的传播语义（不是简单取并集）：
 * - concat：并列保留全部输入标签，同 id 用 noisy-or 合并置信度；
 * - hash：单向伪名化，置信度衰减，并应用 declassify 规则；
 * - tokenize：可逆置换，标签与置信度原样传播；
 * - aggregate：record 级标签默认丢弃，cohort/dataset 级保留，置信度取最弱链路。
 * 每次变换后按偏序做冲突消解，保留多个极大元素；全过程记录证据图。
 */
export class Propagator {
  readonly evidence = new EvidenceGraph();
  private txCounter = 0;
  private readonly hashConfidenceFactor: number;
  private readonly defaultAggregateAction: "drop" | "keep";
  /** fieldName#labelId -> 证据图节点 id */
  private readonly labelNodes = new Map<string, string>();
  private readonly knownFields = new WeakSet<FieldSet>();

  constructor(options: PropagatorOptions = {}) {
    this.hashConfidenceFactor = options.hashConfidenceFactor ?? 0.8;
    this.defaultAggregateAction = options.defaultAggregateAction ?? "drop";
  }

  /** 为外部输入字段登记来源源证据节点；对传播产生的字段是幂等 no-op。 */
  register(field: FieldSet): FieldSet {
    this.ensureInputNodes(field);
    return field;
  }

  concat(name: string, inputs: FieldSet[]): FieldSet {
    return this.apply("concat", name, inputs, (candidates) => {
      // 同 id 多源佐证：noisy-or 合并置信度 1 - Π(1 - c)。
      const byId = new Map<string, Label[]>();
      for (const c of candidates) {
        const list = byId.get(c.label.id) ?? [];
        list.push(c.label);
        byId.set(c.label.id, list);
      }
      const kept: Label[] = [];
      for (const group of byId.values()) {
        const confidence = 1 - group.reduce((acc, l) => acc * (1 - l.confidence), 1);
        const merged = group.reduce(mergeDuplicate);
        kept.push({ ...merged, confidence, source: { kind: "lineage", transform: "concat" } });
      }
      return { kept, dropped: [] };
    });
  }

  hash(name: string, input: FieldSet): FieldSet {
    return this.apply("hash", name, [input], (candidates) => {
      const kept: Label[] = [];
      const dropped: DroppedRecord[] = [];
      for (const { label } of candidates) {
        const rule = label.declassify.find((r) => r.transform === "hash");
        const result = this.applyRule(label, rule, this.hashConfidenceFactor);
        if (result) kept.push(result);
        else dropped.push({ labelId: label.id, reason: "declassify rule: drop on hash" });
      }
      return { kept, dropped };
    });
  }

  tokenize(name: string, input: FieldSet): FieldSet {
    return this.apply("tokenize", name, [input], (candidates) => {
      // 可逆 tokenization 不改变语义内容，标签原样传播。
      return {
        kept: candidates.map(({ label }) => ({
          ...label,
          source: { kind: "lineage", transform: "tokenize" },
        })),
        dropped: [],
      };
    });
  }

  aggregate(name: string, inputs: FieldSet[]): FieldSet {
    return this.apply("aggregate", name, inputs, (candidates) => {
      const byId = new Map<string, Label[]>();
      for (const c of candidates) {
        const list = byId.get(c.label.id) ?? [];
        list.push(c.label);
        byId.set(c.label.id, list);
      }
      const kept: Label[] = [];
      const dropped: DroppedRecord[] = [];
      for (const group of byId.values()) {
        const head = group[0];
        const rule = head.declassify.find((r) => r.transform === "aggregate");
        if (!rule && head.scope === "record" && this.defaultAggregateAction === "drop") {
          dropped.push({ labelId: head.id, reason: "record-scope label does not survive aggregation" });
          continue;
        }
        if (rule?.action === "drop") {
          dropped.push({ labelId: head.id, reason: "declassify rule: drop on aggregate" });
          continue;
        }
        // 置信度取最弱链路：任一输入不成立则聚合结论不成立。
        const confidence = Math.min(...group.map((l) => l.confidence));
        const base = rule ? this.applyRule(head, rule, 1) : head;
        if (!base) continue;
        kept.push({
          ...base,
          confidence: confidence * (rule?.confidenceFactor ?? 1),
          source: { kind: "lineage", transform: "aggregate" },
        });
      }
      return { kept, dropped };
    });
  }

  /** 抽取某个输出字段上某个标签的推导证据子图。 */
  evidenceFor(fieldName: string, labelId: string): EvidenceGraph {
    const nodeId = this.labelNodes.get(`${fieldName}#${labelId}`);
    if (!nodeId) throw new Error(`no evidence for label ${labelId} on field ${fieldName}`);
    return this.evidence.subgraph(nodeId);
  }

  private applyRule(
    label: Label,
    rule: DeclassifyRule | undefined,
    defaultFactor: number,
  ): Label | null {
    if (!rule) {
      return { ...label, confidence: label.confidence * defaultFactor };
    }
    switch (rule.action) {
      case "drop":
        return null;
      case "keep":
        return { ...label, confidence: label.confidence * (rule.confidenceFactor ?? 1) };
      case "downgrade": {
        const toLevel = rule.toLevel ?? label.level;
        if (levelRank(toLevel) > levelRank(label.level)) {
          throw new Error(`declassify rule for ${label.id} upgrades level to ${toLevel}`);
        }
        return {
          ...label,
          level: toLevel,
          confidence: label.confidence * (rule.confidenceFactor ?? 1),
        };
      }
    }
  }

  private ensureInputNodes(field: FieldSet): void {
    if (this.knownFields.has(field)) return;
    this.knownFields.add(field);
    for (const label of field.labels) {
      const nodeId = this.evidence.addNode("source", `${field.name}:${label.id}`, {
        field: field.name,
        labelId: label.id,
        level: label.level,
        confidence: label.confidence,
        source: label.source,
      });
      this.labelNodes.set(`${field.name}#${label.id}`, nodeId);
    }
  }

  private apply(
    kind: TransformKind,
    name: string,
    inputs: FieldSet[],
    propagate: (
      candidates: { label: Label; inputNode: string }[],
    ) => { kept: Label[]; dropped: DroppedRecord[] },
  ): FieldSet {
    for (const input of inputs) this.ensureInputNodes(input);

    const candidates = inputs.flatMap((input) =>
      input.labels.map((label) => ({
        label,
        inputNode: this.labelNodes.get(`${input.name}#${label.id}`)!,
      })),
    );

    const { kept, dropped } = propagate(candidates);
    const resolved = resolveConflicts(kept);

    const txNode = this.evidence.addNode("transform", `${kind}#${++this.txCounter}`, {
      kind,
      output: name,
      inputs: inputs.map((f) => f.name),
    });

    const out: FieldSet = { name, labels: resolved };
    this.knownFields.add(out);
    for (const label of resolved) {
      const nodeId = this.evidence.addNode("label", `${name}:${label.id}`, {
        field: name,
        labelId: label.id,
        level: label.level,
        confidence: label.confidence,
      });
      this.evidence.addEdge(txNode, nodeId, "produces");
      // 精确的逐标签推导边：只连接真正贡献了该输出标签的输入标签节点。
      for (const c of candidates) {
        if (c.label.id === label.id) this.evidence.addEdge(c.inputNode, nodeId, "derives");
      }
      this.labelNodes.set(`${name}#${label.id}`, nodeId);
    }
    for (const d of dropped) {
      const dropNode = this.evidence.addNode("drop", `drop:${d.labelId}`, { reason: d.reason });
      this.evidence.addEdge(txNode, dropNode, "dropped-by");
      for (const c of candidates) {
        if (c.label.id === d.labelId) this.evidence.addEdge(c.inputNode, dropNode, "drops");
      }
    }
    return out;
  }
}
