import { BreakKind, LayoutFailure, LayoutOptions, LayoutOutcome, LayoutSuccess } from './types';
/** An atom is an unbreakable fragment of a word (between soft breaks). */
interface Atom {
    word: number;
    start: number;
    end: number;
    width: number;
}
export interface Model {
    atoms: Atom[];
    /** boundary[b] for 1 <= b <= N-1: break kind allowed after atom b-1, or null. */
    boundary: Array<BreakKind | null>;
    words: LayoutOptions['words'];
    spaceWidth: number;
    hyphenWidth: number;
    maxWidth: number;
    maxHyphenations: number;
    reserved: Map<number, number>;
    minFirst: number;
    minLast: number;
    prefixWidth: number[];
    prefixSpaces: number[];
}
export declare function buildModel(options: LayoutOptions): Model | LayoutFailure;
export declare function availWidth(model: Model, lineNo: number): number;
/** Width of atoms [a, b] on one line, excluding any trailing hyphen. */
export declare function lineContentWidth(model: Model, a: number, b: number): number;
interface Candidate {
    cost: number;
    boundaries: number[];
}
/**
 * Core search. Returns the optimal (cost, break boundaries) or null when no
 * feasible breaking exists. A boundary b means "new line starts at atom b".
 */
export declare function solveModel(model: Model): Candidate | null;
/** Assemble the public result (line spans + breakpoint certificate). */
export declare function assemble(model: Model, solution: Candidate): LayoutSuccess;
/**
 * Optimal line breaking.
 *
 * Minimizes the sum of squared slack over all lines except the last (which is
 * free); ties are broken by the lexicographically smallest breakpoint
 * sequence. Returns an explicit failure for overwide unbreakable words and
 * for constraint infeasibility.
 */
export declare function layout(options: LayoutOptions): LayoutOutcome;
export {};
