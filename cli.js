#!/usr/bin/env node
'use strict';

const { FeedPlanner, PlannerError } = require('./src/planner');

function runCommand(plannerRef, cmd) {
  if (cmd == null || typeof cmd !== 'object' || typeof cmd.op !== 'string') {
    return { ok: false, code: 'E_COMMAND', message: 'each command needs an "op" string' };
  }
  try {
    switch (cmd.op) {
      case 'init': {
        plannerRef.planner = new FeedPlanner({
          quantumExp: cmd.quantumExp,
          slot: cmd.slot,
          segmentTolerance: cmd.segmentTolerance,
          totalTolerance: cmd.totalTolerance,
        });
        return { ok: true };
      }
      case 'beginEdit':
        return requirePlanner(plannerRef).beginEdit();
      case 'addSegment':
        return requirePlanner(plannerRef).addSegment({
          coeffs: cmd.coeffs,
          a: cmd.a,
          b: cmd.b,
        });
      case 'setParams':
        return requirePlanner(plannerRef).setParams(cmd.params || {});
      case 'edit': {
        // Convenience atomic transaction: begin + optional setParams + add* + commit.
        const planner = requirePlanner(plannerRef);
        planner.beginEdit();
        if (cmd.params) planner.setParams(cmd.params);
        for (const seg of cmd.segments || []) planner.addSegment(seg);
        return planner.commit();
      }
      case 'commit':
        return requirePlanner(plannerRef).commit();
      case 'rollback':
        return requirePlanner(plannerRef).rollback();
      case 'undo':
        return requirePlanner(plannerRef).undo();
      case 'redo':
        return requirePlanner(plannerRef).redo();
      case 'certificate':
        return { ok: true, certificate: requirePlanner(plannerRef).certificate() };
      default:
        return { ok: false, code: 'E_COMMAND', message: `unknown op: ${cmd.op}` };
    }
  } catch (e) {
    if (e instanceof PlannerError) return { ok: false, code: e.code, message: e.message };
    throw e;
  }
}

function requirePlanner(ref) {
  if (!ref.planner) throw new PlannerError('E_NOT_INITIALIZED', 'send an "init" command first');
  return ref.planner;
}

function handle(request) {
  const commands = Array.isArray(request.commands) ? request.commands : [request];
  const ref = { planner: null };
  const results = commands.map((cmd) => runCommand(ref, cmd));
  return { ok: results.every((r) => r.ok), results };
}

// Pure string -> { line, exitCode } so the full CLI contract is testable
// in-process; main() below is the only I/O wiring.
function execute(input) {
  try {
    const output = handle(JSON.parse(input));
    return { line: JSON.stringify(output), exitCode: 0 };
  } catch (e) {
    const output = { ok: false, code: 'E_PARSE', message: String((e && e.message) || e) };
    return { line: JSON.stringify(output), exitCode: 1 };
  }
}

function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    const { line, exitCode } = execute(input);
    process.stdout.write(line + '\n');
    process.exit(exitCode);
  });
}

if (require.main === module) main();

module.exports = { handle, execute };
