'use strict';

const fs = require('node:fs');
const { replay, ReconError } = require('./recon');

const LOG_FILE = 'events.jsonl';

function readRecords(logPath) {
  if (!fs.existsSync(logPath)) return [];
  const text = fs.readFileSync(logPath, 'utf8');
  const records = [];
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  lines.forEach((line, i) => {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new ReconError('LOG_CORRUPT', `log line ${i + 1} is not valid JSON: ${err.message}`);
    }
    if (parsed === null || typeof parsed !== 'object' || parsed.event === undefined) {
      throw new ReconError('LOG_CORRUPT', `log line ${i + 1} is missing the "event" field`);
    }
    records.push(parsed);
  });
  return records;
}

function replayLogFile(logPath) {
  const records = readRecords(logPath);
  const engine = replay(
    records.map((r) => r.event),
    records.map((r) => r.result),
  );
  return { engine, records };
}

function appendRecords(logPath, records, startSeq) {
  if (records.length === 0) return;
  const lines = records.map((r, i) => JSON.stringify({ seq: startSeq + i, event: r.event, result: r.result }));
  fs.appendFileSync(logPath, lines.join('\n') + '\n', 'utf8');
}

module.exports = { LOG_FILE, readRecords, replayLogFile, appendRecords };
