import {
  extractGeneratedText,
  type ExtractionInput,
} from "../index.js";

export const embeddedCaptureInput: ExtractionInput = {
  roots: [
    {
      id: "chapter:1",
      instructions: {
        reset: ["chapter"],
        increment: [{ name: "chapter", value: 1 }],
      },
      before: [
        { kind: "literal", value: "Chapter " },
        { kind: "counter", name: "chapter", style: "decimal" },
      ],
      children: [
        {
          id: "section:1.1",
          instructions: {
            reset: ["section"],
            increment: [{ name: "section", value: 1 }],
          },
          before: [
            { kind: "literal", value: " / " },
            {
              kind: "counters",
              name: "section",
              separator: ".",
              style: "decimal",
            },
          ],
        },
      ],
    },
  ],
  initialCounters: {
    chapter: 0n,
    section: 0n,
  },
  outputByteBudget: 4096,
};

export const embeddedCaptureResult = extractGeneratedText(embeddedCaptureInput);
