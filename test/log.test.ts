import { test } from "node:test";
import { strictEqual, deepStrictEqual } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PersistentLog } from "../src/log.js";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "logtest-"));
}

test("append assigns sequential LSNs and persists across reopen", () => {
  const dir = tmpdir();
  const log = PersistentLog.open<string>(dir);
  strictEqual(log.append("a").lsn, 1);
  strictEqual(log.append("b").lsn, 2);
  strictEqual(log.append("c").lsn, 3);
  strictEqual(log.startLsn, 1);
  strictEqual(log.lastLsn, 3);

  const reopened = PersistentLog.open<string>(dir);
  strictEqual(reopened.lastLsn, 3);
  deepStrictEqual(
    reopened.entriesAfter(0).map((e) => e.value),
    ["a", "b", "c"],
  );
  deepStrictEqual(
    reopened.entriesAfter(1).map((e) => e.value),
    ["b", "c"],
  );
});

test("truncatePrefix reclaims the confirmed prefix and survives reopen", () => {
  const dir = tmpdir();
  const log = PersistentLog.open<number>(dir);
  for (let i = 1; i <= 5; i++) log.append(i * 10);

  strictEqual(log.truncatePrefix(3), 3);
  strictEqual(log.startLsn, 4);
  strictEqual(log.length, 2);
  deepStrictEqual(
    log.entriesAfter(0).map((e) => e.value),
    [40, 50],
  );

  // Truncating below the frontier is a no-op.
  strictEqual(log.truncatePrefix(2), 0);
  strictEqual(log.startLsn, 4);

  const reopened = PersistentLog.open<number>(dir);
  strictEqual(reopened.startLsn, 4);
  strictEqual(reopened.lastLsn, 5);
  deepStrictEqual(
    reopened.entriesAfter(0).map((e) => e.value),
    [40, 50],
  );

  // Truncating past the tail clamps at lastLsn.
  strictEqual(reopened.truncatePrefix(99), 2);
  strictEqual(reopened.length, 0);
  strictEqual(reopened.startLsn, 6);
  // LSNs are never reused after full reclamation.
  strictEqual(reopened.append(60).lsn, 6);
});
