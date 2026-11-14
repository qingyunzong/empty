import assert from "node:assert/strict";
import test from "node:test";

import { matchUrl, normalizeUrl } from "../index.ts";

test("normalizes fragments but preserves query strings", () => {
  assert.equal(
    normalizeUrl("HTTPS://Example.COM:443/a/../b?token=1#frag"),
    "https://example.com/b?token=1",
  );
});

test("distinguishes exact URL matches from origin-path matches", () => {
  const exact = matchUrl(
    "https://example.com/file.zip?token=a",
    "https://example.com/file.zip?token=a#ignored",
  );
  assert.equal(exact?.kind, "exact");

  const queryless = matchUrl(
    "https://example.com/file.zip?token=a",
    "https://example.com/file.zip?token=b",
  );
  assert.equal(queryless?.kind, "origin-path");

  assert.equal(
    matchUrl(
      "https://example.com/file.zip?token=a",
      "https://example.com/file.zip?token=b",
      { allowQueryless: false },
    ),
    undefined,
  );
});
