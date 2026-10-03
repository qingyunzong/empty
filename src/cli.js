#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { lex } = require('./lexer');
const { compile } = require('./compiler');
const { replay, explain, enumerateTopoOrders } = require('./adjudicator');

function usage() {
  console.error(
    [
      'usage: node src/cli.js <logfile> [--explain] [--topo]',
      '',
      'log line grammar:',
      '  note: <free text>                      annotation, ignored by the adjudicator',
      '  <node> <clock> commit <key> = <value> [after <node>@<clock> ...]',
      '  <node> <clock> mask <key>             [after <node>@<clock> ...]',
      '  <node> <clock> rollback <key>         [after <node>@<clock> ...]',
    ].join('\n'),
  );
}

function main(argv) {
  const args = argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const files = args.filter((a) => !a.startsWith('--'));
  if (files.length !== 1) {
    usage();
    return 2;
  }

  let program;
  try {
    const source = fs.readFileSync(files[0], 'utf8');
    program = compile(lex(source));
  } catch (err) {
    console.error(`error: ${err.message}`);
    return 1;
  }

  let result;
  try {
    result = replay(program);
  } catch (err) {
    console.error(`error: ${err.message}`);
    return 1;
  }

  if (flags.has('--explain')) {
    console.log(explain(program, result));
    console.log('');
  }

  console.log('order:');
  result.order.forEach((id, i) => console.log(`  ${i + 1}. ${id}`));
  console.log('state:');
  const keys = Object.keys(result.state);
  if (keys.length === 0) console.log('  (empty)');
  for (const k of keys) console.log(`  ${k} = ${JSON.stringify(result.state[k])}`);

  if (result.conflicts.length) {
    console.log('conflict certificates:');
    for (const c of result.conflicts) {
      console.log(`  key "${c.key}":`);
      for (const e of c.events) {
        console.log(`    ${e.id} value=${JSON.stringify(e.value)}`);
      }
      console.log(`    reason: ${c.reason}`);
      console.log('    causal edges among same-key events:');
      if (c.causalEdges.length === 0) console.log('      (none)');
      for (const e of c.causalEdges) console.log(`      ${e.from} -> ${e.to}  [${e.reason}]`);
    }
  }

  if (flags.has('--topo')) {
    const { adj, indeg, events } = result.graph;
    const all = enumerateTopoOrders(events, adj, indeg);
    console.log(`all topological orders (${all.length}):`);
    all.forEach((ord, i) => console.log(`  ${i + 1}. ${ord.join('  ')}`));
    console.log(`deterministic choice: ${result.order.join('  ')}`);
  }

  return result.conflicts.length ? 3 : 0;
}

process.exit(main(process.argv));
