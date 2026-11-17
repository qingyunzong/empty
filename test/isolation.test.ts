import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IsolationController, type Path } from '../src/isolation.js';

let now = 0;

function makeController(): IsolationController {
  now = 0;
  return new IsolationController({ now: () => now });
}

function path(instance: string, zone = 'z1', service = 'svc'): Path {
  return { service, zone, instance };
}

function failTimes(c: IsolationController, p: Path, signature: string, times: number): void {
  for (let i = 0; i < times; i++) {
    c.reportFailure(p, signature);
    now += 10;
  }
}

test('uncorrelated failures isolate only the faulty instance', () => {
  const c = makeController();
  failTimes(c, path('a'), 'http_5xx:local', 3);

  const view = c.inspect(path('a'));
  assert.equal(view.scope, 'instance');
  assert.equal(view.nodes.instance.state, 'isolated');
  assert.equal(view.nodes.instance.cause, 'local');
  assert.equal(view.nodes.zone.state, 'healthy');
  assert.equal(view.nodes.service.state, 'healthy');
  assert.equal(view.weight, 0);

  assert.equal(c.trafficWeight(path('b')), 1);
  assert.equal(c.isolationScope(path('b')), null);
});

test('correlated failures inside a zone escalate to zone-level upstream isolation', () => {
  const c = makeController();
  for (const instance of ['a', 'b', 'c']) {
    failTimes(c, path(instance), 'timeout:upstream:db', 3);
  }

  const view = c.inspect(path('a'));
  assert.equal(view.scope, 'zone');
  assert.equal(view.nodes.zone.state, 'isolated');
  assert.equal(view.nodes.zone.cause, 'upstream');
  assert.equal(view.nodes.instance.state, 'healthy', 'shadowed instance is released');
  assert.equal(view.nodes.service.state, 'healthy');
  assert.equal(view.weight, 0);

  const released = c.events.filter((e) => e.type === 'released').map((e) => e.node);
  assert.ok(released.includes('svc/z1/a'));
  assert.equal(
    c.inspect(path('b')).nodes.instance.state,
    'healthy',
    'instances that never tripped stay healthy under the isolated zone',
  );

  assert.equal(c.isolationScope(path('x', 'z2')), null, 'other zones stay healthy');
});

test('correlated failures across zones escalate to service-level upstream isolation', () => {
  const c = makeController();
  for (const [zone, instances] of [
    ['z1', ['a', 'b']],
    ['z2', ['c', 'd']],
  ] as const) {
    for (const instance of instances) {
      failTimes(c, path(instance, zone), 'timeout:upstream:db', 3);
    }
  }

  const view = c.inspect(path('a', 'z1'));
  assert.equal(view.scope, 'service');
  assert.equal(view.nodes.service.state, 'isolated');
  assert.equal(view.nodes.service.cause, 'upstream');
  assert.equal(view.nodes.zone.state, 'healthy', 'zone isolation is absorbed by the service');
  assert.equal(view.weight, 0);
});

test('mixed signatures keep isolation local instead of escalating', () => {
  const c = makeController();
  failTimes(c, path('a'), 'timeout:upstream:db', 3);
  failTimes(c, path('b'), 'http_5xx:local', 3);
  failTimes(c, path('c'), 'conn_refused:local', 3);

  const view = c.inspect(path('a'));
  assert.equal(view.scope, 'instance');
  assert.equal(view.nodes.zone.state, 'healthy');
  assert.equal(view.nodes.service.state, 'healthy');
});

test('upper-layer degradation throttles lower-layer probe quota', () => {
  const c = makeController();
  const instances = ['a', 'b', 'c', 'd', 'e'];

  const hammer = (zones: string[]): number => {
    let granted = 0;
    for (let attempt = 0; attempt < 40; attempt++) {
      for (const zone of zones) {
        for (const instance of instances) {
          if (c.tryAcquireProbe(path(instance, zone))) granted++;
        }
      }
    }
    return granted;
  };

  const healthyGranted = hammer(['z1', 'z2']);
  assert.equal(healthyGranted, 20, 'healthy service budget caps total probes');

  for (const [zone, pair] of [
    ['z1', ['a', 'b']],
    ['z2', ['c', 'd']],
  ] as const) {
    for (const instance of pair) {
      failTimes(c, path(instance, zone), 'timeout:upstream:db', 3);
    }
  }
  assert.equal(c.isolationScope(path('a')), 'service');

  now += 1_000;
  const cooldownGranted = hammer(['z1', 'z2']);
  assert.equal(cooldownGranted, 0, 'no probes while the service is in cooldown');

  now += 2_000;
  const degradedGranted = hammer(['z1', 'z2']);
  assert.equal(
    degradedGranted,
    4,
    'recovering service clamps subtree probes to its throttled budget',
  );
  assert.ok(degradedGranted < healthyGranted);
});

test('recovery ramps stage by stage and lower layers cannot outramp upper layers', () => {
  const c = makeController();

  failTimes(c, path('x'), 'http_5xx:local', 3);
  assert.equal(c.inspect(path('x')).nodes.instance.cause, 'local');

  now += 1_500;
  for (const instance of ['a', 'b']) {
    failTimes(c, path(instance), 'timeout:upstream:db', 3);
  }
  const zoneView = c.inspect(path('a'));
  assert.equal(zoneView.nodes.zone.state, 'isolated');
  assert.equal(zoneView.nodes.zone.cause, 'upstream');
  assert.equal(
    c.inspect(path('x')).nodes.instance.state,
    'isolated',
    'instance with a distinct signature stays isolated under the zone',
  );

  now += 500;
  for (let i = 0; i < 9; i++) c.reportSuccess(path('x'));
  const gated = c.inspect(path('x'));
  assert.equal(gated.nodes.zone.state, 'isolated');
  assert.equal(gated.nodes.instance.state, 'recovering');
  assert.equal(gated.nodes.instance.recoveryStage, 0, 'parent at weight 0 gates the child');
  assert.equal(gated.weight, 0);
  assert.equal(c.tryAcquireProbe(path('x')), false);

  now += 1_500;
  for (let i = 0; i < 3; i++) c.reportSuccess(path('a'));
  assert.equal(c.inspect(path('a')).nodes.zone.recoveryStage, 1);
  assert.equal(c.trafficWeight(path('a')), 0.5);

  for (let i = 0; i < 3; i++) c.reportSuccess(path('x'));
  const caught = c.inspect(path('x'));
  assert.equal(caught.nodes.instance.recoveryStage, 1, 'child may match but not exceed parent');
  assert.equal(caught.weight, 0.5);

  for (let i = 0; i < 6; i++) c.reportSuccess(path('a'));
  assert.equal(c.inspect(path('a')).nodes.zone.state, 'healthy');
  assert.equal(c.trafficWeight(path('a')), 1);

  for (let i = 0; i < 6; i++) c.reportSuccess(path('x'));
  const done = c.inspect(path('x'));
  assert.equal(done.nodes.instance.state, 'healthy');
  assert.equal(done.weight, 1);
  assert.equal(done.scope, null);
});

test('failure during recovery sends the node back to isolation cooldown', () => {
  const c = makeController();
  failTimes(c, path('a'), 'http_5xx:local', 3);
  now += 2_000;
  for (let i = 0; i < 3; i++) c.reportSuccess(path('a'));
  assert.equal(c.inspect(path('a')).nodes.instance.recoveryStage, 1);

  c.reportFailure(path('a'), 'http_5xx:local');
  const view = c.inspect(path('a'));
  assert.equal(view.nodes.instance.state, 'isolated');
  assert.equal(view.weight, 0);
});
