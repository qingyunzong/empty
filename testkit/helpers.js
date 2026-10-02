import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rundiff-'));
}

export function makeRun(dir, { params = {}, schema = null, data = {} }) {
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'params.json'), JSON.stringify(params, null, 2));
  if (schema) fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify(schema, null, 2));
  for (const [t, csv] of Object.entries(data)) {
    fs.writeFileSync(path.join(dir, 'data', `${t}.csv`), csv);
  }
  return dir;
}

export function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

export function snapOf({ name = 'x', params = {}, tables = {}, schema = { tables: {} }, tolerance = { abs: 0, rel: 0 } }) {
  return { version: 1, name, params, tolerance, schema, tables, hash: 'h' };
}
