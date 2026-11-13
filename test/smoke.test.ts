import test from "node:test";
import assert from "node:assert/strict";

import { AsOfJoin, asOfJoin } from "../index.ts";

interface TestLeft {
  key: string;
  time: number;
  value: string;
}

interface TestRight {
  key: string;
  time: number;
  sourceSeq: number;
  value: string;
}

test("TypeScript entry points compile and run", () => {
  const results = asOfJoin<TestLeft, TestRight, string>(
    [{ key: "k", time: 10, value: "left" }],
    [
      { key: "k", time: 10, sourceSeq: 1, value: "r1" },
      { key: "k", time: 10, sourceSeq: 2, value: "r2" },
    ],
  );

  assert.equal(results[0].right?.value, "r2");

  const join = new AsOfJoin({ tolerance: 5 });
  join.addRight({ key: "k", time: 10, sourceSeq: 1, value: "r" });
  join.addLeft({ key: "k", time: 12, value: "left" });
  assert.equal(join.close()[0].right?.value, "r");
});
