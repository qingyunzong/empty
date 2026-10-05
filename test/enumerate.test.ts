import { test } from "node:test";
import assert from "node:assert/strict";
import { enumerateOdometer, enumerateRecursive, spaceSize } from "../src/enumerate.js";

function toKey(assignment: number[]): string {
  return assignment.join(",");
}

test("两个独立枚举器在多种域形状下产生完全相同的序列", () => {
  const shapes: string[][][] = [
    [["a"]],
    [["a", "b"]],
    [["a", "b"], ["1", "2", "3"]],
    [["x"], ["y", "z"], ["p", "q", "r"], ["s"]],
    [["a", "b"], ["c", "d"], ["e", "f"], ["g", "h"], ["i", "j"]],
  ];
  for (const domains of shapes) {
    const primary = [...enumerateRecursive(domains)].map(toKey);
    const shadow = [...enumerateOdometer(domains)].map(toKey);
    assert.deepEqual(primary, shadow);
    assert.equal(BigInt(primary.length), spaceSize(domains));
  }
});

test("枚举顺序: 先已指定字段少，再按字段与取值序", () => {
  const domains = [["x", "y"], ["1", "2"]];
  const sequence = [...enumerateRecursive(domains)].map(toKey);
  assert.deepEqual(sequence, [
    "-1,-1",
    "0,-1",
    "1,-1",
    "-1,0",
    "-1,1",
    "0,0",
    "0,1",
    "1,0",
    "1,1",
  ]);
});

test("同一层内属性子集按字典序、取值按域序", () => {
  const domains = [["a", "b"], ["c"], ["d", "e"]];
  const sequence = [...enumerateRecursive(domains)].map((assignment) => {
    const parts: string[] = [];
    assignment.forEach((value, attr) => {
      if (value !== -1) parts.push(`${attr}=${value}`);
    });
    return parts.join(" ") || "(empty)";
  });
  assert.deepEqual(sequence, [
    "(empty)",
    "0=0",
    "0=1",
    "1=0",
    "2=0",
    "2=1",
    "0=0 1=0",
    "0=1 1=0",
    "0=0 2=0",
    "0=0 2=1",
    "0=1 2=0",
    "0=1 2=1",
    "1=0 2=0",
    "1=0 2=1",
    "0=0 1=0 2=0",
    "0=0 1=0 2=1",
    "0=1 1=0 2=0",
    "0=1 1=0 2=1",
  ]);
});
