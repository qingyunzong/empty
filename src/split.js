export const COMPONENT_KEYS = ['merchant', 'commission', 'tax'];

// Split `amount` across the three payment components proportionally to the
// original payment shares. Fractional remainders are distributed with the
// largest-remainder method; ties break in fixed component order
// (merchant, commission, tax). All math is exact integer math.
export function splitAmount(amount, components) {
  const total = COMPONENT_KEYS.reduce((sum, key) => sum + components[key], 0);
  const floors = {};
  let floorSum = 0;
  const remainders = COMPONENT_KEYS.map((key, index) => {
    const numerator = amount * components[key];
    const floor = Math.floor(numerator / total);
    floors[key] = floor;
    floorSum += floor;
    return { key, index, remainder: numerator - floor * total };
  });
  remainders.sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  const result = { ...floors };
  const leftover = amount - floorSum;
  for (let i = 0; i < leftover; i += 1) {
    result[remainders[i].key] += 1;
  }
  return result;
}
