/** Easing functions map segment progress u in [0, 1] to eased progress. */
export type Easing = (u: number) => number;

export const linear: Easing = (u) => u;
export const easeInQuad: Easing = (u) => u * u;
export const easeOutQuad: Easing = (u) => u * (2 - u);
export const easeInOutQuad: Easing = (u) =>
  u < 0.5 ? 2 * u * u : -1 + (4 - 2 * u) * u;
/** Step interpolation: hold the segment's start value until the next key. */
export const step: Easing = () => 0;
