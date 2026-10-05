package captoken

import (
	"fmt"
	"sort"
	"time"
)

// Store holds a forest of capability tokens, tracks revocations, and
// verifies tokens against an injected Verifier.
type Store struct {
	verifier Verifier
	tokens   map[string]*Token
	children map[string][]string
	revoked  map[string]bool
}

// NewStore creates a Store that verifies signatures with v.
func NewStore(v Verifier) *Store {
	return &Store{
		verifier: v,
		tokens:   make(map[string]*Token),
		children: make(map[string][]string),
		revoked:  make(map[string]bool),
	}
}

// AddRoot registers a root token. The token must have no parent and carry
// a valid signature.
func (s *Store) AddRoot(t *Token) error {
	if t.Parent != "" {
		return fmt.Errorf("%w: %q has parent %q", ErrRootHasParent, t.ID, t.Parent)
	}
	return s.add(t)
}

// Attenuate registers child as an attenuation of the token identified by
// parentID. The child may only narrow the parent's resource prefix, action
// set, and validity window, and must carry a valid signature.
func (s *Store) Attenuate(parentID string, child *Token) error {
	parent, ok := s.tokens[parentID]
	if !ok {
		return fmt.Errorf("%w: parent %q", ErrUnknownToken, parentID)
	}
	if child.Parent != parentID {
		return fmt.Errorf("%w: token %q declares parent %q, want %q",
			ErrNotChildOfParent, child.ID, child.Parent, parentID)
	}
	if err := checkAttenuation(parent, child); err != nil {
		return err
	}
	return s.add(child)
}

func (s *Store) add(t *Token) error {
	if _, exists := s.tokens[t.ID]; exists {
		return fmt.Errorf("%w: %q", ErrDuplicateToken, t.ID)
	}
	if err := validateWindow(t); err != nil {
		return err
	}
	if err := s.verifier.Verify(t.payload(), t.Signature); err != nil {
		return fmt.Errorf("%w: %q: %v", ErrBadSignature, t.ID, err)
	}
	s.tokens[t.ID] = t
	if t.Parent != "" {
		s.children[t.Parent] = append(s.children[t.Parent], t.ID)
	}
	return nil
}

// Revoke marks the token identified by id as revoked. Because verification
// walks the whole ancestor chain, every descendant of id becomes invalid
// as well.
func (s *Store) Revoke(id string) error {
	if _, ok := s.tokens[id]; !ok {
		return fmt.Errorf("%w: %q", ErrUnknownToken, id)
	}
	s.revoked[id] = true
	return nil
}

// LinkEvidence records the checks performed for one token on the chain.
type LinkEvidence struct {
	TokenID          string
	ParentID         string
	SignatureValid   bool
	NotRevoked       bool
	ValidAt          bool
	AttenuationValid bool // true for the root (no parent to compare against)
}

// Evidence is the chain evidence produced by Verify: one link per token,
// ordered from the verified token up to the root.
type Evidence struct {
	TokenID string
	At      time.Time
	Links   []LinkEvidence
}

// chain returns the tokens from id up to the root, leaf first.
func (s *Store) chain(id string) ([]*Token, error) {
	var chain []*Token
	for cur := id; ; {
		t, ok := s.tokens[cur]
		if !ok {
			return nil, fmt.Errorf("%w: %q", ErrUnknownToken, cur)
		}
		chain = append(chain, t)
		if t.Parent == "" {
			return chain, nil
		}
		cur = t.Parent
	}
}

// Verify checks the token identified by id at time at: the signature of
// every token on the chain, revocation status of the token and all its
// ancestors, the half-open validity windows, and the attenuation
// constraints between each parent and child. It returns the chain
// evidence; on failure the evidence contains the links checked so far and
// the error identifies the failing check.
func (s *Store) Verify(id string, at time.Time) (*Evidence, error) {
	chain, err := s.chain(id)
	if err != nil {
		return nil, err
	}
	ev := &Evidence{TokenID: id, At: at}
	for i, t := range chain {
		link := LinkEvidence{TokenID: t.ID, ParentID: t.Parent, AttenuationValid: true}
		ev.Links = append(ev.Links, link)

		if s.verifier.Verify(t.payload(), t.Signature) != nil {
			return ev, fmt.Errorf("%w: %q", ErrBadSignature, t.ID)
		}
		ev.Links[i].SignatureValid = true

		if s.revoked[t.ID] {
			return ev, fmt.Errorf("%w: %q", ErrRevoked, t.ID)
		}
		ev.Links[i].NotRevoked = true

		switch {
		case at.Before(t.NotBefore):
			return ev, fmt.Errorf("%w: %q valid from %s", ErrNotYetValid, t.ID, t.NotBefore)
		case !at.Before(t.NotAfter):
			return ev, fmt.Errorf("%w: %q valid until %s (exclusive)", ErrExpired, t.ID, t.NotAfter)
		}
		ev.Links[i].ValidAt = true

		if i+1 < len(chain) {
			if err := checkAttenuation(chain[i+1], t); err != nil {
				ev.Links[i].AttenuationValid = false
				return ev, err
			}
		}
	}
	return ev, nil
}

// NodeResult is the outcome of verifying one node during a tree check.
type NodeResult struct {
	TokenID string
	Valid   bool
	Err     error
}

// CheckTree enumerates the token identified by rootID and all of its
// descendants (breadth-first) and verifies each one at time at, returning
// one result per node in enumeration order.
func (s *Store) CheckTree(rootID string, at time.Time) ([]NodeResult, error) {
	if _, ok := s.tokens[rootID]; !ok {
		return nil, fmt.Errorf("%w: %q", ErrUnknownToken, rootID)
	}
	var results []NodeResult
	queue := []string{rootID}
	for len(queue) > 0 {
		id := queue[0]
		queue = queue[1:]
		_, err := s.Verify(id, at)
		results = append(results, NodeResult{TokenID: id, Valid: err == nil, Err: err})
		queue = append(queue, s.children[id]...)
	}
	return results, nil
}

// Children returns the sorted ids of the direct children of id.
func (s *Store) Children(id string) []string {
	ids := append([]string(nil), s.children[id]...)
	sort.Strings(ids)
	return ids
}
