export function tokenize(text) {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

export class PhraseIndex {
  constructor() {
    this.docs = new Map();
  }

  static fromState(state, masked = new Set()) {
    const index = new PhraseIndex();
    for (const [id, node] of state.nodes) {
      if (node.deleted || masked.has(id)) continue;
      index.add(id, node.note);
    }
    return index;
  }

  add(id, text) {
    this.docs.set(id, tokenize(text));
  }

  remove(id) {
    this.docs.delete(id);
  }

  phrase(query) {
    const terms = tokenize(query);
    if (terms.length === 0) return [];
    const hits = [];
    for (const [id, tokens] of this.docs) {
      outer: for (let i = 0; i + terms.length <= tokens.length; i++) {
        for (let j = 0; j < terms.length; j++) {
          if (tokens[i + j] !== terms[j]) continue outer;
        }
        hits.push(id);
        break;
      }
    }
    return hits.sort();
  }

  near(terms, distance = 3) {
    const wanted = terms.map((t) => t.toLowerCase());
    const hits = [];
    for (const [id, tokens] of this.docs) {
      const positions = wanted.map((term) =>
        tokens.flatMap((token, i) => (token === term ? [i] : []))
      );
      if (positions.some((p) => p.length === 0)) continue;
      let current = positions[0];
      let ok = true;
      for (let i = 1; i < positions.length; i++) {
        const next = positions[i].filter((p) => current.some((c) => Math.abs(p - c) <= distance));
        if (next.length === 0) {
          ok = false;
          break;
        }
        current = next;
      }
      if (ok) hits.push(id);
    }
    return hits.sort();
  }
}
