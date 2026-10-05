import { readFileSync } from 'node:fs';
import { replay } from './replay.js';
import { computeDigest, diffDigests } from './digest.js';
import { UnknownMemberError, ValidationError, ConflictError } from './errors.js';

export const EXIT_OK = 0;
export const EXIT_USAGE = 2;
export const EXIT_UNKNOWN_MEMBER = 4;
export const EXIT_DIGEST_MISMATCH = 5;

function readJsonl(path) {
  const text = path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8');
  const events = [];
  text.split('\n').forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed === '') return;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      throw new ValidationError(`${path}:${i + 1}: invalid JSON line`);
    }
  });
  return events;
}

function certificate(result, events, inputs) {
  const digest = computeDigest(events);
  return {
    digest: digest.hash,
    events: result.total,
    accepted: result.accepted.length,
    rejected: result.rejected.length,
    clock: result.clock,
    epochs: Object.fromEntries(Object.entries(result.members).map(([m, info]) => [m, info.currentEpoch])),
    ...(inputs ? { inputs } : {}),
  };
}

function cmdMerge(files) {
  if (files.length === 0) throw new ValidationError('merge requires at least one JSONL input file');
  const inputs = [];
  const all = [];
  for (const f of files) {
    const events = readJsonl(f);
    inputs.push({ file: f, digest: computeDigest(events).hash, count: events.length });
    all.push(...events);
  }
  const result = replay(all);
  return {
    valves: result.valves,
    members: result.members,
    rejected: result.rejected.map((r) => ({ event: r.event.id, reason: r.reason })),
    certificate: certificate(result, all, inputs),
  };
}

function cmdStatus(files) {
  if (files.length === 0) throw new ValidationError('status requires at least one JSONL input file');
  const all = files.flatMap((f) => readJsonl(f));
  const result = replay(all);
  const valves = Object.fromEntries(
    Object.entries(result.valves).map(([v, s]) => [
      v,
      { status: s.status, interlocked: s.interlocked, bypassed: s.bypassed, lastEvent: s.lastEvent },
    ]),
  );
  return {
    valves,
    members: Object.fromEntries(
      Object.entries(result.members).map(([m, info]) => [
        m,
        { currentEpoch: info.currentEpoch, active: info.active, leftEpochs: info.leftEpochs },
      ]),
    ),
    certificate: certificate(result, all),
  };
}

function cmdDigest(files) {
  if (files.length === 1) return { output: computeDigest(readJsonl(files[0])), exitCode: EXIT_OK };
  if (files.length === 2) {
    const a = computeDigest(readJsonl(files[0]));
    const b = computeDigest(readJsonl(files[1]));
    const diff = diffDigests(a, b);
    if (diff.equal) return { output: { equal: true, hash: a.hash, count: a.count }, exitCode: EXIT_OK };
    return {
      output: { equal: false, hashA: diff.hashA, hashB: diff.hashB, divergence: diff.divergence },
      exitCode: EXIT_DIGEST_MISMATCH,
    };
  }
  throw new ValidationError('digest takes one file (print) or two files (compare)');
}

// Runs one CLI invocation. `io` provides stdout/stderr sinks; returns the exit code
// instead of calling process.exit so it can be driven in-process by tests.
export function runCli(argv, io = { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) }) {
  const emitErr = (body) => io.stderr(`${JSON.stringify(body)}\n`);
  try {
    const [command, ...files] = argv;
    switch (command) {
      case 'merge':
        io.stdout(`${JSON.stringify(cmdMerge(files), null, 2)}\n`);
        return EXIT_OK;
      case 'status':
        io.stdout(`${JSON.stringify(cmdStatus(files), null, 2)}\n`);
        return EXIT_OK;
      case 'digest': {
        const { output, exitCode } = cmdDigest(files);
        io.stdout(`${JSON.stringify(output, null, 2)}\n`);
        return exitCode;
      }
      default:
        io.stderr('usage: boiler <merge|digest|status> <file.jsonl>...\n');
        return EXIT_USAGE;
    }
  } catch (err) {
    if (err instanceof UnknownMemberError || err instanceof ValidationError || err instanceof ConflictError) {
      const body = { error: { code: err.code, message: err.message } };
      if (err.member !== undefined) body.error.member = err.member;
      if (err.eventId !== undefined) body.error.event = err.eventId;
      emitErr(body);
      return err.exitCode;
    }
    if (err && err.code === 'ENOENT') {
      emitErr({ error: { code: 'E_IO', message: err.message } });
      return EXIT_USAGE;
    }
    throw err;
  }
}
