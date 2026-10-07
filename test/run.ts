// Runs every test file in a single process. `node --test` spawns a child
// process per file, which is not permitted in every sandbox, so the suite is
// driven through node:test's in-process execution instead.
import "./validate.test.js";
import "./differential.test.js";
