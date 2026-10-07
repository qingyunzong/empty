import assert from 'node:assert/strict';
import test from 'node:test';
import { StateStore, applyAction, heldKeys, initialState, parseGrid, replayPath, shortestPath, verifyPath, } from '../src/index.js';
const OPEN_CORRIDOR = `
#####
#S..#
#..G#
#####
`;
const KEY_DOOR = `
#####
#Sa.#
###A#
#..G#
#####
`;
// Two doors share key 'a': the first must be undone to refund the key
// before the second can be opened.
const UNDO_CORRIDOR = `
#########
#Sa.A.AG#
#########
`;
const NO_KEY = `
#####
#S.A#
#.#G#
#####
`;
test('parseGrid validates size, characters and key budget', () => {
    assert.throws(() => parseGrid('###########\n#S.......G#\n###########'), /at most 10x10/);
    assert.throws(() => parseGrid('###\n#S#\n#G#\n###\n###\n###\n###\n###\n###\n###\n###\n'), /at most 10x10/);
    assert.throws(() => parseGrid('###\n#S?\n#G#\n###\n'), /unexpected character/);
    assert.throws(() => parseGrid('###\n#Sf\n#G#\n###\n'), /at most 5 keys/);
    assert.throws(() => parseGrid('###\n#S#\n#.#\n###\n'), /no goal/);
});
test('shortest path in an open corridor equals Manhattan distance', () => {
    const grid = parseGrid(OPEN_CORRIDOR);
    const result = shortestPath(grid, initialState(grid));
    assert.ok(result);
    assert.equal(result.actions.length, 3);
    assert.equal(result.verified, true);
    assert.equal(result.finalState.x, grid.goal.x);
    assert.equal(result.finalState.y, grid.goal.y);
});
test('key is collected and spent to open the matching door', () => {
    const grid = parseGrid(KEY_DOOR);
    const result = shortestPath(grid, initialState(grid));
    assert.ok(result);
    assert.equal(result.actions.length, 5);
    assert.deepEqual(result.actions.filter((a) => a.kind === 'open'), [{ kind: 'open', door: 0 }]);
    // The key is consumed by the open door.
    assert.equal(heldKeys(grid, result.finalState), 0);
    assert.equal(result.finalState.keys, 1); // collected bit retained
});
test('undo-open refunds the key so a second door of the same type can open', () => {
    const grid = parseGrid(UNDO_CORRIDOR);
    const result = shortestPath(grid, initialState(grid));
    assert.ok(result);
    const kinds = result.actions.map((a) => a.kind);
    assert.deepEqual(kinds, [
        'move', 'move', 'open', 'move', 'move', 'undo-open', 'open', 'move', 'move',
    ]);
    const undo = result.actions.find((a) => a.kind === 'undo-open');
    const reopen = result.actions.filter((a) => a.kind === 'open');
    assert.deepEqual(undo, { kind: 'undo-open', door: 0 });
    assert.deepEqual(reopen, [{ kind: 'open', door: 0 }, { kind: 'open', door: 1 }]);
    // Replay independently and confirm the goal is reached.
    const replayed = replayPath(grid, initialState(grid), result.actions);
    assert.equal(replayed.x, grid.goal.x);
    assert.equal(replayed.y, grid.goal.y);
});
test('unsolvable grid returns null', () => {
    const grid = parseGrid(NO_KEY);
    assert.equal(shortestPath(grid, initialState(grid)), null);
});
test('replay rejects illegal actions', () => {
    const grid = parseGrid(OPEN_CORRIDOR);
    const intoWall = [{ kind: 'move', dir: 'up' }];
    assert.throws(() => replayPath(grid, initialState(grid), intoWall), /wall/);
    const check = verifyPath(grid, initialState(grid), intoWall);
    assert.equal(check.ok, false);
    assert.match(check.reason, /wall/);
});
test('verifyPath flags legal paths that miss the goal', () => {
    const grid = parseGrid(OPEN_CORRIDOR);
    const check = verifyPath(grid, initialState(grid), [{ kind: 'move', dir: 'right' }]);
    assert.equal(check.ok, false);
    assert.match(check.reason, /does not reach the goal/);
});
test('undo-open restores the door and refunds the spent key', () => {
    const grid = parseGrid(KEY_DOOR);
    let s = initialState(grid);
    s = applyAction(grid, s, { kind: 'move', dir: 'right' }); // collect key a
    assert.equal(heldKeys(grid, s), 1);
    s = applyAction(grid, s, { kind: 'move', dir: 'right' });
    s = applyAction(grid, s, { kind: 'open', door: 0 });
    assert.equal(heldKeys(grid, s), 0); // key consumed
    assert.equal(s.openDoors, 1);
    s = applyAction(grid, s, { kind: 'undo-open', door: 0 });
    assert.equal(s.openDoors, 0); // door restored
    assert.equal(heldKeys(grid, s), 1); // key refunded
    // A closed door blocks movement again.
    assert.throws(() => applyAction(grid, s, { kind: 'move', dir: 'down' }), /closed door/);
});
test('state versions fork into independent branches', () => {
    const grid = parseGrid(KEY_DOOR);
    const store = new StateStore();
    const s0 = initialState(grid);
    const v0 = store.create(s0);
    const s1 = applyAction(grid, s0, { kind: 'move', dir: 'right' });
    const v1 = store.commit(v0, s1);
    // Fork at v1: one branch opens the door, the other walks back.
    const opened = applyAction(grid, applyAction(grid, s1, { kind: 'move', dir: 'right' }), {
        kind: 'open',
        door: 0,
    });
    const wandered = applyAction(grid, s1, { kind: 'move', dir: 'left' });
    const vOpen = store.commit(store.fork(v1, 'opener'), opened);
    const vWalk = store.commit(store.fork(v1, 'walker'), wandered);
    assert.equal(store.branchOf(vOpen), 'opener');
    assert.equal(store.branchOf(vWalk), 'walker');
    // Shared prefix is intact on both branches.
    assert.deepEqual(store.history(vOpen).slice(0, 2), [s0, s1]);
    assert.deepEqual(store.history(vWalk).slice(0, 2), [s0, s1]);
    // Branches diverge afterwards.
    assert.equal(store.state(vOpen).openDoors, 1);
    assert.equal(store.state(vWalk).openDoors, 0);
    // Forking does not mutate the original version.
    assert.deepEqual(store.state(v1), s1);
    assert.equal(store.children(v1).length, 2);
});
