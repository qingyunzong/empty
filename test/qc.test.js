'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveFrameFlag, summarizeNight, normalizeConfig, calibKey } = require('../src/qc');

const config = normalizeConfig({ noiseThreshold: 2.0, calibQualityThreshold: 0.5 });

function makeCtx({ weather, dark, flat } = {}) {
  const calibrations = new Map();
  if (dark) calibrations.set(calibKey('dark', 'N1', 'camA'), { kind: 'dark', night: 'N1', instrument: 'camA', version: 1, quality: dark });
  if (flat) calibrations.set(calibKey('flat', 'N1', 'camA'), { kind: 'flat', night: 'N1', instrument: 'camA', version: 1, quality: flat });
  const weatherMap = new Map();
  if (weather) weatherMap.set('N1', { night: 'N1', state: weather });
  return { calibrations, weather: weatherMap };
}

function makeFrame(noise = 1.0) {
  return { frameId: 'f1', night: 'N1', instrument: 'camA', metrics: { noise } };
}

test('missing dark calibration blocks the frame', () => {
  assert.equal(deriveFrameFlag(makeFrame(), makeCtx({ flat: 0.9, weather: 'clear' }), config), 'blocked');
});

test('missing flat calibration blocks the frame', () => {
  assert.equal(deriveFrameFlag(makeFrame(), makeCtx({ dark: 0.9, weather: 'clear' }), config), 'blocked');
});

test('blocked weather blocks the frame even with calibrations present', () => {
  assert.equal(deriveFrameFlag(makeFrame(), makeCtx({ dark: 0.9, flat: 0.9, weather: 'blocked' }), config), 'blocked');
});

test('degraded weather degrades the frame', () => {
  assert.equal(deriveFrameFlag(makeFrame(), makeCtx({ dark: 0.9, flat: 0.9, weather: 'degraded' }), config), 'degraded');
});

test('missing weather node defaults to clear', () => {
  assert.equal(deriveFrameFlag(makeFrame(), makeCtx({ dark: 0.9, flat: 0.9 }), config), 'usable');
});

test('noise exactly equal to threshold stays usable (strictly-greater rule)', () => {
  assert.equal(deriveFrameFlag(makeFrame(2.0), makeCtx({ dark: 0.9, flat: 0.9, weather: 'clear' }), config), 'usable');
});

test('noise just above threshold is degraded', () => {
  assert.equal(deriveFrameFlag(makeFrame(2.0000000000000004), makeCtx({ dark: 0.9, flat: 0.9, weather: 'clear' }), config), 'degraded');
});

test('calibration quality exactly equal to threshold stays usable (strictly-less rule)', () => {
  assert.equal(deriveFrameFlag(makeFrame(), makeCtx({ dark: 0.5, flat: 0.5, weather: 'clear' }), config), 'usable');
});

test('calibration quality just below threshold is degraded', () => {
  const justBelow = 0.5 - Number.EPSILON;
  assert.equal(deriveFrameFlag(makeFrame(), makeCtx({ dark: justBelow, flat: 0.9, weather: 'clear' }), config), 'degraded');
  assert.equal(deriveFrameFlag(makeFrame(), makeCtx({ dark: 0.9, flat: justBelow, weather: 'clear' }), config), 'degraded');
});

test('clean inputs yield usable', () => {
  assert.equal(deriveFrameFlag(makeFrame(), makeCtx({ dark: 0.9, flat: 0.9, weather: 'clear' }), config), 'usable');
});

test('empty night summary is stable with zero counts', () => {
  assert.deepEqual(summarizeNight('N1', []), {
    night: 'N1',
    total: 0,
    usable: 0,
    degraded: 0,
    blocked: 0,
    nightFlag: 'usable',
  });
});

test('night with all frames blocked is blocked', () => {
  assert.equal(summarizeNight('N1', ['blocked', 'blocked']).nightFlag, 'blocked');
});

test('night with any non-usable frame is degraded', () => {
  assert.equal(summarizeNight('N1', ['usable', 'blocked']).nightFlag, 'degraded');
  assert.equal(summarizeNight('N1', ['usable', 'degraded']).nightFlag, 'degraded');
});

test('night with all frames usable is usable', () => {
  assert.equal(summarizeNight('N1', ['usable', 'usable']).nightFlag, 'usable');
});
