'use strict';

const fs = require('fs');
const { Deframer } = require('./link');
const { FrameError } = require('./frame');
const { Engine, CrashError } = require('./engine');
const { Gateway } = require('./gateway');

// Exit codes: 0 ok | 2 corrupt frame | 3 over budget | 4 unknown reqId | 64 usage | 70 simulated crash

function formatReply(reply, n) {
  const tags = [];
  if (reply.dup) tags.push('dup');
  const reason = reply.reason ? ` reason=${reply.reason}` : '';
  const tag = tags.length ? ` [${tags.join(',')}]` : '';
  const lines = [
    `#${String(n).padStart(3, '0')} ${reply.op} member=${reply.member} req=${reply.reqId} ` +
    `want=${reply.want} got=${reply.got} decision=${reply.decision}${reason} ` +
    `budget=${reply.budget} now=${reply.now} merkle=${reply.merkle}${tag}`,
  ];
  for (const ev of reply.events || []) {
    lines.push(`     event=EXPIRED member=${ev.member} req=${ev.reqId} released=${ev.released} now=${reply.now}`);
  }
  return lines;
}

// Core entry, exported for in-process testing. Returns {code, stdout, stderr}
// where stdout/stderr are arrays of lines.
function runGateway(file, env = {}) {
  const stdout = [];
  const stderr = [];
  if (!file) {
    stderr.push('usage: node cli.js <frames.bin>');
    return { code: 64, stdout, stderr };
  }
  const budget = Number(env.CH_BUDGET || 1000);
  const ttl = Number(env.CH_TTL || 100);
  const logPath = env.CH_LOG || null;
  const crashAt = env.CH_CRASH_AT !== undefined ? Number(env.CH_CRASH_AT) : -1;
  const crashPoint = env.CH_CRASH_POINT || null;

  let records = [];
  if (logPath && fs.existsSync(logPath)) {
    records = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  }
  const engine = records.length
    ? Engine.recover({ budget, ttl, records })
    : new Engine({ budget, ttl, crashAt, crashPoint });
  const gateway = new Gateway({ engine });

  let persisted = records.length;
  const persistLog = () => {
    if (!logPath) return;
    while (persisted < engine.log.length) {
      fs.appendFileSync(logPath, JSON.stringify(engine.log.records[persisted]) + '\n');
      persisted += 1;
    }
  };

  const data = fs.readFileSync(file);
  const deframer = new Deframer();
  const CHUNK = 13; // feed the stream in odd-sized chunks to exercise fragmentation
  let n = 0;
  try {
    for (let off = 0; off < data.length; off += CHUNK) {
      const frames = deframer.push(data.subarray(off, Math.min(off + CHUNK, data.length)));
      for (const frame of frames) {
        for (const reply of gateway.handleFrame(frame)) {
          stdout.push(...formatReply(reply, n++));
        }
        persistLog();
      }
    }
    deframer.finish();
  } catch (err) {
    if (err instanceof FrameError) {
      stderr.push(`error: corrupt frame: ${err.message}`);
      return { code: 2, stdout, stderr };
    }
    if (err instanceof CrashError) {
      persistLog();
      stderr.push(`crash: ${err.message}`);
      return { code: 70, stdout, stderr };
    }
    throw err;
  }

  engine.finalize();
  const code = engine.exitFlags.has('over_budget') ? 3 : engine.exitFlags.has('unknown_req') ? 4 : 0;
  const flags = [...engine.exitFlags].join(',') || 'none';
  stderr.push(`done: decisions=${engine.log.length} flags=${flags} merkle=${engine.log.root()}`);
  return { code, stdout, stderr };
}

if (require.main === module) {
  const result = runGateway(process.argv[2], process.env);
  for (const line of result.stdout) console.log(line);
  for (const line of result.stderr) console.error(line);
  process.exit(result.code);
}

module.exports = { runGateway };
