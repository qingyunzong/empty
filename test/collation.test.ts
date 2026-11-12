import assert from "node:assert/strict";
import test from "node:test";

import {
  AlreadyFinishedError,
  BudgetExceededError,
  Collator,
  Compare,
  DuplicateRuleError,
  InvalidRuleError,
  InvalidScalarError,
  NotFinishedError,
  PushAfterFinishError,
  RuleLimitExceededError,
  compareKeyBytes,
  compareLevels,
  stableSortByCollation,
  type CE,
  type CollationElement,
  type CollatorOptions,
  type RulesInput,
  type VariableWeighting,
  type WeightRecord,
} from "../index.js";

interface RefRule {
  readonly source: number[];
  readonly elements: CE[];
}

interface RefRecord {
  readonly value: number;
  readonly level: 1 | 2 | 3 | 4;
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly expansionIndex: number;
  readonly source: {
    readonly start: number;
    readonly end: number;
    readonly expansionIndex: number;
  };
}

type RefLevels = [number[], number[], number[], number[]];

function ce(
  primary: number,
  secondary = 0,
  tertiary = 0,
  variable = false,
): CE {
  return { primary, secondary, tertiary, variable };
}

function rule(source: readonly number[] | string, elements: CE[]): RefRule {
  const scalars =
    typeof source === "string" ? [...source].map((c) => c.codePointAt(0)!) : [...source];
  return { source: scalars, elements };
}

/**
 * Deliberately simple one-shot reference implementation.  It rescans the
 * complete input at every position and therefore shares no streaming code
 * with the implementation being tested.
 */
function reference(
  input: readonly number[],
  rules: readonly RefRule[],
  mode: VariableWeighting,
  backwardSecondary: boolean,
): {
  levels: RefLevels;
  records: [RefRecord[], RefRecord[], RefRecord[], RefRecord[]];
  generatedCEs: number;
} {
  const records: [RefRecord[], RefRecord[], RefRecord[], RefRecord[]] = [
    [],
    [],
    [],
    [],
  ];
  let suppressed = false;
  let generatedCEs = 0;

  const add = (
    level: 1 | 2 | 3 | 4,
    value: number,
    start: number,
    end: number,
    expansionIndex: number,
  ) => {
    const source = { start, end, expansionIndex };
    records[level - 1].push({
      value,
      level,
      sourceStart: start,
      sourceEnd: end,
      expansionIndex,
      source,
    });
  };

  const emit = (
    element: CE,
    start: number,
    end: number,
    expansionIndex: number,
  ) => {
    if (mode === "non-ignorable") {
      if (element.primary !== 0) add(1, element.primary, start, end, expansionIndex);
      if (element.secondary !== 0) add(2, element.secondary, start, end, expansionIndex);
      if (element.tertiary !== 0) add(3, element.tertiary, start, end, expansionIndex);
      return;
    }

    if (element.variable) {
      add(4, element.primary, start, end, expansionIndex);
      suppressed = true;
      return;
    }

    if (suppressed) {
      if (element.primary === 0) return;
      suppressed = false;
      if (element.primary !== 0) add(1, element.primary, start, end, expansionIndex);
      if (element.secondary !== 0) add(2, element.secondary, start, end, expansionIndex);
      if (element.tertiary !== 0) add(3, element.tertiary, start, end, expansionIndex);
      add(4, 0x400000, start, end, expansionIndex);
      return;
    }

    if (element.primary !== 0) add(1, element.primary, start, end, expansionIndex);
    if (element.secondary !== 0) add(2, element.secondary, start, end, expansionIndex);
    if (element.tertiary !== 0) add(3, element.tertiary, start, end, expansionIndex);
  };

  let position = 0;
  while (position < input.length) {
    let best: RefRule | null = null;
    for (const candidate of rules) {
      if (position + candidate.source.length > input.length) continue;
      let matches = true;
      for (let offset = 0; offset < candidate.source.length; offset += 1) {
        if (input[position + offset] !== candidate.source[offset]) {
          matches = false;
          break;
        }
      }
      if (matches && (best === null || candidate.source.length > best.source.length)) {
        best = candidate;
      }
    }

    const length = best === null ? 1 : best.source.length;
    const end = position + length;
    const elements: readonly CE[] =
      best === null
        ? [{ primary: 0x200000 + input[position], secondary: 0, tertiary: 0, variable: false }]
        : best.elements;
    generatedCEs += elements.length;
    for (let index = 0; index < elements.length; index += 1) {
      emit(elements[index], position, end, index);
    }
    position = end;
  }

  if (backwardSecondary) records[1].reverse();
  return {
    levels: records.map((level) => level.map((record) => record.value)) as RefLevels,
    records,
    generatedCEs,
  };
}

function chunksFor(sequence: readonly number[]): number[][][] {
  if (sequence.length === 0) return [[]];
  const partitions: number[][][] = [];
  const cuts = 1 << Math.max(0, sequence.length - 1);
  for (let mask = 0; mask < cuts; mask += 1) {
    const chunks: number[][] = [];
    let start = 0;
    for (let boundary = 1; boundary < sequence.length; boundary += 1) {
      if ((mask & (1 << (boundary - 1))) !== 0) {
        chunks.push(sequence.slice(start, boundary));
        start = boundary;
      }
    }
    chunks.push(sequence.slice(start));
    partitions.push(chunks);
  }
  return partitions;
}

function allSequences(alphabet: readonly number[], maxLength: number): number[][] {
  const result: number[][] = [[]];
  for (let length = 1; length <= maxLength; length += 1) {
    const count = alphabet.length ** length;
    for (let value = 0; value < count; value += 1) {
  let rest = value;
      const sequence: number[] = [];
      for (let index = 0; index < length; index += 1) {
        sequence.push(alphabet[rest % alphabet.length]);
        rest = Math.floor(rest / alphabet.length);
      }
      result.push(sequence);
    }
  }
  return result;
}

function scenarioRules(): RefRule[] {
  return [
    rule("a", [ce(10, 1, 1)]),
    rule("b", [ce(11, 0, 0)]),
    rule("ab", [ce(20, 2, 2)]),
    rule("ba", [ce(21, 0, 7)]),
    rule("x", [ce(30, 3, 3), ce(0, 4, 4)]),
    rule("`", [ce(0, 5, 5)]),
    rule("v", [ce(40, 0, 0, true)]),
    rule("q", [ce(50, 0, 0, true), ce(0, 9, 9)]),
    rule("s", []),
    rule("c", [ce(0, 0, 0)]),
    rule("d", [ce(0, 7, 7)]),
    rule([0x1f600], [ce(60, 6, 6)]),
  ];
}

function optionsFor(
  rules: readonly RefRule[],
  mode: VariableWeighting,
  backwardSecondary: boolean,
  extra: Partial<CollatorOptions> = {},
): CollatorOptions & { rules: RulesInput } {
  return {
    rules: rules.map((item) => ({ source: item.source, elements: item.elements })),
    mode,
    backwardSecondary,
    ...extra,
  } as CollatorOptions & { rules: RulesInput };
}

function compareSign(left: readonly number[][], right: readonly number[][], strength: 1 | 2 | 3 | 4): number {
  for (let level = 0; level < strength; level += 1) {
    const a = left[level];
    const b = right[level];
    const common = Math.min(a.length, b.length);
    for (let index = 0; index < common; index += 1) {
      if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
    }
    if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  }
  return 0;
}

function recordsEqual(actual: readonly WeightRecord[], expected: readonly RefRecord[]): boolean {
  if (actual.length !== expected.length) return false;
  return actual.every((record, index) => {
    const other = expected[index];
    return (
      record.value === other.value &&
      record.level === other.level &&
      record.sourceStart === other.sourceStart &&
      record.sourceEnd === other.sourceEnd &&
      record.expansionIndex === other.expansionIndex &&
      record.source.start === other.source.start &&
      record.source.end === other.source.end &&
      record.source.expansionIndex === other.source.expansionIndex
    );
  });
}

test("longest rule wins across a chunk boundary", () => {
  const rules = [rule("a", [ce(1)]), rule("ab", [ce(2)])];
  const options = optionsFor(rules, "non-ignorable", false);
  const collator = new Collator(options);
  collator.push([0x61]);
  assert.equal(collator.pendingScalarCount, 1);
  collator.push([0x62]);
  assert.deepEqual(collator.result?.levels, undefined);
  const result = collator.finish();
  assert.deepEqual(result.levels, [[2], [], [], []]);
  assert.deepEqual(result.weights[0][0].source, {
    start: 0,
    end: 2,
    expansionIndex: 0,
  });
});

test("short rule that is a prefix of a long rule is only used at true end", () => {
  const rules = [rule("a", [ce(1)]), rule("ab", [ce(2)]), rule("abc", [ce(3)])];
  const options = optionsFor(rules, "non-ignorable", false);

  const stoppedShort = new Collator(options);
  stoppedShort.push([0x61, 0x62]);
  const shortResult = stoppedShort.finish();
  assert.deepEqual(shortResult.levels[0], [2]);

  const completedLong = new Collator(options);
  completedLong.push([0x61]);
  completedLong.push([0x62]);
  completedLong.push([0x63]);
  const longResult = completedLong.finish();
  assert.deepEqual(longResult.levels[0], [3]);

  const trulyEndedShort = new Collator(options);
  trulyEndedShort.push([0x61]);
  assert.deepEqual(trulyEndedShort.finish().levels[0], [1]);
});

test("one source character can expand to several CEs with ordered provenance", () => {
  const rules = [rule("x", [ce(30, 3, 3), ce(0, 4, 4)])];
  const collator = new Collator(optionsFor(rules, "non-ignorable", false));
  collator.push([0x78]);
  const result = collator.finish();
  assert.deepEqual(result.levels, [[30], [3, 4], [3, 4], []]);
  assert.equal(result.weights[0][0].sourceStart, 0);
  assert.equal(result.weights[0][0].sourceEnd, 1);
  assert.equal(result.weights[0][0].expansionIndex, 0);
  assert.equal(result.weights[1][0].expansionIndex, 0);
  assert.equal(result.weights[1][1].expansionIndex, 1);
  assert.equal(result.weights[2][1].expansionIndex, 1);
});

test("empty expansion consumes source and shifts later spans", () => {
  const rules = [rule("s", []), rule("a", [ce(1, 2, 3)])];
  const collator = new Collator(optionsFor(rules, "non-ignorable", false));
  collator.push([0x73, 0x61]);
  const result = collator.finish();
  assert.deepEqual(result.levels, [[1], [2], [3], []]);
  assert.deepEqual(result.weights[0][0].source, {
    start: 1,
    end: 2,
    expansionIndex: 0,
  });
});

test("variable suppression crosses chunks and ignores primary-zero accents", () => {
  const rules = scenarioRules();
  for (const chunks of chunksFor([0x76, 0x60, 0x61])) {
    const collator = new Collator(optionsFor(rules, "shifted", false));
    for (const chunk of chunks) collator.push(chunk);
    const result = collator.finish();
    assert.deepEqual(result.levels, [[10], [1], [1], [40, 0x400000]]);
    const fourth = result.weights[3];
    assert.equal(fourth[0].sourceStart, 0);
    assert.equal(fourth[0].sourceEnd, 1);
    assert.equal(fourth[1].sourceStart, 2);
    assert.equal(fourth[1].sourceEnd, 3);
    // The ignored accent at index 1 must not leave fabricated provenance.
    assert.equal(
      result.weights.flat().some((record) =>
        record.sourceStart === 1 && record.sourceEnd === 2,
      ),
      false,
    );
  }
});

test("suppression persists across expansion CEs of one rule", () => {
  const rules = scenarioRules();
  const collator = new Collator(optionsFor(rules, "shifted", false));
  collator.push([0x71, 0x61]);
  const result = collator.finish();
  assert.deepEqual(result.levels, [[10], [1], [1], [50, 0x400000]]);
  assert.deepEqual(result.weights[3].map((record) => record.expansionIndex), [0, 0]);
  assert.deepEqual(result.weights[3].map((record) => [record.sourceStart, record.sourceEnd]), [
    [0, 1],
    [1, 2],
  ]);
});

test("an unsuppressed primary-zero accent keeps secondary and tertiary, with no marker", () => {
  const rules = scenarioRules();
  const collator = new Collator(optionsFor(rules, "shifted", false));
  collator.push([0x60, 0x61]);
  const result = collator.finish();
  assert.deepEqual(result.levels, [[10], [5, 1], [5, 1], []]);
});

test("all-ignorable text has empty streams and zero-only keys", () => {
  const rules = scenarioRules();
  for (const mode of ["non-ignorable", "shifted"] as const) {
    const collator = new Collator(optionsFor(rules, mode, false));
    collator.push([0x63, 0x63]);
    const result = collator.finish();
    assert.deepEqual(result.levels, [[], [], [], []]);
    assert.deepEqual(result.weights, [[], [], [], []]);
    for (const strength of [1, 2, 3, 4] as const) {
      assert.deepEqual([...collator.key(strength)], new Array(strength * 4).fill(0));
    }
  }
});

test("supplementary-plane fallback uses code point arithmetic", () => {
  const rules = scenarioRules();
  const collator = new Collator(optionsFor(rules, "non-ignorable", false));
  collator.push([0x1f642]);
  const result = collator.finish();
  assert.deepEqual(result.levels, [[0x200000 + 0x1f642], [], [], []]);
  assert.deepEqual(result.weights[0][0].source, {
    start: 0,
    end: 1,
    expansionIndex: 0,
  });

  const fromString = new Collator(optionsFor(rules, "non-ignorable", false));
  fromString.push("🙂");
  const stringResult = fromString.finish();
  assert.deepEqual(stringResult.levels, result.levels);
});

test("an empty rule set still emits fallbacks and retains no source", () => {
  const collator = new Collator({ rules: [] });
  collator.push([0x61, 0x62, 0x1f600]);
  assert.equal(collator.pendingScalarCount, 0);
  const result = collator.finish();
  assert.deepEqual(
    result.levels[0],
    [0x200000 + 0x61, 0x200000 + 0x62, 0x200000 + 0x1f600],
  );
  assert.deepEqual(result.levels.slice(1), [[], [], []]);
});

test("four strengths encode big-endian weights and preserve level boundaries", () => {
  const rules = [rule("a", [ce(10, 1, 1)]), rule("b", [ce(10, 1, 2)])];
  const options = optionsFor(rules, "non-ignorable", false);
  const a = new Collator(options);
  a.push([0x61]);
  a.finish();
  const b = new Collator(options);
  b.push([0x62]);
  b.finish();

  for (const strength of [1, 2, 3, 4] as const) {
    const ka = a.key(strength);
    const kb = b.key(strength);
    if (strength <= 2) {
      assert.equal(compareKeyBytes(ka, kb), 0);
      assert.equal(a.compare([0x61], [0x62], strength), 0);
    } else {
      assert.equal(compareKeyBytes(ka, kb), -1);
      assert.equal(a.compare([0x61], [0x62], strength), -1);
    }
    // Every level is terminated by exactly four zero bytes.
    const zeroCount = [...ka].filter((byte) => byte === 0).length;
    assert.ok(zeroCount >= strength * 4);
  }
  assert.deepEqual([...a.key(1)], [0, 0, 0, 10, 0, 0, 0, 0]);
  assert.deepEqual([...a.key(2)], [0, 0, 0, 10, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0]);
});

test("key byte order matches level order including empty and prefix levels", () => {
  const cases: number[][][] = [
    [[], [], [], []],
    [[1], [], [], []],
    [[1, 2], [], [], []],
    [[1], [5], [], []],
    [[1], [], [7], []],
    [[2], [1], [1], [1]],
  ];
  for (const left of cases) {
    for (const right of cases) {
      assert.equal(
        compareKeyBytes(encodeWeightsForTest(left, 4), encodeWeightsForTest(right, 4)),
        compareLevels(left, right, 4),
      );
    }
  }
});

function encodeWeightsForTest(levels: number[][], strength: 1 | 2 | 3 | 4): Uint8Array {
  let total = strength * 4;
  for (let level = 0; level < strength; level += 1) total += levels[level].length * 4;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (let level = 0; level < strength; level += 1) {
    for (const value of levels[level]) {
      bytes[offset] = (value >>> 24) & 0xff;
      bytes[offset + 1] = (value >>> 16) & 0xff;
      bytes[offset + 2] = (value >>> 8) & 0xff;
      bytes[offset + 3] = value & 0xff;
      offset += 4;
    }
    offset += 4;
  }
  return bytes;
}

test("backward secondary reverses values and provenance together", () => {
  const rules = [rule("a", [ce(1, 1, 1)]), rule("b", [ce(2, 2, 2)])];
  const options = optionsFor(rules, "non-ignorable", true);
  const collator = new Collator(options);
  collator.push([0x61, 0x62]);
  const result = collator.finish();
  assert.deepEqual(result.levels, [[1, 2], [2, 1], [1, 2], []]);
  assert.deepEqual(
    result.weights[1].map((record) => [record.value, record.sourceStart, record.sourceEnd]),
    [
      [2, 1, 2],
      [1, 0, 1],
    ],
  );
  const forward = new Collator(optionsFor(rules, "non-ignorable", false));
  forward.push([0x61, 0x62]);
  const forwardResult = forward.finish();
  assert.deepEqual(forwardResult.levels[0], result.levels[0]);
  assert.deepEqual(forwardResult.levels[2], result.levels[2]);
  assert.notDeepEqual(forwardResult.levels[1], result.levels[1]);
});

test("incremental output matches the one-shot reference for every chunk partition", () => {
  const rules = scenarioRules();
  const sequences: number[][] = [
    [],
    [0x61],
    [0x61, 0x62],
    [0x61, 0x62, 0x63],
    [0x78, 0x60],
    [0x76, 0x60, 0x61],
    [0x71, 0x61],
    [0x73, 0x61, 0x73],
    [0x64, 0x64, 0x61],
    [0x1f600, 0x60],
    [0x7a, 0x1f642, 0x61],
  ];

  for (const sequence of sequences) {
    for (const mode of ["non-ignorable", "shifted"] as const) {
      for (const backwardSecondary of [false, true]) {
        const expected = reference(sequence, rules, mode, backwardSecondary);
        for (const chunks of chunksFor(sequence)) {
          const collator = new Collator(
            optionsFor(rules, mode, backwardSecondary),
          );
          for (const chunk of chunks) {
            collator.push(chunk);
            assert.ok(
              collator.pendingScalarCount < Math.max(1, maximumRuleLength(rules)),
              "frontier should stay bounded by the maximum rule width",
            );
          }
          const result = collator.finish();
          assert.deepEqual(result.levels, expected.levels);
          for (let level = 0; level < 4; level += 1) {
            assert.ok(
              recordsEqual(result.weights[level], expected.records[level]),
              `level ${level + 1} provenance mismatch`,
            );
          }
          assert.equal(collator.generatedCECount, expected.generatedCEs);
        }
      }
    }
  }
});

function maximumRuleLength(rules: readonly RefRule[]): number {
  return Math.max(0, ...rules.map((item) => item.source.length));
}

test("exhaustive small-alphabet comparisons agree with key bytes and reference", () => {
  const rules: RefRule[] = [
    rule("a", [ce(1, 2, 2)]),
    rule("b", [ce(1, 2, 3)]),
    rule("aa", [ce(4, 1, 1)]),
    rule("ab", [ce(3, 5, 0)]),
    rule("ba", [ce(0, 7, 7)]),
    rule("bb", [ce(6, 0, 9, true)]),
  ];
  const alphabet = [0x61, 0x62, 0x63];
  const texts = allSequences(alphabet, 3);

  for (const mode of ["non-ignorable", "shifted"] as const) {
    for (const backwardSecondary of [false, true]) {
      const options = optionsFor(rules, mode, backwardSecondary);
      const collator = new Collator(options);
      const referenceLevels = texts.map(
        (text) => reference(text, rules, mode, backwardSecondary).levels,
      );
      const keys = [1, 2, 3, 4].map((strength) =>
        texts.map((text) => collator.keyFor(text, strength as 1 | 2 | 3 | 4)),
      );

      for (let leftIndex = 0; leftIndex < texts.length; leftIndex += 1) {
        for (let rightIndex = leftIndex; rightIndex < texts.length; rightIndex += 1) {
          const left = texts[leftIndex];
          const right = texts[rightIndex];
          for (const strength of [1, 2, 3, 4] as const) {
            const expected = compareSign(
              referenceLevels[leftIndex],
              referenceLevels[rightIndex],
              strength,
            );
            const actual = Compare(left, right, options, strength);
            assert.equal(actual, expected, `Compare mismatch at strength ${strength}`);
            assert.equal(
              compareKeyBytes(keys[strength - 1][leftIndex], keys[strength - 1][rightIndex]),
              expected,
              `key byte comparison mismatch at strength ${strength}`,
            );
            assert.equal(actual === 0, compareKeyBytes(keys[strength - 1][leftIndex], keys[strength - 1][rightIndex]) === 0);
          }
        }
      }

      const items = texts.map((text, index) => ({ text, index }));
      for (const strength of [1, 2, 3, 4] as const) {
        const expectedOrder = items
          .slice()
          .sort((left, right) => {
            const comparison = compareSign(
              referenceLevels[left.index],
              referenceLevels[right.index],
              strength,
            );
            return comparison !== 0 ? comparison : left.index - right.index;
          })
          .map((item) => item.index);
        const actualOrder = stableSortByCollation(
          items,
          (item) => item.text,
          options,
          strength,
        ).map((item) => item.index);
        assert.deepEqual(actualOrder, expectedOrder);
      }
    }
  }
});

test("stable sort keeps equal-key items in host order", () => {
  const rules = [rule("a", [ce(5, 1, 1)]), rule("b", [ce(5, 1, 1)]), rule("c", [ce(2)])];
  const options = optionsFor(rules, "non-ignorable", false);
  const items = [
    { id: "a1", text: [0x61] },
    { id: "c1", text: [0x63] },
    { id: "b1", text: [0x62] },
    { id: "a2", text: [0x61] },
    { id: "b2", text: [0x62] },
    { id: "c2", text: [0x63] },
  ];
  const sorted = stableSortByCollation(items, (item) => item.text, options);
  assert.deepEqual(sorted.map((item) => item.id), ["c1", "c2", "a1", "b1", "a2", "b2"]);
});

test("invalid scalars, duplicate rules, and bad CEs are rejected", () => {
  const goodRules = [rule("a", [ce(1)])];
  const collator = new Collator(optionsFor(goodRules, "non-ignorable", false));
  for (const invalid of [NaN, -1, 0x110000, 1.5, 0xd800, 0xdfff]) {
    assert.throws(() => collator.push([invalid]), InvalidScalarError);
  }
  assert.throws(
    () => new Collator({ rules: [rule("a", [ce(1)]), rule([0x61], [ce(2)])] }),
    DuplicateRuleError,
  );
  assert.throws(() => new Collator({ rules: [rule("", [ce(1)])] }), InvalidRuleError);
  assert.throws(
    () => new Collator({ rules: [rule("a", [ce(0, 0, 0, true)])] }),
    InvalidRuleError,
  );
  assert.throws(
    () => new Collator({ rules: [rule("a", [ce(0x200000)])] }),
    InvalidRuleError,
  );
  assert.throws(
    () => new Collator({ rules: [rule("a", [ce(1, 0x10000)])] }),
    InvalidRuleError,
  );
});

test("lifecycle and budget errors are explicit", () => {
  const rules = [rule("a", [ce(1), ce(2)])];
  const collator = new Collator(optionsFor(rules, "non-ignorable", false));
  assert.throws(() => collator.key(4), NotFinishedError);
  collator.push([0x61]);
  const result = collator.finish();
  assert.ok(result);
  assert.throws(() => collator.finish(), AlreadyFinishedError);
  assert.throws(() => collator.push([0x61]), PushAfterFinishError);

  assert.throws(
    () => new Collator(optionsFor([rule("abcd", [ce(1)])], "non-ignorable", false, { maxRuleScalars: 3 })),
    RuleLimitExceededError,
  );

  const budgeted = new Collator(
    optionsFor([rule("aab", [ce(1), ce(2)])], "non-ignorable", false, { maxCEs: 1 }),
  );
  budgeted.push([0x61]);
  budgeted.push([0x61]);
  assert.throws(() => budgeted.finish(), BudgetExceededError);
});

test("the maximum-rule frontier is retained, not the whole source", () => {
  const rules = [rule("abc", [ce(1)])];
  const collator = new Collator(optionsFor(rules, "non-ignorable", false));
  collator.push([0x61]);
  assert.equal(collator.pendingScalarCount, 1);
  collator.push([0x62]);
  assert.equal(collator.pendingScalarCount, 2);
  collator.push([0x63]);
  assert.equal(collator.pendingScalarCount, 0);
  collator.finish();
});
