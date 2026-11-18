import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ChaosOrchestrator,
  type FaultSpec,
  type OrchestratorConfig,
  type OrchestratorEvent,
} from '../src/orchestrator.ts';
import {
  naiveInitial,
  naiveExpire,
  naiveSetMetric,
  naiveStep,
  type NaiveState,
} from '../src/naive.ts';

const PLAN: readonly FaultSpec[] = [
  { id: 'A', radius: 1 },
  { id: 'B', radius: 2 },
  { id: 'C', radius: 1 },
];

const CONFIG: OrchestratorConfig = {
  maxRadius: 3,
  guardrails: [{ name: 'errorRate', max: 0.5 }],
  maxInjections: 4,
};

const RADIUS_BY_ID = new Map(PLAN.map((fault) => [fault.id, fault.radius]));

type Action =
  | { readonly kind: 'step' }
  | { readonly kind: 'metric'; readonly value: number }
  | { readonly kind: 'expire'; readonly faultId: string };

const ACTIONS: readonly Action[] = [
  { kind: 'step' },
  { kind: 'metric', value: 0.1 },
  { kind: 'metric', value: 0.9 },
  { kind: 'expire', faultId: 'A' },
  { kind: 'expire', faultId: 'B' },
  { kind: 'expire', faultId: 'C' },
];

function applyToOrchestrator(
  orchestrator: ChaosOrchestrator,
  action: Action,
): readonly OrchestratorEvent[] {
  switch (action.kind) {
    case 'step':
      return orchestrator.step();
    case 'metric':
      return orchestrator.setMetric('errorRate', action.value);
    case 'expire':
      return orchestrator.expire(action.faultId);
  }
}

function applyToNaive(
  state: NaiveState,
  action: Action,
): { state: NaiveState; events: readonly OrchestratorEvent[] } {
  switch (action.kind) {
    case 'step':
      return naiveStep(CONFIG, state);
    case 'metric':
      return naiveSetMetric(CONFIG, state, 'errorRate', action.value);
    case 'expire':
      return naiveExpire(state, action.faultId);
  }
}

function assertRadiusInvariant(orchestrator: ChaosOrchestrator, context: string): void {
  const radius = orchestrator
    .active()
    .reduce((sum, id) => sum + (RADIUS_BY_ID.get(id) ?? 0), 0);
  assert.equal(radius, orchestrator.activeRadius(), `${context}: radius bookkeeping`);
  assert.ok(
    orchestrator.activeRadius() <= CONFIG.maxRadius,
    `${context}: blast radius ${orchestrator.activeRadius()} exceeds ${CONFIG.maxRadius}`,
  );
}

test('exhaustive action sequences match the naive state machine step by step', () => {
  const depth = 6;
  const sequence: Action[] = [];
  let checked = 0;

  const run = (): void => {
    const orchestrator = new ChaosOrchestrator(CONFIG, PLAN);
    let naive = naiveInitial(PLAN);
    for (let i = 0; i < sequence.length; i += 1) {
      const context = `sequence=${JSON.stringify(sequence)} step=${i}`;
      const events = applyToOrchestrator(orchestrator, sequence[i]);
      const naiveResult = applyToNaive(naive, sequence[i]);
      naive = naiveResult.state;

      assert.deepEqual(events, naiveResult.events, `${context}: per-step events`);

      const injected = events.filter((event) => event.type === 'inject').map((e) => e.faultId);
      const rolledBack = events
        .filter((event) => event.type === 'rollback')
        .map((e) => e.faultId);
      assert.deepEqual(
        injected,
        naiveResult.events.filter((event) => event.type === 'inject').map((e) => e.faultId),
        `${context}: injected set`,
      );
      assert.deepEqual(
        rolledBack,
        naiveResult.events.filter((event) => event.type === 'rollback').map((e) => e.faultId),
        `${context}: rolled-back set`,
      );

      assert.deepEqual(orchestrator.active(), naive.active.map((f) => f.id), `${context}: active`);
      assert.deepEqual(orchestrator.rolledBack(), naive.rolledBack, `${context}: rolledBack`);
      assert.equal(orchestrator.halted, naive.halted, `${context}: halted`);
      assert.equal(orchestrator.haltReason, naive.haltReason, `${context}: haltReason`);
      assertRadiusInvariant(orchestrator, context);
      checked += 1;
    }
  };

  const enumerate = (remaining: number): void => {
    if (remaining === 0) {
      run();
      return;
    }
    for (const action of ACTIONS) {
      sequence.push(action);
      enumerate(remaining - 1);
      sequence.pop();
    }
  };

  enumerate(depth);
  assert.ok(checked > 0, 'expected to check at least one sequence');
});

test('guardrail breach rolls back in reverse injection order', () => {
  const orchestrator = new ChaosOrchestrator({ ...CONFIG, maxRadius: 4 }, PLAN);
  orchestrator.step();
  orchestrator.step();
  orchestrator.step();
  assert.deepEqual(orchestrator.active(), ['A', 'B', 'C']);

  const events = orchestrator.setMetric('errorRate', 0.9);
  assert.deepEqual(
    events.filter((event) => event.type === 'rollback').map((event) => event.faultId),
    ['C', 'B', 'A'],
  );
  assert.deepEqual(orchestrator.rolledBack(), ['C', 'B', 'A']);
  assert.deepEqual(orchestrator.active(), []);
  assert.equal(orchestrator.halted, true);
  assert.equal(orchestrator.haltReason, 'guardrail');
});

test('rollback only affects effective faults, expired ones are untouched', () => {
  const orchestrator = new ChaosOrchestrator(CONFIG, PLAN);
  orchestrator.step();
  orchestrator.step();
  orchestrator.expire('A');

  orchestrator.setMetric('errorRate', 0.9);
  assert.deepEqual(orchestrator.rolledBack(), ['B']);
  assert.equal(orchestrator.haltReason, 'guardrail');
});

test('injection that breaches a guardrail is rolled back within the same step', () => {
  const orchestrator = new ChaosOrchestrator(CONFIG, PLAN);
  orchestrator.step();
  orchestrator.setMetric('errorRate', 0.4);

  const events = orchestrator.step();
  assert.deepEqual(events, [{ type: 'inject', faultId: 'B', radius: 2 }]);

  orchestrator.setMetric('errorRate', 0.9);
  assert.deepEqual(orchestrator.rolledBack(), ['B', 'A']);
  assert.equal(orchestrator.activeRadius(), 0);
});

test('blast radius boundary is never crossed and oversized faults are skipped', () => {
  const config: OrchestratorConfig = { maxRadius: 2, guardrails: [] };
  const orchestrator = new ChaosOrchestrator(config, [
    { id: 'A', radius: 1 },
    { id: 'B', radius: 2 },
  ]);
  orchestrator.step();
  const events = orchestrator.step();
  assert.deepEqual(events, [{ type: 'skip-inject', faultId: 'B' }]);
  assert.equal(orchestrator.activeRadius(), 1);

  orchestrator.expire('A');
  orchestrator.step();
  assert.deepEqual(orchestrator.active(), ['B']);
  assert.equal(orchestrator.activeRadius(), 2);
});

test('guardrail trigger interleaved with injection never expands the radius', () => {
  const orchestrator = new ChaosOrchestrator(CONFIG, PLAN);
  orchestrator.step();
  orchestrator.setMetric('errorRate', 0.9);
  assert.equal(orchestrator.halted, true);
  assert.equal(orchestrator.activeRadius(), 0);

  const events = orchestrator.step();
  assert.deepEqual(events, []);
  assert.equal(orchestrator.activeRadius(), 0);
  assert.deepEqual(orchestrator.active(), []);
});

test('stop condition halts without rollback', () => {
  const config: OrchestratorConfig = { ...CONFIG, maxInjections: 2 };
  const orchestrator = new ChaosOrchestrator(config, PLAN);
  orchestrator.step();
  orchestrator.step();
  const events = orchestrator.step();
  assert.deepEqual(events, [{ type: 'halt', reason: 'stop-condition' }]);
  assert.deepEqual(orchestrator.rolledBack(), []);
  assert.deepEqual(orchestrator.active(), ['A', 'B']);
});
