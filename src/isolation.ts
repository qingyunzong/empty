export type Level = 'instance' | 'zone' | 'service';
export type NodeState = 'healthy' | 'isolated' | 'recovering';
export type IsolationCause = 'local' | 'upstream';

export interface Path {
  service: string;
  zone: string;
  instance: string;
}

export interface IsolationOptions {
  /** Sliding window for failure aggregation per node. */
  windowMs?: number;
  /** Failures inside the window required before a node is evaluated for isolation. */
  failureThreshold?: number;
  /** Window used to correlate sibling failures sharing a signature. */
  correlationWindowMs?: number;
  /** Fraction of a node's children that must share the dominant failure signature. */
  correlationThreshold?: number;
  /** Accounting window for probe quotas. */
  probeWindowMs?: number;
  /** Base probe quota per window for each level. */
  probeBudgetPerWindow?: Partial<Record<Level, number>>;
  /** Quota multiplier applied to a non-healthy node (and therefore to its subtree). */
  parentThrottleFactor?: number;
  /** Traffic weights of the recovery ramp, e.g. [0.1, 0.5, 1]. */
  recoveryStages?: number[];
  /** Consecutive probe successes required to advance one recovery stage. */
  recoverySuccessThreshold?: number;
  /** Cooldown before an isolated node starts trickling recovery probes. */
  recoveryDelayMs?: number;
  /** Clock override for deterministic tests. */
  now?: () => number;
}

export type IsolationEventType =
  | 'isolated'
  | 'released'
  | 'recovering'
  | 'stage-advanced'
  | 'recovered'
  | 'relapsed';

export interface IsolationEvent {
  at: number;
  type: IsolationEventType;
  level: Level;
  node: string;
  cause?: IsolationCause;
  stage?: number;
}

export interface NodeInspection {
  state: NodeState;
  cause: IsolationCause | null;
  recoveryStage: number;
  weight: number;
}

export interface Inspection {
  scope: Level | null;
  weight: number;
  nodes: Record<Level, NodeInspection>;
}

interface FailureRec {
  signature: string;
  at: number;
  child: string | null;
}

interface ResolvedOptions {
  windowMs: number;
  failureThreshold: number;
  correlationWindowMs: number;
  correlationThreshold: number;
  probeWindowMs: number;
  probeBudgetPerWindow: Record<Level, number>;
  parentThrottleFactor: number;
  recoveryStages: number[];
  recoverySuccessThreshold: number;
  recoveryDelayMs: number;
}

class IsolationNode {
  readonly failures: FailureRec[] = [];
  readonly children = new Map<string, IsolationNode>();
  state: NodeState = 'healthy';
  cause: IsolationCause | null = null;
  isolatedAt = 0;
  recoveryStage = -1;
  consecutiveSuccesses = 0;
  probeWindowStart = -1;
  probesUsed = 0;

  constructor(
    readonly level: Level,
    readonly name: string,
    readonly fullName: string,
    readonly parent: IsolationNode | null,
  ) {}
}

export class IsolationController {
  private readonly opts: ResolvedOptions;
  private readonly nowFn: () => number;
  private readonly services = new Map<string, IsolationNode>();
  readonly events: IsolationEvent[] = [];

  constructor(options: IsolationOptions = {}) {
    this.opts = {
      windowMs: options.windowMs ?? 10_000,
      failureThreshold: options.failureThreshold ?? 3,
      correlationWindowMs: options.correlationWindowMs ?? 5_000,
      correlationThreshold: options.correlationThreshold ?? 0.5,
      probeWindowMs: options.probeWindowMs ?? 1_000,
      probeBudgetPerWindow: {
        instance: options.probeBudgetPerWindow?.instance ?? 5,
        zone: options.probeBudgetPerWindow?.zone ?? 10,
        service: options.probeBudgetPerWindow?.service ?? 20,
      },
      parentThrottleFactor: options.parentThrottleFactor ?? 0.2,
      recoveryStages: options.recoveryStages ?? [0.1, 0.5, 1],
      recoverySuccessThreshold: options.recoverySuccessThreshold ?? 3,
      recoveryDelayMs: options.recoveryDelayMs ?? 2_000,
    };
    this.nowFn = options.now ?? Date.now;
  }

  /** Record a failure observed at an instance; aggregates up to zone and service. */
  reportFailure(path: Path, signature: string): void {
    const now = this.nowFn();
    const chain = this.chain(path, true);
    for (let i = 0; i < chain.length; i++) {
      const node = chain[i];
      const child = i + 1 < chain.length ? chain[i + 1].name : null;
      node.failures.push({ signature, at: now, child });
      this.prune(node, now);
    }
    for (const node of chain) {
      if (node.state === 'recovering') this.relapse(node, now);
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      this.evaluate(chain[i], now);
    }
  }

  /** Record a success; recovering nodes in the chain count it toward stage advancement. */
  reportSuccess(path: Path): void {
    const now = this.nowFn();
    const chain = this.chain(path, true);
    for (const node of chain) {
      this.refresh(node, now);
      if (node.state !== 'recovering') continue;
      node.consecutiveSuccesses++;
      while (node.consecutiveSuccesses >= this.opts.recoverySuccessThreshold) {
        if (!this.tryAdvance(node, now)) break;
        node.consecutiveSuccesses = 0;
      }
    }
  }

  /**
   * Hierarchical probe quota: a probe to an instance consumes quota at the
   * instance, zone and service level. A non-healthy ancestor shrinks its own
   * budget, which throttles the whole subtree and prevents probe storms.
   */
  tryAcquireProbe(path: Path): boolean {
    const now = this.nowFn();
    const chain = this.chain(path, true);
    for (const node of chain) this.refresh(node, now);
    for (const node of chain) {
      if (node.state === 'isolated') return false;
    }
    for (const node of chain) {
      if (node.probesUsed >= this.effectiveBudget(node)) return false;
    }
    for (const node of chain) node.probesUsed++;
    return true;
  }

  /** Effective traffic weight for a path: the minimum weight along the chain. */
  trafficWeight(path: Path): number {
    const now = this.nowFn();
    const chain = this.chain(path, false);
    if (!chain) return 1;
    let weight = 1;
    for (const node of chain) {
      this.refresh(node, now);
      weight = Math.min(weight, this.nodeWeight(node));
    }
    return weight;
  }

  /** The topmost non-healthy level governing the path, or null when healthy. */
  isolationScope(path: Path): Level | null {
    const chain = this.chain(path, false);
    if (!chain) return null;
    for (const node of chain) {
      if (node.state !== 'healthy') return node.level;
    }
    return null;
  }

  inspect(path: Path): Inspection {
    const chain = this.chain(path, true);
    const now = this.nowFn();
    const nodes = {} as Record<Level, NodeInspection>;
    for (const node of chain) {
      this.refresh(node, now);
      nodes[node.level] = {
        state: node.state,
        cause: node.cause,
        recoveryStage: node.recoveryStage,
        weight: this.nodeWeight(node),
      };
    }
    return { scope: this.isolationScope(path), weight: this.trafficWeight(path), nodes };
  }

  private chain(path: Path, create: true): IsolationNode[];
  private chain(path: Path, create: boolean): IsolationNode[] | null;
  private chain(path: Path, create: boolean): IsolationNode[] | null {
    let service = this.services.get(path.service);
    if (!service) {
      if (!create) return null;
      service = new IsolationNode('service', path.service, path.service, null);
      this.services.set(path.service, service);
    }
    let zone = service.children.get(path.zone);
    if (!zone) {
      if (!create) return null;
      zone = new IsolationNode('zone', path.zone, `${path.service}/${path.zone}`, service);
      service.children.set(path.zone, zone);
    }
    let instance = zone.children.get(path.instance);
    if (!instance) {
      if (!create) return null;
      instance = new IsolationNode(
        'instance',
        path.instance,
        `${path.service}/${path.zone}/${path.instance}`,
        zone,
      );
      zone.children.set(path.instance, instance);
    }
    return [service, zone, instance];
  }

  private prune(node: IsolationNode, now: number): void {
    const cutoff = now - this.opts.windowMs;
    while (node.failures.length > 0 && node.failures[0].at < cutoff) {
      node.failures.shift();
    }
  }

  private evaluate(node: IsolationNode, now: number): void {
    if (node.state !== 'healthy') return;
    if (!this.ancestorsHealthy(node)) return;
    if (node.failures.length < this.opts.failureThreshold) return;
    if (node.level === 'instance') {
      this.isolate(node, 'local', now);
      return;
    }
    const dominant = this.dominantSignature(node, now);
    if (!dominant) return;
    const contributors = new Set<string>();
    for (const failure of node.failures) {
      if (failure.signature === dominant && failure.child !== null) {
        contributors.add(failure.child);
      }
    }
    const fraction = contributors.size / Math.max(node.children.size, 1);
    if (contributors.size >= 2 && fraction >= this.opts.correlationThreshold) {
      this.isolate(node, 'upstream', now);
      for (const child of node.children.values()) {
        if (child.state === 'isolated' && this.dominantSignature(child, now) === dominant) {
          child.state = 'healthy';
          child.cause = null;
          child.failures.length = 0;
          this.emit(now, 'released', child);
        }
      }
    }
  }

  private dominantSignature(node: IsolationNode, now: number): string | null {
    const cutoff = now - this.opts.correlationWindowMs;
    const counts = new Map<string, number>();
    let best: string | null = null;
    for (const failure of node.failures) {
      if (failure.at < cutoff) continue;
      const count = (counts.get(failure.signature) ?? 0) + 1;
      counts.set(failure.signature, count);
      if (best === null || count > counts.get(best)!) best = failure.signature;
    }
    return best;
  }

  private ancestorsHealthy(node: IsolationNode): boolean {
    let current = node.parent;
    while (current) {
      if (current.state !== 'healthy') return false;
      current = current.parent;
    }
    return true;
  }

  private isolate(node: IsolationNode, cause: IsolationCause, now: number): void {
    node.state = 'isolated';
    node.cause = cause;
    node.isolatedAt = now;
    node.recoveryStage = -1;
    node.consecutiveSuccesses = 0;
    this.emit(now, 'isolated', node, cause);
  }

  private relapse(node: IsolationNode, now: number): void {
    node.state = 'isolated';
    node.isolatedAt = now;
    node.recoveryStage = -1;
    node.consecutiveSuccesses = 0;
    this.emit(now, 'relapsed', node, node.cause ?? undefined);
  }

  private refresh(node: IsolationNode, now: number): void {
    if (node.probeWindowStart < 0 || now - node.probeWindowStart >= this.opts.probeWindowMs) {
      node.probeWindowStart = now;
      node.probesUsed = 0;
    }
    if (node.state === 'isolated' && now - node.isolatedAt >= this.opts.recoveryDelayMs) {
      node.state = 'recovering';
      node.recoveryStage = 0;
      node.consecutiveSuccesses = 0;
      this.emit(now, 'recovering', node, node.cause ?? undefined, 0);
    }
  }

  private tryAdvance(node: IsolationNode, now: number): boolean {
    const stages = this.opts.recoveryStages;
    const nextStage = node.recoveryStage + 1;
    if (nextStage >= stages.length) {
      node.state = 'healthy';
      node.recoveryStage = -1;
      node.cause = null;
      node.failures.length = 0;
      node.consecutiveSuccesses = 0;
      this.emit(now, 'recovered', node);
      return true;
    }
    const parentWeight = node.parent ? this.nodeWeight(node.parent) : 1;
    if (stages[nextStage] > parentWeight + 1e-9) return false;
    node.recoveryStage = nextStage;
    this.emit(now, 'stage-advanced', node, node.cause ?? undefined, nextStage);
    return true;
  }

  private nodeWeight(node: IsolationNode): number {
    if (node.state === 'healthy') return 1;
    if (node.state === 'isolated') return 0;
    return this.opts.recoveryStages[
      Math.min(node.recoveryStage, this.opts.recoveryStages.length - 1)
    ];
  }

  private effectiveBudget(node: IsolationNode): number {
    const base = this.opts.probeBudgetPerWindow[node.level];
    if (node.state === 'healthy') return base;
    const factor =
      node.state === 'recovering'
        ? Math.max(this.opts.parentThrottleFactor, this.nodeWeight(node))
        : this.opts.parentThrottleFactor;
    return Math.max(node.state === 'recovering' ? 1 : 0, Math.floor(base * factor));
  }

  private emit(
    at: number,
    type: IsolationEventType,
    node: IsolationNode,
    cause?: IsolationCause,
    stage?: number,
  ): void {
    this.events.push({ at, type, level: node.level, node: node.fullName, cause, stage });
  }
}
