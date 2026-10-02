import { openSync, closeSync, fsyncSync, readFileSync, renameSync, mkdirSync, readdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, sha256 } from './model.js';

// Crash-safe storage: log.jsonl is append+fsync; plan.json commits via
// plan.tmp -> fsync -> rename -> fsync(dir). A leftover plan.tmp on boot is
// an incomplete commit and is discarded, never half-applied.
export class Store {
  constructor(dir) {
    this.dir = dir;
    mkdirSync(join(dir, 'certs'), { recursive: true });
    this.logPath = join(dir, 'log.jsonl');
    this.planPath = join(dir, 'plan.json');
    this.tmpPath = join(dir, 'plan.tmp');
    // discard any incomplete commit from a crash
    if (existsSync(this.tmpPath)) rmSync(this.tmpPath);
  }

  appendOp(op) {
    const fd = openSync(this.logPath, 'a');
    try {
      writeFileSync(fd, canonical(op) + '\n');
      fsyncSync(fd);
    } finally { closeSync(fd); }
  }

  readLog() {
    if (!existsSync(this.logPath)) return [];
    return readFileSync(this.logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  commitPlan(plan) {
    const body = canonical(plan);
    const fd = openSync(this.tmpPath, 'w');
    try {
      writeFileSync(fd, body);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(this.tmpPath, this.planPath);
    const dfd = openSync(this.dir, 'r');
    try { fsyncSync(dfd); } finally { closeSync(dfd); }
  }

  readPlan() {
    if (!existsSync(this.planPath)) return null;
    const plan = JSON.parse(readFileSync(this.planPath, 'utf8'));
    if (plan.digest !== planDigest(plan)) {
      const err = new Error('plan.json checksum mismatch');
      err.code = 'E_CORRUPT';
      throw err;
    }
    return plan;
  }

  writeCert(cert) {
    const name = `cert-${String(cert.seq).padStart(6, '0')}-${cert.type}.json`;
    const p = join(this.dir, 'certs', name);
    const fd = openSync(p, 'wx');
    try {
      writeFileSync(fd, canonical(cert));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    return p;
  }

  readCerts() {
    const dir = join(this.dir, 'certs');
    return readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
      .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
  }
}

export function opHash(op) {
  const { hash, ...rest } = op;
  return sha256(canonical(rest));
}

export function planDigest(plan) {
  const { digest, ...rest } = plan;
  return sha256(canonical(rest));
}
