import fs from 'node:fs';
import path from 'node:path';
import { GateError } from './expr.js';
import { loadRules } from './rules.js';
import { invalidateAt } from './windows.js';

function freshState() {
  return { seq: 0, observations: {}, order: [], caches: { buckets: {}, queries: {} } };
}

function validateObs(obs) {
  if (!obs || typeof obs !== 'object' || Array.isArray(obs)) {
    throw new GateError('E_INPUT', 'observation must be a JSON object');
  }
  if (typeof obs.key !== 'string' || !obs.key) {
    throw new GateError('E_INPUT', 'observation.key must be a non-empty string');
  }
  if (typeof obs.ts !== 'number' || !Number.isFinite(obs.ts)) {
    throw new GateError('E_INPUT', `observation '${obs.key}': ts must be a finite number`);
  }
  if (!obs.metrics || typeof obs.metrics !== 'object' || Array.isArray(obs.metrics)) {
    throw new GateError('E_INPUT', `observation '${obs.key}': metrics must be an object`);
  }
  for (const [name, v] of Object.entries(obs.metrics)) {
    if (v !== null && typeof v !== 'number' && typeof v !== 'string' && typeof v !== 'boolean') {
      throw new GateError('E_INPUT', `observation '${obs.key}': metric '${name}' must be a scalar`);
    }
  }
}

export class Store {
  constructor(home, rules, state) {
    this.home = home;
    this.rules = rules;
    this.state = state;
  }

  static init(home, config, { force = false } = {}) {
    const rules = loadRules(config);
    if (fs.existsSync(path.join(home, 'rules.json'))) {
      if (!force) {
        throw new GateError('E_INPUT', `gate home already exists: ${home} (use --force to reinitialize)`);
      }
      fs.rmSync(home, { recursive: true, force: true });
    }
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'rules.json'), JSON.stringify(rules, null, 2));
    fs.writeFileSync(path.join(home, 'events.jsonl'), '');
    const store = new Store(home, rules, freshState());
    store.save();
    return store;
  }

  static open(home) {
    if (!fs.existsSync(path.join(home, 'rules.json'))) {
      throw new GateError('E_INPUT', `not initialized: ${home} (run 'gate init' first)`);
    }
    if (!fs.existsSync(path.join(home, 'state.json'))) {
      return Store.rebuild(home);
    }
    const rules = JSON.parse(fs.readFileSync(path.join(home, 'rules.json'), 'utf8'));
    const state = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'));
    return new Store(home, rules, state);
  }

  static rebuild(home) {
    if (!fs.existsSync(path.join(home, 'rules.json'))) {
      throw new GateError('E_INPUT', `not initialized: ${home} (run 'gate init' first)`);
    }
    const rules = JSON.parse(fs.readFileSync(path.join(home, 'rules.json'), 'utf8'));
    const store = new Store(home, rules, freshState());
    const lines = fs
      .readFileSync(path.join(home, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim());
    for (const line of lines) {
      const ev = JSON.parse(line);
      if (ev.type === 'obs') store.applyObs(ev.obs, false);
      else if (ev.type === 'correct') store.applyCorrect(ev.key, ev.patch, false);
      else throw new GateError('E_INPUT', `unknown event type '${ev.type}'`);
    }
    return store;
  }

  save() {
    fs.writeFileSync(path.join(this.home, 'state.json'), JSON.stringify(this.state));
  }

  appendEvent(ev) {
    fs.appendFileSync(path.join(this.home, 'events.jsonl'), `${JSON.stringify(ev)}\n`);
  }

  applyObs(obs, record) {
    validateObs(obs);
    if (this.state.observations[obs.key]) {
      throw new GateError('E_INPUT', `duplicate observation key '${obs.key}'`);
    }
    this.state.observations[obs.key] = obs;
    this.state.order.push(obs.key);
    invalidateAt(this.state.caches, this.rules.windows, obs.ts);
    this.state.seq++;
    if (record) this.appendEvent({ type: 'obs', obs });
  }

  addObs(obs) {
    this.applyObs(obs, true);
  }

  applyCorrect(key, patch, record) {
    const obs = this.state.observations[key];
    if (!obs) throw new GateError('E_INPUT', `unknown observation key '${key}'`);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new GateError('E_INPUT', 'patch must be a JSON object');
    }
    const oldTs = obs.ts;
    let newTs = oldTs;
    if ('ts' in patch) {
      if (typeof patch.ts !== 'number' || !Number.isFinite(patch.ts)) {
        throw new GateError('E_INPUT', 'patch.ts must be a finite number');
      }
      newTs = patch.ts;
    }
    let metrics = obs.metrics;
    if ('metrics' in patch) {
      if (!patch.metrics || typeof patch.metrics !== 'object' || Array.isArray(patch.metrics)) {
        throw new GateError('E_INPUT', 'patch.metrics must be an object');
      }
      metrics = { ...obs.metrics, ...patch.metrics };
    }
    const updated = { key, ts: newTs, metrics };
    this.state.observations[key] = updated;
    invalidateAt(this.state.caches, this.rules.windows, oldTs);
    if (newTs !== oldTs) invalidateAt(this.state.caches, this.rules.windows, newTs);
    this.state.seq++;
    if (record) this.appendEvent({ type: 'correct', key, patch });
    return updated;
  }

  correct(key, patch) {
    return this.applyCorrect(key, patch, true);
  }
}
