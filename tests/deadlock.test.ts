import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Simulator,
  findCycle,
  formatGraph,
  toDot,
  type SimConfig,
} from "../src/index";

const deadlockConfig: SimConfig = {
  segments: ["S1", "S2"],
  items: { box1: "S1", box2: "S2" },
  arms: [
    {
      id: "A",
      program: [
        { kind: "acquire", segment: "S1" },
        { kind: "acquire", segment: "S2" },
        { kind: "move", item: "box1", from: "S1", to: "S2" },
      ],
    },
    {
      id: "B",
      program: [
        { kind: "acquire", segment: "S2" },
        { kind: "acquire", segment: "S1" },
        { kind: "move", item: "box2", from: "S2", to: "S1" },
      ],
    },
  ],
};

test("circular wait is detected and reported as a graph", () => {
  const sim = new Simulator(deadlockConfig);
  sim.run();

  assert.equal(sim.armStatus("A"), "blocked");
  assert.equal(sim.armStatus("B"), "blocked");

  const deadlock = sim.events.find((e) => e.type === "deadlock")!;
  assert.ok(deadlock, "deadlock event emitted");
  assert.deepEqual(deadlock.cycle, ["A", "B", "A"]);

  const edges = sim.waitForEdges();
  assert.deepEqual(edges, [
    ["A", "B"],
    ["B", "A"],
  ]);

  const text = formatGraph(edges, findCycle(edges));
  assert.match(text, /A -> B/);
  assert.match(text, /B -> A/);
  assert.match(text, /circular wait detected: A -> B -> A/);

  const dot = toDot(edges, findCycle(edges));
  assert.match(dot, /digraph wait_for/);
  assert.match(dot, /"A" -> "B" \[color=red,penwidth=2\]/);
  assert.match(dot, /"B" -> "A" \[color=red,penwidth=2\]/);

  assert.equal(sim.waitGraphText(), text);
});

test("three-arm cycle is found; acyclic waits report no cycle", () => {
  assert.deepEqual(findCycle([["A", "B"], ["B", "C"], ["C", "A"]]), ["A", "B", "C", "A"]);
  assert.equal(findCycle([["A", "B"], ["B", "C"]]), null);
  assert.equal(findCycle([]), null);

  const dot = toDot([["A", "B"], ["B", "C"]], null);
  assert.match(dot, /"A" -> "B";/);
  assert.ok(!dot.includes("color=red"));
});
