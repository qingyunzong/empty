import { BusinessError } from './errors.js';

export const DEFAULT_CATALOG = {
  'dimension.length': { min: 9.9, max: 10.1, absMin: 0, absMax: 100, unit: 'mm' },
  'dimension.weight': { min: 49.5, max: 50.5, absMin: 0, absMax: 1000, unit: 'g' },
  'electrical.voltage': { min: 3.2, max: 3.4, absMin: 0, absMax: 10, unit: 'V' },
  'visual.defects': { min: 0, max: 0, absMin: 0, absMax: 100, unit: 'count' }
};

export function validateCatalog(catalog) {
  if (catalog === null || typeof catalog !== 'object' || Array.isArray(catalog)) {
    throw new BusinessError('INVALID_CATALOG', 'catalog must be an object keyed by testCode');
  }
  for (const [code, item] of Object.entries(catalog)) {
    const nums = ['min', 'max', 'absMin', 'absMax'];
    for (const field of nums) {
      if (typeof item?.[field] !== 'number' || !Number.isFinite(item[field])) {
        throw new BusinessError('INVALID_CATALOG', `catalog entry "${code}" missing numeric ${field}`);
      }
    }
    if (!(item.absMin <= item.min && item.min <= item.max && item.max <= item.absMax)) {
      throw new BusinessError('INVALID_CATALOG', `catalog entry "${code}" must satisfy absMin <= min <= max <= absMax`);
    }
  }
  return catalog;
}

export function getTestItem(catalog, testCode) {
  const item = catalog[testCode];
  if (!item) {
    throw new BusinessError('UNKNOWN_TEST_CODE', `unknown test code: ${JSON.stringify(testCode)}`);
  }
  return item;
}

export function validateValue(item, testCode, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BusinessError('INVALID_VALUE', `value for ${testCode} must be a finite number, got ${JSON.stringify(value)}`);
  }
  if (value < item.absMin || value > item.absMax) {
    throw new BusinessError(
      'VALUE_OUT_OF_RANGE',
      `value ${value} for ${testCode} outside physical range [${item.absMin}, ${item.absMax}] ${item.unit ?? ''}`.trim()
    );
  }
}
