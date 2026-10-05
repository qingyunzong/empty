// Package docset maintains a collection of documents, each a set of
// tokens (duplicates counted once), and answers Jaccard similarity
// threshold queries with certified pruning.
package docset

import (
	"errors"
	"sort"
)

var (
	// ErrDocExists is returned by Insert when the ID is already present.
	ErrDocExists = errors.New("docset: document already exists")
	// ErrDocMissing is returned when an operation names an unknown ID.
	ErrDocMissing = errors.New("docset: document does not exist")
)

// Store keeps, for every document, its token set plus two derived
// indexes that are maintained in lockstep on every mutation:
//
//   - inv:     token   -> set of document IDs   (inverted index)
//   - byLen:   set size -> set of document IDs  (length index)
//
// lengths mirrors len(docs[id]) for O(1) bound computation.
type Store struct {
	docs    map[string]map[string]struct{}
	inv     map[string]map[string]struct{}
	lengths map[string]int
	byLen   map[int]map[string]struct{}
}

// NewStore returns an empty store.
func NewStore() *Store {
	return &Store{
		docs:    make(map[string]map[string]struct{}),
		inv:     make(map[string]map[string]struct{}),
		lengths: make(map[string]int),
		byLen:   make(map[int]map[string]struct{}),
	}
}

func dedup(tokens []string) map[string]struct{} {
	set := make(map[string]struct{}, len(tokens))
	for _, t := range tokens {
		set[t] = struct{}{}
	}
	return set
}

// Insert adds a new document; duplicate tokens are counted once.
func (s *Store) Insert(id string, tokens []string) error {
	if _, ok := s.docs[id]; ok {
		return ErrDocExists
	}
	s.apply(id, nil, dedup(tokens))
	return nil
}

// Delete removes a document and all of its index postings.
func (s *Store) Delete(id string) error {
	old, ok := s.docs[id]
	if !ok {
		return ErrDocMissing
	}
	s.apply(id, old, nil)
	return nil
}

// CorrectTokens atomically applies a branch token correction: the
// tokens in remove are dropped and the tokens in add are unioned in,
// and the inverted index and the length index are updated in the same
// indivisible step. Removing a token that is not present is a no-op;
// the correction is validated (document exists) before any index is
// touched, so a failed call leaves every index unchanged.
func (s *Store) CorrectTokens(id string, add, remove []string) error {
	old, ok := s.docs[id]
	if !ok {
		return ErrDocMissing
	}
	next := make(map[string]struct{}, len(old)+len(add))
	for t := range old {
		next[t] = struct{}{}
	}
	for _, t := range remove {
		delete(next, t)
	}
	for _, t := range add {
		next[t] = struct{}{}
	}
	s.apply(id, old, next)
	return nil
}

// apply swaps the token set of id from old to next (either may be nil
// for insert/delete) and updates every derived index together.
func (s *Store) apply(id string, old, next map[string]struct{}) {
	if old != nil {
		oldLen := len(old)
		for t := range old {
			if next == nil {
				s.invRemove(t, id)
				continue
			}
			if _, kept := next[t]; !kept {
				s.invRemove(t, id)
			}
		}
		s.lenRemove(oldLen, id)
		delete(s.lengths, id)
	}
	if next != nil {
		for t := range next {
			if old == nil {
				s.invAdd(t, id)
				continue
			}
			if _, had := old[t]; !had {
				s.invAdd(t, id)
			}
		}
		s.lengths[id] = len(next)
		s.lenAdd(len(next), id)
	}
	if next == nil {
		delete(s.docs, id)
	} else {
		s.docs[id] = next
	}
}

func (s *Store) invAdd(token, id string) {
	posting, ok := s.inv[token]
	if !ok {
		posting = make(map[string]struct{})
		s.inv[token] = posting
	}
	posting[id] = struct{}{}
}

func (s *Store) invRemove(token, id string) {
	posting := s.inv[token]
	delete(posting, id)
	if len(posting) == 0 {
		delete(s.inv, token)
	}
}

func (s *Store) lenAdd(length int, id string) {
	bucket, ok := s.byLen[length]
	if !ok {
		bucket = make(map[string]struct{})
		s.byLen[length] = bucket
	}
	bucket[id] = struct{}{}
}

func (s *Store) lenRemove(length int, id string) {
	bucket := s.byLen[length]
	delete(bucket, id)
	if len(bucket) == 0 {
		delete(s.byLen, length)
	}
}

// DocIDs returns all document IDs in sorted order.
func (s *Store) DocIDs() []string {
	ids := make([]string, 0, len(s.docs))
	for id := range s.docs {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// Tokens returns the document's deduplicated tokens in sorted order.
func (s *Store) Tokens(id string) ([]string, bool) {
	set, ok := s.docs[id]
	if !ok {
		return nil, false
	}
	tokens := make([]string, 0, len(set))
	for t := range set {
		tokens = append(tokens, t)
	}
	sort.Strings(tokens)
	return tokens, true
}

// Len returns the document's token count (duplicates excluded).
func (s *Store) Len(id string) (int, bool) {
	n, ok := s.lengths[id]
	return n, ok
}
