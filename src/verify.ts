import {
  availableWidth,
  buildModel,
  lineWidthOf,
  validateOptions,
  widowOrphanOk,
  wordCountOf,
} from "./model.js";
import { replay } from "./solve.js";
import type { Certificate, LayoutInput } from "./types.js";

export interface Verification {
  valid: boolean;
  errors: string[];
  /** Cost recomputed by replaying the certificate's breakpoints. */
  cost?: number;
}

/** Verify a breakpoint certificate against the input: every break must be
 *  legal, every line must fit its available width, hyphenation/widow/
 *  orphan constraints must hold, and the replayed cost must match the
 *  certificate's claimed total. */
export function verifyCertificate(
  input: LayoutInput,
  cert: Certificate,
): Verification {
  const errors: string[] = [];
  try {
    validateOptions(input);
  } catch (e) {
    return { valid: false, errors: [`invalid options: ${(e as Error).message}`] };
  }
  const built = buildModel(input);
  if (!built.ok) {
    return { valid: false, errors: [`input not buildable: ${built.reason}`] };
  }
  const model = built.model;
  const F = model.fragments.length;
  const bp = cert.breakpoints;

  for (let i = 0; i < bp.length; i++) {
    const b = bp[i];
    if (!Number.isInteger(b) || b < 1 || b > F - 1) {
      errors.push(`breakpoint ${b} out of range [1, ${F - 1}]`);
    } else {
      if (i > 0 && b <= bp[i - 1]) {
        errors.push(`breakpoints not strictly increasing at index ${i}`);
      }
      if (!model.breakable[b]) {
        errors.push(`breakpoint ${b} is not a legal break position`);
      }
    }
  }
  if (errors.length > 0) return { valid: false, errors };

  const replayed = replay(model, input, bp);

  let prevHyphen = false;
  for (let i = 0; i < replayed.lines.length; i++) {
    const line = replayed.lines[i];
    const expectAvail = availableWidth(i, prevHyphen, input);
    if (line.available !== expectAvail) {
      errors.push(`line ${i}: available ${line.available} != expected ${expectAvail}`);
    }
    if (line.width !== lineWidthOf(model, line.startFragment, line.endFragment)) {
      errors.push(`line ${i}: width mismatch`);
    }
    if (line.slack < 0) {
      errors.push(`line ${i}: overfull by ${-line.slack}`);
    }
    const expectCost = i === replayed.lines.length - 1 ? 0 : line.slack * line.slack;
    if (line.cost !== expectCost) {
      errors.push(`line ${i}: cost ${line.cost} != expected ${expectCost}`);
    }
    prevHyphen = line.endsWithHyphen;
  }

  if (
    input.maxHyphenations !== undefined &&
    replayed.hyphenations > input.maxHyphenations
  ) {
    errors.push(
      `hyphenations ${replayed.hyphenations} exceed K=${input.maxHyphenations}`,
    );
  }
  const totalLines = replayed.lines.length;
  if (
    input.minLastLineWords !== undefined &&
    totalLines > 1 &&
    wordCountOf(model, bp.length > 0 ? bp[bp.length - 1] : 0, F) <
      input.minLastLineWords
  ) {
    errors.push("last line has too few words");
  }
  if (!widowOrphanOk(totalLines, input)) {
    errors.push("widow/orphan constraint violated");
  }
  if (replayed.totalCost !== cert.totalCost) {
    errors.push(
      `total cost mismatch: certificate claims ${cert.totalCost}, replay gives ${replayed.totalCost}`,
    );
  }
  if (cert.lines.length !== replayed.lines.length) {
    errors.push("line count mismatch between certificate and replay");
  } else {
    for (let i = 0; i < replayed.lines.length; i++) {
      const got = cert.lines[i];
      const want = replayed.lines[i];
      const fields = [
        "lineIndex", "startFragment", "endFragment", "startWord", "endWord",
        "charStart", "charEnd", "text", "width", "available", "slack",
        "endsWithHyphen", "cost",
      ] as const;
      for (const f of fields) {
        if (got[f] !== want[f]) {
          errors.push(`line ${i}: field ${f} is ${JSON.stringify(got[f])}, replay gives ${JSON.stringify(want[f])}`);
        }
      }
    }
  }
  if (cert.hyphenations !== replayed.hyphenations) {
    errors.push(
      `hyphenation count mismatch: certificate claims ${cert.hyphenations}, replay gives ${replayed.hyphenations}`,
    );
  }
  return {
    valid: errors.length === 0,
    errors,
    cost: replayed.totalCost,
  };
}
