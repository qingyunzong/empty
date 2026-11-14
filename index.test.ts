import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePath,
  projectPaths,
  type DateRule,
  type EnumRule,
  type InjectedRule,
  type IntegerRule,
} from './index.ts';

const month: IntegerRule = { type: 'integer', name: 'month', range: [1, 12], digits: 2 };
const day: IntegerRule = { type: 'integer', name: 'day', range: [1, 31], digits: 2 };
const region: EnumRule = { type: 'enum', name: 'region', values: ['us', 'eu', 'ap'] };
const tenant: InjectedRule = { type: 'injected', name: 'tenant' };
const dt: DateRule = {
  type: 'date',
  name: 'dt',
  range: ['2026-03-07', '2026-03-11'],
  format: 'yyyy-MM-dd',
  interval: 1,
  intervalUnit: 'day',
  timezone: 'America/New_York',
};

test('integer range predicate with zero-padded segments', () => {
  const result = projectPaths([month], { month: { op: 'range', min: 3, max: 5 } }, {
    template: 'm={month}',
  });
  assert.equal(result.closed, true);
  assert.deepEqual(result.paths, ['m=03', 'm=04', 'm=05']);
});

test('zero padding does not change parsed numeric value', () => {
  assert.deepEqual(parsePath([month], 'm=007', 'm={month}'), { month: 7 });
  const projected = projectPaths([month], { month: { op: 'eq', value: 7 } }, {
    template: 'm={month}',
  });
  assert.deepEqual(projected.paths, ['m=07']);
  assert.deepEqual(parsePath([month], projected.paths[0], 'm={month}'), { month: 7 });
});

test('date stepping across DST uses wall-clock days in the rule timezone', () => {
  const result = projectPaths([dt], {}, { template: 'dt={dt}' });
  assert.equal(result.closed, true);
  assert.deepEqual(result.paths, [
    'dt=2026-03-07',
    'dt=2026-03-08',
    'dt=2026-03-09',
    'dt=2026-03-10',
    'dt=2026-03-11',
  ]);
});

test('hourly date stepping keeps local midnight across spring forward', () => {
  const hourly: DateRule = {
    ...dt,
    range: ['2026-03-08T00:00', '2026-03-10T00:00'],
    format: 'yyyy-MM-dd-HH',
    intervalUnit: 'hour',
    interval: 12,
  };
  const result = projectPaths([hourly], {}, { template: 'h={dt}' });
  assert.deepEqual(result.paths, [
    'h=2026-03-08-00',
    'h=2026-03-08-12',
    'h=2026-03-09-00',
    'h=2026-03-09-12',
    'h=2026-03-10-00',
  ]);
});

test('enum predicates filter declared values only', () => {
  const result = projectPaths([region], { region: { op: 'in', values: ['eu', 'xx'] } });
  assert.deepEqual(result.paths, ['eu']);
  const empty = projectPaths([region], { region: { op: 'eq', value: 'xx' } });
  assert.equal(empty.closed, true);
  assert.deepEqual(empty.paths, []);
});

test('injected column requires a predicate to stay closed', () => {
  const open = projectPaths([tenant]);
  assert.equal(open.closed, false);
  assert.deepEqual(open.paths, []);
  const closed = projectPaths([tenant], { tenant: { op: 'eq', value: 'acme' } }, {
    template: 't={tenant}',
  });
  assert.deepEqual(closed.paths, ['t=acme']);
});

test('over budget returns unclosed instead of a truncated list', () => {
  const result = projectPaths([month, day], {}, { maxPaths: 50 });
  assert.equal(result.closed, false);
  assert.deepEqual(result.paths, []);
  assert.match(result.reason ?? '', /exceeds budget/);
});

test('generation and parsing round-trip across all rule kinds', () => {
  const rules = [dt, month, region, tenant];
  const predicates = {
    dt: { op: 'range', min: '2026-03-08', max: '2026-03-10' },
    month: { op: 'in', values: [3, 4] },
    region: { op: 'eq', value: 'ap' },
    tenant: { op: 'eq', value: 'acme' },
  } as const;
  const template = 'd={dt}/m={month}/r={region}/t={tenant}';
  const projected = projectPaths(rules, predicates, { template });
  assert.equal(projected.closed, true);
  assert.equal(projected.paths.length, 6);
  for (const path of projected.paths) {
    const values = parsePath(rules, path, template);
    assert.ok(values, `path ${path} must parse`);
    assert.equal(values.month === 3 || values.month === 4, true);
    assert.equal(values.region, 'ap');
    assert.equal(values.tenant, 'acme');
    const replayed = projectPaths(rules, {
      dt: { op: 'eq', value: values.dt },
      month: { op: 'eq', value: values.month },
      region: { op: 'eq', value: values.region },
      tenant: { op: 'eq', value: values.tenant },
    }, { template });
    assert.deepEqual(replayed.paths, [path]);
  }
});

test('parsePath rejects paths that do not match the projection', () => {
  assert.equal(parsePath([month], 'm=13', 'm={month}'), null);
  assert.equal(parsePath([month], 'm=ab', 'm={month}'), null);
  assert.equal(parsePath([region], 'r=xx', 'r={region}'), null);
  assert.equal(parsePath([dt], 'dt=2026/03/08', 'dt={dt}'), null);
});

test('date parsing yields ISO instants in the rule timezone', () => {
  const values = parsePath([dt], 'dt=2026-03-08', 'dt={dt}');
  assert.ok(values);
  assert.equal(values.dt, '2026-03-08T05:00:00.000Z');
});
