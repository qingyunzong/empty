export interface FaultSpec {
  readonly id: string;
  readonly radius: number;
}

export interface Guardrail {
  readonly name: string;
  readonly min?: number;
  readonly max?: number;
}

export interface OrchestratorConfig {
  readonly maxRadius: number;
  readonly guardrails: readonly Guardrail[];
  readonly maxInjections?: number;
}

export type HaltReason = 'guardrail' | 'stop-condition' | 'drained';

export type OrchestratorEvent =
  | { readonly type: 'inject'; readonly faultId: string; readonly radius: number }
  | { readonly type: 'skip-inject'; readonly faultId: string }
  | { readonly type: 'rollback'; readonly faultId: string }
  | { readonly type: 'expire'; readonly faultId: string }
  | { readonly type: 'halt'; readonly reason: HaltReason };

export class ChaosOrchestrator {
  private readonly config: OrchestratorConfig;
  private readonly queue: FaultSpec[];
  private readonly activeList: FaultSpec[] = [];
  private readonly rolledBackList: string[] = [];
  private readonly metrics = new Map<string, number>();
  private totalInjections = 0;
  private haltedFlag = false;
  private haltReasonValue: HaltReason | undefined;
  private pending: OrchestratorEvent[] = [];

  constructor(config: OrchestratorConfig, plan: readonly FaultSpec[]) {
    if (!Number.isFinite(config.maxRadius) || config.maxRadius < 0) {
      throw new Error('maxRadius must be a non-negative finite number');
    }
    for (const fault of plan) {
      if (!(fault.radius > 0)) {
        throw new Error(`fault ${fault.id} must have a positive radius`);
      }
    }
    this.config = config;
    this.queue = [...plan];
  }

  get halted(): boolean {
    return this.haltedFlag;
  }

  get haltReason(): HaltReason | undefined {
    return this.haltReasonValue;
  }

  activeRadius(): number {
    let sum = 0;
    for (const fault of this.activeList) sum += fault.radius;
    return sum;
  }

  active(): readonly string[] {
    return this.activeList.map((fault) => fault.id);
  }

  rolledBack(): readonly string[] {
    return [...this.rolledBackList];
  }

  step(): readonly OrchestratorEvent[] {
    this.pending = [];
    if (!this.haltedFlag) {
      if (this.enforceGuardrails()) {
        // Guardrail breach halted the run and rolled everything back.
      } else if (this.stopConditionMet()) {
        this.halt('stop-condition');
      } else if (this.queue.length === 0) {
        this.halt('drained');
      } else {
        const next = this.queue[0];
        if (this.activeRadius() + next.radius <= this.config.maxRadius) {
          this.queue.shift();
          this.activeList.push(next);
          this.totalInjections += 1;
          this.pending.push({ type: 'inject', faultId: next.id, radius: next.radius });
          // The injection itself may push a guardrail metric out of bounds.
          this.enforceGuardrails();
        } else {
          this.pending.push({ type: 'skip-inject', faultId: next.id });
        }
      }
    }
    return [...this.pending];
  }

  setMetric(name: string, value: number): readonly OrchestratorEvent[] {
    this.metrics.set(name, value);
    this.pending = [];
    if (!this.haltedFlag) {
      this.enforceGuardrails();
    }
    return [...this.pending];
  }

  expire(faultId: string): readonly OrchestratorEvent[] {
    this.pending = [];
    const index = this.activeList.findIndex((fault) => fault.id === faultId);
    if (index >= 0) {
      this.activeList.splice(index, 1);
      this.pending.push({ type: 'expire', faultId });
    }
    return [...this.pending];
  }

  private stopConditionMet(): boolean {
    const limit = this.config.maxInjections;
    return limit !== undefined && this.totalInjections >= limit;
  }

  private findBreach(): boolean {
    for (const guardrail of this.config.guardrails) {
      const value = this.metrics.get(guardrail.name);
      if (value === undefined) continue;
      if (guardrail.min !== undefined && value < guardrail.min) return true;
      if (guardrail.max !== undefined && value > guardrail.max) return true;
    }
    return false;
  }

  private enforceGuardrails(): boolean {
    if (!this.findBreach()) return false;
    // Roll back in reverse injection order; activeList only holds
    // currently effective faults, so expired items are untouched.
    for (let i = this.activeList.length - 1; i >= 0; i -= 1) {
      const fault = this.activeList[i];
      this.rolledBackList.push(fault.id);
      this.pending.push({ type: 'rollback', faultId: fault.id });
    }
    this.activeList.length = 0;
    this.halt('guardrail');
    return true;
  }

  private halt(reason: HaltReason): void {
    this.haltedFlag = true;
    this.haltReasonValue = reason;
    this.pending.push({ type: 'halt', reason });
  }
}
