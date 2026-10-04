import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ReplaceSession } from '../src/session';
import { interpret } from '../src/reference';
import { tagText, untag, taggedReplace, type TaggedChar } from '../src/tagged';
import type { CaptureMatch, Range } from '../src/types';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = ['a', 'b', 'c', ' ', 'x', 'é', '\u{1F600}'];

function makeRng(seed: number) {
  const next = mulberry32(seed);
  const int = (lo: number, hi: number): number => lo + Math.floor(next() * (hi - lo + 1));
  return { next, int };
}

function randomText(rng: ReturnType<typeof makeRng>): string {
  const len = rng.int(3, 24);
  let s = '';
  for (let i = 0; i < len; i += 1) s += ALPHABET[rng.int(0, ALPHABET.length - 1)];
  return s;
}

function randomRound(
  rng: ReturnType<typeof makeRng>,
  text: string,
): { matches: CaptureMatch[]; templates: string[] } {
  const n = text.length;
  const matches: CaptureMatch[] = [];
  const templates: string[] = [];
  let cursor = 0;
  const count = rng.int(0, 4);
  for (let k = 0; k < count && cursor <= n; k += 1) {
    const start = cursor + rng.int(0, n - cursor);
    let end: number;
    if (start === n || rng.next() < 0.25) end = start;
    else end = start + 1 + rng.int(0, n - start - 1);
    const groupCount = rng.int(0, 2);
    const captures: (Range | null)[] = [];
    for (let g = 0; g < groupCount; g += 1) {
      if (rng.next() < 0.2 || end === start) {
        captures.push(end === start && rng.next() < 0.5 ? { start, end: start } : null);
      } else {
        const cs = start + rng.int(0, end - start);
        const ce = cs + rng.int(0, end - cs);
        captures.push({ start: cs, end: ce });
      }
    }
    matches.push({ start, end, captures });
    templates.push(randomTemplate(rng, groupCount));
    cursor = end;
  }
  return { matches, templates };
}

function randomTemplate(rng: ReturnType<typeof makeRng>, groupCount: number): string {
  const tokens = rng.int(0, 4);
  let t = '';
  for (let i = 0; i < tokens; i += 1) {
    const r = rng.next();
    if (r < 0.3) {
      const len = rng.int(1, 3);
      for (let j = 0; j < len; j += 1) t += ALPHABET[rng.int(0, 4)]; // no '$' or astral here
    } else if (r < 0.45) {
      t += rng.next() < 0.5 ? '$$' : '$x';
    } else if (r < 0.7) {
      t += '$&';
    } else if (groupCount > 0) {
      t += `$${rng.int(1, groupCount)}`;
    } else {
      t += 'z';
    }
  }
  return t;
}

function expandRanges(ranges: Range[]): number[] {
  const out: number[] = [];
  for (const r of ranges) for (let p = r.start; p < r.end; p += 1) out.push(p);
  return out.sort((a, b) => a - b);
}

test('random three-round replacements match direct source-label propagation', () => {
  for (let seed = 1; seed <= 60; seed += 1) {
    const rng = makeRng(seed);
    const original = randomText(rng);
    const session = new ReplaceSession(original);
    let tags: TaggedChar[] = tagText(original);
    for (let round = 0; round < 3; round += 1) {
      const { matches, templates } = randomRound(rng, session.current);
      const before = session.current;
      const applied = session.applyRound(matches, templates);
      // cross-check against the naive segment-by-segment interpreter
      assert.equal(interpret(before, matches, templates), applied.output, `seed ${seed} round ${round}`);
      // direct source-label propagation
      tags = taggedReplace(tags, matches, templates);
      assert.equal(untag(tags), session.current, `seed ${seed} round ${round} text`);
    }
    const map = session.composedMap();
    assert.ok(map);
    assert.equal(map.inLength, original.length);
    assert.equal(map.outLength, session.current.length);
    // forward: every output position resolves to its propagated source label
    for (let outPos = 0; outPos < session.current.length; outPos += 1) {
      assert.equal(map.forward(outPos), tags[outPos].src, `seed ${seed} forward(${outPos})`);
    }
    // inverse: every source position resolves to exactly the propagated output positions
    for (let srcPos = 0; srcPos < original.length; srcPos += 1) {
      const expected: number[] = [];
      for (let i = 0; i < tags.length; i += 1) if (tags[i].src === srcPos) expected.push(i);
      assert.deepEqual(
        expandRanges(map.inverse(srcPos)),
        expected,
        `seed ${seed} inverse(${srcPos})`,
      );
    }
    // rollback unwinds every round back to the original text
    assert.equal(session.roundCount, 3);
    session.rollback();
    session.rollback();
    session.rollback();
    assert.equal(session.current, original);
    assert.equal(session.composedMap(), null);
  }
});
