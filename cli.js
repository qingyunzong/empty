#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { FactoringLedger, FactoringError } from './src/factoring.js';

const USAGE = `Usage: node cli.js <command> [options]

Commands:
  add         Add an invoice and freeze its financing amount
  revoke      Revoke an invoice, release its amount, print certificate
  status      Show credit limit, frozen total and available amount
  clusters    List association clusters
  candidates  List match candidates for an invoice (distance, amount diff)

Common options:
  --file <path>       Data file (default: ./factoring.json)

add options:
  --id <id> --creditor <name> --face <amount> --rate <0-1> [--memo <text>]
  --limit <amount>    Credit limit (required when creating a new data file)
  --slop <n>          Near-neighbor slop, integer >= 0 (default 0 for new file)

revoke/candidates options:
  --id <id>
`;

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function parseCommon(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      file: { type: 'string', default: './factoring.json' },
      id: { type: 'string' },
      creditor: { type: 'string' },
      face: { type: 'string' },
      rate: { type: 'string' },
      memo: { type: 'string', default: '' },
      limit: { type: 'string' },
      slop: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  return { values, positionals };
}

function main() {
  const argv = process.argv.slice(2);
  const { values, positionals } = parseCommon(argv);
  const command = positionals[0];
  if (!command || values.help) {
    process.stdout.write(USAGE);
    process.exit(command ? 0 : 1);
  }

  let ledger;
  try {
    switch (command) {
      case 'add': {
        for (const key of ['id', 'creditor', 'face', 'rate']) {
          if (values[key] === undefined) fail(`missing --${key}`);
        }
        if (existsSync(values.file)) {
          ledger = FactoringLedger.load(values.file);
        } else {
          if (values.limit === undefined) fail('missing --limit for new data file');
          ledger = new FactoringLedger({
            creditLimit: Number(values.limit),
            slop: values.slop !== undefined ? Number(values.slop) : 0,
          });
        }
        const invoice = ledger.addInvoice({
          id: values.id,
          creditor: values.creditor,
          faceValue: Number(values.face),
          advanceRate: Number(values.rate),
          memo: values.memo,
        });
        ledger.save(values.file);
        console.log(JSON.stringify({ added: invoice, frozenTotal: ledger.frozenTotal(), available: ledger.available() }, null, 2));
        break;
      }
      case 'revoke': {
        if (values.id === undefined) fail('missing --id');
        ledger = FactoringLedger.load(values.file);
        const certificate = ledger.revoke(values.id);
        ledger.save(values.file);
        console.log(JSON.stringify({ certificate, frozenTotal: ledger.frozenTotal(), available: ledger.available() }, null, 2));
        break;
      }
      case 'status': {
        ledger = FactoringLedger.load(values.file);
        console.log(JSON.stringify({
          creditLimit: ledger.creditLimit,
          slop: ledger.slop,
          frozenTotal: ledger.frozenTotal(),
          available: ledger.available(),
          invoices: [...ledger.invoices.values()],
        }, null, 2));
        break;
      }
      case 'clusters': {
        ledger = FactoringLedger.load(values.file);
        console.log(JSON.stringify(ledger.clusters(), null, 2));
        break;
      }
      case 'candidates': {
        if (values.id === undefined) fail('missing --id');
        ledger = FactoringLedger.load(values.file);
        console.log(JSON.stringify(ledger.matchCandidates(values.id), null, 2));
        break;
      }
      default:
        fail(`unknown command: ${command}`);
    }
  } catch (err) {
    if (err instanceof FactoringError) fail(`${err.code}: ${err.message}`);
    throw err;
  }
}

main();
