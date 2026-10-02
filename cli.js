#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { EvidenceGraph } from './src/evidence.js';

function emit(payload, exitCode = 0) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = exitCode;
}

function main(argv) {
  const args = argv.slice(2);
  let certId = null;
  let showDiffs = false;
  const files = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--certificate') {
      certId = args[i + 1];
      i += 1;
    } else if (args[i] === '--diffs') {
      showDiffs = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      process.stdout.write('Usage: node cli.js [--certificate <claimId>] [--diffs] [ops.json]\nReads operations JSON from file or stdin, replays them, prints ranking JSON.\n');
      return;
    } else {
      files.push(args[i]);
    }
  }

  let input;
  try {
    input = files.length > 0 ? readFileSync(files[0], 'utf8') : readFileSync(0, 'utf8');
  } catch (e) {
    emit({ ok: false, error: { code: 'E_IO', message: e.message } }, 1);
    return;
  }

  let ops;
  try {
    ops = JSON.parse(input);
  } catch (e) {
    emit({ ok: false, error: { code: 'E_PARSE', message: `invalid JSON input: ${e.message}` } }, 1);
    return;
  }

  const graph = new EvidenceGraph();
  const result = graph.replay(ops);
  const out = {
    ok: result.ok,
    applied: result.applied,
    errors: result.errors,
    ranking: graph.getRanking(),
    excluded: graph.getExcluded(),
  };
  if (showDiffs) out.diffs = result.diffs;

  let exitCode = result.ok ? 0 : 1;
  if (certId !== null && certId !== undefined) {
    try {
      out.certificate = graph.getCertificate(certId);
    } catch (e) {
      out.ok = false;
      out.errors.push({ code: e.code ?? 'E_INVALID', message: e.message });
      exitCode = 1;
    }
  }
  emit(out, exitCode);
}

main(process.argv);
