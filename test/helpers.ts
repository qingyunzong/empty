import assert from 'node:assert/strict';
import type { RenderResult } from '../src/index.js';

export function scanTags(template: string): Array<[number, number]> {
  const tags: Array<[number, number]> = [];
  let pos = 0;
  while (pos < template.length) {
    const open = template.indexOf('{{', pos);
    if (open === -1) break;
    const close = template.indexOf('}}', open + 2);
    if (close === -1) break;
    tags.push([open, close + 2]);
    pos = close + 2;
  }
  return tags;
}

export function resolveDisplayPath(data: unknown, path: string): unknown {
  let value = data;
  for (const token of path.match(/[^.[\]]+|\[\d+\]/g) ?? []) {
    value = token.startsWith('[')
      ? (value as Record<number, unknown>)[Number(token.slice(1, -1))]
      : (value as Record<string, unknown>)[token];
  }
  return value;
}

export function assertMapping(template: string, data: unknown, result: RenderResult): void {
  assert.equal(
    result.segments.map((s) => s.text).join(''),
    result.output,
    'segments must join back to the output',
  );

  for (const segment of result.segments) {
    if (segment.source.kind === 'template') {
      const { start, end } = segment.source;
      assert.equal(
        segment.text,
        template.slice(start, end),
        `template segment [${start}, ${end}) must match the template slice`,
      );
    } else {
      if (segment.source.path.includes('@index')) continue;
      const value = resolveDisplayPath(data, segment.source.path);
      const text = value === null || value === undefined ? '' : String(value);
      assert.equal(
        segment.text,
        text.slice(segment.source.start, segment.source.end),
        `variable segment "${segment.source.path}" must match the resolved value slice`,
      );
    }
  }

  const tags = scanTags(template);
  for (const segment of result.segments) {
    if (segment.source.kind !== 'template') continue;
    const { start, end } = segment.source;
    for (const [tagStart, tagEnd] of tags) {
      assert.ok(
        end <= tagStart || start >= tagEnd,
        `template segment [${start}, ${end}) must not overlap tag [${tagStart}, ${tagEnd})`,
      );
    }
  }
}

export function originString(result: RenderResult): string {
  return result.segments
    .map((s) => (s.source.kind === 'template' ? 'T' : 'V').repeat(s.text.length))
    .join('');
}
