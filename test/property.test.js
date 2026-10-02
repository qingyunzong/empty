import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { check } from '../src/checker.js';
import { compile } from '../src/compiler.js';
import { VM } from '../src/vm.js';
import { MACHINE_DSL, mulberry32 } from './helpers.js';

// Independent transition reference model: interprets the checked AST directly
// (no bytecode, no shared VM code) and re-implements the command semantics.
function makeReference(source) {
  const checked = check(parse(tokenize(source)));
  const signals = checked.signals;
  const state = {
    values: signals.map((s) => s.init),
    running: signals.map(() => false),
  };
  const history = [{ values: state.values.slice(), running: state.running.slice() }];
  let cursor = 0;

  const clone = (s) => ({ values: s.values.slice(), running: s.running.slice() });

  function evalExpr(node, values) {
    switch (node.kind) {
      case 'bool':
      case 'duration':
        return node.value;
      case 'enumLit':
        return node.name;
      case 'ref':
        return values[node.index];
      case 'not':
        return !evalExpr(node.expr, values);
      case 'and':
        return evalExpr(node.left, values) && evalExpr(node.right, values);
      case 'or':
        return evalExpr(node.left, values) || evalExpr(node.right, values);
      case 'cmp': {
        const l = evalExpr(node.left, values);
        const r = evalExpr(node.right, values);
        switch (node.op) {
          case '==': return l === r;
          case '!=': return l !== r;
          case '<': return l < r;
          case '<=': return l <= r;
          case '>': return l > r;
          case '>=': return l >= r;
          default: throw new Error(`bad op ${node.op}`);
        }
      }
      default:
        throw new Error(`bad expr ${node.kind}`);
    }
  }

  const invariantsHold = (values) => checked.invariants.every((inv) => evalExpr(inv.expr, values));

  function runRules(s) {
    for (const rule of checked.rules) {
      if (evalExpr(rule.guard, s.values)) s.values[rule.targetIndex] = rule.value;
    }
  }

  const byLabel = new Map(signals.map((s) => [s.label, s]));
  const byPlain = new Map();
  for (const s of signals) {
    if (!byPlain.has(s.name)) byPlain.set(s.name, s);
    else byPlain.set(s.name, null); // ambiguous
  }
  const lookup = (name) => byLabel.get(name) ?? byPlain.get(name) ?? null;

  function apply(cmd) {
    if (cmd.cmd === 'undo') {
      if (cursor === 0) return false;
      cursor -= 1;
      const h = history[cursor];
      state.values = h.values.slice();
      state.running = h.running.slice();
      return true;
    }
    if (cmd.cmd === 'redo') {
      if (cursor >= history.length - 1) return false;
      cursor += 1;
      const h = history[cursor];
      state.values = h.values.slice();
      state.running = h.running.slice();
      return true;
    }
    const next = clone(state);
    if (cmd.cmd === 'advance') {
      if (!Number.isFinite(cmd.ms) || cmd.ms < 0) return false;
      for (const s of signals) {
        if (s.kind === 'timer' && next.running[s.index]) next.values[s.index] += cmd.ms;
      }
    } else if (cmd.cmd === 'set_input' || cmd.cmd === 'set_output' || cmd.cmd === 'start_timer') {
      const sig = lookup(cmd.signal);
      if (!sig) return false;
      if (cmd.cmd === 'set_input' && sig.kind !== 'input') return false;
      if (cmd.cmd === 'set_output' && sig.kind !== 'output') return false;
      if (cmd.cmd === 'start_timer') {
        if (sig.kind !== 'timer' || !Number.isFinite(cmd.ms) || cmd.ms < 0) return false;
        next.values[sig.index] = 0;
        next.running[sig.index] = true;
      } else {
        if (sig.type.kind === 'bool' && typeof cmd.value !== 'boolean') return false;
        if (sig.type.kind === 'enum' && !sig.type.values.includes(cmd.value)) return false;
        next.values[sig.index] = cmd.value;
      }
    } else {
      return false;
    }
    if (!invariantsHold(next.values)) return false;
    runRules(next);
    if (!invariantsHold(next.values)) return false;
    const changed = next.values.some((v, i) => v !== state.values[i])
      || next.running.some((v, i) => v !== state.running[i]);
    if (changed) {
      history.length = cursor + 1;
      history.push(clone(next));
      cursor += 1;
      state.values = next.values;
      state.running = next.running;
    }
    return true;
  }

  return { apply, state };
}

function randomCommands(rand, checked, count) {
  const inputs = checked.signals.filter((s) => s.kind === 'input');
  const outputs = checked.signals.filter((s) => s.kind === 'output');
  const timers = checked.signals.filter((s) => s.kind === 'timer');
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const randomValue = (sig) => {
    if (sig.type.kind === 'bool') return rand() < 0.5;
    return pick(sig.type.values);
  };
  const commands = [];
  let tick = 0;
  for (let i = 0; i < count; i += 1) {
    if (rand() < 0.7) tick += 1; // sometimes several commands share a tick
    const kind = Math.floor(rand() * 6);
    let cmd;
    if (kind === 0) cmd = { cmd: 'set_input', signal: pick(inputs).label, value: randomValue(pick(inputs)) };
    else if (kind === 1) cmd = { cmd: 'set_output', signal: pick(outputs).label, value: randomValue(pick(outputs)) };
    else if (kind === 2) cmd = { cmd: 'start_timer', signal: pick(timers).label, ms: Math.floor(rand() * 1000) };
    else if (kind === 3) cmd = { cmd: 'advance', ms: Math.floor(rand() * 1000) };
    else if (kind === 4) cmd = { cmd: 'undo' };
    else cmd = { cmd: 'redo' };
    cmd.tick = tick;
    commands.push(cmd);
  }
  return commands;
}

test('acceptance 5: VM matches the independent reference model on random <=12-step sequences', () => {
  const checked = check(parse(tokenize(MACHINE_DSL)));
  const program = compile(checked);
  const SEEDS = 300;
  for (let seed = 1; seed <= SEEDS; seed += 1) {
    const rand = mulberry32(seed);
    const steps = 1 + Math.floor(rand() * 12); // 1..12 commands
    const commands = randomCommands(rand, checked, steps);
    const vm = new VM(program);
    const ref = makeReference(MACHINE_DSL);
    commands.forEach((cmd, i) => {
      const got = vm.applyCommand(cmd);
      const want = ref.apply(cmd);
      assert.equal(
        got.accepted, want,
        `seed ${seed} step ${i} (${JSON.stringify(cmd)}): accepted mismatch`,
      );
      const vmState = vm.state;
      assert.deepEqual(
        { values: vmState.values, running: vmState.running },
        { values: ref.state.values, running: ref.state.running },
        `seed ${seed} step ${i} (${JSON.stringify(cmd)}): state mismatch`,
      );
    });
  }
});
