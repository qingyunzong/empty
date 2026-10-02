import { lex } from './lexer.js';
import { parse } from './parser.js';
import { check } from './checker.js';
import { compile, resolveAliases } from './compiler.js';
import { normalizeEvent } from './events.js';
import { VM } from './vm.js';
import { DiagnosticError } from './errors.js';

// Compiles rules source to a bytecode program (throws on diagnostics).
export function compileRules(rulesSrc) {
  const ast = parse(lex(rulesSrc));
  const meta = check(ast);
  resolveAliases(ast);
  return compile(ast, meta);
}

// Runs the full pipeline: rules source + JSONL events text -> result object.
// Never throws for domain/diagnostic problems; they land in `errors`.
export function runEngine(rulesSrc, eventsText) {
  const errors = [];
  const records = [];
  const pushErr = (e) => errors.push(e instanceof DiagnosticError ? e.toJSON()
    : { message: String(e?.message ?? e), phase: 'internal' });

  // 1. Rules: lex, parse, static check, compile to bytecode.
  let program;
  try {
    program = compileRules(rulesSrc);
  } catch (e) {
    for (const err of Array.isArray(e) ? e : [e]) pushErr(err);
    return finish(false, records, errors, 0);
  }

  // 2. Events: parse and validate every line first (deterministic failure).
  const events = [];
  const deviceIds = new Set();
  const lines = eventsText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].trim();
    if (!text) continue;
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      errors.push({ message: 'invalid JSON', phase: 'event', event: i + 1 });
      return finish(false, records, errors, 0);
    }
    try {
      const ev = normalizeEvent(raw, i + 1, program.fields);
      events.push({ ev, line: i + 1 });
      if (ev.device) deviceIds.add(ev.device);
    } catch (e) {
      pushErr(e);
      return finish(false, records, errors, 0);
    }
  }

  // 3. Empty device group check: every regex target must match >= 1 device.
  for (const rule of program.rules) {
    const t = rule.target;
    if (t.kind !== 'regex') continue;
    if (![...deviceIds].some((d) => t.re.test(d))) {
      const label = t.group ? `"${t.group}" (/${t.pattern}/)` : `/${t.pattern}/`;
      errors.push({
        message: `device group ${label} of rule "${rule.name}" matches no devices in the event stream`,
        phase: 'check', line: rule.line, col: rule.col,
      });
    }
  }
  if (errors.length) return finish(false, records, errors, 0);

  // 4. Incremental replay. A domain error stops processing; events already
  //    processed keep their deterministic records.
  const vm = new VM(program);
  let processed = 0;
  try {
    for (const { ev, line } of events) {
      vm.ingest(ev, line);
      processed += 1;
    }
  } catch (e) {
    pushErr(e);
  }
  vm.flush();
  records.push(...vm.records);

  const stats = {
    events: processed,
    alerts: records.filter((r) => r.kind === 'alert').length,
    withdraws: records.filter((r) => r.kind === 'withdraw').length,
  };
  return { ok: errors.length === 0, records, errors, stats };
}

function finish(ok, records, errors, processed) {
  return {
    ok, records, errors,
    stats: { events: processed, alerts: 0, withdraws: 0 },
  };
}
