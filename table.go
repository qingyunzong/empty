// Package hdrclient determines the real client address from a forwarding
// header (e.g. X-Forwarded-For) by stripping configured trusted proxies
// from right to left.
package hdrclient

import (
	"errors"
	"fmt"
	"net/netip"
	"sync"
)

// Decision is the outcome attached to a trusted-prefix table entry.
type Decision int

const (
	// Deny marks an exception entry: matching addresses are never trusted,
	// even when a broader Trust entry also matches.
	Deny Decision = iota
	// Trust marks an entry whose matching addresses are trusted proxies.
	Trust
)

func (d Decision) String() string {
	switch d {
	case Trust:
		return "trust"
	case Deny:
		return "deny"
	default:
		return "unknown"
	}
}

// Rule is the concrete table entry (or absence of one) used to classify a
// single address during analysis.
type Rule struct {
	// Prefix is the longest matching table prefix. Invalid when Matched is false.
	Prefix netip.Prefix
	// Decision is the decision attached to Prefix.
	Decision Decision
	// Matched reports whether any table entry matched. An unmatched address
	// is untrusted by default.
	Matched bool
}

// Trusted reports whether the rule establishes trust for the address.
func (r Rule) Trusted() bool { return r.Matched && r.Decision == Trust }

func (r Rule) String() string {
	if !r.Matched {
		return "no-match (default: untrusted)"
	}
	return fmt.Sprintf("%s %s", r.Decision, r.Prefix)
}

// Table is a mutable trusted-prefix table. All reads go through Snapshot;
// all writes go through a Tx so updates apply atomically.
type Table struct {
	mu    sync.RWMutex
	unify bool
	rules map[netip.Prefix]Decision
}

// NewTable creates an empty table. unifyIPv4Mapped controls whether
// IPv4-mapped IPv6 addresses (e.g. ::ffff:1.2.3.4) share the identity of
// their embedded IPv4 address; the flag is frozen into every Snapshot.
func NewTable(unifyIPv4Mapped bool) *Table {
	return &Table{unify: unifyIPv4Mapped, rules: map[netip.Prefix]Decision{}}
}

// normalizePrefix masks the prefix and, when unification is enabled, rewrites
// IPv4-mapped IPv6 prefixes to their IPv4 form so identities stay consistent
// with parsed addresses.
func normalizePrefix(p netip.Prefix, unify bool) (netip.Prefix, error) {
	if !p.IsValid() {
		return p, errors.New("hdrclient: invalid prefix")
	}
	p = p.Masked()
	if unify && p.Addr().Is4In6() {
		if p.Bits() < 96 {
			return p, fmt.Errorf("hdrclient: 4-in-6 prefix %s too short to unmap", p)
		}
		p = netip.PrefixFrom(p.Addr().Unmap(), p.Bits()-96)
	}
	return p, nil
}

// ParsePrefix parses s and normalizes it the same way table entries are.
func ParsePrefix(s string, unifyIPv4Mapped bool) (netip.Prefix, error) {
	p, err := netip.ParsePrefix(s)
	if err != nil {
		return p, fmt.Errorf("hdrclient: %w", err)
	}
	return normalizePrefix(p, unifyIPv4Mapped)
}

// op is one buffered table mutation.
type op struct {
	prefix   netip.Prefix
	decision Decision
	remove   bool
}

// Tx is a pending transactional update to a Table. Buffer operations with
// Trust, Deny and Remove, then Commit to apply them atomically or Rollback
// to discard them. A Tx is not safe for concurrent use.
type Tx struct {
	table *Table
	ops   []op
	done  bool
}

// Begin starts a new transactional update.
func (t *Table) Begin() *Tx { return &Tx{table: t} }

// Trust buffers an entry trusting addr prefixes matching p.
func (tx *Tx) Trust(p netip.Prefix) *Tx { return tx.add(p, Trust, false) }

// Deny buffers an exception entry rejecting addresses matching p, overriding
// any broader Trust entry via longest-prefix match.
func (tx *Tx) Deny(p netip.Prefix) *Tx { return tx.add(p, Deny, false) }

// Remove buffers deletion of the exact entry for p.
func (tx *Tx) Remove(p netip.Prefix) *Tx { return tx.add(p, Deny, true) }

func (tx *Tx) add(p netip.Prefix, d Decision, remove bool) *Tx {
	if tx.done {
		return tx
	}
	tx.ops = append(tx.ops, op{prefix: p, decision: d, remove: remove})
	return tx
}

// Commit validates and applies every buffered operation atomically. If any
// operation is invalid, nothing is applied and an error is returned.
func (tx *Tx) Commit() error {
	if tx.done {
		return errors.New("hdrclient: transaction already closed")
	}
	tx.done = true
	normalized := make([]op, len(tx.ops))
	for i, o := range tx.ops {
		p, err := normalizePrefix(o.prefix, tx.table.unify)
		if err != nil {
			return fmt.Errorf("hdrclient: commit aborted, nothing applied: %w", err)
		}
		normalized[i] = op{prefix: p, decision: o.decision, remove: o.remove}
	}
	tx.table.mu.Lock()
	defer tx.table.mu.Unlock()
	for _, o := range normalized {
		if o.remove {
			delete(tx.table.rules, o.prefix)
		} else {
			tx.table.rules[o.prefix] = o.decision
		}
	}
	return nil
}

// Rollback discards all buffered operations.
func (tx *Tx) Rollback() { tx.done = true; tx.ops = nil }

// Snapshot is an immutable view of a Table plus its unification flag.
// Analyses bind to a Snapshot, so later table updates never affect them.
type Snapshot struct {
	unify bool
	rules map[netip.Prefix]Decision
}

// Snapshot captures the current table state.
func (t *Table) Snapshot() *Snapshot {
	t.mu.RLock()
	defer t.mu.RUnlock()
	rules := make(map[netip.Prefix]Decision, len(t.rules))
	for p, d := range t.rules {
		rules[p] = d
	}
	return &Snapshot{unify: t.unify, rules: rules}
}

// UnifyIPv4Mapped reports whether the snapshot unifies IPv4-mapped IPv6
// addresses with their embedded IPv4 identity.
func (s *Snapshot) UnifyIPv4Mapped() bool { return s.unify }

// Lookup returns the longest-prefix-match rule for addr. addr must already
// be normalized (unmapped) according to the snapshot's unification flag.
func (s *Snapshot) Lookup(addr netip.Addr) Rule {
	best := -1
	var rule Rule
	for p, d := range s.rules {
		if p.Bits() > best && p.Contains(addr) {
			best = p.Bits()
			rule = Rule{Prefix: p, Decision: d, Matched: true}
		}
	}
	return rule
}

// unifyAddr normalizes addr according to the snapshot's unification flag.
func (s *Snapshot) unifyAddr(addr netip.Addr) netip.Addr {
	if s.unify {
		return addr.Unmap()
	}
	return addr
}
