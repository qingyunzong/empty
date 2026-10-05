import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  Exporter,
  FsPublisher,
  MemoryPermissionAuthority,
  MemorySnapshotSource,
  PermissionVerificationError,
} from "../src/index";
import type { ExportRow, Publisher, StagedFile } from "../src/index";

const ROWS: ExportRow[] = [
  { id: "row-1", permissionEpoch: 7, payload: "alpha" },
  { id: "row-2", permissionEpoch: 3, payload: "beta" },
  { id: "row-3", permissionEpoch: 11, payload: "gamma" },
];

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "safe-export-test-"));
}

function makeAuthority(): MemoryPermissionAuthority {
  return new MemoryPermissionAuthority(ROWS.map((r) => [r.id, r.permissionEpoch] as const));
}

/** Runs `hook` between snapshot/staging and the pre-publish re-verification. */
function hookingPublisher(inner: Publisher, hook: () => void): Publisher {
  return {
    async stage(targetPath: string, content: string): Promise<StagedFile> {
      const staged = await inner.stage(targetPath, content);
      hook();
      return staged;
    },
  };
}

test("publishes snapshot content when all permission epochs still match", async () => {
  const dir = makeTempDir();
  try {
    const target = join(dir, "export.ndjson");
    const exporter = new Exporter(
      new MemorySnapshotSource(ROWS),
      makeAuthority(),
      new FsPublisher()
    );

    const result = await exporter.export({ targetPath: target });

    assert.equal(result.rowCount, 3);
    const content = readFileSync(target, "utf8");
    const lines = content.trim().split("\n");
    assert.equal(lines.length, 4); // header + 3 rows
    assert.equal(JSON.parse(lines[0]!).snapshotId, result.snapshotId);
    assert.deepEqual(
      lines.slice(1).map((l) => JSON.parse(l).id),
      ["row-1", "row-2", "row-3"]
    );
    assert.ok(!existsSync(join(dir, ".staging")), "staging dir cleaned after commit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshot is fixed at export start: later source mutations are not exported", async () => {
  const dir = makeTempDir();
  try {
    const target = join(dir, "export.ndjson");
    const source = new MemorySnapshotSource(ROWS);
    // Mutate the source after the snapshot was taken but before publish.
    const publisher = hookingPublisher(new FsPublisher(), () => {
      source.mutate((rows) => [
        ...rows.filter((r) => r.id !== "row-2"),
        { id: "row-4", permissionEpoch: 1, payload: "late-addition" },
      ]);
    });
    const exporter = new Exporter(source, makeAuthority(), publisher);

    await exporter.export({ targetPath: target });

    const content = readFileSync(target, "utf8");
    assert.ok(content.includes("row-2"), "row removed after snapshot is still exported");
    assert.ok(!content.includes("row-4"), "row added after snapshot is not exported");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mid-export revocation withholds the whole file and leaves the old file unchanged", async () => {
  const dir = makeTempDir();
  try {
    const target = join(dir, "export.ndjson");
    const oldContent = "previous published export\n";
    writeFileSync(target, oldContent);

    const authority = makeAuthority();
    // Revoke one row's permission while the export is staged.
    const publisher = hookingPublisher(new FsPublisher(), () => authority.revoke("row-2"));
    const exporter = new Exporter(new MemorySnapshotSource(ROWS), authority, publisher);

    await assert.rejects(
      exporter.export({ targetPath: target }),
      (err: unknown) => {
        if (!(err instanceof PermissionVerificationError)) return false;
        assert.equal(err.kind, "revoked");
        assert.equal(err.rowId, "row-2");
        return true;
      }
    );

    assert.equal(readFileSync(target, "utf8"), oldContent, "old file byte-for-byte unchanged");
    assert.ok(!existsSync(join(dir, ".staging")), "staging dir cleaned after abort");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("epoch change without revocation also withholds the whole file", async () => {
  const dir = makeTempDir();
  try {
    const target = join(dir, "export.ndjson");
    const authority = makeAuthority();
    const publisher = hookingPublisher(new FsPublisher(), () =>
      authority.setEpoch("row-3", 12)
    );
    const exporter = new Exporter(new MemorySnapshotSource(ROWS), authority, publisher);

    await assert.rejects(
      exporter.export({ targetPath: target }),
      (err: unknown) => {
        if (!(err instanceof PermissionVerificationError)) return false;
        assert.equal(err.kind, "epoch-changed");
        assert.equal(err.rowId, "row-3");
        assert.equal(err.snapshotEpoch, 11);
        assert.equal(err.currentEpoch, 12);
        return true;
      }
    );
    assert.ok(!existsSync(target), "no file published at all");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("publish failure leaves the old file unchanged and cleans staging", async () => {
  const dir = makeTempDir();
  try {
    const target = join(dir, "export.ndjson");
    const oldContent = "keep me\n";
    writeFileSync(target, oldContent);

    const failingPublisher: Publisher = {
      async stage(targetPath: string): Promise<StagedFile> {
        const inner = await new FsPublisher().stage(targetPath, "staged content");
        return {
          stagingPath: inner.stagingPath,
          commit: async () => {
            throw new Error("simulated publish failure (disk full)");
          },
          abort: inner.abort,
        };
      },
    };
    const exporter = new Exporter(
      new MemorySnapshotSource(ROWS),
      makeAuthority(),
      failingPublisher
    );

    await assert.rejects(exporter.export({ targetPath: target }), /simulated publish failure/);

    assert.equal(readFileSync(target, "utf8"), oldContent, "old file byte-for-byte unchanged");
    assert.ok(!existsSync(join(dir, ".staging")), "staging dir cleaned after failure");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("intermediate staging is not readable (dir 0700, file 0600)", async () => {
  const dir = makeTempDir();
  try {
    const target = join(dir, "export.ndjson");
    const observed: { fileMode?: number; dirMode?: number } = {};
    const inspecting = hookingPublisher(new FsPublisher(), () => {
      const stagingDir = join(dir, ".staging");
      const stagedFiles = readdirSync(stagingDir);
      assert.equal(stagedFiles.length, 1, "exactly one staged file");
      observed.fileMode = statSync(join(stagingDir, stagedFiles[0]!)).mode & 0o777;
      observed.dirMode = statSync(stagingDir).mode & 0o777;
    });
    const exporter = new Exporter(new MemorySnapshotSource(ROWS), makeAuthority(), inspecting);

    await exporter.export({ targetPath: target });

    assert.equal(observed.dirMode, 0o700, "staging dir is owner-only");
    assert.equal(observed.fileMode, 0o600, "staged file is owner read/write only");
    assert.equal(
      statSync(dirname(target)).mode & 0o777,
      0o700,
      "temp dir itself untouched"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
