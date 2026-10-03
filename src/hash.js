import { createHash } from 'node:crypto';

export function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

export function eventHash(evt) {
  return sha256(JSON.stringify({ seq: evt.seq, text: evt.text }));
}

export function recordHash(rec) {
  return sha256(JSON.stringify([
    rec.id, rec.version, rec.date, rec.side, rec.qty,
    rec.isin, rec.priceKind, rec.price, rec.fee,
  ]));
}
