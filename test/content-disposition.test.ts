import assert from "node:assert/strict";
import test from "node:test";

import {
  dispositionFilename,
  filenameMatches,
  parseContentDisposition,
  safeFilename,
} from "../index.ts";

test("parses quoted, escaped, and RFC 5987 filenames", () => {
  const parsed = parseContentDisposition(
    "attachment; filename=\"fallback \\\"name\\\".zip\"; filename*=UTF-8''%E4%B8%AD%E6%96%87%20report.zip",
  );
  assert.equal(parsed?.type, "attachment");
  assert.equal(parsed?.filename, "中文 report.zip");
  assert.equal(parsed?.parameters.filename, "fallback \"name\".zip");

  assert.equal(
    dispositionFilename("inline; filename=plain.txt"),
    "plain.txt",
  );
  assert.equal(dispositionFilename(undefined), undefined);
});

test("compares sanitized basenames", () => {
  assert.equal(safeFilename("C:\\downloads\\a.zip"), "a.zip");
  assert.equal(safeFilename("../a.zip"), "a.zip");
  assert.equal(filenameMatches("folder/report.zip", "report.zip"), true);
  assert.equal(filenameMatches("report.zip", "other.zip"), false);
  assert.equal(filenameMatches(undefined, "report.zip"), false);
});
