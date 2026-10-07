import { buildModel } from './layout';
import { LayoutOutcome } from './types';
/**
 * Reference implementation: enumerates every subset of allowed break
 * boundaries (full enumeration / 全切分) and picks the optimum with the same
 * tie-break rule as `layout`. Exponential — intended for verifying the DP on
 * short texts only.
 */
export declare function layoutBruteForce(options: Parameters<typeof buildModel>[0]): LayoutOutcome;
