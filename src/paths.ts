const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function childPath(parent: string, key: string): string {
  return IDENTIFIER.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}

export function indexPath(parent: string, index: number): string {
  return `${parent}[${index}]`;
}

export function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
