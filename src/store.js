'use strict';

const fs = require('fs');
const { MonitorError } = require('./monitor');

// Write-ahead log: one JSON record per line { seq, events, hash }.
// Appends are fsynced; a torn tail line (crash mid-write) is tolerated.
class Wal {
  constructor(path) {
    this.path = path;
  }

  reset() {
    fs.writeFileSync(this.path, '');
  }

  append(record) {
    const fd = fs.openSync(this.path, 'a');
    try {
      fs.writeSync(fd, JSON.stringify(record) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  readAll() {
    if (!fs.existsSync(this.path)) return [];
    const raw = fs.readFileSync(this.path, 'utf8');
    const lines = raw.split('\n');
    let lastNonEmpty = -1;
    for (let i = 0; i < lines.length; i++) if (lines[i].trim() !== '') lastNonEmpty = i;
    const out = [];
    for (let i = 0; i <= lastNonEmpty; i++) {
      const line = lines[i].trim();
      if (line === '') continue;
      try {
        out.push(JSON.parse(line));
      } catch (e) {
        if (i === lastNonEmpty) break; // torn tail write: stop before it
        throw new MonitorError(`corrupt WAL record at line ${i + 1}`);
      }
    }
    return out;
  }
}

function writeCheckpoint(path, checkpoint) {
  const tmp = path + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(checkpoint) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, path); // atomic publish
}

function readCheckpoint(path) {
  if (!fs.existsSync(path)) return null;
  const raw = fs.readFileSync(path, 'utf8').trim();
  if (raw === '') return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new MonitorError('corrupt checkpoint file');
  }
}

module.exports = { Wal, writeCheckpoint, readCheckpoint };
