"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const database_1 = require("../src/database");
function makeDb() {
    const db = new database_1.Database();
    db.createTable({
        name: "users",
        indexedFields: ["age", "city"],
        uniqueFields: ["email"],
    });
    return db;
}
(0, node_test_1.default)("indexes map field values to row ids", () => {
    const db = makeDb();
    let alice = 0;
    let bob = 0;
    db.transaction((tx) => {
        alice = tx.insert("users", { email: "a@x.io", age: 30, city: "sh" });
        bob = tx.insert("users", { email: "b@x.io", age: 30, city: "bj" });
    });
    strict_1.default.deepEqual(db.query("users", "age", 30).map((r) => r.email).sort(), ["a@x.io", "b@x.io"]);
    strict_1.default.deepEqual(db.query("users", "city", "bj"), [
        { email: "b@x.io", age: 30, city: "bj" },
    ]);
    strict_1.default.deepEqual(db.query("users", "email", "a@x.io"), [
        { email: "a@x.io", age: 30, city: "sh" },
    ]);
    db.transaction((tx) => tx.update("users", alice, { city: "gz" }));
    strict_1.default.deepEqual(db.query("users", "city", "sh"), []);
    strict_1.default.equal(db.query("users", "city", "gz").length, 1);
    db.transaction((tx) => tx.delete("users", bob));
    strict_1.default.deepEqual(db.query("users", "email", "b@x.io"), []);
    strict_1.default.equal(db.query("users", "age", 30).length, 1);
});
(0, node_test_1.default)("repeated writes to one row publish only the final delta", () => {
    const db = makeDb();
    let id = 0;
    db.transaction((tx) => {
        id = tx.insert("users", { email: "a@x.io", age: 30, city: "sh" });
    });
    const published = [];
    db.subscribe("users", (changes) => published.push([...changes]));
    db.transaction((tx) => {
        tx.update("users", id, { age: 31 });
        tx.update("users", id, { age: 32, city: "bj" });
        tx.update("users", id, { city: "gz" });
    });
    strict_1.default.equal(published.length, 1);
    strict_1.default.deepEqual(published[0], [
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
    strict_1.default.equal(published.length, 1, "no notification for a net-zero row");
    // net-zero update publishes nothing either
    db.transaction((tx) => {
        tx.update("users", id, { age: 99 });
        tx.update("users", id, { age: 32 });
    });
    strict_1.default.equal(published.length, 1);
});
(0, node_test_1.default)("unique index allows swapping keys within one batch", () => {
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
    strict_1.default.equal(db.get("users", alice).email, "b@x.io");
    strict_1.default.equal(db.get("users", bob).email, "a@x.io");
    strict_1.default.deepEqual(db.query("users", "email", "a@x.io"), [
        { email: "a@x.io", age: 40, city: "bj" },
    ]);
});
(0, node_test_1.default)("unique conflict rolls back the whole transaction", () => {
    const db = makeDb();
    let alice = 0;
    db.transaction((tx) => {
        alice = tx.insert("users", { email: "a@x.io", age: 30, city: "sh" });
        tx.insert("users", { email: "b@x.io", age: 40, city: "bj" });
    });
    const published = [];
    db.subscribe("users", (changes) => published.push([...changes]));
    strict_1.default.throws(() => db.transaction((tx) => {
        tx.insert("users", { email: "c@x.io", age: 50, city: "gz" });
        tx.update("users", alice, { email: "b@x.io", age: 31 });
    }), (err) => err instanceof database_1.UniqueConstraintError);
    // nothing leaked through: no new row, no partial update, no notification
    strict_1.default.equal(db.all("users").length, 2);
    strict_1.default.deepEqual(db.get("users", alice), {
        email: "a@x.io",
        age: 30,
        city: "sh",
    });
    strict_1.default.deepEqual(db.query("users", "email", "c@x.io"), []);
    strict_1.default.deepEqual(db.query("users", "city", "gz"), []);
    strict_1.default.equal(published.length, 0);
});
(0, node_test_1.default)("exceptions inside a transaction roll back everything", () => {
    const db = makeDb();
    strict_1.default.throws(() => db.transaction((tx) => {
        tx.insert("users", { email: "a@x.io", age: 30, city: "sh" });
        throw new Error("boom");
    }), /boom/);
    strict_1.default.equal(db.all("users").length, 0);
    strict_1.default.deepEqual(db.indexSnapshot("users"), {
        indexes: { age: [], city: [] },
        uniqueIndexes: { email: [] },
    });
});
(0, node_test_1.default)("subscribers run after commit and may reenter", () => {
    const db = makeDb();
    const events = [];
    db.subscribe("users", (changes, db2) => {
        for (const change of changes) {
            // post-commit: committed state is already visible inside the callback
            const visible = db2.get("users", change.id);
            events.push(`saw ${change.type} committed=${visible !== undefined}`);
            if (change.type === "insert") {
                // reentrant: open and commit a brand-new transaction from the callback
                db2.transaction((tx) => tx.update("users", change.id, { city: "reentrant" }));
            }
        }
    });
    let id = 0;
    db.transaction((tx) => {
        id = tx.insert("users", { email: "a@x.io", age: 30, city: "sh" });
        events.push(`inside tx, committed sees: ${db.all("users").length}`);
    });
    strict_1.default.deepEqual(events, [
        "inside tx, committed sees: 0",
        "saw insert committed=true",
        "saw update committed=true",
    ]);
    strict_1.default.equal(db.get("users", id).city, "reentrant");
});
(0, node_test_1.default)("unsubscribe stops notifications", () => {
    const db = makeDb();
    let count = 0;
    const off = db.subscribe("users", () => count++);
    db.transaction((tx) => tx.insert("users", { email: "a@x.io" }));
    off();
    db.transaction((tx) => tx.insert("users", { email: "b@x.io" }));
    strict_1.default.equal(count, 1);
});
