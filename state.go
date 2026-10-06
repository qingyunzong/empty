package linearchk

import (
	"fmt"
	"sort"
	"strings"
)

// Sym describes one symbol in an abstract state.
type Sym struct {
	Kind   Kind
	Live   bool
	Target string // for borrows: the owner name
}

// State maps names to symbols. Only the live view is behaviorally
// relevant: dead symbols may be redefined freely.
type State struct {
	syms map[string]Sym
}

func newState() *State { return &State{syms: map[string]Sym{}} }

func (s *State) get(name string) Sym { return s.syms[name] }

func (s *State) set(name string, sym Sym) {
	if !sym.Live {
		delete(s.syms, name)
		return
	}
	s.syms[name] = sym
}

func (s *State) clone() *State {
	out := newState()
	for k, v := range s.syms {
		out.syms[k] = v
	}
	return out
}

// liveBorrowsOf returns the names of live borrows of owner, sorted.
func (s *State) liveBorrowsOf(owner string) []string {
	var out []string
	for n, v := range s.syms {
		if v.Live && v.Kind != Owner && v.Target == owner {
			out = append(out, n)
		}
	}
	sort.Strings(out)
	return out
}

// key is the canonical form of the live view. Two states with equal
// keys behave identically under all further commands.
func (s *State) key() string {
	names := make([]string, 0, len(s.syms))
	for n, v := range s.syms {
		if v.Live {
			names = append(names, n)
		}
	}
	sort.Strings(names)
	var b strings.Builder
	for _, n := range names {
		v := s.syms[n]
		fmt.Fprintf(&b, "%s:%s", n, v.Kind)
		if v.Kind != Owner {
			fmt.Fprintf(&b, "->%s", v.Target)
		}
		b.WriteByte(';')
	}
	return b.String()
}

// compatible reports whether two branch-exit states may merge: every
// name must agree on liveness, kind, and borrow target.
func compatible(a, b *State) (diff string, ok bool) {
	names := map[string]bool{}
	for n := range a.syms {
		names[n] = true
	}
	for n := range b.syms {
		names[n] = true
	}
	sorted := make([]string, 0, len(names))
	for n := range names {
		sorted = append(sorted, n)
	}
	sort.Strings(sorted)
	for _, n := range sorted {
		x, y := a.get(n), b.get(n)
		if x.Live != y.Live {
			return fmt.Sprintf("symbol %q live in one branch only", n), false
		}
		if !x.Live {
			continue
		}
		if x.Kind != y.Kind {
			return fmt.Sprintf("symbol %q is %s in one branch, %s in the other", n, x.Kind, y.Kind), false
		}
		if x.Target != y.Target {
			return fmt.Sprintf("symbol %q borrows %q in one branch, %q in the other", n, x.Target, y.Target), false
		}
	}
	return "", true
}
