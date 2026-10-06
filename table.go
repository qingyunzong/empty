package hdrclient

import (
	"errors"
	"fmt"
	"net/netip"
	"sync"
)

// Action decides what a matched prefix means for an address.
type Action int

const (
	// ActionTrust marks the address as a trusted proxy hop to strip.
	ActionTrust Action = iota
	// ActionDeny is an exception: the address is rejected from the
	// trusted set even if a broader trust prefix also matches.
	ActionDeny
)

func (a Action) String() string {
	if a == ActionDeny {
		return "deny"
	}
	return "trust"
}

// Rule is one entry of the trusted prefix table.
type Rule struct {
	Name   string
	Prefix netip.Prefix
	Action Action
}

func (r Rule) String() string {
	return fmt.Sprintf("%s(%s %s)", r.Name, r.Action, r.Prefix)
}

var (
	ErrTxClosed      = errors.New("hdrclient: transaction already closed")
	ErrTxConflict    = errors.New("hdrclient: table changed since transaction began")
	ErrDuplicateRule = errors.New("hdrclient: duplicate rule")
	ErrRuleNotFound  = errors.New("hdrclient: no rule with that name")
	ErrBadPrefix     = errors.New("hdrclient: cannot unify 4-in-6 prefix broader than /96")
)

type ruleset struct {
	rules []Rule
	unify bool
}

func (rs *ruleset) clone() *ruleset {
	return &ruleset{rules: append([]Rule(nil), rs.rules...), unify: rs.unify}
}

// Table is the mutable trusted prefix table. All changes go through
// transactions; readers use immutable snapshots.
type Table struct {
	mu  sync.Mutex
	gen uint64
	rs  *ruleset
}

func NewTable() *Table {
	return &Table{rs: &ruleset{}}
}

// Begin starts a transaction against the current table state.
func (t *Table) Begin() *Tx {
	t.mu.Lock()
	defer t.mu.Unlock()
	return &Tx{table: t, base: t.gen, rs: t.rs.clone()}
}

// Snapshot returns an immutable view of the committed table state.
func (t *Table) Snapshot() *Snapshot {
	t.mu.Lock()
	defer t.mu.Unlock()
	return &Snapshot{rules: append([]Rule(nil), t.rs.rules...), unify: t.rs.unify, gen: t.gen}
}

// Tx is a pending transactional update. It is not safe for concurrent use.
type Tx struct {
	table *Table
	base  uint64
	rs    *ruleset
	done  bool
}

// Trust adds a trusted proxy prefix rule.
func (tx *Tx) Trust(name string, prefix netip.Prefix) error {
	return tx.add(Rule{Name: name, Prefix: prefix, Action: ActionTrust})
}

// Deny adds an exception rule rejecting addresses from the trusted set.
func (tx *Tx) Deny(name string, prefix netip.Prefix) error {
	return tx.add(Rule{Name: name, Prefix: prefix, Action: ActionDeny})
}

// SetUnifyIPv4MappedIPv6 sets the identity switch: when on, an
// IPv4-mapped IPv6 address such as ::ffff:10.0.0.1 is the same identity
// as 10.0.0.1; when off, the two stay distinct.
func (tx *Tx) SetUnifyIPv4MappedIPv6(on bool) error {
	if tx.done {
		return ErrTxClosed
	}
	tx.rs.unify = on
	return nil
}

func (tx *Tx) add(r Rule) error {
	if tx.done {
		return ErrTxClosed
	}
	if r.Name == "" {
		return errors.New("hdrclient: rule name required")
	}
	if tx.rs.unify {
		if r.Prefix.Addr().Is4In6() && r.Prefix.Bits() < 96 {
			return fmt.Errorf("%w: %s", ErrBadPrefix, r.Prefix)
		}
	}
	r.Prefix = r.Prefix.Masked()
	if tx.rs.unify {
		p, err := unmapPrefix(r.Prefix)
		if err != nil {
			return err
		}
		r.Prefix = p
	}
	for _, e := range tx.rs.rules {
		if e.Prefix == r.Prefix && e.Action == r.Action {
			return fmt.Errorf("%w: %s %s", ErrDuplicateRule, r.Action, r.Prefix)
		}
	}
	tx.rs.rules = append(tx.rs.rules, r)
	return nil
}

// Remove deletes every rule carrying the given name.
func (tx *Tx) Remove(name string) error {
	if tx.done {
		return ErrTxClosed
	}
	kept := tx.rs.rules[:0]
	removed := false
	for _, r := range tx.rs.rules {
		if r.Name == name {
			removed = true
			continue
		}
		kept = append(kept, r)
	}
	if !removed {
		return fmt.Errorf("%w: %q", ErrRuleNotFound, name)
	}
	tx.rs.rules = kept
	return nil
}

// Commit atomically applies the transaction. It fails with ErrTxConflict
// if another transaction committed after this one began.
func (tx *Tx) Commit() error {
	if tx.done {
		return ErrTxClosed
	}
	tx.done = true
	t := tx.table
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.gen != tx.base {
		return ErrTxConflict
	}
	t.rs = tx.rs
	t.gen++
	return nil
}

// Rollback discards the transaction.
func (tx *Tx) Rollback() {
	tx.done = true
	tx.rs = nil
}

func unmapPrefix(p netip.Prefix) (netip.Prefix, error) {
	if !p.Addr().Is4In6() {
		return p, nil
	}
	if p.Bits() < 96 {
		return netip.Prefix{}, fmt.Errorf("%w: %s", ErrBadPrefix, p)
	}
	return netip.PrefixFrom(p.Addr().Unmap(), p.Bits()-96), nil
}

// Snapshot is an immutable, point-in-time view of the table. Analyses are
// bound to a snapshot, so later table updates never affect them.
type Snapshot struct {
	rules []Rule
	unify bool
	gen   uint64
}

// Generation identifies the committed table state this snapshot came from.
func (s *Snapshot) Generation() uint64 { return s.gen }

// UnifyIPv4MappedIPv6 reports the identity switch of this snapshot.
func (s *Snapshot) UnifyIPv4MappedIPv6() bool { return s.unify }

// Lookup returns the longest-prefix matching rule for addr. On equal
// prefix length a deny exception wins over a trust rule.
func (s *Snapshot) Lookup(addr netip.Addr) (Rule, bool) {
	best := -1
	for i, r := range s.rules {
		if !r.Prefix.Contains(addr) {
			continue
		}
		if best < 0 ||
			r.Prefix.Bits() > s.rules[best].Prefix.Bits() ||
			(r.Prefix.Bits() == s.rules[best].Prefix.Bits() && r.Action == ActionDeny) {
			best = i
		}
	}
	if best < 0 {
		return Rule{}, false
	}
	return s.rules[best], true
}

// normalize applies the snapshot's identity switch to a parsed address.
func (s *Snapshot) normalize(addr netip.Addr) netip.Addr {
	addr = addr.WithZone("")
	if s.unify {
		addr = addr.Unmap()
	}
	return addr
}
