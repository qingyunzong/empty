import { JsonSyntaxError } from './errors.js';

export function parsePointer(pointer: string): string[] {
  if (pointer === '') {
    return [];
  }
  if (!pointer.startsWith('/')) {
    throw new JsonSyntaxError(`Invalid JSON pointer ${JSON.stringify(pointer)}`, 0);
  }
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => unescapeSegment(segment, pointer));
}

function unescapeSegment(segment: string, pointer: string): string {
  if (/~(?:[^01]|$)/.test(segment)) {
    throw new JsonSyntaxError(
      `Invalid escape in JSON pointer ${JSON.stringify(pointer)}`,
      0,
    );
  }
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

export function escapeSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

export function canonicalPointer(segments: readonly string[]): string {
  if (segments.length === 0) {
    return '';
  }
  return '/' + segments.map(escapeSegment).join('/');
}
