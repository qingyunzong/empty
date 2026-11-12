import { createHash } from 'node:crypto';
import { JoinEngineError } from './errors.ts';
import type { Atom, JoinInput, Row } from './types.ts';

const encoder = new TextEncoder();

const INTEGER_PATTERN = /^(?:0|-?[1-9][0-9]*)$/;

export function utf8Bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

export function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const limit = Math.min(left.length, right.length);
  for (let index = 0; index < limit; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] < right[index] ? -1 : 1;
    }
  }
  return left.length === right.length ? 0 : left.length < right.length ? -1 : 1;
}

export function compareUtf8(left: string, right: string): number {
  return compareBytes(utf8Bytes(left), utf8Bytes(right));
}

export function assertCanonicalInteger(text: string): void {
  if (!INTEGER_PATTERN.test(text)) {
    throw new JoinEngineError(
      'INVALID_INTEGER',
      `value ${JSON.stringify(text)} is not a canonical decimal integer`,
    );
  }
}

export function compareAtoms(left: Atom, right: Atom): number {
  if (typeof left === 'bigint' && typeof right === 'bigint') {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  if (typeof left === 'string' && typeof right === 'string') {
    return compareUtf8(left, right);
  }
  throw new JoinEngineError('TYPE_MISMATCH', 'cannot compare values of different domains');
}

function atomKey(atom: Atom): string {
  if (typeof atom === 'bigint') {
    return `i:${atom.toString()};`;
  }
  const bytes = utf8Bytes(atom);
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return `s:${hex};`;
}

export function rowKey(row: Row, attributes: readonly string[]): string {
  let key = '';
  for (const attribute of attributes) {
    key += `${atomKey(row[attribute])}|`;
  }
  return key;
}

export function compareRows(
  left: Row,
  right: Row,
  attributes: readonly string[],
): number {
  for (const attribute of attributes) {
    const result = compareAtoms(left[attribute], right[attribute]);
    if (result !== 0) {
      return result;
    }
  }
  return 0;
}

export function canonicalRowOrder(
  rows: readonly Row[],
  attributes: readonly string[],
): Row[] {
  return [...rows].sort((left, right) => compareRows(left, right, attributes));
}

function atomFingerprintLine(atom: Atom): string {
  return typeof atom === 'bigint' ? `i\t${atom.toString()}` : `s\t${atom}`;
}

export function inputFingerprint(input: JoinInput): string {
  const lines: string[] = [];
  const relations = [...input.relations].sort((left, right) =>
    compareUtf8(left.name, right.name),
  );
  for (const relation of relations) {
    lines.push(`R\t${relation.name}`);
    const attributes = [...relation.attributes].sort(compareUtf8);
    const distinctRows = new Map<string, Row>();
    for (const row of relation.rows) {
      distinctRows.set(rowKey(row, attributes), row);
    }
    const rows = canonicalRowOrder([...distinctRows.values()], attributes);
    for (const attribute of attributes) {
      lines.push(`A\t${attribute}`);
    }
    for (const row of rows) {
      lines.push('W');
      for (const attribute of attributes) {
        lines.push(atomFingerprintLine(row[attribute]));
      }
    }
  }
  const normalizedEdges = input.edges
    .map(([left, right]): [string, string] =>
      compareUtf8(left, right) <= 0 ? [left, right] : [right, left],
    )
    .sort(([la, ra], [lb, rb]) => {
      const first = compareUtf8(la, lb);
      return first !== 0 ? first : compareUtf8(ra, rb);
    });
  for (const [left, right] of normalizedEdges) {
    lines.push(`E\t${left}\t${right}`);
  }
  return createHash('sha256').update(lines.join('\n')).digest().toString('hex');
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest().toString('hex');
}

const base64UrlAlphabet =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function base64UrlEncode(bytes: Uint8Array): string {
  let output = '';
  let index = 0;
  while (index + 3 <= bytes.length) {
    const chunk = (bytes[index] << 16) | (bytes[index + 1] << 8) | bytes[index + 2];
    output += base64UrlAlphabet[(chunk >> 18) & 63];
    output += base64UrlAlphabet[(chunk >> 12) & 63];
    output += base64UrlAlphabet[(chunk >> 6) & 63];
    output += base64UrlAlphabet[chunk & 63];
    index += 3;
  }
  const remainder = bytes.length - index;
  if (remainder === 1) {
    const chunk = bytes[index] << 16;
    output += base64UrlAlphabet[(chunk >> 18) & 63];
    output += base64UrlAlphabet[(chunk >> 12) & 63];
  } else if (remainder === 2) {
    const chunk = (bytes[index] << 16) | (bytes[index + 1] << 8);
    output += base64UrlAlphabet[(chunk >> 18) & 63];
    output += base64UrlAlphabet[(chunk >> 12) & 63];
    output += base64UrlAlphabet[(chunk >> 6) & 63];
  }
  return output;
}

export function base64UrlDecode(text: string): Uint8Array {
  const values = new Map<string, number>();
  for (let index = 0; index < base64UrlAlphabet.length; index += 1) {
    values.set(base64UrlAlphabet[index], index);
  }
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of text) {
    const value = values.get(character);
    if (value === undefined) {
      throw new JoinEngineError('TOKEN_CORRUPT', 'token contains invalid base64url data');
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 255);
    }
  }
  return Uint8Array.from(bytes);
}
