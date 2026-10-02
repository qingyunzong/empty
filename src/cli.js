import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { AppendLog, AuditError, recoverLog, verifyLog, READONLY_MARKER } from './log.js';
import { DEFAULT_PAGE_SIZE } from './page.js';

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_CORRUPT = 2;

const defaultIo = {
  out: (s) => process.stdout.write(s + '\n'),
  err: (s) => process.stderr.write(s + '\n'),
  readStdin: () => fs.readFileSync(0, 'utf8'),
};

function fail(io, code, message, details) {
  io.err(JSON.stringify({ error: { code, message, ...(details ? { details } : {}) } }));
  return code === 'CORRUPT' ? EXIT_CORRUPT : EXIT_ERROR;
}

function loadConfig(configPath) {
  if (!configPath) return {};
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function readRecords(io, inputPath) {
  const text = inputPath ? fs.readFileSync(inputPath, 'utf8') : io.readStdin();
  const records = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      throw new AuditError('CORRUPT', `invalid JSON on input line ${i + 1}`);
    }
  }
  return records;
}

function cmdAppend(io, argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      log: { type: 'string' },
      input: { type: 'string' },
      config: { type: 'string' },
    },
    strict: true,
  });
  if (!values.log) return fail(io, 'CORRUPT', 'append requires --log <dir>');
  const config = loadConfig(values.config);
  if (fs.existsSync(path.join(values.log, READONLY_MARKER))) {
    return fail(io, 'READONLY', `log is marked read-only: ${values.log}`);
  }
  let log;
  try {
    log = AppendLog.open(values.log, {
      pageSize: config.pageSize ?? DEFAULT_PAGE_SIZE,
      bufferPages: config.bufferPages ?? 4,
      quotas: config.quotas ?? {},
      agingFactor: config.agingFactor ?? 1,
    });
  } catch (err) {
    if (err instanceof AuditError) return fail(io, err.code, err.message, err.details);
    throw err;
  }
  const violations = [];
  let appended = 0;
  try {
    for (const record of readRecords(io, values.input)) {
      try {
        log.append(record);
        appended += 1;
      } catch (err) {
        if (err instanceof AuditError) {
          violations.push({
            code: err.code,
            tenant: record?.tenant ?? null,
            seq: record?.seq ?? null,
            message: err.message,
          });
        } else {
          throw err;
        }
      }
    }
    log.flush();
  } catch (err) {
    if (err instanceof AuditError) return fail(io, err.code, err.message, err.details);
    throw err;
  } finally {
    log.close();
  }
  io.out(JSON.stringify({ stats: { ...log.stats(), appended }, root: log.root(), violations }, null, 2));
  return EXIT_OK;
}

function cmdRecover(io, argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      log: { type: 'string' },
      config: { type: 'string' },
    },
    strict: true,
  });
  if (!values.log) return fail(io, 'CORRUPT', 'recover requires --log <dir>');
  const config = loadConfig(values.config);
  const report = recoverLog(values.log, { pageSize: config.pageSize ?? DEFAULT_PAGE_SIZE });
  io.out(JSON.stringify({
    stats: {
      committedPages: report.committedPages,
      records: report.records,
      truncatedBytes: report.truncatedBytes,
      quarantined: report.quarantine.length,
    },
    root: report.root,
    violations: [],
    quarantine: report.quarantine,
  }, null, 2));
  return EXIT_OK;
}

function cmdVerify(io, argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      log: { type: 'string' },
      config: { type: 'string' },
    },
    strict: true,
  });
  if (!values.log) return fail(io, 'CORRUPT', 'verify requires --log <dir>');
  const config = loadConfig(values.config);
  const report = verifyLog(values.log, { pageSize: config.pageSize ?? DEFAULT_PAGE_SIZE });
  const violations = report.violations.map((v) => ({
    code: v.code === 'SEQ_GAP' ? 'SEQ_GAP' : 'CORRUPT',
    ...v,
  }));
  io.out(JSON.stringify({ ok: report.ok, stats: report.stats, root: report.root, violations }, null, 2));
  return report.ok ? EXIT_OK : EXIT_CORRUPT;
}

export async function main(argv, io = defaultIo) {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'append':
        return cmdAppend(io, rest);
      case 'recover':
        return cmdRecover(io, rest);
      case 'verify':
        return cmdVerify(io, rest);
      default:
        io.err('usage: auditlog <append|recover|verify> --log <dir> [--input file] [--config file]');
        return EXIT_ERROR;
    }
  } catch (err) {
    if (err instanceof AuditError) return fail(io, err.code, err.message, err.details);
    io.err(JSON.stringify({ error: { code: 'INTERNAL', message: err.message } }));
    return EXIT_ERROR;
  }
}
