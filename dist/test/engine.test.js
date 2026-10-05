import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, CycleError, formatValue, parseAddr, compareAddr } from '../src/index.js';
function int(n) {
    return { kind: 'int', value: n };
}
function err(code, origin) {
    return { kind: 'error', code, origin: parseAddr(origin) };
}
describe('address ordering (row-major)', () => {
    test('row dominates column', () => {
        assert.ok(compareAddr(parseAddr('B1'), parseAddr('A9')) < 0);
        assert.ok(compareAddr(parseAddr('A2'), parseAddr('B1')) > 0);
        assert.ok(compareAddr(parseAddr('A1'), parseAddr('B1')) < 0);
        assert.equal(compareAddr(parseAddr('C3'), parseAddr('C3')), 0);
    });
});
describe('basic arithmetic', () => {
    test('literals, operators, precedence, references', () => {
        const e = new Engine();
        e.setCell('A1', '=1+2*3');
        e.setCell('A2', '=(1+2)*3');
        e.setCell('B1', '=A1+A2');
        e.setCell('B2', '=-A1');
        e.setCell('B3', '=7/2');
        assert.deepEqual(e.getCell('A1'), int(7));
        assert.deepEqual(e.getCell('A2'), int(9));
        assert.deepEqual(e.getCell('B1'), int(16));
        assert.deepEqual(e.getCell('B2'), int(-7));
        assert.deepEqual(e.getCell('B3'), int(3)); // truncating integer division
    });
    test('comparisons yield 1/0', () => {
        const e = new Engine();
        e.setCell('A1', '=3<4');
        e.setCell('A2', '=3=4');
        e.setCell('A3', '=4>=4');
        e.setCell('A4', '=3<>3');
        assert.deepEqual(e.getCell('A1'), int(1));
        assert.deepEqual(e.getCell('A2'), int(0));
        assert.deepEqual(e.getCell('A3'), int(1));
        assert.deepEqual(e.getCell('A4'), int(0));
    });
});
describe('errors and min-origin propagation', () => {
    test('division by zero originates at the dividing cell', () => {
        const e = new Engine();
        e.setCell('C3', '=1/0');
        assert.deepEqual(e.getCell('C3'), err('DIV/0', 'C3'));
    });
    test('reference to empty cell originates at the referenced cell', () => {
        const e = new Engine();
        e.setCell('B2', '=Z9+1');
        assert.deepEqual(e.getCell('B2'), err('EMPTY', 'Z9'));
    });
    test('minimal origin address wins (row-major, not lexicographic)', () => {
        const e = new Engine();
        e.setCell('A9', '=1/0'); // origin A9 (row 9)
        e.setCell('B1', '=1/0'); // origin B1 (row 1)
        // Lexicographically "A9" < "B1", but row-major B1 < A9.
        e.setCell('C1', '=A9+B1');
        assert.deepEqual(e.getCell('C1'), err('DIV/0', 'B1'));
    });
    test('error origin survives multi-hop propagation', () => {
        const e = new Engine();
        e.setCell('D4', '=5/0');
        e.setCell('C3', '=D4*2');
        e.setCell('B2', '=C3+10');
        e.setCell('A1', '=B2');
        assert.deepEqual(e.getCell('A1'), err('DIV/0', 'D4'));
    });
    test('error is repaired when its source is fixed', () => {
        const e = new Engine();
        e.setCell('A1', '=1/0');
        e.setCell('B1', '=A1+1');
        assert.deepEqual(e.getCell('B1'), err('DIV/0', 'A1'));
        e.setCell('A1', '=41');
        assert.deepEqual(e.getCell('B1'), int(42));
    });
});
describe('dynamic IF dependencies', () => {
    test('only the selected branch is a dependency', () => {
        const e = new Engine();
        e.setCell('B1', '=1');
        e.setCell('C1', '=10');
        e.setCell('D1', '=20');
        e.setCell('A1', '=IF(B1, C1, D1)');
        assert.deepEqual(e.getCell('A1'), int(10));
        assert.deepEqual(e.dependenciesOf('A1'), ['B1', 'C1']);
    });
    test('switching the condition rewrites dependencies', () => {
        const e = new Engine();
        e.setCell('B1', '=1');
        e.setCell('C1', '=10');
        e.setCell('D1', '=20');
        e.setCell('A1', '=IF(B1, C1, D1)');
        e.setCell('B1', '=0');
        assert.deepEqual(e.getCell('A1'), int(20));
        assert.deepEqual(e.dependenciesOf('A1'), ['B1', 'D1']);
        // C1 is no longer a dependency: changing it must not affect A1.
        e.setCell('C1', '=999');
        assert.deepEqual(e.getCell('A1'), int(20));
    });
    test('error in the untaken branch is ignored', () => {
        const e = new Engine();
        e.setCell('A1', '=1/0');
        e.setCell('B1', '=IF(1, 5, A1)');
        assert.deepEqual(e.getCell('B1'), int(5));
        assert.deepEqual(e.dependenciesOf('B1'), []);
        e.setCell('B1', '=IF(0, 5, A1)');
        assert.deepEqual(e.getCell('B1'), err('DIV/0', 'A1'));
    });
    test('error in the condition propagates and branches are not read', () => {
        const e = new Engine();
        e.setCell('A1', '=1/0');
        e.setCell('B1', '=IF(A1, C1, D1)');
        assert.deepEqual(e.getCell('B1'), err('DIV/0', 'A1'));
        assert.deepEqual(e.dependenciesOf('B1'), ['A1']);
    });
});
describe('incremental updates', () => {
    test('change propagates through a chain', () => {
        const e = new Engine();
        e.setCell('A1', '=1');
        e.setCell('B1', '=A1+1');
        e.setCell('C1', '=B1*2');
        assert.deepEqual(e.getCell('C1'), int(4));
        e.setCell('A1', '=5');
        assert.deepEqual(e.getCell('B1'), int(6));
        assert.deepEqual(e.getCell('C1'), int(12));
    });
    test('clearing a cell turns dependents into EMPTY errors at that address', () => {
        const e = new Engine();
        e.setCell('A1', '=1');
        e.setCell('B1', '=A1*2');
        assert.deepEqual(e.getCell('B1'), int(2));
        e.setCell('A1', null);
        assert.equal(e.getCell('A1'), undefined);
        assert.deepEqual(e.getCell('B1'), err('EMPTY', 'A1'));
    });
    test('diamond dependency updates consistently', () => {
        const e = new Engine();
        e.setCell('A1', '=2');
        e.setCell('B1', '=A1+1');
        e.setCell('C1', '=A1*10');
        e.setCell('D1', '=B1+C1');
        assert.deepEqual(e.getCell('D1'), int(23));
        e.setCell('A1', '=5');
        assert.deepEqual(e.getCell('D1'), int(56));
    });
});
describe('cycle rejection', () => {
    test('direct and indirect cycles throw CycleError and leave table unchanged', () => {
        const e = new Engine();
        e.setCell('A1', '=B1+1');
        assert.throws(() => e.setCell('B1', '=A1+1'), CycleError);
        assert.equal(e.getCell('B1'), undefined); // rejected write left no trace
        assert.deepEqual(e.getCell('A1'), err('EMPTY', 'B1'));
        assert.throws(() => e.setCell('A1', '=A1'), CycleError); // self-cycle
        assert.deepEqual(e.getCell('A1'), err('EMPTY', 'B1'));
    });
    test('statically possible but dynamically inactive cycle is still rejected', () => {
        const e = new Engine();
        e.setCell('B1', '=0');
        // A1 only reads C1 when B1 != 0, but the static graph rejects it anyway.
        e.setCell('A1', '=IF(B1, C1, 1)');
        assert.throws(() => e.setCell('C1', '=A1'), CycleError);
    });
});
describe('value formatting', () => {
    test('formatValue', () => {
        const e = new Engine();
        e.setCell('A1', '=1/0');
        assert.equal(formatValue(e.getCell('A1')), '#DIV/0!@A1');
    });
});
