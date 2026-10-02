import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadTzTable } from '../src/tztable.js';
import { loadCalendar } from '../src/calendar.js';
import { hashInputs } from '../src/certificate.js';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));

export const tzdbRaw = JSON.parse(readFileSync(ROOT + 'examples/tzdb.json', 'utf8'));
export const calendarsRaw = JSON.parse(readFileSync(ROOT + 'examples/calendars.json', 'utf8'));

export function freshInputs() {
  const tzTable = loadTzTable(tzdbRaw);
  const calendars = new Map(
    calendarsRaw.map((c) => {
      const cal = loadCalendar(c);
      return [cal.id, cal];
    }),
  );
  const inputHashes = hashInputs({ tzdbRaw, calendarsRaw });
  return { tzTable, calendars, inputHashes };
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
