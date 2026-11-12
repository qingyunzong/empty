import assert from "node:assert/strict";
import test from "node:test";

import {
  contains,
  difference,
  intersection,
  isSubset,
  normalize,
  parse,
  union,
} from "./dist/index.js";

const SID_A = "0123456789abcdef0123456789abcdef";
const SID_B = "fedcba9876543210fedcba9876543210";
const SID_C = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function compareLabels(left, right) {
  if (left === right) {
    return 0;
  }
  if (left === null) {
    return -1;
  }
  if (right === null) {
    return 1;
  }
  return left < right ? -1 : 1;
}

function namespaceKey(sid, label) {
  return `${sid.toLowerCase()}\u0000${label ?? ""}`;
}

function consolidate(entries) {
  const groups = new Map();

  for (const entry of entries) {
    const sid = entry.sid.toLowerCase();
    const key = namespaceKey(sid, entry.label);
    let group = groups.get(key);

    if (!group) {
      group = { sid, label: entry.label, values: new Set() };
      groups.set(key, group);
    }

    for (const [start, end] of entry.intervals) {
      for (let value = start; value <= end; value += 1) {
        group.values.add(value);
      }
    }
  }

  return groups;
}

function formatValues(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const parts = [];
  let index = 0;

  while (index < sorted.length) {
    const start = sorted[index];
    let end = start;
    index += 1;

    while (index < sorted.length && sorted[index] === end + 1) {
      end = sorted[index];
      index += 1;
    }

    parts.push(start === end ? String(start) : `${start}-${end}`);
  }

  return parts.join(":");
}

function expectedText(groups) {
  const present = [...groups.values()].filter(
    (group) => group.values.size > 0,
  );

  present.sort((left, right) => {
    if (left.sid !== right.sid) {
      return left.sid < right.sid ? -1 : 1;
    }
    return compareLabels(left.label, right.label);
  });

  return present
    .map((group) => {
      const label = group.label === null ? "" : `${group.label}:`;
      return `${group.sid}:${label}${formatValues(group.values)}`;
    })
    .join(",");
}

function cloneGroups(groups) {
  const result = new Map();
  for (const [key, group] of groups) {
    result.set(key, {
      sid: group.sid,
      label: group.label,
      values: new Set(group.values),
    });
  }
  return result;
}

function expectedUnion(left, right) {
  const result = cloneGroups(left);

  for (const [key, group] of right) {
    let target = result.get(key);
    if (!target) {
      target = { sid: group.sid, label: group.label, values: new Set() };
      result.set(key, target);
    }
    for (const value of group.values) {
      target.values.add(value);
    }
  }

  return result;
}

function expectedIntersection(left, right) {
  const result = new Map();

  for (const [key, group] of left) {
    const other = right.get(key);
    if (!other) {
      continue;
    }

    const values = new Set();
    for (const value of group.values) {
      if (other.values.has(value)) {
        values.add(value);
      }
    }

    if (values.size > 0) {
      result.set(key, { sid: group.sid, label: group.label, values });
    }
  }

  return result;
}

function expectedDifference(left, right) {
  const result = new Map();

  for (const [key, group] of left) {
    const other = right.get(key);
    const values = new Set();

    for (const value of group.values) {
      if (!other || !other.values.has(value)) {
        values.add(value);
      }
    }

    if (values.size > 0) {
      result.set(key, { sid: group.sid, label: group.label, values });
    }
  }

  return result;
}

function expectedSubset(candidate, superset) {
  for (const [key, group] of candidate) {
    const other = superset.get(key);
    if (!other) {
      return false;
    }

    for (const value of group.values) {
      if (!other.values.has(value)) {
        return false;
      }
    }
  }

  return true;
}

function expectedContains(groups, transaction) {
  for (const group of groups.values()) {
    if (group.values.has(transaction)) {
      return true;
    }
  }
  return false;
}

function expectedContainsNamespace(groups, sid, label, transaction) {
  const group = groups.get(namespaceKey(sid, label));
  return group !== undefined && group.values.has(transaction);
}

function renderEntries(entries) {
  return entries
    .map((entry) => {
      const intervals = entry.intervals
        .map(([start, end]) =>
          start === end ? String(start) : `${start}-${end}`,
        )
        .join(":");
      return `${entry.sid}:${entry.label === null ? "" : `${entry.label}:`}${intervals}`;
    })
    .join(",");
}

function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomInteger(random, minimum, maximum) {
  return minimum + Math.floor(random() * (maximum - minimum + 1));
}

const namespaces = [
  { sid: SID_A, inputSid: SID_A, label: null },
  { sid: SID_A, inputSid: SID_A.toUpperCase(), label: "alpha" },
  { sid: SID_A, inputSid: SID_A.toUpperCase(), label: "Alpha" },
  { sid: SID_B, inputSid: SID_B, label: null },
  { sid: SID_B, inputSid: SID_B.toUpperCase(), label: "_9" },
];

function makeRandomEntries(random) {
  const entries = [];

  for (const namespace of namespaces) {
    const sectionCount = randomInteger(random, 0, 2);

    for (let section = 0; section < sectionCount; section += 1) {
      const intervalCount = randomInteger(random, 1, 4);
      const intervals = [];

      for (let interval = 0; interval < intervalCount; interval += 1) {
        const first = randomInteger(random, 1, 64);
        const second = randomInteger(random, 1, 64);
        intervals.push(
          first <= second ? [first, second] : [second, first],
        );
      }

      entries.push({
        sid: namespace.inputSid,
        label: namespace.label,
        intervals,
      });
    }
  }

  return entries;
}

test("canonical form handles SID case, labels, adjacency, and repeats", () => {
  const upper = SID_A.toUpperCase();

  assert.equal(normalize(`${upper}:5-5:6-8`), `${SID_A}:5-8`);
  assert.equal(
    normalize(`${SID_A}:1,${upper}:2`),
    `${SID_A}:1-2`,
  );
  assert.equal(normalize(`${SID_A}:1-2:4`), `${SID_A}:1-2:4`);
  assert.equal(normalize(`${SID_A}:1-2:3`), `${SID_A}:1-3`);
  assert.equal(normalize(`${SID_A}:1-2:2-3:3`), `${SID_A}:1-3`);
  assert.equal(
    normalize(`${SID_A}:1,${SID_A}:tag:1,${SID_A}:Tag:1`),
    `${SID_A}:1,${SID_A}:Tag:1,${SID_A}:tag:1`,
  );
});

test("a numeric first fragment is an interval, not a label", () => {
  assert.equal(normalize(`${SID_A}:1-2:3`), `${SID_A}:1-3`);
  assert.equal(
    normalize(`${SID_A}:123:1`),
    `${SID_A}:1:123`,
  );
  assert.equal(
    normalize(`${SID_A}:tag:1:2`),
    `${SID_A}:tag:1-2`,
  );
  assert.equal(
    normalize(`${SID_A}:_:1`),
    `${SID_A}:_:1`,
  );
  assert.equal(
    normalize(`${SID_A}:a1:2`),
    `${SID_A}:a1:2`,
  );

  for (const invalid of ["0", "01", "1a", "1-02", "3-2", "0-1"]) {
    assert.equal(parse(`${SID_A}:${invalid}`).ok, false, invalid);
  }
});

test("labels are case-sensitive and limited to 32 characters", () => {
  const label32 = "a".repeat(32);
  const label33 = "a".repeat(33);

  assert.equal(
    normalize(`${SID_A}:${label32}:1`),
    `${SID_A}:${label32}:1`,
  );
  assert.equal(parse(`${SID_A}:${label33}:1`).ok, false);
  assert.equal(parse(`${SID_A}:a-b:1`).ok, false);
});

test("canonical ordering is SID, then label with unlabeled first", () => {
  const input = [
    `${SID_B}:z:2`,
    `${SID_A}:beta:2`,
    `${SID_A}:Beta:1`,
    `${SID_A}:2`,
    `${SID_A}:alpha:3`,
  ].join(",");

  assert.equal(
    normalize(input),
    [
      `${SID_A}:2`,
      `${SID_A}:Beta:1`,
      `${SID_A}:alpha:3`,
      `${SID_A}:beta:2`,
      `${SID_B}:z:2`,
    ].join(","),
  );
});

test("maximum endpoint is exact and never incremented", () => {
  const maximum = "9223372036854775807";
  const below = "9223372036854775806";

  assert.equal(normalize(`${SID_A}:${maximum}`), `${SID_A}:${maximum}`);
  assert.equal(
    normalize(`${SID_A}:${below}-${maximum}:${maximum}`),
    `${SID_A}:${below}-${maximum}`,
  );
  assert.equal(parse(`${SID_A}:${maximum}:${maximum}`).ok, true);
  assert.equal(parse(`${SID_A}:9223372036854775808`).ok, false);
  assert.equal(contains(`${SID_A}:${maximum}`, BigInt(maximum)), true);
});

test("difference splits one interval without touching other namespaces", () => {
  assert.equal(
    difference(
      `${SID_A}:1-10:20,${SID_A}:keep:1-10,${SID_B}:1-10`,
      `${SID_A}:4-6`,
    ),
    `${SID_A}:1-3:7-10:20,${SID_A}:keep:1-10,${SID_B}:1-10`,
  );

  assert.equal(
    difference(`${SID_A}:1-10`, `${SID_A}:keep:1-10`),
    `${SID_A}:1-10`,
  );
  assert.equal(difference(`${SID_A}:1-10`, `${SID_A}:1-10`), "");
});

test("subset and single-transaction containment respect namespaces", () => {
  const superset = [
    `${SID_A}:1-10`,
    `${SID_A}:alpha:2-4`,
    `${SID_B}:7`,
  ].join(",");
  const candidate = [
    `${SID_A}:2-3`,
    `${SID_A}:alpha:3`,
    `${SID_B}:7`,
  ].join(",");

  assert.equal(isSubset(candidate, superset), true);
  assert.equal(isSubset(`${SID_A}:2-3,${SID_A}:Beta:3`, superset), false);
  assert.equal(isSubset(`${SID_A}:2-11`, superset), false);

  assert.equal(contains(superset, 4), true);
  assert.equal(contains(superset, 11), false);
  assert.equal(contains(superset, SID_A, 11), false);
  assert.equal(contains(superset, SID_A, "alpha", 3), true);
  assert.equal(contains(superset, SID_A, "Alpha", 3), false);
  assert.equal(contains(superset, SID_B, 7), true);
});

test("malformed input reports a zero-based UTF-8 byte offset", () => {
  const cases = [
    ["x", 0],
    ["0123", 4],
    [",", 0],
    [`${SID_A}:1,,${SID_A}:1`, 35],
    [`${SID_A}:01`, 33],
    [`${SID_A}:1 `, 34],
    [`${SID_A}:\u4e2d:1`, 33],
  ];

  for (const [input, offset] of cases) {
    const result = parse(input);
    assert.equal(result.ok, false, input);
    assert.equal(result.offset, offset, input);
  }
});

test("empty string is the empty set and empty sections are rejected", () => {
  assert.equal(normalize(""), "");
  assert.equal(union("", ""), "");
  assert.equal(intersection("", `${SID_A}:1`), "");
  assert.equal(difference("", `${SID_A}:1`), "");
  assert.equal(isSubset("", ""), true);
  assert.equal(isSubset(`${SID_A}:1`, ""), false);

  assert.equal(parse("").ok, true);
  assert.equal(parse(",,").ok, false);
  assert.equal(parse(`${SID_A}:1,`).ok, false);
  assert.equal(parse(`,${SID_A}:1`).ok, false);
});

test("randomized sets match independent expanded-set oracles", () => {
  const random = makeRandom(0x5eed1234);

  for (let iteration = 0; iteration < 120; iteration += 1) {
    const leftEntries = makeRandomEntries(random);
    const rightEntries = makeRandomEntries(random);
    const leftText = renderEntries(leftEntries);
    const rightText = renderEntries(rightEntries);
    const left = consolidate(leftEntries);
    const right = consolidate(rightEntries);

    assert.equal(
      union(leftText, rightText),
      expectedText(expectedUnion(left, right)),
      `union iteration ${iteration}`,
    );
    assert.equal(
      intersection(leftText, rightText),
      expectedText(expectedIntersection(left, right)),
      `intersection iteration ${iteration}`,
    );
    assert.equal(
      difference(leftText, rightText),
      expectedText(expectedDifference(left, right)),
      `difference iteration ${iteration}`,
    );
    assert.equal(
      isSubset(leftText, rightText),
      expectedSubset(left, right),
      `subset iteration ${iteration}`,
    );

    const parsedLeft = parse(leftText);
    assert.equal(parsedLeft.ok, true, `parse iteration ${iteration}`);

    for (let transaction = 1; transaction <= 64; transaction += 1) {
      assert.equal(
        contains(parsedLeft, transaction),
        expectedContains(left, transaction),
        `contains ${transaction} iteration ${iteration}`,
      );
    }

    for (const namespace of namespaces) {
      for (let transaction = 1; transaction <= 64; transaction += 1) {
        assert.equal(
          contains(
            parsedLeft,
            namespace.sid,
            namespace.label,
            transaction,
          ),
          expectedContainsNamespace(
            left,
            namespace.sid,
            namespace.label,
            transaction,
          ),
          `namespaced contains ${transaction} iteration ${iteration}`,
        );
      }
    }
  }
});

test("parse returns canonical structured intervals", () => {
  const result = parse(`${SID_A}:1-2:4,${SID_A}:tag:5-5`);
  assert.equal(result.ok, true);
  assert.equal(result.value.groups.length, 2);
  assert.deepEqual(result.value.groups[0].intervals, [
    { start: 1n, end: 2n },
    { start: 4n, end: 4n },
  ]);
  assert.equal(result.value.groups[0].label, null);
  assert.equal(result.value.groups[1].label, "tag");
  assert.deepEqual(result.value.groups[1].intervals, [
    { start: 5n, end: 5n },
  ]);
});
