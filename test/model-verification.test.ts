import test from "node:test";
import assert from "node:assert/strict";
import { Database, UniqueConstraintError, type Row, type RowId } from "../src/database";
import { ModelTable } from "../src/model";

const SCHEMA = {
  name: "items",
  indexedFields: ["group", "qty"],
  uniqueFields: ["sku"],
} as const;

/** Deterministic PRNG (mulberry32) so failures reproduce. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sortedRows(rows: Iterable<Row>): Row[] {
  return [...rows]
    .map((row) => ({ ...row }))
    .sort((a, b) => (String(a.sku) < String(b.sku) ? -1 : 1));
}

test("replica table with fully rebuilt indexes verifies the real database", () => {
  for (const seed of [1, 7, 42, 1337, 20261008]) {
    const random = rng(seed);
    const db = new Database();
    db.createTable(SCHEMA);
    const model = new ModelTable(SCHEMA);

    // The replica is fed exclusively from post-commit notifications.
    db.subscribe("items", (changes) => model.apply(changes));

    const liveIds: RowId[] = [];
    let skuCounter = 0;

    const pickId = (): RowId =>
      liveIds[Math.floor(random() * liveIds.length)];

    const pickOtherId = (id: RowId): RowId => {
      let other = pickId();
      while (other === id) other = pickId();
      return other;
    };

    const verify = (step: number): void => {
      // Row content matches the replica...
      assert.deepEqual(
        sortedRows(db.all("items")),
        sortedRows(model.rows.values()),
        `rows diverged (seed ${seed}, step ${step})`,
      );
      // ...every incrementally maintained index matches a full rebuild...
      assert.deepEqual(
        db.indexSnapshot("items"),
        model.rebuildIndexes(),
        `index mismatch (seed ${seed}, step ${step})`,
      );
      // ...and index-driven queries match the model's full scans.
      for (const group of ["g0", "g1", "g2", "g3"]) {
        assert.deepEqual(
          sortedRows(db.query("items", "group", group)),
          sortedRows(model.query("group", group)),
          `query mismatch (seed ${seed}, step ${step})`,
        );
      }
    };

    for (let step = 0; step < 400; step++) {
      const roll = random();
      try {
        if (roll < 0.35 || liveIds.length === 0) {
          // insert; ~10% deliberately reuse a live sku -> must roll back
          const duplicate = random() < 0.1 && liveIds.length > 0;
          const sku = duplicate
            ? db.get("items", liveIds[0])!.sku
            : `sku-${skuCounter++}`;
          const row = {
            sku,
            group: `g${Math.floor(random() * 4)}`,
            qty: Math.floor(random() * 5),
          };
          if (duplicate) {
            const before = db.all("items");
            assert.throws(
              () => db.transaction((tx) => tx.insert("items", row)),
              (err) => err instanceof UniqueConstraintError,
            );
            assert.deepEqual(db.all("items"), before, "rollback left state untouched");
          } else {
            db.transaction((tx) => tx.insert("items", row));
            const id = db
              .indexSnapshot("items")
              .uniqueIndexes.sku.find(([value]) => value === row.sku)![1];
            liveIds.push(id);
          }
        } else if (roll < 0.6) {
          // update, sometimes several times to the same row in one tx
          const id = pickId();
          db.transaction((tx) => {
            const rounds = 1 + Math.floor(random() * 3);
            for (let i = 0; i < rounds; i++) {
              tx.update("items", id, {
                qty: Math.floor(random() * 5),
                group: `g${Math.floor(random() * 4)}`,
              });
            }
          });
        } else if (roll < 0.75 && liveIds.length >= 2) {
          // swap the unique keys of two rows inside one batch
          const a = pickId();
          const b = pickOtherId(a);
          const skuA = db.get("items", a)!.sku;
          const skuB = db.get("items", b)!.sku;
          db.transaction((tx) => {
            tx.update("items", a, { sku: skuB });
            tx.update("items", b, { sku: skuA });
          });
        } else if (roll < 0.85 && liveIds.length >= 2) {
          // conflicting update -> whole transaction must roll back
          const a = pickId();
          const b = pickOtherId(a);
          const skuB = db.get("items", b)!.sku;
          const before = db.all("items");
          assert.throws(
            () =>
              db.transaction((tx) => {
                tx.update("items", a, { sku: skuB, qty: 999 });
                tx.insert("items", {
                  sku: `sku-${skuCounter++}`,
                  group: "g0",
                  qty: 0,
                });
              }),
            (err) => err instanceof UniqueConstraintError,
          );
          assert.deepEqual(db.all("items"), before, "rollback left state untouched");
        } else {
          // delete
          const id = pickId();
          db.transaction((tx) => tx.delete("items", id));
          liveIds.splice(liveIds.indexOf(id), 1);
        }
      } catch (err) {
        throw new Error(`seed ${seed} step ${step}: ${(err as Error).message}`);
      }
      verify(step);
    }
  }
});
