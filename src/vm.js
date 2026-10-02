// Tick-based VM. Every command runs one tick cycle:
//   1. read inputs   (apply the command's effect to a working copy)
//   2. check invariants, evaluate guards (device rules, declaration order)
//   3. atomically commit outputs (or reject: state fully unchanged)
// History records only accepted commands; undo/redo navigate committed states.

function cloneState(state) {
  return { values: state.values.slice(), running: state.running.slice() };
}

function statesEqual(a, b) {
  return a.values.every((v, i) => v === b.values[i])
    && a.running.every((v, i) => v === b.running[i]);
}

export class VM {
  constructor(program) {
    this.program = program;
    this.state = {
      values: program.signals.map((s) => s.init),
      running: program.signals.map(() => false),
    };
    this.history = [cloneState(this.state)];
    this.cursor = 0;
    this.byName = new Map();
    this.ambiguous = new Set();
    for (const sig of program.signals) {
      this.byName.set(sig.label, sig.index);
      if (this.byName.has(sig.name)) {
        if (this.byName.get(sig.name) !== sig.index) {
          this.ambiguous.add(sig.name);
        }
      } else {
        this.byName.set(sig.name, sig.index);
      }
    }
  }

  evalCode(code, values) {
    const stack = [];
    for (const ins of code) {
      switch (ins.op) {
        case 'CONST': stack.push(ins.arg); break;
        case 'LOAD': stack.push(values[ins.arg]); break;
        case 'NOT': stack.push(!stack.pop()); break;
        case 'AND': { const b = stack.pop(); const a = stack.pop(); stack.push(a && b); break; }
        case 'OR': { const b = stack.pop(); const a = stack.pop(); stack.push(a || b); break; }
        case 'EQ': { const b = stack.pop(); const a = stack.pop(); stack.push(a === b); break; }
        case 'NE': { const b = stack.pop(); const a = stack.pop(); stack.push(a !== b); break; }
        case 'LT': { const b = stack.pop(); const a = stack.pop(); stack.push(a < b); break; }
        case 'LE': { const b = stack.pop(); const a = stack.pop(); stack.push(a <= b); break; }
        case 'GT': { const b = stack.pop(); const a = stack.pop(); stack.push(a > b); break; }
        case 'GE': { const b = stack.pop(); const a = stack.pop(); stack.push(a >= b); break; }
        default: throw new Error(`unknown opcode '${ins.op}'`);
      }
    }
    return stack[stack.length - 1];
  }

  violatedInvariant(values) {
    for (const inv of this.program.invariants) {
      if (!this.evalCode(inv.code, values)) return inv;
    }
    return null;
  }

  runRules(state) {
    for (const rule of this.program.rules) {
      if (this.evalCode(rule.guard, state.values)) {
        state.values[rule.targetIndex] = rule.value;
      }
    }
  }

  commit(next) {
    this.history.length = this.cursor + 1; // a new command clears the redo tail
    this.history.push(cloneState(next));
    this.cursor += 1;
    this.state = cloneState(next);
  }

  lookupSignal(name) {
    if (typeof name !== 'string') return { error: 'command is missing a signal name' };
    if (this.ambiguous.has(name)) {
      return { error: `ambiguous signal '${name}'; use a device-qualified name` };
    }
    const index = this.byName.get(name);
    if (index === undefined) return { error: `unknown signal '${name}'` };
    return { index };
  }

  checkValue(sig, value) {
    const t = sig.type;
    if (t.kind === 'bool') {
      if (typeof value !== 'boolean') return `type mismatch for '${sig.label}': expected bool`;
      return null;
    }
    if (t.kind === 'enum') {
      if (typeof value !== 'string' || !t.values.includes(value)) {
        return `type mismatch for '${sig.label}': expected one of ${t.values.join(', ')}`;
      }
      return null;
    }
    return `signal '${sig.label}' has no settable value type`;
  }

  applyCommand(cmd) {
    const reject = (reason) => ({ accepted: false, reason });
    if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) return reject('invalid command');
    switch (cmd.cmd) {
      case 'undo': {
        if (this.cursor === 0) return reject('nothing to undo');
        this.cursor -= 1;
        this.state = cloneState(this.history[this.cursor]);
        return { accepted: true, reason: 'ok' };
      }
      case 'redo': {
        if (this.cursor >= this.history.length - 1) return reject('nothing to redo');
        this.cursor += 1;
        this.state = cloneState(this.history[this.cursor]);
        return { accepted: true, reason: 'ok' };
      }
      case 'set_input':
      case 'set_output':
      case 'start_timer':
      case 'advance':
        return this.applyStateCommand(cmd, reject);
      default:
        return reject(`unknown command '${cmd.cmd}'`);
    }
  }

  applyStateCommand(cmd, reject) {
    const next = cloneState(this.state);

    if (cmd.cmd === 'advance') {
      if (!Number.isFinite(cmd.ms) || cmd.ms < 0) return reject(`invalid advance ms '${cmd.ms}'`);
      for (const sig of this.program.signals) {
        if (sig.kind === 'timer' && next.running[sig.index]) {
          next.values[sig.index] += cmd.ms;
        }
      }
    } else {
      const { index, error } = this.lookupSignal(cmd.signal);
      if (error) return reject(error);
      const sig = this.program.signals[index];
      if (cmd.cmd === 'set_input' && sig.kind !== 'input') {
        return reject(`signal '${sig.label}' is ${sig.kind === 'output' ? 'an' : 'a'} ${sig.kind}, not an input`);
      }
      if (cmd.cmd === 'set_output' && sig.kind !== 'output') {
        return reject(`signal '${sig.label}' is ${sig.kind === 'input' ? 'an' : 'a'} ${sig.kind}, not an output`);
      }
      if (cmd.cmd === 'start_timer') {
        if (sig.kind !== 'timer') return reject(`signal '${sig.label}' is not a timer`);
        if (!Number.isFinite(cmd.ms) || cmd.ms < 0) return reject(`invalid timer ms '${cmd.ms}'`);
        next.values[index] = 0;
        next.running[index] = true;
      } else {
        const valueError = this.checkValue(sig, cmd.value);
        if (valueError) return reject(valueError);
        next.values[index] = cmd.value;
      }
    }

    // Invariants must hold for the commanded state itself...
    const before = this.violatedInvariant(next.values);
    if (before) return reject(`invariant violated: ${before.text}`);
    // ...then guards are evaluated and outputs committed atomically.
    this.runRules(next);
    const after = this.violatedInvariant(next.values);
    if (after) return reject(`invariant violated: ${after.text}`);

    if (statesEqual(next, this.state)) return { accepted: true, reason: 'ok (no change)' };
    this.commit(next);
    return { accepted: true, reason: 'ok' };
  }

  snapshot() {
    const values = {};
    const timers = {};
    for (const sig of this.program.signals) {
      values[sig.label] = this.state.values[sig.index];
      if (sig.kind === 'timer') timers[sig.label] = this.state.running[sig.index];
    }
    return { values, timers };
  }
}
