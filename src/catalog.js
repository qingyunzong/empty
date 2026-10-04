import fs from 'node:fs';
import path from 'node:path';
import { BusinessError, CorruptionError } from './errors.js';

export const DEFAULT_CATALOG = {
  DIM_LEN: { unit: 'mm', specLower: 9.9, specUpper: 10.1, absMin: 0, absMax: 1000, ncrBelow: 9.5, ncrAbove: 10.5 },
  WEIGHT: { unit: 'g', specLower: 49.5, specUpper: 50.5, absMin: 0, absMax: 10000, ncrBelow: 48, ncrAbove: 52 },
  VOLTAGE: { unit: 'V', specLower: 3.2, specUpper: 3.7, absMin: 0, absMax: 100 },
};

export function validateCatalog(catalog) {
  if (catalog === null || typeof catalog !== 'object' || Array.isArray(catalog)) {
    throw new BusinessError('ERR_INVALID_CATALOG', 'catalog must be an object keyed by testCode');
  }
  for (const [code, item] of Object.entries(catalog)) {
    const nums = ['specLower', 'specUpper', 'absMin', 'absMax'];
    for (const k of nums) {
      if (typeof item?.[k] !== 'number' || !Number.isFinite(item[k])) {
        throw new BusinessError('ERR_INVALID_CATALOG', `catalog item ${code}: ${k} must be a finite number`);
      }
    }
    if (!(item.absMin <= item.specLower && item.specLower <= item.specUpper && item.specUpper <= item.absMax)) {
      throw new BusinessError('ERR_INVALID_CATALOG', `catalog item ${code}: require absMin <= specLower <= specUpper <= absMax`);
    }
  }
  return catalog;
}

export function loadCatalog(dir) {
  const file = path.join(dir, 'catalog.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new BusinessError('ERR_NOT_INITIALIZED', `database not initialized at ${dir} (missing catalog.json)`);
  }
  let catalog;
  try {
    catalog = JSON.parse(raw);
  } catch {
    throw new CorruptionError(`catalog.json is not valid JSON`);
  }
  try {
    return validateCatalog(catalog);
  } catch (err) {
    if (err instanceof BusinessError && err.code === 'ERR_INVALID_CATALOG') {
      throw new CorruptionError(`catalog.json invalid: ${err.message}`);
    }
    throw err;
  }
}

export function judge(value, item, testCode) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BusinessError('ERR_INVALID_VALUE', `value for ${testCode} must be a finite number`, { value });
  }
  if (value < item.absMin || value > item.absMax) {
    throw new BusinessError(
      'ERR_VALUE_OUT_OF_RANGE',
      `value ${value} for ${testCode} outside plausible range [${item.absMin}, ${item.absMax}]`,
      { value, absMin: item.absMin, absMax: item.absMax },
    );
  }
  if (value >= item.specLower && value <= item.specUpper) return 'OK';
  if ((item.ncrBelow != null && value < item.ncrBelow) || (item.ncrAbove != null && value > item.ncrAbove)) return 'NCR';
  return 'NG';
}
