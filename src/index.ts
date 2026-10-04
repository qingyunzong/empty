export type { Assignment, Certificate, Correction, Item } from "./types.js";
export { MAX_ITEMS } from "./types.js";
export { solve, assignLayers, validateItems } from "./solver.js";
export { bruteForce, colorsNeeded, preferByIds } from "./brute.js";
export { verifyCertificate } from "./certificate.js";
export { applyCorrections } from "./corrections.js";
