'use strict';

const { Engine, EngineError } = require('./engine');

function parseInput(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // Fall back to JSON Lines input.
    return trimmed.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
  }
}

// Run a JSON (array | object | JSONL) command stream; return one result object
// per command. Processing continues after errors so callers get a full report.
function run(text) {
  let commands;
  try {
    commands = parseInput(text);
  } catch (err) {
    return {
      lines: [{ ok: false, error: { code: 'INVALID_INPUT', message: String(err && err.message || err) } }],
      hadError: true,
    };
  }
  const engine = new Engine();
  const lines = [];
  let hadError = false;
  commands.forEach((cmd, i) => {
    try {
      lines.push({ ok: true, cmd: i, ...engine.execute(cmd) });
    } catch (err) {
      hadError = true;
      if (err instanceof EngineError) {
        lines.push({ ok: false, cmd: i, error: { code: err.code, message: err.message } });
      } else {
        lines.push({ ok: false, cmd: i, error: { code: 'INTERNAL', message: String(err && err.message || err) } });
      }
    }
  });
  return { lines, hadError };
}

module.exports = { run };
