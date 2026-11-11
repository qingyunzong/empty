package q207

import (
	"fmt"
	"sort"
	"sync/atomic"
)

// KeyRule describes constraints for a single query key.
type KeyRule struct {
	// Repeatable allows the key to appear multiple times in the query.
	Repeatable bool
}

// Rules is one immutable version of the normalization rules.
type Rules struct {
	// Keys lists allowed keys and their rules; unlisted keys are rejected.
	Keys map[string]KeyRule
	// RequireUTF8Values rejects values that are not valid UTF-8 after decoding.
	RequireUTF8Values bool
}

func (r *Rules) validate() error {
	if r == nil {
		return fmt.Errorf("q207: nil rules")
	}
	for k := range r.Keys {
		if k == "" {
			return fmt.Errorf("q207: empty key in rules")
		}
		if hasControl(k) {
			return fmt.Errorf("q207: key %q contains control characters", k)
		}
	}
	return nil
}

// snapshot is one hot-reloadable rule version, pinned for a single request.
type snapshot struct {
	version uint64
	rules   *Rules
}

// RuleStore holds the currently active rule version with hot reload support.
type RuleStore struct {
	cur atomic.Pointer[snapshot]
}

// NewRuleStore creates a store with the given rules at version 1.
func NewRuleStore(rules *Rules) (*RuleStore, error) {
	if err := rules.validate(); err != nil {
		return nil, err
	}
	s := &RuleStore{}
	s.cur.Store(&snapshot{version: 1, rules: rules})
	return s, nil
}

// Update hot-reloads the rules; the version increases monotonically and
// in-flight requests keep using the version they started with.
func (s *RuleStore) Update(rules *Rules) (uint64, error) {
	if err := rules.validate(); err != nil {
		return 0, err
	}
	for {
		old := s.cur.Load()
		next := &snapshot{version: old.version + 1, rules: rules}
		if s.cur.CompareAndSwap(old, next) {
			return next.version, nil
		}
	}
}

// Version returns the current rule version.
func (s *RuleStore) Version() uint64 {
	return s.cur.Load().version
}

// load pins the rule version for one request.
func (s *RuleStore) load() *snapshot {
	return s.cur.Load()
}

// sortedKeys returns the configured keys in sorted order.
func (r *Rules) sortedKeys() []string {
	keys := make([]string, 0, len(r.Keys))
	for k := range r.Keys {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
