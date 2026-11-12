import assert from "node:assert/strict";
import test from "node:test";
import {
  ExtractionError,
  extractGeneratedText,
  type ExtractionInput,
  type ParsedNode,
} from "../index.js";
import { embeddedCaptureResult } from "../examples/embedded-capture.js";
import { referenceExtract } from "./reference-model.js";

function assertSameAsReference(input: ExtractionInput) {
  const actual = extractGeneratedText(input);
  const expected = referenceExtract(input);
  assert.equal(actual.text, expected.text);
  assert.deepEqual(actual.segments, expected.segments);
  return actual;
}

function errorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ExtractionError);
    return error.code;
  }
  assert.fail("expected extraction to fail");
}

test("sibling reset replaces the layer instance; a child increment persists", () => {
  const roots: ParsedNode[] = [
    {
      id: "outer",
      instructions: { reset: ["section"] },
      before: [{ kind: "counter", name: "section", style: "decimal" }],
      children: [
        {
          id: "mutator",
          instructions: { increment: [{ name: "section", value: 2 }] },
          before: [{ kind: "counter", name: "section", style: "decimal" }],
        },
      ],
      after: [
        { kind: "counter", name: "section", style: "decimal" },
      ],
    },
    {
      id: "sibling",
      instructions: {
        reset: ["section"],
        increment: [{ name: "section", value: 1 }],
      },
      before: [
        { kind: "literal", value: "sib:" },
        { kind: "counter", name: "section", style: "decimal" },
      ],
      after: [
        { kind: "counters", name: "section", separator: ".", style: "decimal" },
      ],
    },
  ];

  const result = assertSameAsReference({
    roots,
    initialCounters: { section: 99n },
  });
  assert.equal(result.text, "022sib:199.1");
  assert.deepEqual(result.segments[1].reads, [
    { name: "section", createdBy: "outer", value: "2" },
  ]);
  assert.deepEqual(result.segments[2].reads, [
    { name: "section", createdBy: "outer", value: "2" },
  ]);
  assert.deepEqual(result.segments[4].reads, [
    { name: "section", createdBy: "sibling", value: "1" },
  ]);
  assert.deepEqual(result.segments[5].reads, [
    { name: "section", createdBy: "$initial", value: "99" },
    { name: "section", createdBy: "sibling", value: "1" },
  ]);
});

test("nested same-name counters form a stack and only the layer instance is popped", () => {
  const roots: ParsedNode[] = [
    {
      id: "chapter",
      instructions: {
        reset: ["section"],
        increment: [{ name: "section", value: 1 }],
      },
      before: [{ kind: "literal", value: "chapter=" }],
      children: [
        {
          id: "subsection",
          instructions: {
            reset: ["section"],
            increment: [{ name: "section", value: 1 }],
          },
          before: [
            { kind: "counters", name: "section", separator: ".", style: "decimal" },
          ],
          children: [
            {
              id: "deep",
              instructions: { increment: [{ name: "section", value: 2 }] },
              before: [
                { kind: "counters", name: "section", separator: ".", style: "decimal" },
              ],
            },
          ],
          after: [
            { kind: "counters", name: "section", separator: ".", style: "decimal" },
          ],
        },
      ],
      after: [{ kind: "counter", name: "section", style: "decimal" }],
    },
  ];

  const result = assertSameAsReference({
    roots,
    initialCounters: { section: 0 },
  });
  assert.equal(result.text, "chapter=0.1.10.1.30.1.31");
  assert.deepEqual(result.segments.at(-1)?.reads, [
    { name: "section", createdBy: "chapter", value: "1" },
  ]);
});

test("suppressText still applies instructions and traverses children", () => {
  const roots: ParsedNode[] = [
    {
      id: "hidden",
      suppressText: true,
      instructions: {
        reset: ["hiddenCount"],
        increment: [{ name: "hiddenCount", value: 5 }],
      },
      before: [{ kind: "literal", value: "SECRET-BEFORE" }],
      after: [{ kind: "literal", value: "SECRET-AFTER" }],
      children: [
        {
          id: "visible-child",
          before: [
            { kind: "counter", name: "hiddenCount", style: "decimal" },
          ],
        },
      ],
    },
    {
      id: "later",
      before: [
        { kind: "counter", name: "hiddenCount", style: "decimal" },
      ],
    },
  ];

  const result = assertSameAsReference({
    roots,
    initialCounters: { hiddenCount: 0 },
  });
  assert.equal(result.text, "55");
  assert.ok(!result.text.includes("SECRET"));
  assert.ok(result.segments.every((segment) => segment.nodeId !== "hidden"));
});

test("skipSubtree executes neither directives/content nor descendants", () => {
  const roots: ParsedNode[] = [
    {
      id: "skipped",
      skipSubtree: true,
      instructions: {
        reset: ["x"],
        increment: [{ name: "x", value: 10 }],
      },
      before: [{ kind: "literal", value: "BAD" }],
      children: [
        {
          id: "never",
          before: [{ kind: "counter", name: "x", style: "decimal" }],
        },
      ],
    },
    {
      id: "after",
      before: [{ kind: "counter", name: "x", style: "decimal" }],
    },
  ];
  const result = assertSameAsReference({
    roots,
    initialCounters: { x: 0 },
  });
  assert.equal(result.text, "0");
  assert.equal(result.segments.length, 1);
});

test("set/increment order and cross-class duplicate names are supported", () => {
  const roots: ParsedNode[] = [
    {
      id: "ordered",
      instructions: {
        reset: ["x"],
        set: [{ name: "x", value: 100 }],
        increment: [{ name: "x", value: 5 }],
      },
      before: [{ kind: "counter", name: "x", style: "decimal" }],
    },
  ];
  const result = assertSameAsReference({
    roots,
    initialCounters: { x: 7 },
  });
  assert.equal(result.text, "105");
  assert.deepEqual(result.segments[0].reads, [
    { name: "x", createdBy: "ordered", value: "105" },
  ]);
});

test("arbitrary precision decimals, non-positive alpha fallback, and alpha carry", () => {
  const huge = "-12345678901234567890123456789012345678901234567890";
  const roots: ParsedNode[] = [
    {
      id: "large",
      instructions: {
        set: [{ name: "huge", value: huge }],
        increment: [{ name: "huge", value: -987654321098765432109876543210n }],
      },
      before: [
        { kind: "counter", name: "huge", style: "decimal" },
        { kind: "literal", value: "|" },
      ],
      children: [
        { id: "a1", before: [{ kind: "counter", name: "a", style: "lower-alpha" }] },
        { id: "a26", before: [{ kind: "counter", name: "b", style: "lower-alpha" }] },
        { id: "a27", before: [{ kind: "counter", name: "c", style: "lower-alpha" }] },
        { id: "a702", before: [{ kind: "counter", name: "d", style: "lower-alpha" }] },
        { id: "a703", before: [{ kind: "counter", name: "e", style: "lower-alpha" }] },
        {
          id: "negative-alpha",
          before: [{ kind: "counter", name: "negative", style: "lower-alpha" }],
        },
      ],
    },
  ];
  const result = assertSameAsReference({
    roots,
    initialCounters: {
      huge: 0,
      a: 1n,
      b: "26",
      c: 27n,
      d: 702n,
      e: 703n,
      negative: "-987654321098765432109876543210",
    },
  });
  const expectedHuge = (
    BigInt(huge) - 987654321098765432109876543210n
  ).toString();
  assert.equal(
    result.text,
    `${expectedHuge}|azaazzaaa${"-987654321098765432109876543210"}`,
  );
  assert.equal(result.segments[0].reads[0].value, expectedHuge);
});

test("segment provenance records literals, phases, token indexes, and all reads", () => {
  const roots: ParsedNode[] = [
    {
      id: "root",
      instructions: { reset: ["x"], increment: [{ name: "x", value: 1 }] },
      before: [
        { kind: "literal", value: "L" },
        { kind: "counter", name: "x", style: "decimal" },
        { kind: "counters", name: "x", separator: "/", style: "decimal" },
      ],
      after: [{ kind: "literal", value: "R" }],
    },
  ];
  const result = assertSameAsReference({
    roots,
    initialCounters: { x: 9 },
  });
  assert.equal(result.text, "L19/1R");
  assert.deepEqual(result.segments, [
    {
      nodeId: "root",
      position: "before",
      tokenIndex: 0,
      kind: "literal",
      text: "L",
      reads: [],
    },
    {
      nodeId: "root",
      position: "before",
      tokenIndex: 1,
      kind: "counter",
      text: "1",
      reads: [{ name: "x", createdBy: "root", value: "1" }],
    },
    {
      nodeId: "root",
      position: "before",
      tokenIndex: 2,
      kind: "counters",
      text: "9/1",
      reads: [
        { name: "x", createdBy: "$initial", value: "9" },
        { name: "x", createdBy: "root", value: "1" },
      ],
    },
    {
      nodeId: "root",
      position: "after",
      tokenIndex: 0,
      kind: "literal",
      text: "R",
      reads: [],
    },
  ]);
});

test("each instruction list rejects duplicate names independently", () => {
  const base = { roots: [], initialCounters: { x: 0 } };
  assert.equal(
    errorCode(() =>
      extractGeneratedText({
        ...base,
        roots: [{ id: "n", instructions: { reset: ["x", "x"] } }],
      }),
    ),
    "DUPLICATE_INSTRUCTION",
  );
  assert.equal(
    errorCode(() =>
      extractGeneratedText({
        ...base,
        roots: [
          {
            id: "n",
            instructions: {
              set: [
                { name: "x", value: 1 },
                { name: "x", value: 2 },
              ],
            },
          },
        ],
      }),
    ),
    "DUPLICATE_INSTRUCTION",
  );
  assert.equal(
    errorCode(() =>
      extractGeneratedText({
        ...base,
        roots: [
          {
            id: "n",
            instructions: {
              increment: [
                { name: "x", value: 1 },
                { name: "x", value: 2 },
              ],
            },
          },
        ],
      }),
    ),
    "DUPLICATE_INSTRUCTION",
  );
});

test("unknown names and invalid tokens/directives fail even under skipSubtree", () => {
  assert.equal(
    errorCode(() =>
      extractGeneratedText({
        roots: [
          {
            id: "n",
            skipSubtree: true,
            instructions: { increment: [{ name: "missing", value: 1 }] },
          },
        ],
        initialCounters: { x: 0 },
      }),
    ),
    "UNKNOWN_COUNTER",
  );
  assert.equal(
    errorCode(() =>
      extractGeneratedText({
        roots: [
          {
            id: "n",
            skipSubtree: true,
            before: [{ kind: "counter", name: "x", style: "upper-roman" }],
          },
        ],
        initialCounters: { x: 0 },
      }),
    ),
    "INVALID_TOKEN",
  );
  assert.equal(
    errorCode(() =>
      extractGeneratedText({
        roots: [
          {
            id: "n",
            skipSubtree: true,
            after: [{ kind: "counters", name: "x", style: "decimal" }],
          },
        ],
        initialCounters: { x: 0 },
      }),
    ),
    "INVALID_TOKEN",
  );
});

test("cycles, multiple parents, and duplicate ids fail before traversal", () => {
  const cyclic: ParsedNode = { id: "a", skipSubtree: true };
  cyclic.children = [cyclic];
  assert.equal(
    errorCode(() =>
      extractGeneratedText({ roots: [cyclic], initialCounters: {} }),
    ),
    "CYCLE",
  );

  const shared: ParsedNode = { id: "shared" };
  assert.equal(
    errorCode(() =>
      extractGeneratedText({
        roots: [
          { id: "left", children: [shared] },
          { id: "right", children: [shared] },
        ],
        initialCounters: {},
      }),
    ),
    "MULTIPLE_PARENTS",
  );

  assert.equal(
    errorCode(() =>
      extractGeneratedText({
        roots: [{ id: "same" }, { id: "same" }],
        initialCounters: {},
      }),
    ),
    "DUPLICATE_ID",
  );
});

test("UTF-8 byte budget applies to the whole result and fails atomically", () => {
  const input: ExtractionInput = {
    roots: [
      {
        id: "n",
        before: [
          { kind: "literal", value: "中" },
          { kind: "literal", value: "a" },
        ],
      },
    ],
    initialCounters: {},
    outputByteBudget: 4,
  };
  assert.equal(extractGeneratedText(input).text, "中a");
  assert.equal(
    errorCode(() => extractGeneratedText({ ...input, outputByteBudget: 3 })),
    "OUTPUT_BUDGET_EXCEEDED",
  );
  assert.equal(
    errorCode(() =>
      extractGeneratedText({ ...input, outputByteBudget: 0 }),
    ),
    "OUTPUT_BUDGET_EXCEEDED",
  );
});

test("invalid input shapes and unsafe numbers are rejected", () => {
  assert.equal(
    errorCode(() => extractGeneratedText({ roots: [], initialCounters: { x: 1.5 } })),
    "INVALID_INPUT",
  );
  assert.equal(
    errorCode(() =>
      extractGeneratedText({
        roots: [{ id: "n", instructions: { increment: [{ name: "x", value: Number.MAX_VALUE }] } }],
        initialCounters: { x: 0 },
      }),
    ),
    "INVALID_NUMBER",
  );
  assert.equal(
    errorCode(() =>
      extractGeneratedText({
        roots: "not-an-array" as unknown as ParsedNode[],
        initialCounters: {},
      }),
    ),
    "INVALID_INPUT",
  );
});

test("the embedded capture example produces the documented text", () => {
  assert.equal(embeddedCaptureResult.text, "Chapter 1 / 0.1");
  assert.equal(embeddedCaptureResult.segments.length, 4);
});
