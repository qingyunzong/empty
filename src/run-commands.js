import { AllocationEngine } from './allocation.js';

const DISPATCH = {
  addDevice: (engine, cmd) => engine.addDevice(cmd.id, cmd.rect),
  removeDevice: (engine, cmd) => engine.removeDevice(cmd.id),
  addDefect: (engine, cmd) => engine.addDefect(cmd.id, cmd.rect),
  removeDefect: (engine, cmd) => engine.removeDefect(cmd.id),
  moveDefect: (engine, cmd) => engine.moveDefect(cmd.id, cmd.dx, cmd.dy),
  scaleDefect: (engine, cmd) => engine.scaleDefect(cmd.id, cmd.sx, cmd.sy),
  splitDefect: (engine, cmd) => engine.splitDefect(cmd.id, cmd.axis, cmd.at, cmd.blockIndex ?? 0),
  undo: (engine) => engine.undo(),
  redo: (engine) => engine.redo(),
};

// Executes a command list against a fresh engine. Returns
// { results, report } where `report` is the final allocation report.
export function runCommands(commands) {
  const engine = new AllocationEngine();
  const results = [];
  for (const cmd of commands) {
    if (!cmd || typeof cmd.op !== 'string') {
      results.push({ ok: false, error: 'command must have a string "op"' });
      continue;
    }
    if (cmd.op === 'report') {
      results.push({ op: 'report', ok: true, report: engine.report() });
      continue;
    }
    const handler = DISPATCH[cmd.op];
    if (!handler) {
      results.push({ op: cmd.op, ok: false, error: `unknown op "${cmd.op}"` });
      continue;
    }
    results.push({ op: cmd.op, ...handler(engine, cmd) });
  }
  return { results, report: engine.report() };
}

// Parses the stdin JSON document (array of commands or { commands: [...] }).
export function runJson(text) {
  const input = JSON.parse(text);
  const commands = Array.isArray(input) ? input : input.commands;
  if (!Array.isArray(commands)) {
    throw new Error('input must be an array of commands or { "commands": [...] }');
  }
  return runCommands(commands);
}
