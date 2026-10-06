package linearck

import (
	"fmt"
	"sort"
	"strings"
)

// Status is the finite state enumeration of an owner variable.
//
//	Dead        -- not declared or already dropped
//	Owned       -- alive, no active borrows
//	Lent        -- alive, one or more shared borrows active
//	MutBorrowed -- alive, exactly one exclusive borrow active
type Status int

const (
	Dead Status = iota
	Owned
	Lent
	MutBorrowed
)

func (s Status) String() string {
	switch s {
	case Dead:
		return "dead"
	case Owned:
		return "owned"
	case Lent:
		return "lent"
	case MutBorrowed:
		return "mut-borrowed"
	}
	return "unknown"
}

// refInfo describes a live or moved-away borrow reference.
type refInfo struct {
	owner string
	kind  Kind
	moved bool // ownership of the borrow was transferred elsewhere
}

// State is the abstract borrow state threaded through the command machine.
// vars holds the set of alive owners; refs holds every known reference,
// including moved-away and dangling ones (kept so misuse can be reported).
type State struct {
	vars map[string]bool
	refs map[string]refInfo
}

// NewState returns the empty state: no owners, no borrows.
func NewState() *State {
	return &State{vars: map[string]bool{}, refs: map[string]refInfo{}}
}

// Clone deep-copies the state.
func (s *State) Clone() *State {
	out := NewState()
	for k, v := range s.vars {
		out.vars[k] = v
	}
	for k, v := range s.refs {
		out.refs[k] = v
	}
	return out
}

// key is the canonical encoding used for dedup and merge compatibility.
func (s *State) key() string {
	var b strings.Builder
	vars := make([]string, 0, len(s.vars))
	for n := range s.vars {
		vars = append(vars, n)
	}
	sort.Strings(vars)
	for _, n := range vars {
		fmt.Fprintf(&b, "V%s;", n)
	}
	refs := make([]string, 0, len(s.refs))
	for n := range s.refs {
		refs = append(refs, n)
	}
	sort.Strings(refs)
	for _, n := range refs {
		r := s.refs[n]
		fmt.Fprintf(&b, "R%s=%s/%d/%t;", n, r.owner, r.kind, r.moved)
	}
	return b.String()
}

// borrowsOf returns the live (not moved-away) borrow names on owner.
func (s *State) borrowsOf(owner string) []string {
	var out []string
	for n, r := range s.refs {
		if r.owner == owner && !r.moved {
			out = append(out, n)
		}
	}
	return out
}

// exclusiveOn reports whether owner has a live exclusive borrow.
func (s *State) exclusiveOn(owner string) (string, bool) {
	for n, r := range s.refs {
		if r.owner == owner && !r.moved && r.kind == Exclusive {
			return n, true
		}
	}
	return "", false
}

// StatusOf maps an owner name onto the finite status enumeration.
func (s *State) StatusOf(owner string) Status {
	if !s.vars[owner] {
		return Dead
	}
	st := Owned
	for _, r := range s.refs {
		if r.owner == owner && !r.moved {
			if r.kind == Exclusive {
				return MutBorrowed
			}
			st = Lent
		}
	}
	return st
}
