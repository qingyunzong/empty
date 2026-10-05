// Package tokenindex maintains a set of documents, each holding a set of
// tokens (duplicates counted once), and answers Jaccard similarity
// threshold queries with verifiable pruning certificates.
package tokenindex

import (
	"fmt"
	"sort"
	"sync"
)

// DocID identifies a document. Ordering of results falls back to DocID.
type DocID int64

// Index stores document token sets together with an inverted index
// (token -> docs) and a length index (doc -> |tokens|). All three are
// updated atomically under a single lock.
type Index struct {
	mu        sync.RWMutex
	docs      map[DocID]map[string]struct{}
	inv       map[string]map[DocID]struct{}
	lens      map[DocID]int
	emptyDocs map[DocID]struct{}
}

// New returns an empty Index.
func New() *Index {
	return &Index{
		docs:      make(map[DocID]map[string]struct{}),
		inv:       make(map[string]map[DocID]struct{}),
		lens:      make(map[DocID]int),
		emptyDocs: make(map[DocID]struct{}),
	}
}

// dedup returns the distinct tokens of the input.
func dedup(tokens []string) map[string]struct{} {
	set := make(map[string]struct{}, len(tokens))
	for _, t := range tokens {
		set[t] = struct{}{}
	}
	return set
}

// Add inserts a new document. Duplicate tokens are counted once.
// It fails if the ID already exists.
func (x *Index) Add(id DocID, tokens []string) error {
	x.mu.Lock()
	defer x.mu.Unlock()
	if _, ok := x.docs[id]; ok {
		return fmt.Errorf("tokenindex: doc %d already exists", id)
	}
	set := dedup(tokens)
	x.docs[id] = set
	x.applyDeltaLocked(id, set, nil)
	return nil
}

// Remove deletes a document. It fails if the ID does not exist.
func (x *Index) Remove(id DocID) error {
	x.mu.Lock()
	defer x.mu.Unlock()
	set, ok := x.docs[id]
	if !ok {
		return fmt.Errorf("tokenindex: doc %d not found", id)
	}
	delete(x.docs, id)
	x.applyDeltaLocked(id, nil, set)
	return nil
}

// Correct atomically applies a branch token correction: tokens in del are
// removed and tokens in add are added. The document set, the inverted
// index and the length index are updated in a single critical section, so
// no observer can see a partially applied correction. It fails (leaving
// the index untouched) if the ID does not exist.
func (x *Index) Correct(id DocID, add, del []string) error {
	x.mu.Lock()
	defer x.mu.Unlock()
	set, ok := x.docs[id]
	if !ok {
		return fmt.Errorf("tokenindex: doc %d not found", id)
	}
	addSet := dedup(add)
	delSet := dedup(del)
	// Tokens both added and deleted cancel out; deletion wins for tokens
	// already present, addition wins for tokens absent. Resolve to a
	// well-defined net effect: apply deletions first, then additions.
	removed := make(map[string]struct{})
	for t := range delSet {
		if _, ok := set[t]; ok {
			if _, also := addSet[t]; !also {
				removed[t] = struct{}{}
			}
		}
	}
	added := make(map[string]struct{})
	for t := range addSet {
		if _, ok := set[t]; !ok {
			added[t] = struct{}{}
		}
	}
	for t := range removed {
		delete(set, t)
	}
	for t := range added {
		set[t] = struct{}{}
	}
	x.applyDeltaLocked(id, added, removed)
	return nil
}

// applyDeltaLocked updates the inverted index, the length index and the
// empty-doc index for a document whose token set gained `added` and lost
// `removed`. Caller must hold the write lock; docs[id] must already
// reflect the new set (or be absent for a removal with added==nil).
func (x *Index) applyDeltaLocked(id DocID, added, removed map[string]struct{}) {
	for t := range added {
		posting, ok := x.inv[t]
		if !ok {
			posting = make(map[DocID]struct{})
			x.inv[t] = posting
		}
		posting[id] = struct{}{}
	}
	for t := range removed {
		posting, ok := x.inv[t]
		if ok {
			delete(posting, id)
			if len(posting) == 0 {
				delete(x.inv, t)
			}
		}
	}
	if set, ok := x.docs[id]; ok {
		x.lens[id] = len(set)
		if len(set) == 0 {
			x.emptyDocs[id] = struct{}{}
		} else {
			delete(x.emptyDocs, id)
		}
	} else {
		delete(x.lens, id)
		delete(x.emptyDocs, id)
	}
}

// Tokens returns the sorted distinct tokens of a document.
func (x *Index) Tokens(id DocID) ([]string, bool) {
	x.mu.RLock()
	defer x.mu.RUnlock()
	set, ok := x.docs[id]
	if !ok {
		return nil, false
	}
	out := make([]string, 0, len(set))
	for t := range set {
		out = append(out, t)
	}
	sort.Strings(out)
	return out, true
}

// Len returns the number of distinct tokens of a document.
func (x *Index) Len(id DocID) (int, bool) {
	x.mu.RLock()
	defer x.mu.RUnlock()
	n, ok := x.lens[id]
	return n, ok
}

// NumDocs returns the number of documents in the index.
func (x *Index) NumDocs() int {
	x.mu.RLock()
	defer x.mu.RUnlock()
	return len(x.docs)
}

// DocIDs returns all document IDs in ascending order.
func (x *Index) DocIDs() []DocID {
	x.mu.RLock()
	defer x.mu.RUnlock()
	ids := make([]DocID, 0, len(x.docs))
	for id := range x.docs {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids
}

// CheckInvariants verifies that the inverted index and the length index
// agree with the document sets. It is used by tests and by the
// independent full-comparison audit.
func (x *Index) CheckInvariants() error {
	x.mu.RLock()
	defer x.mu.RUnlock()
	for id, set := range x.docs {
		if x.lens[id] != len(set) {
			return fmt.Errorf("tokenindex: length index mismatch for doc %d: %d != %d", id, x.lens[id], len(set))
		}
		_, wantEmpty := x.emptyDocs[id]
		if wantEmpty != (len(set) == 0) {
			return fmt.Errorf("tokenindex: empty index mismatch for doc %d", id)
		}
		for t := range set {
			posting, ok := x.inv[t]
			if !ok {
				return fmt.Errorf("tokenindex: token %q of doc %d missing from inverted index", t, id)
			}
			if _, ok := posting[id]; !ok {
				return fmt.Errorf("tokenindex: doc %d missing from posting list of %q", id, t)
			}
		}
	}
	for id := range x.lens {
		if _, ok := x.docs[id]; !ok {
			return fmt.Errorf("tokenindex: length index references unknown doc %d", id)
		}
	}
	for id := range x.emptyDocs {
		if _, ok := x.docs[id]; !ok {
			return fmt.Errorf("tokenindex: empty index references unknown doc %d", id)
		}
	}
	for t, posting := range x.inv {
		if len(posting) == 0 {
			return fmt.Errorf("tokenindex: empty posting list for %q", t)
		}
		for id := range posting {
			set, ok := x.docs[id]
			if !ok {
				return fmt.Errorf("tokenindex: posting list of %q references unknown doc %d", t, id)
			}
			if _, ok := set[t]; !ok {
				return fmt.Errorf("tokenindex: posting list of %q references doc %d without the token", t, id)
			}
		}
	}
	return nil
}
