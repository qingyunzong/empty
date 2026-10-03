import { createHash } from 'node:crypto';
import { QError } from './errors.js';
import { decodeSegment, findPhrase } from './segment.js';
import { computeHead, elemHashHex } from './manifest.js';

const sha256hex = (buf) => createHash('sha256').update(buf).digest('hex');

// Third-party verification: pure functions, no keys, no network.
export function verifyInclusion(proof, phrase = null) {
  const data = Buffer.from(proof.segmentB64, 'base64');
  const seg = decodeSegment(data); // E_TORN if malformed
  if (sha256hex(data) !== proof.segHash) throw new QError('E_CHAIN', 'segment hash mismatch');
  const el = proof.elements[proof.index];
  if (!el || el.kind !== 'seg' || el.id !== proof.id || el.hash !== proof.segHash) {
    throw new QError('E_CHAIN', 'chain element mismatch');
  }
  if (computeHead(proof.elements) !== proof.head) throw new QError('E_CHAIN', 'head mismatch');
  const result = { id: proof.id, epoch: proof.epoch, head: proof.head, text: seg.text };
  if (phrase !== null) {
    result.positions = findPhrase(seg.index, phrase);
    if (result.positions.length === 0) throw new QError('E_ABSENT', 'phrase not in segment');
  }
  return result;
}

export function verifyExclusion(proof) {
  if (computeHead(proof.elements) !== proof.head) throw new QError('E_CHAIN', 'head mismatch');
  const t = proof.tombstone;
  const els = proof.elements;
  const idx = els.findIndex(
    (e) => e.kind === 'tomb' && e.id === t.id && e.hash === t.hash && e.epoch === t.epoch,
  );
  if (idx < 0) throw new QError('E_ABSENT', 'tombstone not in chain');
  const pred = idx > 0 ? elemHashHex(els[idx - 1]) : null;
  const succ = idx < els.length - 1 ? elemHashHex(els[idx + 1]) : null;
  if (pred !== t.pred || succ !== t.succ) {
    throw new QError('E_CHAIN', 'tombstone pred/succ mismatch');
  }
  if (els.some((e) => e.kind === 'seg' && (e.id === t.id || e.hash === t.hash))) {
    throw new QError('E_CHAIN', 'segment still live');
  }
  return { id: t.id, epoch: proof.epoch, head: proof.head };
}

export function verifyProof(proof, phrase = null) {
  if (proof.type === 'inclusion') return { inclusion: verifyInclusion(proof, phrase) };
  if (proof.type === 'exclusion') return { exclusion: verifyExclusion(proof) };
  if (proof.type === 'exclusion+inclusion') {
    return {
      exclusion: verifyExclusion(proof.exclusion),
      inclusion: proof.inclusion ? verifyInclusion(proof.inclusion, phrase) : null,
    };
  }
  throw new QError('E_ABSENT', `unknown proof type ${proof.type}`);
}
