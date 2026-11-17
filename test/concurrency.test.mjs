import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPatch,
  threeWayMerge,
} from "../dist/index.js";
import { clone, installApply } from "./helpers.mjs";

installApply(applyPatch);

const options = {
  lists: {
    "spec.containers": { strategy: "keyed", key: "name" },
    "spec.labels": "set",
  },
};

test("interleaved managers retain every disjoint field and list item", () => {
  let applied = {
    metadata: { labels: { base: "yes" } },
    spec: {
      image: "v1",
      replicas: 1,
      containers: [{ name: "base", image: "base:1" }],
      labels: ["base"],
    },
  };

  const expectedFields = new Map();
  const expectedItems = new Set(["base"]);
  const expectedSet = new Set(["base"]);

  for (let round = 0; round < 40; round += 1) {
    const managerField = `manager_${round}`;
    const externalField = `external_${round}`;
    const managerValue = `m-${round}`;
    const externalValue = `e-${round}`;

    const desired = clone(applied);
    desired.spec[managerField] = managerValue;
    desired.spec.containers.push({
      name: `crowd-${round}`,
      image: `crowd:${round}`,
    });
    desired.spec.labels.push(`tag-${round}`);

    // Another manager's write lands after this manager loaded the base.
    const current = clone(applied);
    current.spec[externalField] = externalValue;
    current.spec.containers.push({
      name: `external-${round}`,
      image: `external:${round}`,
      unknown: { round },
    });
    current.spec.labels.push(`ext-${round}`);
    current.status = { observed: round };

    const result = threeWayMerge(applied, current, desired, options);
    assert.equal(
      result.hasConflicts,
      false,
      `round ${round} must not conflict`,
    );
    assert.deepEqual(applyPatch(current, result.patch), result.merged);

    expectedFields.set(managerField, managerValue);
    expectedFields.set(externalField, externalValue);
    expectedItems.add(`crowd-${round}`);
    expectedItems.add(`external-${round}`);
    expectedSet.add(`tag-${round}`);
    expectedSet.add(`ext-${round}`);

    applied = result.merged;
    for (const [field, value] of expectedFields) {
      assert.equal(applied.spec[field], value, `${field} was lost`);
    }
    assert.equal(applied.status.observed, round);
    const itemNames = new Set(
      applied.spec.containers.map((item) => item.name),
    );
    for (const name of expectedItems) {
      assert.ok(itemNames.has(name), `container ${name} was lost`);
    }
    const tags = new Set(applied.spec.labels);
    for (const tag of expectedSet) {
      assert.ok(tags.has(tag), `tag ${tag} was lost`);
    }
  }
});

test("managers applying patches to a shared base compose without loss", () => {
  const base = {
    spec: {
      settings: { retention: 1 },
      containers: [{ name: "api", image: "api:1" }],
    },
  };
  let state = clone(base);

  for (let index = 0; index < 25; index += 1) {
    const managerDesired = clone(base);
    managerDesired.spec.settings[`field_${index}`] = index;
    managerDesired.spec.containers.push({
      name: `managed-${index}`,
      image: `managed:${index}`,
    });

    // Apply this manager's patch to the current shared state, then merge the
    // next manager against the same last-applied base.
    const merged = threeWayMerge(base, state, managerDesired, options);
    assert.equal(merged.hasConflicts, false);
    state = merged.merged;
    state = applyPatch(state, merged.patch);
  }

  for (let index = 0; index < 25; index += 1) {
    assert.equal(state.spec.settings[`field_${index}`], index);
    assert.ok(
      state.spec.containers.some(
        (item) => item.name === `managed-${index}`,
      ),
    );
  }
  assert.equal(state.spec.settings.retention, 1);
});

test("deterministic interleaving with nested disjoint writes has no conflicts", () => {
  let seed = 0x12345678;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  let base = {
    spec: {
      groups: {
        alpha: { desired: 0, observed: 0, note: "alpha" },
        beta: { desired: 0, observed: 0, note: "beta" },
        gamma: { desired: 0, observed: 0, note: "gamma" },
      },
    },
  };
  const expected = {
    alpha: { desired: 0, observed: 0 },
    beta: { desired: 0, observed: 0 },
    gamma: { desired: 0, observed: 0 },
  };

  for (let step = 0; step < 120; step += 1) {
    const groups = ["alpha", "beta", "gamma"];
    const desiredGroup = groups[Math.floor(random() * groups.length)];
    let currentGroup = groups[Math.floor(random() * groups.length)];
    if (currentGroup === desiredGroup) {
      currentGroup = groups[(groups.indexOf(currentGroup) + 1) % groups.length];
    }

    const desired = clone(base);
    desired.spec.groups[desiredGroup].desired += 1;
    expected[desiredGroup].desired += 1;

    const current = clone(base);
    current.spec.groups[currentGroup].observed += 1;
    current.spec.groups[currentGroup].runtimeOnly = step;
    expected[currentGroup].observed += 1;

    const result = threeWayMerge(base, current, desired);
    assert.equal(result.hasConflicts, false);
    assert.deepEqual(applyPatch(current, result.patch), result.merged);
    base = result.merged;

    for (const group of groups) {
      assert.equal(
        base.spec.groups[group].desired,
        expected[group].desired,
      );
      assert.equal(
        base.spec.groups[group].observed,
        expected[group].observed,
      );
      assert.equal(base.spec.groups[group].note, group);
    }
  }
});
