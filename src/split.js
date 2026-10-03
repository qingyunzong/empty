'use strict';

const RATIOS = Object.freeze({ merchant: 94, fee: 5, tax: 1 });
const ORDER = Object.freeze(['merchant', 'fee', 'tax']);

function split(total, ratios = RATIOS) {
  if (!Number.isInteger(total) || total < 0) {
    throw new TypeError('total must be a non-negative integer number of cents');
  }
  const totalRatio = ORDER.reduce((sum, key) => sum + ratios[key], 0);
  const shares = {};
  let remainder = total;
  for (const key of ORDER) {
    shares[key] = Math.floor((total * ratios[key]) / totalRatio);
    remainder -= shares[key];
  }
  const ranked = ORDER.slice().sort(
    (a, b) => shares[b] - shares[a] || ORDER.indexOf(a) - ORDER.indexOf(b)
  );
  for (let i = 0; i < remainder; i += 1) {
    shares[ranked[i % ranked.length]] += 1;
  }
  return shares;
}

module.exports = { split, RATIOS, ORDER };
