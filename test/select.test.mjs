import test from "node:test";
import assert from "node:assert/strict";

import { Rational, selectPicture } from "../dist/index.js";

const baseUrl = "https://cdn.example.test/i/";

function callbacks({ supportedTypes = [], viewportWidth = Rational.from("800") } = {}) {
  const supported = new Set(supportedTypes);
  return {
    mediaMatches: (media, context) => {
      const match = /^\((min|max)-width: (\d+(?:\.\d+)?)px\)$/.exec(media);
      if (match === null) {
        return media === "";
      }
      const width = Rational.from(match[2]);
      return match[1] === "min"
        ? context.viewportWidth.compare(width) >= 0
        : context.viewportWidth.compare(width) <= 0;
    },
    supportsType: (type) => supported.has(type),
  };
}

function choose(input) {
  return selectPicture({
    baseUrl,
    mediaMatches: () => true,
    supportsType: () => true,
    ...input,
  });
}

test("selection keeps data URL commas and reports the original candidate range", () => {
  const result = choose({
    sources: [
      {
        srcset:
          "data:image/png;base64,AA 1x, data:image/png;base64,BB 2x",
      },
    ],
    viewportWidth: 100,
    dpr: 2,
  });

  assert.equal(result.selected.url, "data:image/png;base64,BB");
  assert.equal(result.selected.density.toString(), "2");
  assert.equal(result.selected.densityNumber, 2);
  assert.equal(result.source, "source");
  assert.equal(result.sourceIndex, 0);
  assert.equal(result.selected.candidate.range.start, 29);
  assert.equal(result.selected.candidate.raw, "data:image/png;base64,BB 2x");
});

test("URL trailing commas and omitted descriptors participate in x selection", () => {
  const result = choose({
    sources: [{ srcset: "plain.png, hi.png 2x" }],
    viewportWidth: 100,
    dpr: 2,
  });

  assert.equal(result.selected.url, "https://cdn.example.test/i/hi.png");
  assert.equal(result.selected.density.toString(), "2");
  assert.equal(result.candidateSet.candidates.length, 2);
  assert.equal(result.candidateSet.candidates[0].raw, "plain.png,");
  assert.equal(result.candidateSet.candidates[0].descriptor.text, "1x");
});

test("when no density reaches DPR, the maximum density wins", () => {
  const result = choose({
    sources: [{ srcset: "only.png" }],
    viewportWidth: 100,
    dpr: 3,
  });

  assert.equal(result.selected.url, "https://cdn.example.test/i/only.png");
  assert.equal(result.selected.density.toString(), "1");
});

test("invalid candidates are recorded and scanning resumes", () => {
  const result = choose({
    sources: [{ srcset: "a.png 2x, broken.png 0w, b.png 1x" }],
    viewportWidth: 100,
    dpr: 2,
  });

  assert.equal(result.selected.url, "https://cdn.example.test/i/a.png");
  assert.equal(result.discarded.length, 1);
  assert.equal(result.discarded[0].reason, "non-positive-descriptor");
  assert.ok(result.discarded[0].range.end > result.discarded[0].range.start);
});

test("img src is appended as 1x only when there is no w and no 1x", () => {
  const result = choose({
    sources: [],
    img: { srcset: "small.png 2x", src: "fallback.png" },
    viewportWidth: 100,
    dpr: 1,
  });

  assert.equal(result.source, "img");
  assert.equal(result.selected.url, "https://cdn.example.test/i/fallback.png");
  assert.equal(result.selected.density.toString(), "1");
  assert.equal(result.selected.candidate.origin, "src");
  assert.equal(result.candidateSet.candidates.length, 2);
  assert.equal(result.candidateSet.candidates[0].origin, "srcset");
});

test("img src is not appended when a 1x descriptor already exists", () => {
  const result = choose({
    sources: [],
    img: { srcset: "one.png 1x, two.png 2x", src: "fallback.png" },
    viewportWidth: 100,
    dpr: 1,
  });

  assert.equal(result.selected.url, "https://cdn.example.test/i/one.png");
  assert.equal(result.candidateSet.candidates.length, 2);
  assert.ok(
    result.candidateSet.candidates.every((candidate) => candidate.origin === "srcset"),
  );
});

test("img src is not appended for a width-descriptor set", () => {
  const result = choose({
    sources: [],
    img: { srcset: "wide.png 200w", src: "fallback.png" },
    viewportWidth: 100,
    dpr: 2,
  });

  assert.equal(result.selected.url, "https://cdn.example.test/i/wide.png");
  assert.equal(result.selected.density.toString(), "2");
  assert.ok(
    result.candidateSet.candidates.every((candidate) => candidate.origin === "srcset"),
  );
});

test("img with an empty srcset uses non-empty src, but an empty set is unusable", () => {
  const selected = choose({
    sources: [],
    img: { src: "fallback.png" },
    viewportWidth: 100,
    dpr: 1,
  });
  assert.equal(selected.selected.url, "https://cdn.example.test/i/fallback.png");

  const failed = choose({
    sources: [],
    img: { srcset: "", src: "" },
    viewportWidth: 100,
    dpr: 1,
  });
  assert.equal(failed.selected, null);
  assert.equal(failed.reason, "img-candidate-set-unusable");
});

test("source order, media, and MIME callbacks decide which source is used", () => {
  const sources = [
    {
      srcset: "desktop.png 2x",
      media: "(min-width: 700px)",
      type: "image/webp",
    },
    {
      srcset: "tablet.png 2x",
      media: "(min-width: 500px)",
      type: "image/avif",
    },
    { srcset: "fallback-source.png 1x" },
  ];

  const mobile = choose({
    sources,
    img: { src: "img.png" },
    viewportWidth: 400,
    dpr: 2,
    ...callbacks({ supportedTypes: ["image/webp"], viewportWidth: Rational.from("400") }),
  });
  assert.equal(
    mobile.selected.url,
    "https://cdn.example.test/i/fallback-source.png",
  );
  assert.equal(mobile.sourceIndex, 2);

  const tablet = choose({
    sources,
    img: { src: "img.png" },
    viewportWidth: 600,
    dpr: 2,
    ...callbacks({ supportedTypes: ["image/webp"], viewportWidth: Rational.from("600") }),
  });
  assert.equal(tablet.selected.url, "https://cdn.example.test/i/fallback-source.png");
  assert.equal(tablet.trace[1].mediaMatched, true);
  assert.equal(tablet.trace[1].typeSupported, false);

  const desktop = choose({
    sources,
    img: { src: "img.png" },
    viewportWidth: 800,
    dpr: 2,
    ...callbacks({ supportedTypes: ["image/webp"], viewportWidth: Rational.from("800") }),
  });
  assert.equal(desktop.selected.url, "https://cdn.example.test/i/desktop.png");
  assert.equal(desktop.sourceIndex, 0);
});

test("a mixed w/x source is skipped in favor of the next usable source", () => {
  const result = choose({
    sources: [
      { srcset: "mixed.png 100w, mixed.png 2x" },
      { srcset: "good.png 1x" },
    ],
    viewportWidth: 100,
    dpr: 1,
  });

  assert.equal(result.selected.url, "https://cdn.example.test/i/good.png");
  assert.equal(result.sourceIndex, 1);
  assert.equal(result.trace[0].candidateSet.issue.reason, "mixed-descriptor-types");
});

test("a mixed w/x img is not usable", () => {
  const result = choose({
    sources: [],
    img: { srcset: "mixed.png 100w, mixed.png 2x", src: "fallback.png" },
    viewportWidth: 100,
    dpr: 1,
  });

  assert.equal(result.selected, null);
  assert.equal(result.reason, "img-candidate-set-unusable");
});

test("width descriptors use the first valid sizes entry for their slot", () => {
  const result = choose({
    sources: [
      {
        srcset: "s.png 400w, m.png 800w, l.png 1200w",
        sizes: [
          { media: "(min-width: 1000px)", expression: "50vw" },
          { media: "(min-width: 600px)", expression: "25vw" },
        ],
      },
    ],
    viewportWidth: 800,
    dpr: 3,
    ...callbacks({ viewportWidth: Rational.from("800") }),
  });

  assert.equal(result.selected.url, "https://cdn.example.test/i/m.png");
  assert.equal(result.selected.density.toString(), "4");
  assert.equal(result.selected.slotWidth.toString(), "200");
  assert.equal(result.sizesIndex, 1);
  assert.equal(result.adopted.sizes.expression, "25vw");
});

test("invalid sizes entries are skipped and sizes fall back to viewport width", () => {
  const skipped = choose({
    sources: [
      {
        srcset: "s.png 400w, m.png 800w, l.png 1200w",
        sizes: [
          { media: "(min-width: 600px)", expression: "10em" },
          { media: "(min-width: 600px)", expression: "min(10px, 20px)" },
          { expression: "100px" },
        ],
      },
    ],
    viewportWidth: 800,
    dpr: 50,
    ...callbacks({ viewportWidth: Rational.from("800") }),
  });
  assert.equal(skipped.selected.url, "https://cdn.example.test/i/m.png");
  assert.equal(skipped.selected.slotWidth.toString(), "10");
  assert.equal(skipped.sizesIndex, 1);

  const fallback = choose({
    sources: [{ srcset: "s.png 400w, m.png 800w, l.png 1200w" }],
    viewportWidth: 800,
    dpr: 2,
  });
  assert.equal(fallback.selected.url, "https://cdn.example.test/i/l.png");
  assert.equal(fallback.selected.density.toString(), "3/2");
  assert.equal(fallback.selected.slotWidth.toString(), "800");
  assert.equal(fallback.sizesIndex, null);
  assert.equal(fallback.adopted.sizes.usedViewportFallback, true);
});

test("width density arithmetic stays exact for rational viewport widths", () => {
  const result = choose({
    sources: [
      {
        srcset: "wide.png 1000w",
        sizes: [{ expression: "50vw" }],
      },
    ],
    viewportWidth: "1001/2",
    dpr: 2,
  });

  assert.equal(result.selected.slotWidth.toString(), "1001/4");
  assert.equal(result.selected.density.toString(), "4000/1001");
  assert.equal(result.sizesIndex, 0);
});

test("x selection chooses the smallest density at or above DPR", () => {
  const result = choose({
    sources: [{ srcset: "a.png 2x, b.png 3x, c.png 4x" }],
    viewportWidth: 100,
    dpr: "2.5",
  });

  assert.equal(result.selected.url, "https://cdn.example.test/i/b.png");
  assert.equal(result.selected.density.toString(), "3");

  const beyond = choose({
    sources: [{ srcset: "a.png 2x, b.png 3x, c.png 4x" }],
    viewportWidth: 100,
    dpr: 5,
  });
  assert.equal(beyond.selected.url, "https://cdn.example.test/i/c.png");
  assert.equal(beyond.selected.density.toString(), "4");
});

test("equal density ties keep original candidate order after de-duplication", () => {
  const result = choose({
    sources: [{ srcset: "first.png 2x, duplicate.png 2.0x, later.png 3x" }],
    viewportWidth: 100,
    dpr: 2,
  });

  assert.equal(result.selected.url, "https://cdn.example.test/i/first.png");
  assert.equal(result.discarded.length, 1);
  assert.equal(result.discarded[0].reason, "duplicate-descriptor");
});

test("relative URLs are canonicalized against the absolute base URL", () => {
  const result = choose({
    sources: [{ srcset: "../img.png 1x" }],
    viewportWidth: 100,
    dpr: 1,
  });

  assert.equal(result.selected.url, "https://cdn.example.test/img.png");
});

test("an unusable source set falls through to img", () => {
  const result = choose({
    sources: [{ srcset: "bad.png 0w" }],
    img: { srcset: "small.png 2x", src: "fallback.png" },
    viewportWidth: 100,
    dpr: 1,
  });

  assert.equal(result.source, "img");
  assert.equal(result.selected.url, "https://cdn.example.test/i/fallback.png");
  assert.equal(result.trace[0].candidateSet.issue.reason, "empty-candidate-set");
});
