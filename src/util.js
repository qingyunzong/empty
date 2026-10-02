import {createHash} from 'node:crypto';

export function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function sha256hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

export function cmpStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
