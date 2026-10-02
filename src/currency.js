// Fixed conversion rates to the base currency (USD). Amounts are minor units.
export const BASE_CURRENCY = 'USD';

export const RATES_TO_USD = Object.freeze({
  USD: 1,
  EUR: 1.1,
  GBP: 1.27,
  CNY: 0.14,
  JPY: 0.0067,
});

export function isKnownCurrency(currency) {
  return currency != null && Object.hasOwn(RATES_TO_USD, currency);
}

// Bucket key for aggregation. NULL/unknown currencies are never converted;
// they stay in their own bucket. NULL currency uses the 'UNKNOWN' bucket.
export function bucketKey(currency) {
  return currency == null ? 'UNKNOWN' : String(currency);
}
