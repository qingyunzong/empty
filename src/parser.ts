export interface RawLink {
  text: string;
  label: string;
}

export interface RawBlock {
  kind: 'heading' | 'paragraph';
  level: number;
  text: string;
  startLine: number;
  endLine: number;
  links: RawLink[];
}

const HEADING_RE = /^[ \t]{0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const DEF_RE = /^[ \t]{0,3}\[([^\]\n]+)\]:[ \t]*(\S+)[ \t]*$/;
const LINK_RE = /\[([^\]\n]*)\]\[([^\]\n]*)\]/g;
const BLANK_RE = /^[ \t]*$/;

export function normalizeLabel(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}

export type LineKind = 'blank' | 'heading' | 'definition' | 'text';

export function classifyLine(line: string): LineKind {
  if (BLANK_RE.test(line)) return 'blank';
  if (DEF_RE.test(line)) return 'definition';
  if (HEADING_RE.test(line)) return 'heading';
  return 'text';
}

export function parseDefinition(line: string): { label: string; url: string } | null {
  const match = DEF_RE.exec(line);
  if (!match) return null;
  return { label: normalizeLabel(match[1]), url: match[2] };
}

export function parseLinks(text: string): RawLink[] {
  const links: RawLink[] = [];
  LINK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = LINK_RE.exec(text)) !== null) {
    const linkText = match[1];
    const rawLabel = match[2] === '' ? linkText : match[2];
    const label = normalizeLabel(rawLabel);
    if (label === '') continue;
    links.push({ text: linkText, label });
  }
  return links;
}

export function parseBlocks(lines: string[], start: number, end: number): RawBlock[] {
  const blocks: RawBlock[] = [];
  let i = start;
  while (i < end) {
    const kind = classifyLine(lines[i]);
    if (kind === 'blank' || kind === 'definition') {
      i++;
      continue;
    }
    if (kind === 'heading') {
      const level = HEADING_RE.exec(lines[i])![1].length;
      blocks.push({
        kind: 'heading',
        level,
        text: lines[i],
        startLine: i,
        endLine: i + 1,
        links: parseLinks(lines[i]),
      });
      i++;
      continue;
    }
    const buffer: string[] = [];
    let j = i;
    while (j < end && classifyLine(lines[j]) === 'text') {
      buffer.push(lines[j]);
      j++;
    }
    const text = buffer.join('\n');
    blocks.push({
      kind: 'paragraph',
      level: 0,
      text,
      startLine: i,
      endLine: j,
      links: parseLinks(text),
    });
    i = j;
  }
  return blocks;
}
