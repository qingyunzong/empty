import test from "node:test";
import assert from "node:assert/strict";
import { MemoryFileAdapter, PowerCutError } from "../src/memory-adapter";
import { Migrator } from "../src/migrator";
import type { ConfigObject, Migration } from "../src/types";

const CONFIG_PATH = "/app/config.json";
const JOURNAL_PATH = CONFIG_PATH + ".journal";

const ORIGINAL: ConfigObject = {
  version: "1",
  window: { width: 800, height: 600 },
  accounts: ["alice"],
};

function seed(adapter: MemoryFileAdapter, config: ConfigObject = ORIGINAL): void {
  adapter.write(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function readConfig(adapter: MemoryFileAdapter): ConfigObject {
  return JSON.parse(adapter.read(CONFIG_PATH)!) as ConfigObject;
}

interface StepOptions {
  failUp?: boolean;
  failDown?: { times: number };
}

/** v1 -> v2: adds `ui.theme`; v2 -> v3: renames `accounts` to `profiles`. */
function makeMigrations(options: Record<string, StepOptions> = {}): Migration[] {
  const up1 = options["001-add-theme"]?.failUp;
  const up2 = options["002-rename-accounts"]?.failUp;
  const down1 = options["001-add-theme"]?.failDown;
  const down2 = options["002-rename-accounts"]?.failDown;
  let down1Failures = 0;
  let down2Failures = 0;
  return [
    {
      id: "001-add-theme",
      from: "1",
      to: "2",
      up(config) {
        if (up1) throw new Error("up 001 exploded");
        return { ...config, ui: { theme: "dark" } };
      },
      down(config) {
        if (down1 && down1Failures++ < down1.times) {
          throw new Error("down 001 exploded");
        }
        const { ui: _ui, ...rest } = config as { ui?: unknown };
        return rest;
      },
    },
    {
      id: "002-rename-accounts",
      from: "2",
      to: "3",
      up(config) {
        if (up2) throw new Error("up 002 exploded");
        const { accounts, ...rest } = config as { accounts?: unknown };
        return { ...rest, profiles: accounts };
      },
      down(config) {
        if (down2 && down2Failures++ < down2.times) {
          throw new Error("down 002 exploded");
        }
        const { profiles, ...rest } = config as { profiles?: unknown };
        return { ...rest, accounts: profiles };
      },
    },
  ];
}

function makeMigrator(
  adapter: MemoryFileAdapter,
  migrations: Migration[],
): Migrator {
  return new Migrator({ adapter, configPath: CONFIG_PATH, migrations });
}

test("migrates across the version graph to the inferred latest version", () => {
  const adapter = new MemoryFileAdapter();
  seed(adapter);
  const result = makeMigrator(adapter, makeMigrations()).migrate();

  assert.equal(result.status, "migrated");
  assert.equal(result.version, "3");
  assert.deepEqual(result.applied, ["001-add-theme", "002-rename-accounts"]);
  assert.deepEqual(readConfig(adapter), {
    version: "3",
    window: { width: 800, height: 600 },
    ui: { theme: "dark" },
    profiles: ["alice"],
  });
  assert.equal(adapter.exists(JOURNAL_PATH), false);
});

test("takes the shorter branch of a diverging version graph", () => {
  const adapter = new MemoryFileAdapter();
  seed(adapter);
  const direct: Migration = {
    id: "010-v1-to-v3",
    from: "1",
    to: "3",
    up: (c) => ({ ...c, via: "direct" }),
    down: (c) => c,
  };
  const result = makeMigrator(adapter, [...makeMigrations(), direct]).migrate("3");

  assert.equal(result.status, "migrated");
  assert.deepEqual(result.applied, ["010-v1-to-v3"]);
  assert.equal(readConfig(adapter)["via"], "direct");
});

test("reports already-current when no migration is needed", () => {
  const adapter = new MemoryFileAdapter();
  seed(adapter, { ...ORIGINAL, version: "3" });
  const result = makeMigrator(adapter, makeMigrations()).migrate("3");
  assert.equal(result.status, "already-current");
});

test("rolls back in reverse order when a forward step fails", () => {
  const adapter = new MemoryFileAdapter();
  seed(adapter);
  const migrations = makeMigrations({
    "002-rename-accounts": { failUp: true },
  });
  const result = makeMigrator(adapter, migrations).migrate("3");

  assert.equal(result.status, "rolled-back");
  assert.equal(result.version, "1");
  assert.deepEqual(result.applied, ["001-add-theme"]);
  assert.deepEqual(result.reverted, ["001-add-theme"]);
  assert.match(result.error ?? "", /up 002 exploded/);
  // Config is byte-identical to the original.
  assert.equal(adapter.read(CONFIG_PATH), JSON.stringify(ORIGINAL, null, 2));
  assert.equal(adapter.exists(JOURNAL_PATH), false);
});

test("keeps the resume position when a reverse patch fails, then recover() finishes", () => {
  const adapter = new MemoryFileAdapter();
  seed(adapter);
  const migrations = makeMigrations({
    "002-rename-accounts": { failUp: true },
    "001-add-theme": { failDown: { times: 1 } },
  });
  const migrator = makeMigrator(adapter, migrations);

  const failed = migrator.migrate("3");
  assert.equal(failed.status, "rollback-paused");
  assert.equal(failed.version, "2"); // still at the intermediate version
  assert.match(failed.error ?? "", /down 001 exploded/);
  assert.equal(adapter.exists(JOURNAL_PATH), true);
  // Config keeps the intermediate state: theme added, accounts not renamed.
  assert.deepEqual(readConfig(adapter), {
    version: "2",
    window: { width: 800, height: 600 },
    accounts: ["alice"],
    ui: { theme: "dark" },
  });

  // migrate() refuses to run on top of an unfinished journal.
  assert.throws(() => migrator.migrate("3"), /recover\(\) first/);

  const recovered = migrator.recover();
  assert.equal(recovered.status, "rolled-back");
  assert.equal(recovered.version, "1");
  assert.deepEqual(recovered.reverted, ["001-add-theme"]);
  assert.equal(adapter.read(CONFIG_PATH), JSON.stringify(ORIGINAL, null, 2));
  assert.equal(adapter.exists(JOURNAL_PATH), false);
});

test("survives a power cut mid-migration and recover() rolls back to the origin", () => {
  const adapter = new MemoryFileAdapter();
  seed(adapter);
  const migrator = makeMigrator(adapter, makeMigrations());

  // Writes so far: 1 (seed). Journal write is #2, first config write #3.
  // Cut the power right after the first step commits.
  adapter.crashAfterWrites(2);
  assert.throws(() => migrator.migrate("3"), PowerCutError);

  // Machine restarts; the config on "disk" is at the intermediate version.
  adapter.reboot();
  assert.equal(readConfig(adapter)["version"], "2");
  assert.equal(adapter.exists(JOURNAL_PATH), true);

  const recovered = makeMigrator(adapter, makeMigrations()).recover();
  assert.equal(recovered.status, "rolled-back");
  assert.equal(recovered.version, "1");
  assert.equal(adapter.read(CONFIG_PATH), JSON.stringify(ORIGINAL, null, 2));
  assert.equal(adapter.exists(JOURNAL_PATH), false);
});

test("survives a power cut mid-rollback and resumes from the recorded position", () => {
  const adapter = new MemoryFileAdapter();
  seed(adapter);
  const migrations = makeMigrations({
    "002-rename-accounts": { failUp: true },
  });

  // Writes after arming: 1 journal(migrating), 2 config@2, 3 journal(rolling-back).
  // Cut power during the rollback's config write so the journal survives.
  adapter.crashAfterWrites(3);
  assert.throws(() => makeMigrator(adapter, migrations).migrate("3"), PowerCutError);

  adapter.reboot();
  // The rollback never committed: config is still at version "2".
  assert.equal(readConfig(adapter)["version"], "2");

  const recovered = makeMigrator(adapter, migrations).recover();
  assert.equal(recovered.status, "rolled-back");
  assert.equal(adapter.read(CONFIG_PATH), JSON.stringify(ORIGINAL, null, 2));
});

test("repeated recover() calls are safe and idempotent", () => {
  const adapter = new MemoryFileAdapter();
  seed(adapter);
  const migrations = makeMigrations({
    "002-rename-accounts": { failUp: true },
    "001-add-theme": { failDown: { times: 2 } },
  });
  const migrator = makeMigrator(adapter, migrations);

  assert.equal(migrator.migrate("3").status, "rollback-paused");
  // First recovery attempt hits the second injected down-failure.
  const first = migrator.recover();
  assert.equal(first.status, "rollback-paused");
  assert.equal(first.version, "2");
  // Second attempt finishes the rollback.
  const second = migrator.recover();
  assert.equal(second.status, "rolled-back");
  assert.equal(adapter.read(CONFIG_PATH), JSON.stringify(ORIGINAL, null, 2));
  // Third and fourth calls are no-ops.
  assert.equal(migrator.recover().status, "already-current");
  assert.equal(migrator.recover().status, "already-current");
  assert.equal(adapter.read(CONFIG_PATH), JSON.stringify(ORIGINAL, null, 2));
});

test("recover() on a clean state is a no-op", () => {
  const adapter = new MemoryFileAdapter();
  seed(adapter);
  const result = makeMigrator(adapter, makeMigrations()).recover();
  assert.equal(result.status, "already-current");
  assert.equal(result.version, "1");
});
