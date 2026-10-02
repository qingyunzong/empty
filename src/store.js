import {readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {initialState, computePlan, applyCorrect, applyFail, applyRestore} from './domain.js';

export function applyEvent(state, ev) {
  switch (ev.cmd) {
    case 'ingest': {
      const s = initialState(ev.input, ev.seq);
      return {state: s, result: {plan: s.plan}};
    }
    case 'plan': {
      state.seq = ev.seq;
      state.plan = computePlan(state, {});
      return {state, result: {plan: state.plan}};
    }
    case 'correct': {
      state.seq = ev.seq;
      const r = applyCorrect(state, ev.input);
      return {state, result: r};
    }
    case 'fail': {
      state.seq = ev.seq;
      const f = applyFail(state, ev.input, ev.seq);
      return {state, result: {failure: f}};
    }
    case 'restore': {
      state.seq = ev.seq;
      const cert = applyRestore(state, ev.input);
      return {state, result: {certificate: cert}};
    }
    default:
      throw new Error(`unknown event ${ev.cmd}`);
  }
}

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.statePath = join(dir, 'state.json');
    this.logPath = join(dir, 'events.jsonl');
  }

  loadState() {
    return existsSync(this.statePath) ? JSON.parse(readFileSync(this.statePath, 'utf8')) : null;
  }

  readEvents() {
    if (!existsSync(this.logPath)) return [];
    return readFileSync(this.logPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  }

  replay() {
    let state = null;
    for (const ev of this.readEvents()) state = applyEvent(state, ev).state;
    return state;
  }

  resetLog(ev) {
    mkdirSync(this.dir, {recursive: true});
    writeFileSync(this.logPath, JSON.stringify(ev) + '\n');
  }

  record(ev) {
    mkdirSync(this.dir, {recursive: true});
    appendFileSync(this.logPath, JSON.stringify(ev) + '\n');
  }

  save(state) {
    mkdirSync(this.dir, {recursive: true});
    writeFileSync(this.statePath, JSON.stringify(state, null, 2));
  }
}
