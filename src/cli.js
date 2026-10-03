import fs from 'node:fs';
import { Archive } from './archive.js';

function readJsonl(path) {
  return fs.readFileSync(path, 'utf8').split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
}

export function runCli(argv, env = {}, write = (s) => process.stdout.write(s)) {
  const dataDir = env.WXA_DATA ?? '.wxa';
  const archive = new Archive(dataDir, { crashAt: env.WXA_CRASH_AT ?? null });
  const out = (obj) => write(JSON.stringify(obj, null, 2) + '\n');
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'ingest': {
      const records = readJsonl(args[0]);
      const eventIds = archive.ingest(records);
      out({ ok: true, ingested: eventIds.length, eventIds });
      return 0;
    }
    case 'correct': {
      const batch = JSON.parse(fs.readFileSync(args[0], 'utf8'));
      const result = archive.correct(batch);
      out({ ok: true, ...result });
      return 0;
    }
    case 'undo': {
      const eventId = archive.undo(args[0]);
      out({ ok: true, undone: args[0], undoEventId: eventId });
      return 0;
    }
    case 'query': {
      const [site, from, to] = args;
      const brute = env.WXA_BRUTE === '1';
      const asOf = env.WXA_AS_OF_LAMPORT ? Number(env.WXA_AS_OF_LAMPORT) : null;
      const result = archive.query(site, from, to, { brute, asOfLamport: asOf });
      out({ site, from, to, ...result });
      return 0;
    }
    case 'audit': {
      out(archive.audit(args[0]));
      return 0;
    }
    case 'certificate': {
      out(archive.certificate(args[0]));
      return 0;
    }
    case 'verify': {
      const cert = JSON.parse(fs.readFileSync(args[0], 'utf8'));
      out(Archive.verifyCertificate(cert, archive));
      return 0;
    }
    default:
      throw new Error('usage: wxa <ingest|correct|undo|query|audit|certificate|verify> ...');
  }
}
