// Package capability implements attenuable capability tokens organized as a
// forest. Each token carries a resource prefix, an action set and a
// half-open validity interval [NotBefore, NotAfter). Child tokens may only
// narrow their parent's capabilities and may never extend them. Revoking
// any ancestor invalidates the whole subtree.
package capability

import (
	"bytes"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

// Verifier decides whether a token's signature is acceptable. It is
// injected into the Store so callers can plug in any signature scheme.
type Verifier interface {
	Verify(payload, signature []byte) bool
}

// VerifierFunc adapts a plain function to the Verifier interface.
type VerifierFunc func(payload, signature []byte) bool

// Verify implements Verifier.
func (f VerifierFunc) Verify(payload, signature []byte) bool { return f(payload, signature) }

// Token is a capability token. The zero value is not usable; tokens are
// inserted into a Store via MintRoot or Attenuate.
type Token struct {
	ID        string
	Parent    string // empty for root tokens
	Resource  string // capability applies to Resource and anything under this prefix
	Actions   []string
	NotBefore time.Time
	NotAfter  time.Time // exclusive: valid while NotBefore <= t < NotAfter
	Signature []byte
}

// SigningPayload returns the canonical byte encoding that is signed.
func (t Token) SigningPayload() []byte {
	actions := append([]string(nil), t.Actions...)
	sort.Strings(actions)
	var b bytes.Buffer
	fmt.Fprintf(&b, "id=%s\nparent=%s\nresource=%s\nactions=%s\nnotbefore=%d\nnotafter=%d\n",
		t.ID, t.Parent, t.Resource, strings.Join(actions, ","),
		t.NotBefore.UnixNano(), t.NotAfter.UnixNano())
	return b.Bytes()
}

// validAt reports whether the token is live at the given instant under the
// half-open interval [NotBefore, NotAfter).
func (t Token) validAt(at time.Time) bool {
	return !at.Before(t.NotBefore) && at.Before(t.NotAfter)
}

// narrows reports whether child is a strict narrowing of parent: resource
// keeps the parent's prefix, actions are a subset, and the validity
// interval is contained in (never extends beyond) the parent's.
func narrows(parent, child Token) bool {
	if !strings.HasPrefix(child.Resource, parent.Resource) {
		return false
	}
	parentActions := make(map[string]bool, len(parent.Actions))
	for _, a := range parent.Actions {
		parentActions[a] = true
	}
	for _, a := range child.Actions {
		if !parentActions[a] {
			return false
		}
	}
	if child.NotBefore.Before(parent.NotBefore) {
		return false
	}
	if child.NotAfter.After(parent.NotAfter) {
		return false
	}
	return child.NotBefore.Before(child.NotAfter)
}

// Sentinel errors returned by Store operations.
var (
	ErrUnknownToken     = errors.New("capability: unknown token")
	ErrDuplicateToken   = errors.New("capability: duplicate token id")
	ErrBadSignature     = errors.New("capability: signature verification failed")
	ErrNotAttenuation   = errors.New("capability: child does not narrow parent")
	ErrRevoked          = errors.New("capability: token or an ancestor is revoked")
	ErrExpired          = errors.New("capability: token not valid at the given time")
	ErrBrokenChain      = errors.New("capability: chain link does not narrow")
	ErrRootHasParent    = errors.New("capability: root token must have empty parent")
	ErrChildNeedsParent = errors.New("capability: child token must name its parent")
)

// Chain is the evidence returned by Verify: every token from the root down
// to the queried leaf, in order.
type Chain struct {
	Tokens []Token
}

// Root returns the first token of the chain; Leaf returns the last.
func (c Chain) Root() Token { return c.Tokens[0] }

// Leaf returns the token the chain was verified for.
func (c Chain) Leaf() Token { return c.Tokens[len(c.Tokens)-1] }

// Store keeps the token forest, revocation marks and the injected
// signature verifier.
type Store struct {
	verifier Verifier
	tokens   map[string]Token
	children map[string][]string
	revoked  map[string]bool
}

// NewStore creates a Store that checks signatures with v.
func NewStore(v Verifier) *Store {
	return &Store{
		verifier: v,
		tokens:   make(map[string]Token),
		children: make(map[string][]string),
		revoked:  make(map[string]bool),
	}
}

func (s *Store) insert(t Token) error {
	if _, dup := s.tokens[t.ID]; dup {
		return ErrDuplicateToken
	}
	if !t.NotBefore.Before(t.NotAfter) {
		return fmt.Errorf("%w: empty validity interval", ErrNotAttenuation)
	}
	if !s.verifier.Verify(t.SigningPayload(), t.Signature) {
		return ErrBadSignature
	}
	s.tokens[t.ID] = t
	if t.Parent != "" {
		s.children[t.Parent] = append(s.children[t.Parent], t.ID)
	}
	return nil
}

// MintRoot inserts a root token after checking its signature.
func (s *Store) MintRoot(t Token) error {
	if t.Parent != "" {
		return ErrRootHasParent
	}
	return s.insert(t)
}

// Attenuate inserts a child of parentID. The child must narrow the parent
// and must not extend its validity interval.
func (s *Store) Attenuate(parentID string, child Token) error {
	parent, ok := s.tokens[parentID]
	if !ok {
		return ErrUnknownToken
	}
	if child.Parent == "" {
		return ErrChildNeedsParent
	}
	if child.Parent != parentID {
		return fmt.Errorf("%w: child names parent %q, want %q", ErrNotAttenuation, child.Parent, parentID)
	}
	if !narrows(parent, child) {
		return ErrNotAttenuation
	}
	return s.insert(child)
}

// Revoke marks id as revoked; every descendant becomes invalid as well.
func (s *Store) Revoke(id string) error {
	if _, ok := s.tokens[id]; !ok {
		return ErrUnknownToken
	}
	s.revoked[id] = true
	return nil
}

// isLive reports whether id and all of its ancestors are unrevoked.
func (s *Store) isLive(id string) bool {
	for id != "" {
		if s.revoked[id] {
			return false
		}
		id = s.tokens[id].Parent
	}
	return true
}

// Verify checks that id is usable at time at and returns the chain
// evidence (root … leaf). It fails if any ancestor is revoked, if any
// chain link fails to narrow, or if the leaf is not valid at at.
func (s *Store) Verify(id string, at time.Time) (Chain, error) {
	if _, ok := s.tokens[id]; !ok {
		return Chain{}, ErrUnknownToken
	}
	var rev []Token
	for cur := id; cur != ""; {
		t := s.tokens[cur]
		rev = append(rev, t)
		cur = t.Parent
	}
	chain := Chain{Tokens: make([]Token, len(rev))}
	for i, t := range rev {
		chain.Tokens[len(rev)-1-i] = t
	}
	for _, t := range chain.Tokens {
		if s.revoked[t.ID] {
			return Chain{}, fmt.Errorf("%w: %s", ErrRevoked, t.ID)
		}
	}
	for i := 1; i < len(chain.Tokens); i++ {
		if !narrows(chain.Tokens[i-1], chain.Tokens[i]) {
			return Chain{}, fmt.Errorf("%w: %s -> %s", ErrBrokenChain, chain.Tokens[i-1].ID, chain.Tokens[i].ID)
		}
	}
	leaf := chain.Leaf()
	if !leaf.validAt(at) {
		return Chain{}, fmt.Errorf("%w: %s at %s", ErrExpired, leaf.ID, at.Format(time.RFC3339Nano))
	}
	return chain, nil
}

// Entry is one row of the tree enumeration produced by Enumerate.
type Entry struct {
	Token   Token
	Depth   int
	Revoked bool // this token itself was revoked
	Live    bool // neither this token nor any ancestor is revoked
}

// Enumerate walks the whole forest depth-first and returns every token
// with its depth and revocation status, so callers can cross-check the
// tree against expectations.
func (s *Store) Enumerate() []Entry {
	var roots []string
	for id, t := range s.tokens {
		if t.Parent == "" {
			roots = append(roots, id)
		}
	}
	sort.Strings(roots)
	var out []Entry
	var walk func(id string, depth int, ancestorRevoked bool)
	walk = func(id string, depth int, ancestorRevoked bool) {
		t := s.tokens[id]
		self := s.revoked[id]
		out = append(out, Entry{
			Token:   t,
			Depth:   depth,
			Revoked: self,
			Live:    !self && !ancestorRevoked,
		})
		kids := append([]string(nil), s.children[id]...)
		sort.Strings(kids)
		for _, k := range kids {
			walk(k, depth+1, ancestorRevoked || self)
		}
	}
	for _, r := range roots {
		walk(r, 0, false)
	}
	return out
}
