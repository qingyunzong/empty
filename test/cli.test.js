import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { runCLI } from '../src/cli.js';

async function run(lines) {
  const out = [];
  const input = Readable.from(lines.join('\n') + '\n');
  await runCLI(input, (line) => out.push(JSON.parse(line)));
  return out;
}

test('JSONL CLI end-to-end session', async () => {
  const out = await run([
    '{"op":"account","id":"A","funds":{"num":"10","den":"1"}}',
    '{"op":"account","id":"B","funds":"0"}',
    '{"op":"instrument","id":"X","price":{"num":"2","den":"1"}}',
    '{"op":"order","id":"O1","account":"A","side":"buy","instrument":"X","qty":"2","limit":{"num":"3","den":"1"}}',
    '{"op":"order","id":"O2","account":"B","side":"sell","instrument":"X","qty":"2","limit":{"num":"1","den":"1"}}',
    '{"op":"trial","window":"W1","proof":false}',
    '{"op":"commit","window":"W1","submit":"S1"}',
    '{"op":"commit","window":"W1","submit":"S1"}',
    '{"op":"state"}',
    '{"op":"compensate","window":"W1","submit":"C1"}',
    '{"op":"compensate","window":"W1","submit":"C2"}',
    'not json',
    '{"op":"bogus"}',
  ]);
  assert.equal(out.length, 13);
  const trial = out[5];
  assert.ok(trial.ok);
  assert.equal(trial.volume, '2');
  assert.equal(trial.count, '1');
  assert.deepEqual(trial.spend, { num: '4', den: '1' });
  assert.equal(trial.vector.O1, '2');
  const c1 = out[6];
  const c2 = out[7];
  assert.ok(c1.ok && c2.ok);
  assert.deepEqual(c2, c1, 'idempotent commit replay');
  const state = out[8];
  assert.equal(state.accounts.A.funds.num, '6');
  assert.equal(state.accounts.B.funds.num, '4');
  assert.equal(state.orders.O1.remaining, '0');
  const comp = out[9];
  assert.ok(comp.ok && comp.compensated);
  const dup = out[10];
  assert.equal(dup.error, 'E_ALREADY_COMPENSATED');
  assert.equal(out[11].error, 'E_PARSE');
});

test('CLI reports budget exhaustion without fabricating fills', async () => {
  const out = await run([
    '{"op":"account","id":"A","funds":"100"}',
    '{"op":"account","id":"B","funds":"0"}',
    '{"op":"instrument","id":"X","price":"2"}',
    '{"op":"order","id":"O1","account":"A","side":"buy","instrument":"X","qty":"3","limit":"5"}',
    '{"op":"order","id":"O2","account":"A","side":"buy","instrument":"X","qty":"3","limit":"5"}',
    '{"op":"order","id":"O3","account":"B","side":"sell","instrument":"X","qty":"3","limit":"1"}',
    '{"op":"order","id":"O4","account":"B","side":"sell","instrument":"X","qty":"3","limit":"1"}',
    '{"op":"trial","window":"W1","budget":2}',
  ]);
  const trial = out[7];
  assert.equal(trial.ok, false);
  assert.equal(trial.error, 'E_BUDGET');
  assert.equal(trial.volume, undefined);
});
