'use strict';

const { Engine, AuditError } = require('./engine');
const { PackError } = require('./pack');

// Executes one audit command stream. Returns { exitCode, stdout, stderr }.
function runAudit(lines) {
  const engine = new Engine();
  const stdout = [];
  const stderr = [];
  for (const raw of lines) {
    const line = String(raw).trim();
    if (!line || line.startsWith('//')) continue;
    let cmd;
    try {
      cmd = JSON.parse(line);
    } catch {
      stderr.push(`ERROR BAD_JSON ${line}`);
      return { exitCode: 4, stdout, stderr };
    }
    try {
      for (const out of engine.exec(cmd)) stdout.push(out);
    } catch (e) {
      if (e instanceof AuditError || e instanceof PackError) {
        stderr.push(`ERROR ${e.code} ${e.message}`);
        return { exitCode: e.exitCode, stdout, stderr };
      }
      throw e;
    }
  }
  return { exitCode: 0, stdout, stderr };
}

module.exports = { runAudit };
