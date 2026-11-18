import type {
  FaultSpec,
  HaltReason,
  OrchestratorConfig,
  OrchestratorEvent,
} from './orchestrator.ts';

export interface NaiveState {
  readonly queue: readonly FaultSpec[];
  readonly active: readonly FaultSpec[];
  readonly rolledBack: readonly string[];
  readonly metrics: Readonly<Record<string, number>>;
  readonly injections: number;
  readonly halted: boolean;
  readonly haltReason: HaltReason | undefined;
}

export interface NaiveResult {
  readonly state: NaiveState;
  readonly events: readonly OrchestratorEvent[];
}

export function naiveInitial(plan: readonly FaultSpec[]): NaiveState {
  return {
    queue: [...plan],
    active: [],
    rolledBack: [],
    metrics: {},
    injections: 0,
    halted: false,
    haltReason: undefined,
  };
}

function breached(config: OrchestratorConfig, state: NaiveState): boolean {
  return config.guardrails.some((guardrail) => {
    const value = state.metrics[guardrail.name];
    if (value === undefined) return false;
    if (guardrail.min !== undefined && value < guardrail.min) return true;
    if (guardrail.max !== undefined && value > guardrail.max) return true;
    return false;
  });
}

function radiusOf(active: readonly FaultSpec[]): number {
  return active.reduce((sum, fault) => sum + fault.radius, 0);
}

function rollbackAll(state: NaiveState): { state: NaiveState; events: OrchestratorEvent[] } {
  const events: OrchestratorEvent[] = [];
  const rolledBack = [...state.rolledBack];
  // Reverse injection order; only effective (still active) faults.
  const remaining = [...state.active];
  while (remaining.length > 0) {
    const fault = remaining.pop()!;
    rolledBack.push(fault.id);
    events.push({ type: 'rollback', faultId: fault.id });
  }
  events.push({ type: 'halt', reason: 'guardrail' });
  return {
    state: { ...state, active: [], rolledBack, halted: true, haltReason: 'guardrail' },
    events,
  };
}

export function naiveStep(config: OrchestratorConfig, state: NaiveState): NaiveResult {
  if (state.halted) return { state, events: [] };
  if (breached(config, state)) {
    const rolled = rollbackAll(state);
    return { state: rolled.state, events: rolled.events };
  }
  if (config.maxInjections !== undefined && state.injections >= config.maxInjections) {
    return {
      state: { ...state, halted: true, haltReason: 'stop-condition' },
      events: [{ type: 'halt', reason: 'stop-condition' }],
    };
  }
  if (state.queue.length === 0) {
    return {
      state: { ...state, halted: true, haltReason: 'drained' },
      events: [{ type: 'halt', reason: 'drained' }],
    };
  }
  const next = state.queue[0];
  if (radiusOf(state.active) + next.radius > config.maxRadius) {
    return { state, events: [{ type: 'skip-inject', faultId: next.id }] };
  }
  const injected: NaiveState = {
    ...state,
    queue: state.queue.slice(1),
    active: [...state.active, next],
    injections: state.injections + 1,
  };
  const events: OrchestratorEvent[] = [
    { type: 'inject', faultId: next.id, radius: next.radius },
  ];
  if (breached(config, injected)) {
    const rolled = rollbackAll(injected);
    return { state: rolled.state, events: [...events, ...rolled.events] };
  }
  return { state: injected, events };
}

export function naiveSetMetric(
  config: OrchestratorConfig,
  state: NaiveState,
  name: string,
  value: number,
): NaiveResult {
  const updated: NaiveState = { ...state, metrics: { ...state.metrics, [name]: value } };
  if (updated.halted || !breached(config, updated)) {
    return { state: updated, events: [] };
  }
  const rolled = rollbackAll(updated);
  return { state: rolled.state, events: rolled.events };
}

export function naiveExpire(state: NaiveState, faultId: string): NaiveResult {
  if (!state.active.some((fault) => fault.id === faultId)) {
    return { state, events: [] };
  }
  return {
    state: {
      ...state,
      active: state.active.filter((fault) => fault.id !== faultId),
    },
    events: [{ type: 'expire', faultId }],
  };
}
