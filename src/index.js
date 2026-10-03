// Fielded positional inverted index:
//   field -> term -> (docId -> [positions])
export class PositionalIndex {
  constructor() {
    this.fields = new Map();
  }

  #field(name) {
    let f = this.fields.get(name);
    if (!f) {
      f = new Map();
      this.fields.set(name, f);
    }
    return f;
  }

  add(docId, fieldName, tokens) {
    const f = this.#field(fieldName);
    tokens.forEach((term, pos) => {
      let posting = f.get(term);
      if (!posting) {
        posting = new Map();
        f.set(term, posting);
      }
      let arr = posting.get(docId);
      if (!arr) {
        arr = [];
        posting.set(docId, arr);
      }
      arr.push(pos);
    });
  }

  // Returns Map(docId -> [positions]); empty Map when term unknown.
  postings(fieldName, term) {
    return this.#field(fieldName).get(term) ?? new Map();
  }

  positions(fieldName, term, docId) {
    return this.postings(fieldName, term).get(docId) ?? [];
  }
}
