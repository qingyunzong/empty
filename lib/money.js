'use strict';

// All money is handled as integer cents internally to avoid float drift.

function toCents(value) {
  return Math.round(value * 100);
}

function fromCents(cents) {
  return cents / 100;
}

const TIERS = ['full', 'eighty', 'deferred'];

function tierRate(tier) {
  if (tier === 'full') return 1;
  if (tier === 'eighty') return 0.8;
  return 0;
}

function reservedCents(amountCents, tier) {
  if (tier === 'full') return amountCents;
  if (tier === 'eighty') return Math.round(amountCents * 0.8);
  return 0;
}

module.exports = { toCents, fromCents, TIERS, tierRate, reservedCents };
