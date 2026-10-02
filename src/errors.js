export class InvalidInput extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidInput';
    this.code = 'INVALID_INPUT';
  }
}

export function parseUint(value, name, { min = 0, max = 0xffffffff } = {}) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      throw new InvalidInput(`${name} must be an integer, got "${value}"`);
    }
    value = Number(trimmed);
  }
  if (!Number.isInteger(value)) {
    throw new InvalidInput(`${name} must be an integer, got ${value}`);
  }
  if (value < min || value > max) {
    throw new InvalidInput(`${name} out of range [${min}, ${max}]: ${value}`);
  }
  return value;
}
