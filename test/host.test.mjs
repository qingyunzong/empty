import test from "node:test";
import assert from "node:assert/strict";

import { Rational } from "../dist/index.js";
import {
  mediaQueryMatches,
  selectHostPicture,
} from "../dist/examples/host.js";

test("host media callback handles deterministic min/max width queries", () => {
  assert.equal(mediaQueryMatches("", Rational.from("800")), true);
  assert.equal(
    mediaQueryMatches("(min-width: 600px)", Rational.from("800")),
    true,
  );
  assert.equal(
    mediaQueryMatches("(max-width: 599px)", Rational.from("800")),
    false,
  );
  assert.equal(
    mediaQueryMatches("(min-width: 600px)", Rational.from("400")),
    false,
  );
  assert.equal(mediaQueryMatches("print", Rational.from("800")), false);
});

test("host snapshot selection mirrors a captured picture element", () => {
  const snapshot = {
    sources: [
      {
        srcset: "desktop.webp 1x",
        media: "(min-width: 600px)",
        type: "image/webp",
      },
      { srcset: "fallback.png 1x" },
    ],
    img: { src: "fallback.png" },
    baseUrl: "https://cdn.example.test/pictures/",
    viewportWidth: Rational.from("800"),
    dpr: Rational.from("1"),
    supportedMimeTypes: ["image/webp"],
  };

  const selected = selectHostPicture(snapshot);
  assert.equal(
    selected.selected.url,
    "https://cdn.example.test/pictures/desktop.webp",
  );
  assert.equal(selected.sourceIndex, 0);

  const narrow = selectHostPicture({
    ...snapshot,
    viewportWidth: Rational.from("400"),
  });
  assert.equal(
    narrow.selected.url,
    "https://cdn.example.test/pictures/fallback.png",
  );
  assert.equal(narrow.sourceIndex, 1);
});

test("host MIME support controls type-based source switching", () => {
  const snapshot = {
    sources: [
      { srcset: "avif.png 2x", type: "image/avif" },
      { srcset: "webp.png 2x", type: "image/webp" },
    ],
    img: { srcset: "fallback.png 1x" },
    baseUrl: "https://cdn.example.test/",
    viewportWidth: Rational.from("800"),
    dpr: Rational.from("2"),
    supportedMimeTypes: ["image/webp"],
  };

  const result = selectHostPicture(snapshot);
  assert.equal(result.selected.url, "https://cdn.example.test/webp.png");
  assert.equal(result.sourceIndex, 1);
  assert.equal(result.trace[0].typeSupported, false);
});

test("host snapshot supports width descriptors and sizes entries", () => {
  const result = selectHostPicture({
    sources: [
      {
        srcset: "small.jpg 400w, large.jpg 800w",
        sizes: [
          { expression: "50vw" },
          { media: "(min-width: 900px)", expression: "100vw" },
        ],
      },
    ],
    img: { src: "fallback.jpg" },
    baseUrl: "https://cdn.example.test/gallery/",
    viewportWidth: Rational.from("1000"),
    dpr: Rational.from("2"),
    supportedMimeTypes: [],
  });

  assert.equal(
    result.selected.url,
    "https://cdn.example.test/gallery/large.jpg",
  );
  assert.equal(result.selected.slotWidth.toString(), "500");
  assert.equal(result.selected.density.toString(), "8/5");
  assert.equal(result.sizesIndex, 0);
});
