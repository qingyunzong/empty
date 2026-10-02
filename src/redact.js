import { canonicalize, sha256hex } from './canonical.js';
import { applyPatch, PatchApplyError } from './patch.js';
import { computeCommitHash, snapshotHashes, replay } from './history.js';

// Raised for every condition that must abort the rewrite without touching
// the original files. The CLI maps this to exit code 2.
export class RewriteAbort extends Error {
  constructor(message, reason) {
    super(message);
    this.name = 'RewriteAbort';
    this.reason = reason; // 'token-collision' | 'patch-context' | 'projection-mismatch'
  }
}

// Raised for malformed input histories (integrity failures). Exit code 1.
export class IntegrityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IntegrityError';
  }
}

export function defaultTokenize(value) {
  return `«REDACTED:${sha256hex(value).slice(0, 16)}»`;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Rules:
//   { name, pattern: "<regex>" }              -- match by regular expression
//   { name, values: ["literal", ...] }        -- match literal values
//   { name, ..., token: "FIXED" }             -- optional fixed token for all
//                                                matches of this rule
export function compileRules(rules) {
  return (rules ?? []).map((rule, index) => {
    const name = rule.name ?? `rule-${index}`;
    let source;
    if (Array.isArray(rule.values)) {
      if (rule.values.length === 0) throw new IntegrityError(`rule ${name}: empty values list`);
      source = rule.values.map(escapeRegExp).join('|');
    } else if (typeof rule.pattern === 'string') {
      source = rule.pattern;
    } else {
      throw new IntegrityError(`rule ${name}: needs "pattern" or "values"`);
    }
    return { name, regex: new RegExp(source, 'g'), fixedToken: rule.token ?? null };
  });
}

// Assigns stable tokens to sensitive values. The same original value always
// receives the same token across all commits; a token shared by two distinct
// original values aborts the rewrite.
export class Tokenizer {
  constructor(rules, tokenize = defaultTokenize) {
    this.compiled = compileRules(rules);
    this.tokenizeFn = tokenize;
    this.valueToToken = new Map();
    this.tokenToValue = new Map();
  }

  tokenFor(value, rule) {
    let token = this.valueToToken.get(value);
    if (token === undefined) {
      token = (rule && rule.fixedToken) ?? this.tokenizeFn(value);
      const existing = this.tokenToValue.get(token);
      if (existing !== undefined && existing !== value) {
        throw new RewriteAbort(
          `token collision: distinct values ${JSON.stringify(existing)} and ` +
          `${JSON.stringify(value)} both map to token ${JSON.stringify(token)}`,
          'token-collision',
        );
      }
      this.valueToToken.set(value, token);
      this.tokenToValue.set(token, value);
    }
    return token;
  }

  // Replaces every rule match in `text` with its stable token. Matches are
  // located in the original text; at a shared start offset the longest match
  // wins and overlapping matches are skipped.
  redactText(text) {
    if (typeof text !== 'string' || text === '') return text;
    const matches = [];
    for (const rule of this.compiled) {
      rule.regex.lastIndex = 0;
      for (const m of text.matchAll(rule.regex)) {
        if (m[0] === '') continue;
        matches.push({ start: m.index, end: m.index + m[0].length, value: m[0], rule });
      }
    }
    matches.sort((a, b) => a.start - b.start || b.end - a.end);
    let result = '';
    let cursor = 0;
    for (const m of matches) {
      if (m.start < cursor) continue;
      result += text.slice(cursor, m.start) + this.tokenFor(m.value, m.rule);
      cursor = m.end;
    }
    return result + text.slice(cursor);
  }

  entries() {
    return [...this.valueToToken.entries()]
      .map(([value, token]) => ({ value, token }))
      .sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  }
}

const HUNK_TEXT_FIELDS = ['context', 'text', 'old', 'new'];

// Locates sensitive values inside a structured patch and returns a redacted
// deep copy; the input patch is never mutated.
export function redactPatch(patch, tokenizer) {
  return (patch ?? []).map((entry) => ({
    ...entry,
    hunks: (entry.hunks ?? []).map((hunk) => {
      const copy = { ...hunk };
      for (const field of HUNK_TEXT_FIELDS) {
        if (field in copy) copy[field] = tokenizer.redactText(copy[field]);
      }
      return copy;
    }),
  }));
}

// Rewrites a commit history, replacing sensitive values with stable tokens
// and recomputing every commit hash per the specification.
//
// Options:
//   tokenize(value) -> token string (default: sha256-based stable token)
//
// Returns { commits, manifest, tokenMap }.
// Throws RewriteAbort (exit code 2 at the CLI) on token collisions, on patch
// context that can no longer be located after substitution, or if the
// replayed redacted history fails to match the redacted projection of the
// original final state. Throws IntegrityError for malformed input.
export function rewriteHistory(commits, rules, options = {}) {
  const tokenizer = new Tokenizer(rules, options.tokenize);

  // Replay the original history first: this validates integrity and yields
  // the authoritative old hashes for the rewrite mapping.
  const original = replay(commits);
  commits.forEach((commit, i) => {
    if (commit.hash !== undefined && commit.hash !== original.results[i].hash) {
      throw new IntegrityError(
        `commit ${i}: recorded hash ${commit.hash} does not match recomputed ${original.results[i].hash}`,
      );
    }
  });

  const store = {};
  const newCommits = [];
  const mapping = [];
  let parent = null;

  commits.forEach((commit, i) => {
    const newMessage = tokenizer.redactText(commit.message ?? '');
    const newPatch = redactPatch(commit.patch ?? [], tokenizer);
    try {
      applyPatch(store, newPatch);
    } catch (err) {
      if (err instanceof PatchApplyError) {
        throw new RewriteAbort(
          `commit ${i}: patch context cannot be located after substitution: ${err.message}`,
          'patch-context',
        );
      }
      throw err;
    }
    const files = snapshotHashes(store);
    const rewritten = {
      author: commit.author ?? null,
      message: newMessage,
      patch: newPatch,
    };
    const hash = computeCommitHash(rewritten, parent, files);
    newCommits.push({ ...rewritten, files, hash });
    mapping.push({ index: i, oldHash: original.results[i].hash, newHash: hash });
    parent = hash;
  });

  // Safety property: replaying the rewritten history must reproduce the
  // original final state under the redaction projection.
  for (const name of Object.keys(original.store)) {
    const projected = tokenizer.redactText(original.store[name]);
    if (store[name] !== projected) {
      throw new RewriteAbort(
        `final-state projection mismatch for file ${JSON.stringify(name)}`,
        'projection-mismatch',
      );
    }
  }
  for (const name of Object.keys(store)) {
    if (!(name in original.store)) {
      throw new RewriteAbort(
        `final-state projection mismatch: unexpected file ${JSON.stringify(name)}`,
        'projection-mismatch',
      );
    }
  }

  const oldTip = mapping.length ? mapping[mapping.length - 1].oldHash : null;
  const newTip = mapping.length ? mapping[mapping.length - 1].newHash : null;
  const tokens = tokenizer.entries();

  const manifest = {
    format: 'history-redact/manifest/1',
    oldTip,
    newTip,
    commits: mapping,
    tokens,
    invalidation: {
      statement:
        `History with tip ${oldTip} is invalidated and superseded by rewritten ` +
        `history with tip ${newTip}.`,
      oldTip,
      newTip,
      // Binds old tip, new tip, the full commit mapping and the token map
      // into a single verifiable digest.
      proofHash: sha256hex(canonicalize({ oldTip, newTip, commits: mapping, tokens })),
    },
  };

  return { commits: newCommits, manifest, tokenMap: tokens };
}
