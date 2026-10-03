#!/usr/bin/env node
// limit - pre-authorization credit limit ledger CLI.
//
//   limit run ops.jsonl [--explain] [--limit N]
//     Execute operations in file order. Exit 0 on success; exit 1 on the
//     first E_LIMIT/E_STATE/E_EXPIRED error or when the file exceeds
//     20000 operations; exit 2 on usage/IO/parse errors. --explain prints
//     a JSON trace line (result + full account state) after every op.
//
//   limit check log.jsonl [--limit N]
//     Linearizability check of a concurrent log. Prints LINEARIZABLE plus
//     a witness sequence (exit 0) or NOT_LINEARIZABLE (exit 1).
//
// ops.jsonl line formats (one JSON object per line):
//   {"op":"open","acc":"a","creditLimit":1000}
//   {"op":"freeze","authId":"a1","acc":"a","amount":100,"ttl":5000,"time":0}
//   {"op":"capture","authId":"a1","amount":40,"time":10}
//   {"op":"release","authId":"a1","time":20}
//   {"op":"extend","authId":"a1","ttl":1000,"time":15}
//   {"op":"sweep","time":30}
//
// log.jsonl lines for 'check' add: "id", "start", "end", and
// "result" ('ok' or an error code such as "E_LIMIT").

import { runCli } from '../src/cli.js';

process.exitCode = runCli(process.argv.slice(2));
