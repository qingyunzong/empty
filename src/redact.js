'use strict';

const crypto = require('node:crypto');

class AbortRewrite extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'AbortRewrite';
    this.reason = reason;
    this.exitCode = 2;
  }
}

function sha256hex(data) {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function contentHashOf(content) {
  return sha256hex(content);
}

function computeCommitId(commit) {
  return sha256hex(canonical({
    parent: commit.parent,
    author: commit.author,
    note: commit.note,
    patch: commit.patch,
    contentHash: commit.contentHash,
  }));
}

function applyPatch(content, patch) {
  let result = content;
  for (const hunk of patch.hunks) {
    const needle = hunk.before + hunk.remove + hunk.after;
    if (needle === '') {
      throw new AbortRewrite('context-not-found', 'hunk has empty context and removal; cannot locate');
    }
    const replacement = hunk.before + hunk.add + hunk.after;
    const first = result.indexOf(needle);
    if (first === -1) {
      throw new AbortRewrite('context-not-found',
        'patch context not found in content: ' + JSON.stringify(needle.slice(0, 80)));
    }
    if (result.indexOf(needle, first + 1) !== -1) {
      throw new AbortRewrite('context-ambiguous',
        'patch context matches more than once: ' + JSON.stringify(needle.slice(0, 80)));
    }
    result = result.slice(0, first) + replacement + result.slice(first + needle.length);
  }
  return result;
}

function compilePatterns(rules) {
  return rules.map((rule) => {
    const flags = rule.flags && rule.flags.includes('g') ? rule.flags : (rule.flags || '') + 'g';
    return new RegExp(rule.pattern, flags);
  });
}

function findSensitiveValues(text, patterns) {
  const found = [];
  for (const re of patterns) {
    re.lastIndex = 0;
    for (const match of text.matchAll(re)) found.push(match[0]);
  }
  return found;
}

function buildTokenMap(values, tokenLength) {
  const valueToToken = new Map();
  const tokenToValue = new Map();
  for (const value of values) {
    const token = 'REDACTED-' + sha256hex(value).slice(0, tokenLength);
    const existing = tokenToValue.get(token);
    if (existing !== undefined && existing !== value) {
      throw new AbortRewrite('token-collision',
        'distinct values map to the same token ' + JSON.stringify(token));
    }
    valueToToken.set(value, token);
    tokenToValue.set(token, value);
  }
  return valueToToken;
}

function redactText(text, tokenMap) {
  let out = text;
  const values = [...tokenMap.keys()].sort((a, b) => b.length - a.length);
  for (const value of values) out = out.split(value).join(tokenMap.get(value));
  return out;
}

function redactPatch(patch, tokenMap) {
  return {
    file: patch.file,
    hunks: patch.hunks.map((h) => ({
      before: redactText(h.before, tokenMap),
      remove: redactText(h.remove, tokenMap),
      add: redactText(h.add, tokenMap),
      after: redactText(h.after, tokenMap),
    })),
  };
}

function rewriteHistory(repo, rules, options = {}) {
  const tokenLength = options.tokenLength ?? 12;
  const patterns = compilePatterns(rules);
  const initial = repo.initial == null ? '' : repo.initial;

  const orderedValues = new Map();
  const collect = (text) => {
    for (const value of findSensitiveValues(text, patterns)) {
      if (!orderedValues.has(value)) orderedValues.set(value, true);
    }
  };

  let content = initial;
  collect(content);
  for (const commit of repo.commits) {
    collect(commit.note);
    for (const hunk of commit.patch.hunks) {
      collect(hunk.before);
      collect(hunk.remove);
      collect(hunk.add);
      collect(hunk.after);
    }
    content = applyPatch(content, commit.patch);
    collect(content);
  }
  const originalFinal = content;

  const tokenMap = buildTokenMap([...orderedValues.keys()], tokenLength);

  let rewrittenContent = redactText(initial, tokenMap);
  const newCommits = [];
  const commitMap = [];
  let parent = null;
  for (const commit of repo.commits) {
    const newPatch = redactPatch(commit.patch, tokenMap);
    rewrittenContent = applyPatch(rewrittenContent, newPatch);
    const newCommit = {
      parent,
      author: commit.author,
      note: redactText(commit.note, tokenMap),
      patch: newPatch,
      contentHash: contentHashOf(rewrittenContent),
    };
    newCommit.id = computeCommitId(newCommit);
    commitMap.push({ old: commit.id == null ? null : commit.id, new: newCommit.id });
    parent = newCommit.id;
    newCommits.push(newCommit);
  }

  if (redactText(originalFinal, tokenMap) !== rewrittenContent) {
    throw new AbortRewrite('projection-mismatch',
      'redacted projection of original final content differs from rewritten final content');
  }

  const oldHead = repo.commits.length === 0 ? null : repo.commits[repo.commits.length - 1].id ?? null;
  const tokenToValue = new Map([...tokenMap.entries()].map(([v, t]) => [t, v]));
  const proof = {
    kind: 'redaction-history-rewrite',
    oldHead,
    newHead: parent,
    invalidatedHistoryHash: sha256hex(canonical(repo.commits)),
    commitMap,
    redactedValueCount: tokenMap.size,
    tokens: [...tokenMap.values()].sort().map((token) => ({
      token,
      valueSha256: sha256hex(tokenToValue.get(token)),
    })),
  };

  return {
    repo: { initial: redactText(initial, tokenMap), commits: newCommits },
    proof,
    tokenMap,
    originalFinal,
    rewrittenFinal: rewrittenContent,
  };
}

module.exports = {
  AbortRewrite,
  sha256hex,
  canonical,
  contentHashOf,
  computeCommitId,
  applyPatch,
  compilePatterns,
  findSensitiveValues,
  buildTokenMap,
  redactText,
  redactPatch,
  rewriteHistory,
};
