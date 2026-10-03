#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { AuditService } from './src/service.js';
import { AuditError } from './src/errors.js';

const STATE_FILE = process.env.AUDIT_STATE ?? '.audit-state.json';

function load() {
  if (!existsSync(STATE_FILE)) return new AuditService();
  return AuditService.fromJSON(JSON.parse(readFileSync(STATE_FILE, 'utf8')));
}

function save(service) {
  writeFileSync(STATE_FILE, `${JSON.stringify(service.toJSON(), null, 2)}\n`);
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

const [command, ...args] = process.argv.slice(2);

try {
  const service = load();
  switch (command) {
    case 'import': {
      const strict = args.includes('--strict');
      const payload = readJson(args.find((a) => !a.startsWith('--')));
      const result = service.importBatch(payload, { strict });
      save(service);
      print(result);
      break;
    }
    case 'query': {
      print(service.query(Number(args[0])));
      break;
    }
    case 'report': {
      const bound = args.length >= 2 ? [Number(args[0]), Number(args[1])] : undefined;
      print(service.report(bound));
      break;
    }
    case 'patch': {
      const result = service.applyPatch(readJson(args[0]));
      save(service);
      print(result);
      break;
    }
    case 'revoke': {
      const result = service.revokePatch(args[0]);
      save(service);
      print(result);
      break;
    }
    case 'certs': {
      print(service.certs.map((c) => ({ id: c.id, body: c.body })));
      break;
    }
    case 'verify': {
      print({ ok: service.verify(), certs: service.certs.length });
      break;
    }
    case 'reset': {
      save(new AuditService());
      print({ ok: true });
      break;
    }
    default:
      process.stderr.write([
        'usage: node cli.js <command>',
        '  import <batch.json> [--strict]   register intervals, issue certificate',
        '  query <point>                    point membership status',
        '  report [lo hi]                   normalized sets, overlaps, gaps',
        '  patch <patch.json>               reverse interval patch (add/subtract)',
        '  revoke <patchId>                 revoke latest patch, restore holes',
        '  certs                            list certificates',
        '  verify                           verify the certificate chain',
        '  reset                            clear local state',
        '',
      ].join('\n'));
      process.exitCode = command ? 1 : 0;
  }
} catch (err) {
  if (err instanceof AuditError) {
    process.stderr.write(`${JSON.stringify({ error: err.code, message: err.message, details: err.details ?? null })}\n`);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
