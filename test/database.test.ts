import test from "node:test";
import assert from "node:assert/strict";
import {
  Database,
  UniqueConstraintError,
  type Change,
} from "../src/database";

function makeDb() {
  const db = new Database();
  db.createTable({
    name: "users",
    indexedFields: ["age", "city"],
    uniqueFields: ["email"],
  });
  return db;
}

test("indexes map field values to row ids", () => {
  const db = makeDb();
  let alice = 0;
  let bob = 0;
  db.transaction((tx) => {
    alice = tx.insert("users", { email: "a@x.io", age: 30, city: "sh" });
    bob = tx.insert("users", { email: "b@x.io", age: 30, city: "bj" });
  });

  assert.deepEqual(
    db.query("users", "age", 30).map((r) => r.email).sort(),
    ["a@x.io", "b@x.io"],
  );
  assert.deepEqual(db.query("users", "city", "bj"), [
    { email: "b@x.io", age: 30, city: "bj" },
  ]);
  assert.deepEqual(db.query("users", "email", "a@x.io"), [
    { email: "a@x.io", age: 30, city: "sh" },
  ]);

  db.transaction((tx) => tx.update("users", alice, { city: "gz" }));
  assert.deepEqual(db.query("users", "city", "sh"), []);
  assert.equal(db.query("users", "city", "gz").length, 1);

  db.transaction((tx) => tx.delete("users", bob));
  assert.deepEqual(db.query("users", "email", "b@x.io"), []);
  assert.equal(db.query("users", "age", 30).length, 1);
});

test("repeated writes to one row publish only the final delta", () => {
  const db = makeDb();
  let id = 0;
  db.transaction((tx) => {
    id = tx.insert("users", { email: "a@x.io", age: 30, city: "sh" });
  });

  const published: Change[][] = [];
  db.subscribe("users", (changes) => published.push([...changes]));

  db.transaction((tx) => {
    tx.update("users", id, { age: 31 });
    tx.update("users", id, { age: 32, city: "bj" });
    tx.update("users", id, { city: "gz" });
  });

  assert.equal(published.length, 1);
  assert.deepEqual(published[0], [
    {
      type: "update",
      id,
      before: { email: "a@x.io", age: 30, city: "sh" },
      after: { email: "a@x.io", age: 32, city: "gz" },
    },
  ]);

  // insert + update + delete of the same row inside one tx nets out to nothing
  db.transaction((tx) => {
    const temp = tx.insert("users", { email: "tmp@x.io", age: 1, city: "sh" });
    tx.update("users", temp, { age: 2 });
    tx.delete("users", temp);
  });
  assert.equal(published.length, 1, "no notification for a net-zero row");

  // net-zero update publishes nothing either
  db.transaction((tx) => {
    tx.update("users", id, { age: 99 });
    tx.update("users", id, { age: 32 });
  });
  assert.equal(published.length, 1);
});

test("unique index allows swapping keys within one batch", () => {
  const db = makeDb();
  let alice = 0;
  let bob = 0;
  db.transaction((tx) => {
    alice = tx.insert("users", { email: "a@x.io", age: 30, city: "sh" });
    bob = tx.insert("users", { email: "b@x.io", age: 40, city: "bj" });
  });

  db.transaction((tx) => {
    tx.update("users", alice, { email: "b@x.io" });
    tx.update("users", bob, { email: "a@x.io" });
  });

  assert.equal(db.get("users", alice)!.email, "b@x.io");
  assert.equal(db.get("users", bob)!.email, "a@x.io");
  assert.deepEqual(db.query("users", "email", "a@x.io"), [
    { email: "a@x.io", age: 40, city: "bj" },
  ]);
});

test("unique conflict rolls back the whole transaction", () => {
  const db = makeDb();
  let alice = 0;
  db.transaction((tx) => {
    alice = tx.insert("users", { email: "a@x.io", age: 30, city: "sh" });
    tx.insert("users", { email: "b@x.io", age: 40, city: "bj" });
  });

  const published: Change[][] = [];
  db.subscribe("users", (changes) => published.push([...changes]));

  assert.throws(
    () =>
      db.transaction((tx) => {
        tx.insert("users", { email: "c@x.io", age: 50, city: "gz" });
        tx.update("users", alice, { email: "b@x.io", age: 31 });
      }),
    (err) => err instanceof UniqueConstraintError,
  );

  // nothing leaked through: no new row, no partial update, no notification
  assert.equal(db.all("users").length, 2);
  assert.deepEqual(db.get("users", alice), {
    email: "a@x.io",
    age: 30,
    city: "sh",
  });
  assert.deepEqual(db.query("users", "email", "c@x.io"), []);
  assert.deepEqual(db.query("users", "city", "gz"), []);
  assert.equal(published.length, 0);
});

test("exceptions inside a transaction roll back everything", () => {
  const db = makeDb();
  assert.throws(
    () =>
      db.transaction((tx) => {
        tx.insert("users", { email: "a@x.io", age: 30, city: "sh" });
        throw new Error("boom");
      }),
    /boom/,
  );
  assert.equal(db.all("users").length, 0);
  assert.deepEqual(db.indexSnapshot("users"), {
    indexes: { age: [], city: [] },
    uniqueIndexes: { email: [] },
  });
});

test("subscribers run after commit and may reenter", () => {
  const db = makeDb();
  const events: string[] = [];

  db.subscribe("users", (changes, db2) => {
    for (const change of changes) {
      // post-commit: committed state is already visible inside the callback
      const visible = db2.get("users", change.id);
      events.push(`saw ${change.type} committed=${visible !== undefined}`);
      if (change.type === "insert") {
        // reentrant: open and commit a brand-new transaction from the callback
        db2.transaction((tx) =>
          tx.update("users", change.id, { city: "reentrant" }),
        );
      }
    }
  });

  let id = 0;
  db.transaction((tx) => {
    id = tx.insert("users", { email: "a@x.io", age: 30, city: "sh" });
    events.push(`inside tx, committed sees: ${db.all("users").length}`);
  });

  assert.deepEqual(events, [
    "inside tx, committed sees: 0",
    "saw insert committed=true",
    "saw update committed=true",
  ]);
  assert.equal(db.get("users", id)!.city, "reentrant");
});

test("unsubscribe stops notifications", () => {
  const db = makeDb();
  let count = 0;
  const off = db.subscribe("users", () => count++);
  db.transaction((tx) => tx.insert("users", { email: "a@x.io" }));
  off();
  db.transaction((tx) => tx.insert("users", { email: "b@x.io" }));
  assert.equal(count, 1);
});
