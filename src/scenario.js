// Scenario loading and execution, shared by the CLI and the tests.

import { readFileSync } from 'node:fs';
import { FleetEngine } from './engine.js';

export function loadScenario(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

// A scenario is { config, events } or { config, steps }.
// `events` is a shorthand: each event is ingested in array order with
// `arrival` defaulting to the event's own `ts`. `steps` gives full control,
// including when settlement happens:
//   { "op": "ingest", "event": {...}, "arrival": 0 } | { "op": "settle", "ts": 100 }
export function runScenario(scenario) {
  const engine = new FleetEngine(scenario.config);
  const steps =
    scenario.steps ??
    (scenario.events ?? []).map((event) => ({
      op: 'ingest',
      event,
      arrival: event.arrival ?? event.ts,
    }));
  const log = [];
  for (const step of steps) {
    if (step.op === 'ingest') {
      const r = engine.ingest(step.event, step.arrival ?? step.event?.ts);
      log.push({ op: 'ingest', seq: step.event?.seq ?? null, ...r });
    } else if (step.op === 'settle') {
      engine.settle(step.ts);
      log.push({ op: 'settle', ts: step.ts });
    } else {
      throw new Error(`unknown step op: ${step.op}`);
    }
  }
  return { steps: log, ...engine.report() };
}
