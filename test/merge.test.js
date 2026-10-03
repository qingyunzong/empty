'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeOrders } = require('../src/merge');
const { ConflictError } = require('../src/errors');

const base = [
  { id: 'o1', status: 'assigned', assignee: 'alice', priority: 'low' },
  { id: 'o2', status: 'created', assignee: 'carol', priority: 'medium' },
];

test('acceptance 1: one side changes assignee, the other changes priority', () => {
  const local = [
    { id: 'o1', status: 'assigned', assignee: 'bob', priority: 'low' },
    { id: 'o2', status: 'created', assignee: 'carol', priority: 'medium' },
  ];
  const remote = [
    { id: 'o1', status: 'assigned', assignee: 'alice', priority: 'high' },
    { id: 'o2', status: 'created', assignee: 'carol', priority: 'medium' },
  ];
  const merged = mergeOrders(base, local, remote);
  assert.equal(merged.o1.assignee, 'bob');
  assert.equal(merged.o1.priority, 'high');
  assert.equal(merged.o1.status, 'assigned');
});

test('acceptance 2: both sides set different assignees on the same order', () => {
  const local = [
    { id: 'o1', status: 'assigned', assignee: 'bob', priority: 'low' },
    { id: 'o2', status: 'created', assignee: 'carol', priority: 'medium' },
  ];
  const remote = [
    { id: 'o1', status: 'assigned', assignee: 'dave', priority: 'low' },
    { id: 'o2', status: 'created', assignee: 'carol', priority: 'medium' },
  ];
  assert.throws(
    () => mergeOrders(base, local, remote),
    (err) => {
      assert.ok(err instanceof ConflictError);
      assert.equal(err.exitCode, 1);
      assert.ok(err.conflicts.some((c) => c.orderId === 'o1' && c.field === 'assignee'));
      return true;
    }
  );
});

test('acceptance 3: undoing a pre-done change vs updating a terminal order conflicts', () => {
  const doneBase = [
    { id: 'o1', status: 'done', assignee: 'alice', priority: 'high' },
  ];
  const localUndone = [
    { id: 'o1', status: 'in_progress', assignee: 'alice', priority: 'high' },
  ];
  const remoteTouched = [
    { id: 'o1', status: 'done', assignee: 'bob', priority: 'high' },
  ];
  assert.throws(
    () => mergeOrders(doneBase, localUndone, remoteTouched),
    (err) => {
      assert.ok(err instanceof ConflictError);
      assert.equal(err.exitCode, 1);
      assert.ok(err.conflicts.some((c) => c.orderId === 'o1'));
      return true;
    }
  );
});

test('orders changed on disjoint sides merge automatically', () => {
  const local = [
    { id: 'o1', status: 'assigned', assignee: 'bob', priority: 'low' },
    { id: 'o2', status: 'created', assignee: 'carol', priority: 'medium' },
  ];
  const remote = [
    { id: 'o1', status: 'assigned', assignee: 'alice', priority: 'low' },
    { id: 'o2', status: 'assigned', assignee: 'carol', priority: 'high' },
  ];
  const merged = mergeOrders(base, local, remote);
  assert.equal(merged.o1.assignee, 'bob');
  assert.equal(merged.o2.status, 'assigned');
  assert.equal(merged.o2.priority, 'high');
});

test('identical changes on both sides are not conflicts', () => {
  const local = [
    { id: 'o1', status: 'in_progress', assignee: 'alice', priority: 'low' },
    { id: 'o2', status: 'created', assignee: 'carol', priority: 'medium' },
  ];
  const merged = mergeOrders(base, local, local);
  assert.equal(merged.o1.status, 'in_progress');
});

test('merged illegal status transition is a conflict', () => {
  const local = [
    { id: 'o1', status: 'done', assignee: 'alice', priority: 'low' },
    { id: 'o2', status: 'created', assignee: 'carol', priority: 'medium' },
  ];
  assert.throws(
    () => mergeOrders(base, local, base),
    (err) => err instanceof ConflictError && err.exitCode === 1
  );
});

test('any modification of a terminal order is a conflict', () => {
  const doneBase = [{ id: 'o1', status: 'done', assignee: 'alice', priority: 'low' }];
  const remote = [{ id: 'o1', status: 'done', assignee: 'alice', priority: 'high' }];
  assert.throws(
    () => mergeOrders(doneBase, doneBase, remote),
    (err) => err instanceof ConflictError && err.exitCode === 1
  );
});

test('legal status transition on one side merges cleanly', () => {
  const local = [
    { id: 'o1', status: 'in_progress', assignee: 'alice', priority: 'low' },
    { id: 'o2', status: 'created', assignee: 'carol', priority: 'medium' },
  ];
  const merged = mergeOrders(base, local, base);
  assert.equal(merged.o1.status, 'in_progress');
});

test('orders added on one or both sides are carried over', () => {
  const local = [...base, { id: 'o3', status: 'created', assignee: 'erin', priority: 'low' }];
  const remote = [...base, { id: 'o4', status: 'assigned', assignee: 'fred', priority: 'high' }];
  const merged = mergeOrders(base, local, remote);
  assert.equal(merged.o3.assignee, 'erin');
  assert.equal(merged.o4.assignee, 'fred');
  const both = mergeOrders(base, local, local);
  assert.equal(both.o3.assignee, 'erin');
});
