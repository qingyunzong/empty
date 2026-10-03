#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { compileNfa } = require('./src/nfa');
const { judgeEvents } = require('./src/judge');
const { makeProof, verifyProof } = require('./src/proof');
const { ComplianceError } = require('./src/errors');

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function readJsonl(path) {
  return fs
    .readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

const USAGE =
  'usage: node cli.js judge <flow.json> <log.jsonl> [--proof out.json] [--verify proof.json]';

// Returns { code, stdout, stderr } so the CLI can be driven in-process by tests.
function run(argv) {
  const [command, flowPath, logPath, ...rest] = argv;
  if (command !== 'judge' || !flowPath || !logPath) {
    return { code: 2, stdout: '', stderr: `${USAGE}\n` };
  }
  let proofOut = null;
  let verifyPath = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--proof' && i + 1 < rest.length) {
      proofOut = rest[++i];
    } else if (rest[i] === '--verify' && i + 1 < rest.length) {
      verifyPath = rest[++i];
    } else {
      return { code: 2, stdout: '', stderr: `unknown argument: ${rest[i]}\n${USAGE}\n` };
    }
  }
  try {
    const flow = readJson(flowPath);
    const events = readJsonl(logPath);
    const dfa = compileNfa(flow);
    const result = judgeEvents(dfa, events);
    const proof = makeProof(dfa, result);
    if (proofOut) {
      fs.writeFileSync(proofOut, `${JSON.stringify(proof, null, 2)}\n`);
    }
    const output = {
      verdict: result.verdict,
      reason: result.reason,
      prefix: result.prefix,
      continuations: result.continuations,
      path: result.path,
      finalState: result.finalState,
      proof,
    };
    if (verifyPath) {
      output.verification = verifyProof(flow, events, readJson(verifyPath));
    }
    const stdout = `${JSON.stringify(output, null, 2)}\n`;
    if (verifyPath) return { code: output.verification.ok ? 0 : 1, stdout, stderr: '' };
    return { code: result.verdict === 'accept' ? 0 : 1, stdout, stderr: '' };
  } catch (err) {
    const code = err instanceof ComplianceError ? err.code : 'INTERNAL';
    return { code: 2, stdout: '', stderr: `${JSON.stringify({ error: code, message: err.message })}\n` };
  }
}

if (require.main === module) {
  const { code, stdout, stderr } = run(process.argv.slice(2));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exitCode = code;
}

module.exports = { run };
