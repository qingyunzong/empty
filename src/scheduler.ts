export type ClassId = number;
export type NodeId = number;

export type ExprValue =
  | null
  | boolean
  | number
  | string
  | readonly ExprValue[]
  | { readonly [key: string]: ExprValue };

export interface Expr {
  readonly op: string;
  readonly args?: readonly Expr[];
  readonly value?: ExprValue;
}

export interface VarPattern {
  readonly kind: "var";
  readonly name: string;
}

export interface NodePattern {
  readonly kind?: "node";
  readonly op: string;
  readonly args?: readonly Pattern[];
  readonly value?: ExprValue;
}

export type Pattern = VarPattern | NodePattern;

export type Template = Expr | VarPattern | NodePattern;

export interface RuleMatch {
  readonly ruleId: string;
  readonly root: ClassId;
  readonly nodeKey: string;
  readonly node?: ENodeView;
  readonly variables: ReadonlyMap<string, ClassId>;
  get(name: string): ClassId;
}

export type RuleResult =
  | Template
  | readonly Template[]
  | null
  | undefined;

export interface RewriteRule {
  readonly id: string;
  readonly pattern: Pattern;
  readonly replacement?: Template | readonly Template[];
  readonly apply?: (match: RuleMatch) => RuleResult;
  readonly when?: (match: RuleMatch) => boolean;
}

export interface SchedulerOptions {
  readonly rules?: readonly RewriteRule[];
  readonly maxIterations?: number;
  readonly maxNodes?: number;
}

export type SchedulerStatus =
  | "idle"
  | "fixpoint"
  | "iteration-limit"
  | "node-limit";

export interface SchedulerStats {
  readonly status: SchedulerStatus;
  readonly iterations: number;
  readonly classesScanned: number;
  readonly matchesFound: number;
  readonly matchesApplied: number;
  readonly matchesSkipped: number;
  readonly matchesInvalidated: number;
  readonly rewrites: number;
  readonly nodesAdded: number;
  readonly classesCreated: number;
  readonly unions: number;
  readonly wakes: number;
}

export interface ENodeView {
  readonly id: NodeId;
  readonly key: string;
  readonly op: string;
  readonly args: readonly ClassId[];
  readonly hasValue: boolean;
  readonly value?: ExprValue;
}

export interface ClassSnapshot {
  readonly id: ClassId;
  readonly nodes: readonly ENodeView[];
}

export interface GraphSnapshot {
  readonly classes: readonly ClassSnapshot[];
  readonly roots: readonly ClassId[];
}

export interface SaturationComparison {
  readonly equal: boolean;
  readonly incremental: GraphSnapshot;
  readonly fullRescan: GraphSnapshot;
  readonly incrementalSignature: string;
  readonly fullRescanSignature: string;
  readonly incrementalStats: SchedulerStats;
  readonly fullRescanStats: SchedulerStats;
}

interface InternalNode {
  readonly id: NodeId;
  cls: ClassId;
  readonly op: string;
  args: ClassId[];
  readonly hasValue: boolean;
  readonly value?: ExprValue;
  readonly valueKey: string;
  key: string;
  alive: boolean;
}

interface ActiveMatch {
  readonly fingerprint: string;
  readonly dependencies: ReadonlySet<ClassId>;
}

interface MatchCandidate {
  readonly ruleId: string;
  readonly root: ClassId;
  readonly nodeKey: string;
  readonly node?: InternalNode;
  readonly variables: ReadonlyMap<string, ClassId>;
  readonly dependencies: ReadonlySet<ClassId>;
}

type MatchVisitor = (
  bindings: ReadonlyMap<string, ClassId>,
  dependencies: ReadonlySet<ClassId>,
) => void;

interface RunCounters {
  iterations: number;
  classesScanned: number;
  matchesFound: number;
  matchesApplied: number;
  matchesSkipped: number;
  matchesInvalidated: number;
  rewrites: number;
  nodesAdded: number;
  classesCreated: number;
  unions: number;
  wakes: number;
}

const ABSENT_VALUE = "\u0000absent";

export function variable(name: string): VarPattern {
  if (name.length === 0) {
    throw new Error("A pattern variable must have a name");
  }
  return { kind: "var", name };
}

export const v = variable;
export const varPattern = variable;
export const wildcard = variable;

export function expr(
  op: string,
  args: readonly Expr[] = [],
  value?: ExprValue,
): Expr {
  return value === undefined ? { op, args } : { op, args, value };
}

export function pattern(
  op: string,
  args: readonly Pattern[] = [],
  value?: ExprValue,
): NodePattern {
  return value === undefined ? { op, args } : { op, args, value };
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function stableValue(value: ExprValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Expression values must be finite numbers");
    }
    return Object.is(value, -0) ? "-0" : String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    const items = value as readonly ExprValue[];
    return `[${items.map(stableValue).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as { readonly [key: string]: ExprValue };
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableValue(record[key])}`)
      .join(",")}}`;
  }
  throw new Error(`Unsupported expression value: ${String(value)}`);
}

function valueKeyOf(value: unknown, hasValue: boolean): string {
  return hasValue ? stableValue(value as ExprValue) : ABSENT_VALUE;
}

function nodeKeyOf(
  op: string,
  valueKey: string,
  args: readonly ClassId[],
): string {
  return JSON.stringify([op, valueKey, args]);
}

function isVarPattern(value: Template | Pattern): value is VarPattern {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "var"
  );
}

function asTemplateList(result: RuleResult): readonly Template[] {
  if (result === null || result === undefined) return [];
  if (Array.isArray(result)) return result as readonly Template[];
  return [result as Template];
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export class RuleScheduler {
  private readonly rules = new Map<string, RewriteRule>();
  private readonly parent = new Map<ClassId, ClassId>();
  private readonly classSizes = new Map<ClassId, number>();
  private readonly classNodes = new Map<ClassId, Set<NodeId>>();
  private readonly nodes = new Map<NodeId, InternalNode>();
  private readonly hashcons = new Map<string, NodeId>();
  private readonly childUsers = new Map<ClassId, Set<NodeId>>();

  private readonly activeMatches = new Map<string, ActiveMatch>();
  private readonly dependencies = new Map<ClassId, Set<string>>();
  private readonly attempted = new Set<string>();

  private readonly worklist: ClassId[] = [];
  private readonly queued = new Set<ClassId>();
  private workHead = 0;
  private readonly dirtyNodes = new Set<NodeId>();

  private nextClassId = 0;
  private nextNodeId = 0;
  private aliveNodeCount = 0;
  private status: SchedulerStatus = "idle";
  private lastStats: SchedulerStats;
  private currentCounters: RunCounters | null = null;

  private readonly maxIterations: number;
  private readonly maxNodes: number;

  constructor(options: SchedulerOptions = {}) {
    this.maxIterations = options.maxIterations ?? 10_000;
    this.maxNodes = options.maxNodes ?? 100_000;
    if (!Number.isInteger(this.maxIterations) || this.maxIterations < 1) {
      throw new Error("maxIterations must be a positive integer");
    }
    if (!Number.isInteger(this.maxNodes) || this.maxNodes < 1) {
      throw new Error("maxNodes must be a positive integer");
    }
    for (const rule of options.rules ?? []) this.registerRule(rule);
    this.lastStats = this.emptyStats("idle");
  }

  get classCount(): number {
    let count = 0;
    for (const id of this.classSizes.keys()) {
      if (this.find(id) === id) count += 1;
    }
    return count;
  }

  get nodeCount(): number {
    return this.aliveNodeCount;
  }

  get stats(): SchedulerStats {
    return this.lastStats;
  }

  get pendingClassCount(): number {
    return this.queued.size;
  }

  get fingerprintCount(): number {
    return this.attempted.size;
  }

  get activeMatchCount(): number {
    return this.activeMatches.size;
  }

  add(expression: Expr): ClassId {
    const result = this.addExpression(expression);
    this.status = "idle";
    return result;
  }

  addAll(expressions: readonly Expr[]): readonly ClassId[] {
    return expressions.map((expression) => this.add(expression));
  }

  registerRule(rule: RewriteRule): void {
    if (this.rules.has(rule.id)) {
      throw new Error(`Duplicate rewrite rule id: ${rule.id}`);
    }
    if (rule.replacement === undefined && rule.apply === undefined) {
      throw new Error(`Rule ${rule.id} has no replacement or apply function`);
    }
    this.rules.set(rule.id, rule);
    this.status = "idle";
    if (this.aliveNodeCount > 0) {
      for (const id of this.classSizes.keys()) {
        if (this.find(id) === id) this.wake(id);
      }
    }
  }

  find(classId: ClassId): ClassId {
    let root = classId;
    let cursor = classId;
    while (this.parent.get(cursor) !== cursor) {
      cursor = this.parent.get(cursor)!;
    }
    root = cursor;
    cursor = classId;
    while (this.parent.get(cursor) !== cursor) {
      const next = this.parent.get(cursor)!;
      this.parent.set(cursor, root);
      cursor = next;
    }
    return root;
  }

  areEquivalent(left: ClassId, right: ClassId): boolean {
    return this.find(left) === this.find(right);
  }

  classOf(expression: Expr): ClassId | undefined {
    const childIds: ClassId[] = [];
    for (const child of expression.args ?? []) {
      const childId = this.classOf(child);
      if (childId === undefined) return undefined;
      childIds.push(childId);
    }
    const hasValue = hasOwn(expression, "value");
    const key = nodeKeyOf(
      expression.op,
      valueKeyOf(expression.value, hasValue),
      childIds,
    );
    const nodeId = this.hashcons.get(key);
    const node = nodeId === undefined ? undefined : this.nodes.get(nodeId);
    return node?.alive ? this.find(node.cls) : undefined;
  }

  nodesInClass(classId: ClassId): readonly ENodeView[] {
    const root = this.find(classId);
    const ids = this.classNodes.get(root);
    if (ids === undefined) return [];
    const views: ENodeView[] = [];
    for (const id of ids) {
      const node = this.nodes.get(id);
      if (node === undefined || !node.alive) continue;
      views.push(this.viewOf(node));
    }
    views.sort((left, right) => left.id - right.id);
    return views;
  }

  snapshot(roots: readonly ClassId[] = []): GraphSnapshot {
    const classes: ClassSnapshot[] = [];
    for (const id of this.classSizes.keys()) {
      if (this.find(id) !== id) continue;
      classes.push({ id, nodes: this.nodesInClass(id) });
    }
    classes.sort((left, right) => left.id - right.id);
    return {
      classes,
      roots: roots.map((root) => this.find(root)),
    };
  }

  signature(roots: readonly ClassId[] = []): string {
    return graphSignature(this.snapshot(roots));
  }

  validate(): void {
    const classesByKey = new Map<string, Set<ClassId>>();
    for (const node of this.nodes.values()) {
      if (!node.alive) continue;
      const root = this.find(node.cls);
      if (!this.classNodes.get(root)?.has(node.id)) {
        throw new Error(`Node ${node.id} is missing from class ${root}`);
      }
      const key = nodeKeyOf(node.op, node.valueKey, node.args);
      if (key !== node.key) {
        throw new Error(`Node ${node.id} has a stale key`);
      }
      const consolidated = this.hashcons.get(node.key);
      if (consolidated === undefined) {
        throw new Error(`Node ${node.id} is missing from hashcons`);
      }
      const consolidatedNode = this.nodes.get(consolidated);
      if (
        consolidatedNode === undefined ||
        !consolidatedNode.alive ||
        this.find(consolidatedNode.cls) !== root
      ) {
        throw new Error(`Node ${node.id} has an invalid hashcons entry`);
      }
      let keyClasses = classesByKey.get(node.key);
      if (keyClasses === undefined) {
        keyClasses = new Set();
        classesByKey.set(node.key, keyClasses);
      }
      keyClasses.add(root);
      for (const child of node.args) {
        if (!this.childUsers.get(this.find(child))?.has(node.id)) {
          throw new Error(`Node ${node.id} is missing a child-users entry`);
        }
      }
    }
    for (const [key, keyClasses] of classesByKey) {
      if (keyClasses.size > 1) {
        throw new Error(`Equivalent e-node key ${key} spans multiple classes`);
      }
    }
    for (const [classId, nodeIds] of this.classNodes) {
      if (this.find(classId) !== classId) {
        throw new Error(`Class ${classId} is not canonical`);
      }
      for (const nodeId of nodeIds) {
        const node = this.nodes.get(nodeId);
        if (node === undefined || !node.alive || node.cls !== classId) {
          throw new Error(`Class ${classId} contains stale node ${nodeId}`);
        }
      }
    }
    for (const [key, nodeId] of this.hashcons) {
      const node = this.nodes.get(nodeId);
      if (node === undefined || !node.alive || node.key !== key) {
        throw new Error(`Hashcons entry ${key} points to a stale node`);
      }
    }
    for (const [childClass, nodeIds] of this.childUsers) {
      if (this.find(childClass) !== childClass) {
        throw new Error(`Child-users key ${childClass} is not canonical`);
      }
      for (const nodeId of nodeIds) {
        const node = this.nodes.get(nodeId);
        if (
          node === undefined ||
          !node.alive ||
          !node.args.some((arg) => this.find(arg) === childClass)
        ) {
          throw new Error(
            `Child-users entry ${childClass} contains stale node ${nodeId}`,
          );
        }
      }
    }
  }

  run(options: { readonly fullRescan?: boolean } = {}): SchedulerStats {
    const counters = this.newCounters();
    this.currentCounters = counters;
    try {
      if (options.fullRescan === true) {
        this.runFullRescan(counters);
      } else {
        this.runIncremental(counters);
      }
    } finally {
      this.currentCounters = null;
    }
    this.lastStats = {
      status: this.status,
      iterations: counters.iterations,
      classesScanned: counters.classesScanned,
      matchesFound: counters.matchesFound,
      matchesApplied: counters.matchesApplied,
      matchesSkipped: counters.matchesSkipped,
      matchesInvalidated: counters.matchesInvalidated,
      rewrites: counters.rewrites,
      nodesAdded: counters.nodesAdded,
      classesCreated: counters.classesCreated,
      unions: counters.unions,
      wakes: counters.wakes,
    };
    return this.lastStats;
  }

  saturate(options: { readonly fullRescan?: boolean } = {}): SchedulerStats {
    return this.run(options);
  }

  private emptyStats(status: SchedulerStatus): SchedulerStats {
    return {
      status,
      iterations: 0,
      classesScanned: 0,
      matchesFound: 0,
      matchesApplied: 0,
      matchesSkipped: 0,
      matchesInvalidated: 0,
      rewrites: 0,
      nodesAdded: 0,
      classesCreated: 0,
      unions: 0,
      wakes: 0,
    };
  }

  private newCounters(): RunCounters {
    return {
      iterations: 0,
      classesScanned: 0,
      matchesFound: 0,
      matchesApplied: 0,
      matchesSkipped: 0,
      matchesInvalidated: 0,
      rewrites: 0,
      nodesAdded: 0,
      classesCreated: 0,
      unions: 0,
      wakes: 0,
    };
  }

  private addExpression(expression: Expr): ClassId {
    if (typeof expression.op !== "string" || expression.op.length === 0) {
      throw new Error("Every expression must have a non-empty op");
    }
    const args = expression.args ?? [];
    if (!Array.isArray(args)) {
      throw new Error(`Expression ${expression.op} has invalid args`);
    }
    const childIds = args.map((child) => this.addExpression(child));
    const hasValue = hasOwn(expression, "value");
    return this.addNode(expression.op, childIds, hasValue, expression.value);
  }

  private addNode(
    op: string,
    rawArgs: readonly ClassId[],
    hasValue: boolean,
    value: ExprValue | undefined,
  ): ClassId {
    const args = rawArgs.map((arg) => this.find(arg));
    const valueKey = valueKeyOf(value, hasValue);
    const key = nodeKeyOf(op, valueKey, args);
    const existingId = this.hashcons.get(key);
    if (existingId !== undefined) {
      const existing = this.nodes.get(existingId);
      if (existing !== undefined && existing.alive) {
        return this.find(existing.cls);
      }
      this.hashcons.delete(key);
    }

    const classId = this.nextClassId++;
    const nodeId = this.nextNodeId++;
    const node: InternalNode = {
      id: nodeId,
      cls: classId,
      op,
      args,
      hasValue,
      value,
      valueKey,
      key,
      alive: true,
    };
    this.parent.set(classId, classId);
    this.classSizes.set(classId, 1);
    this.classNodes.set(classId, new Set([nodeId]));
    this.nodes.set(nodeId, node);
    this.hashcons.set(key, nodeId);
    this.aliveNodeCount += 1;
    if (this.currentCounters !== null) {
      this.currentCounters.nodesAdded += 1;
      this.currentCounters.classesCreated += 1;
    }
    for (const child of args) this.addChildUser(child, nodeId);
    this.wake(classId);
    return classId;
  }

  private addChildUser(child: ClassId, nodeId: NodeId): void {
    const root = this.find(child);
    let users = this.childUsers.get(root);
    if (users === undefined) {
      users = new Set();
      this.childUsers.set(root, users);
    }
    users.add(nodeId);
  }

  private removeChildUser(child: ClassId, nodeId: NodeId): void {
    const root = this.find(child);
    const users = this.childUsers.get(root);
    if (users === undefined) return;
    users.delete(nodeId);
    if (users.size === 0) this.childUsers.delete(root);
  }

  private wake(classId: ClassId): void {
    const root = this.find(classId);
    if (this.queued.has(root)) return;
    this.queued.add(root);
    this.worklist.push(root);
    if (this.currentCounters !== null) this.currentCounters.wakes += 1;
  }

  private runIncremental(counters: RunCounters): void {
    while (this.workHead < this.worklist.length) {
      if (counters.iterations >= this.maxIterations) {
        this.status = "iteration-limit";
        return;
      }
      const raw = this.worklist[this.workHead++];
      const root = this.find(raw);
      if (!this.queued.delete(root)) continue;
      if (this.queued.has(raw) && raw !== root) this.queued.delete(raw);
      this.scanClass(root, counters);
      counters.iterations += 1;
      if (this.aliveNodeCount > this.maxNodes) {
        this.status = "node-limit";
        return;
      }
    }
    this.compactWorklist();
    this.status = "fixpoint";
  }

  private runFullRescan(counters: RunCounters): void {
    for (;;) {
      if (counters.iterations >= this.maxIterations) {
        this.status = "iteration-limit";
        return;
      }
      const roots: ClassId[] = [];
      for (const id of this.classSizes.keys()) {
        if (this.find(id) === id) roots.push(id);
      }
      roots.sort((left, right) => left - right);
      counters.iterations += 1;
      let appliedBefore = counters.matchesApplied;
      for (const root of roots) this.scanClass(root, counters);
      if (this.aliveNodeCount > this.maxNodes) {
        this.status = "node-limit";
        return;
      }
      if (counters.matchesApplied === appliedBefore) {
        this.worklist.length = 0;
        this.workHead = 0;
        this.queued.clear();
        this.status = "fixpoint";
        return;
      }
    }
  }

  private compactWorklist(): void {
    if (this.workHead === 0) return;
    this.worklist.splice(0, this.workHead);
    this.workHead = 0;
  }

  private scanClass(root: ClassId, counters: RunCounters): void {
    const canonical = this.find(root);
    const nodeIds = this.classNodes.get(canonical);
    if (nodeIds === undefined) return;
    counters.classesScanned += 1;
    for (const rule of this.rules.values()) {
      this.enumerateMatches(rule, canonical, (candidate) => {
        counters.matchesFound += 1;
        const fingerprint = this.fingerprint(candidate);
        if (this.attempted.has(fingerprint)) {
          counters.matchesSkipped += 1;
          return;
        }
        this.attempted.add(fingerprint);

        const match = this.makeMatch(candidate);
        if (rule.when !== undefined && !rule.when(match)) {
          counters.matchesSkipped += 1;
          return;
        }

        counters.matchesApplied += 1;
        counters.rewrites += 1;
        this.recordDependencies(fingerprint, candidate.dependencies);
        const result =
          rule.apply !== undefined
            ? rule.apply(match)
            : (rule.replacement as Template | readonly Template[]);
        for (const template of asTemplateList(result)) {
          const replacementClass = this.instantiate(template, candidate.variables);
          this.unionClasses(candidate.root, replacementClass);
        }
      });
    }
  }

  private makeMatch(candidate: MatchCandidate): RuleMatch {
    const frozen = new Map<string, ClassId>();
    for (const [name, classId] of candidate.variables) {
      frozen.set(name, this.find(classId));
    }
    return {
      ruleId: candidate.ruleId,
      root: this.find(candidate.root),
      nodeKey: candidate.nodeKey,
      ...(candidate.node === undefined
        ? {}
        : { node: this.viewOf(candidate.node) }),
      variables: frozen,
      get(name: string): ClassId {
        const classId = frozen.get(name);
        if (classId === undefined) {
          throw new Error(
            `Rule ${candidate.ruleId} referenced unbound variable ${name}`,
          );
        }
        return classId;
      },
    };
  }

  private enumerateMatches(
    rule: RewriteRule,
    root: ClassId,
    visit: (candidate: MatchCandidate) => void,
  ): void {
    const pattern = rule.pattern;
    if (isVarPattern(pattern)) {
      const variables = new Map<string, ClassId>([[pattern.name, root]]);
      visit({
        ruleId: rule.id,
        root,
        nodeKey: "",
        variables,
        dependencies: new Set([root]),
      });
      return;
    }

    const ids = this.classNodes.get(this.find(root));
    if (ids === undefined) return;
    const seenKeys = new Set<string>();
    for (const nodeId of [...ids].sort((left, right) => left - right)) {
      const node = this.nodes.get(nodeId);
      if (node === undefined || !node.alive) continue;
      if (seenKeys.has(node.key)) continue;
      seenKeys.add(node.key);
      if (node.op !== pattern.op) continue;
      if (hasOwn(pattern, "value")) {
        if (!node.hasValue) continue;
        if (valueKeyOf(pattern.value, true) !== node.valueKey) continue;
      }
      const patternArgs = pattern.args ?? [];
      if (patternArgs.length !== node.args.length) continue;

      const bindings = new Map<string, ClassId>();
      const dependencies = new Set<ClassId>([root]);
      this.enumerateChildren(
        patternArgs,
        node.args,
        0,
        bindings,
        dependencies,
        (matchedBindings, matchedDependencies) => {
          visit({
            ruleId: rule.id,
            root,
            nodeKey: node.key,
            node,
            variables: new Map(matchedBindings),
            dependencies: new Set(
              [...matchedDependencies].map((dependency) =>
                this.find(dependency),
              ),
            ),
          });
        },
      );
    }
  }

  private enumerateChildren(
    patterns: readonly Pattern[],
    args: readonly ClassId[],
    index: number,
    bindings: Map<string, ClassId>,
    dependencies: Set<ClassId>,
    visit: MatchVisitor,
  ): void {
    if (index === patterns.length) {
      visit(bindings, dependencies);
      return;
    }
    this.enumeratePattern(
      patterns[index],
      this.find(args[index]),
      bindings,
      dependencies,
      (nextBindings, nextDependencies) => {
        this.enumerateChildren(
          patterns,
          args,
          index + 1,
          new Map(nextBindings),
          new Set(nextDependencies),
          visit,
        );
      },
    );
  }

  private enumeratePattern(
    pattern: Pattern,
    classId: ClassId,
    bindings: Map<string, ClassId>,
    dependencies: Set<ClassId>,
    visit: MatchVisitor,
  ): void {
    const root = this.find(classId);
    dependencies.add(root);
    if (isVarPattern(pattern)) {
      const bound = bindings.get(pattern.name);
      if (bound === undefined) {
        const nextBindings = new Map(bindings);
        nextBindings.set(pattern.name, root);
        visit(nextBindings, new Set(dependencies));
      } else if (this.find(bound) === root) {
        visit(new Map(bindings), new Set(dependencies));
      }
      return;
    }

    const ids = this.classNodes.get(root);
    if (ids === undefined) return;
    const seenKeys = new Set<string>();
    for (const nodeId of [...ids].sort((left, right) => left - right)) {
      const node = this.nodes.get(nodeId);
      if (node === undefined || !node.alive) continue;
      if (seenKeys.has(node.key)) continue;
      seenKeys.add(node.key);
      if (node.op !== pattern.op) continue;
      if (hasOwn(pattern, "value")) {
        if (!node.hasValue) continue;
        if (valueKeyOf(pattern.value, true) !== node.valueKey) continue;
      }
      const patternArgs = pattern.args ?? [];
      if (patternArgs.length !== node.args.length) continue;

      const localBindings = new Map(bindings);
      const localDependencies = new Set(dependencies);
      this.enumerateChildren(
        patternArgs,
        node.args,
        0,
        localBindings,
        localDependencies,
        visit,
      );
    }
  }

  private fingerprint(candidate: MatchCandidate): string {
    const bindings = [...candidate.variables.entries()]
      .map(([name, classId]) => [name, this.find(classId)] as const)
      .sort((left, right) => compareStrings(left[0], right[0]));
    return JSON.stringify([
      candidate.ruleId,
      this.find(candidate.root),
      candidate.nodeKey,
      bindings,
    ]);
  }

  private recordDependencies(
    fingerprint: string,
    dependencies: ReadonlySet<ClassId>,
  ): void {
    const canonical = new Set<ClassId>();
    for (const dependency of dependencies) {
      canonical.add(this.find(dependency));
    }
    this.activeMatches.set(fingerprint, {
      fingerprint,
      dependencies: canonical,
    });
    for (const dependency of canonical) {
      let matches = this.dependencies.get(dependency);
      if (matches === undefined) {
        matches = new Set();
        this.dependencies.set(dependency, matches);
      }
      matches.add(fingerprint);
    }
  }

  private invalidate(classId: ClassId): void {
    const matches = this.dependencies.get(classId);
    if (matches === undefined) return;
    this.dependencies.delete(classId);
    for (const fingerprint of matches) {
      const active = this.activeMatches.get(fingerprint);
      if (active === undefined) continue;
      this.activeMatches.delete(fingerprint);
      for (const dependency of active.dependencies) {
        const dependents = this.dependencies.get(dependency);
        if (dependents === undefined) continue;
        dependents.delete(fingerprint);
        if (dependents.size === 0) this.dependencies.delete(dependency);
      }
      if (this.currentCounters !== null) {
        this.currentCounters.matchesInvalidated += 1;
      }
    }
  }

  private instantiate(
    template: Template,
    bindings: ReadonlyMap<string, ClassId>,
  ): ClassId {
    if (isVarPattern(template)) {
      const classId = bindings.get(template.name);
      if (classId === undefined) {
        throw new Error(`Unbound replacement variable: ${template.name}`);
      }
      return this.find(classId);
    }
    if (typeof template.op !== "string" || template.op.length === 0) {
      throw new Error("Replacement nodes must have a non-empty op");
    }
    const args = template.args ?? [];
    const childIds = args.map((arg) => this.instantiate(arg, bindings));
    const hasValue = hasOwn(template, "value");
    return this.addNode(template.op, childIds, hasValue, template.value);
  }

  private unionClasses(left: ClassId, right: ClassId): boolean {
    const changed = this.unionRoots(this.find(left), this.find(right));
    if (!changed) return false;
    this.rebuildCongruence();
    return true;
  }

  private unionRoots(left: ClassId, right: ClassId): boolean {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot === rightRoot) return false;

    const winner = Math.min(leftRoot, rightRoot);
    const loser = Math.max(leftRoot, rightRoot);
    this.parent.set(loser, winner);
    if (this.currentCounters !== null) this.currentCounters.unions += 1;

    const moved = this.classNodes.get(loser);
    const target = this.classNodes.get(winner);
    if (target === undefined) {
      throw new Error(`Missing class ${winner}`);
    }
    if (moved !== undefined) {
      for (const nodeId of moved) {
        const node = this.nodes.get(nodeId);
        if (node === undefined || !node.alive) continue;
        node.cls = winner;
        target.add(nodeId);
        this.dirtyNodes.add(nodeId);
      }
      this.classNodes.delete(loser);
    }
    this.classSizes.set(
      winner,
      (this.classSizes.get(winner) ?? 0) +
        (this.classSizes.get(loser) ?? 0),
    );
    this.classSizes.delete(loser);

    const affectedParents = new Set<ClassId>();
    for (const cls of [winner, loser]) {
      const users = this.childUsers.get(cls);
      if (users === undefined) continue;
      for (const nodeId of users) {
        const node = this.nodes.get(nodeId);
        if (node === undefined || !node.alive) continue;
        this.dirtyNodes.add(nodeId);
        affectedParents.add(this.find(node.cls));
      }
    }
    const loserUsers = this.childUsers.get(loser);
    if (loserUsers !== undefined) {
      const winnerUsers = this.childUsers.get(winner);
      if (winnerUsers === undefined) {
        this.childUsers.set(winner, new Set(loserUsers));
      } else {
        for (const nodeId of loserUsers) winnerUsers.add(nodeId);
      }
      this.childUsers.delete(loser);
    }

    this.invalidate(winner);
    this.invalidate(loser);
    this.wake(winner);
    if (this.queued.has(loser)) {
      this.queued.delete(loser);
      this.wake(winner);
    }
    for (const parentClass of affectedParents) this.wake(parentClass);
    return true;
  }

  private rebuildCongruence(): void {
    let guard = 0;
    const guardLimit = Math.max(100, this.aliveNodeCount * this.aliveNodeCount);
    while (this.dirtyNodes.size > 0) {
      guard += 1;
      if (guard > guardLimit) {
        throw new Error("Congruence rebuild did not converge");
      }

      const queue = [...this.dirtyNodes];
      this.dirtyNodes.clear();
      for (const nodeId of queue) {
        const node = this.nodes.get(nodeId);
        if (node === undefined || !node.alive) continue;
        const classRoot = this.find(node.cls);
        if (classRoot !== node.cls) node.cls = classRoot;

        let childrenChanged = false;
        const canonicalArgs = node.args.map((arg) => {
          const root = this.find(arg);
          if (root !== arg) childrenChanged = true;
          return root;
        });
        if (childrenChanged) {
          for (const child of node.args) this.removeChildUser(child, node.id);
          node.args = canonicalArgs;
          for (const child of node.args) this.addChildUser(child, node.id);
        }

        const nextKey = nodeKeyOf(node.op, node.valueKey, node.args);
        if (nextKey === node.key) continue;

        if (this.hashcons.get(node.key) === node.id) {
          this.hashcons.delete(node.key);
        }
        const otherId = this.hashcons.get(nextKey);
        if (otherId !== undefined && otherId !== node.id) {
          const other = this.nodes.get(otherId);
          if (other !== undefined && other.alive) {
            const otherRoot = this.find(other.cls);
            if (otherRoot !== classRoot) {
              this.dirtyNodes.add(node.id);
              this.dirtyNodes.add(other.id);
              this.unionRoots(classRoot, otherRoot);
              continue;
            }
            this.mergeDuplicateNodes(node, other, nextKey);
            continue;
          }
          this.hashcons.delete(nextKey);
        }
        node.key = nextKey;
        this.hashcons.set(nextKey, node.id);
        this.wake(classRoot);
        const users = this.childUsers.get(classRoot);
        if (users !== undefined) {
          for (const userId of users) {
            const user = this.nodes.get(userId);
            if (user === undefined || !user.alive) continue;
            this.wake(this.find(user.cls));
          }
        }
      }
    }
  }

  private mergeDuplicateNodes(
    node: InternalNode,
    other: InternalNode,
    key: string,
  ): void {
    const keep = node.id < other.id ? node : other;
    const drop = keep === node ? other : node;
    keep.key = key;
    this.hashcons.set(key, keep.id);
    drop.alive = false;
    this.aliveNodeCount -= 1;
    this.classSizes.set(
      keep.cls,
      Math.max(1, (this.classSizes.get(keep.cls) ?? 1) - 1),
    );
    this.classNodes.get(keep.cls)?.delete(drop.id);
    for (const child of drop.args) this.removeChildUser(child, drop.id);
    if (this.hashcons.get(key) === drop.id) this.hashcons.set(key, keep.id);
    if (this.hashcons.get(drop.key) === drop.id) {
      this.hashcons.delete(drop.key);
    }
    this.dirtyNodes.delete(drop.id);
  }

  private viewOf(node: InternalNode): ENodeView {
    return {
      id: node.id,
      key: node.key,
      op: node.op,
      args: [...node.args],
      hasValue: node.hasValue,
      ...(node.hasValue ? { value: node.value } : {}),
    };
  }
}

export function graphSignature(snapshot: GraphSnapshot): string {
  const classes = snapshot.classes;
  if (classes.length === 0) return JSON.stringify({ classes: [], roots: [] });
  const ids = classes.map((entry) => entry.id).sort((left, right) => left - right);
  let colors = new Map<ClassId, number>();

  for (const entry of classes) {
    colors.set(entry.id, 0);
  }

  const rounds = classes.length + 1;
  for (let round = 0; round < rounds; round += 1) {
    const signatures = new Map<ClassId, string>();
    for (const entry of classes) {
      const nodes = [...entry.nodes]
        .map((node) =>
          JSON.stringify([
            node.op,
            node.hasValue,
            node.hasValue ? stableValue(node.value as ExprValue) : ABSENT_VALUE,
            node.args.map((arg) => colors.get(arg) ?? -1),
          ]),
        )
        .sort(compareStrings);
      signatures.set(entry.id, nodes.join("|"));
    }
    const unique = [...new Set(signatures.values())].sort(compareStrings);
    const next = new Map<ClassId, number>();
    for (const id of ids) {
      next.set(id, unique.indexOf(signatures.get(id)!));
    }
    let same = true;
    for (const id of ids) {
      if (colors.get(id) !== next.get(id)) {
        same = false;
        break;
      }
    }
    colors = next;
    if (same) break;
  }

  const finalSignatures = new Map<ClassId, string>();
  for (const entry of classes) {
    const nodes = [...entry.nodes]
      .map((node) =>
        JSON.stringify([
          node.op,
          node.hasValue,
          node.hasValue ? stableValue(node.value as ExprValue) : ABSENT_VALUE,
          node.args.map((arg) => colors.get(arg) ?? -1),
        ]),
      )
      .sort(compareStrings)
      .join("|");
    finalSignatures.set(entry.id, nodes);
  }
  const classSignatures = [...finalSignatures.values()].sort(compareStrings);
  const rootSignatures = snapshot.roots.map(
    (root) => finalSignatures.get(root) ?? "\u0000missing",
  );
  return JSON.stringify({
    classes: classSignatures,
    roots: rootSignatures,
  });
}

export function verifyAgainstFullRescan(
  seeds: readonly Expr[],
  rules: readonly RewriteRule[],
  options: Omit<SchedulerOptions, "rules"> = {},
): SaturationComparison {
  const incremental = new RuleScheduler({ ...options, rules });
  const incrementalRoots = seeds.map((seed) => incremental.add(seed));
  const incrementalStats = incremental.run();
  incremental.validate();

  const fullRescan = new RuleScheduler({ ...options, rules });
  const fullRoots = seeds.map((seed) => fullRescan.add(seed));
  const fullRescanStats = fullRescan.run({ fullRescan: true });
  fullRescan.validate();

  const incrementalSignature = incremental.signature(incrementalRoots);
  const fullRescanSignature = fullRescan.signature(fullRoots);
  return {
    equal: incrementalSignature === fullRescanSignature,
    incremental: incremental.snapshot(incrementalRoots),
    fullRescan: fullRescan.snapshot(fullRoots),
    incrementalSignature,
    fullRescanSignature,
    incrementalStats,
    fullRescanStats,
  };
}
