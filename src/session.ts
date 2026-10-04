import { createHash } from 'node:crypto';
import { replace, type ReplaceOptions, type ReplaceResult } from './replace';
import { SourceMap } from './sourcemap';
import type { CaptureMatch } from './types';

/** Digest-style summary of the text as it was before a round was applied. */
export interface PreImageSummary {
  round: number;
  length: number;
  sha256: string;
  preview: string;
}

interface RoundRecord {
  summary: PreImageSummary;
  preImage: string;
  map: SourceMap;
}

export interface AppliedRound {
  output: string;
  summary: PreImageSummary;
  map: SourceMap;
}

/**
 * Applies replacement rounds to a text. Each round binds a summary of its
 * pre-image (length + SHA-256 + preview) so it can be rolled back later;
 * failed rounds (invalid reference, exceeded budget) leave the session
 * untouched.
 */
export class ReplaceSession {
  private text: string;
  private readonly rounds: RoundRecord[] = [];

  constructor(initial: string) {
    this.text = initial;
  }

  get current(): string {
    return this.text;
  }

  get roundCount(): number {
    return this.rounds.length;
  }

  history(): PreImageSummary[] {
    return this.rounds.map((r) => r.summary);
  }

  applyRound(
    matches: CaptureMatch[],
    templates: string[],
    options: ReplaceOptions = {},
  ): AppliedRound {
    const result: ReplaceResult = replace(this.text, matches, templates, options);
    const summary: PreImageSummary = {
      round: this.rounds.length,
      length: this.text.length,
      sha256: createHash('sha256').update(this.text, 'utf8').digest('hex'),
      preview: this.text.slice(0, 24),
    };
    this.rounds.push({ summary, preImage: this.text, map: result.map });
    this.text = result.output;
    return { output: result.output, summary, map: result.map };
  }

  /** Undoes the most recent round and returns its pre-image summary. */
  rollback(): PreImageSummary | null {
    const rec = this.rounds.pop();
    if (!rec) return null;
    this.text = rec.preImage;
    return rec.summary;
  }

  /** Map from the original text (round 0 pre-image) to the current text. */
  composedMap(): SourceMap | null {
    if (this.rounds.length === 0) return null;
    let acc = this.rounds[0].map;
    for (let i = 1; i < this.rounds.length; i += 1) {
      acc = SourceMap.compose(acc, this.rounds[i].map);
    }
    return acc;
  }
}
