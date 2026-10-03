// Recursive DFS reference model of savepoint semantics, used as a test oracle.
import { applyOp } from './state.js';
import { BizError } from './errors.js';
import { computeCertificate } from './certificate.js';

function releaseRec(frames, name) {
  if (frames.length === 0) throw new BizError(`no such savepoint: ${name}`);
  const last = frames[frames.length - 1];
  if (last.name === name) return frames.slice(0, -1);
  // Everything declared after the named savepoint is destroyed too.
  return releaseRec(frames.slice(0, -1), name);
}

function rollbackRec(frames, name) {
  if (frames.length === 0) throw new BizError(`no such savepoint: ${name}`);
  const last = frames[frames.length - 1];
  if (last.name === name) return { frames, state: structuredClone(last.saved) };
  return rollbackRec(frames.slice(0, -1), name);
}

export class RefTx {
  constructor(state) {
    this.state = structuredClone(state);
    this.frames = [];
  }
  op(data) { applyOp(this.state, data); }
  savepoint(name) { this.frames.push({ name, saved: structuredClone(this.state) }); }
  release(name) { this.frames = releaseRec(this.frames, name); }
  rollback(name) {
    const r = rollbackRec(this.frames, name);
    this.frames = r.frames;
    this.state = r.state;
  }
  certificate(prevHash) {
    const s = { ...this.state, seq: this.state.seq + 1 };
    return computeCertificate(s, prevHash);
  }
}
