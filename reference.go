package linearck

import (
	"fmt"
	"sort"
	"strings"
)

// Reference is an independent implementation used to verify Check: it
// enumerates the finite (block, state) machine exhaustively, depth-first,
// with its own state encoding and no merge reasoning, and reports every
// command violation it reaches. Because the command/state space is
// finite, the enumeration is a complete reference model of the program.
func Reference(p *Program) ([]Violation, error) {
	if err := p.Validate(); err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	var out []Violation
	var visit func(block string, s *State)
	visit = func(block string, s *State) {
		id := block + "|" + refKey(s)
		if seen[id] {
			return
		}
		seen[id] = true
		b := p.Blocks[block]
		st := s
		for i, c := range b.Cmds {
			if v := c.exec(st); v != nil {
				v.Cmd = c.String()
				v.At = Step{Block: block, Index: i}
				out = append(out, *v)
			}
		}
		for _, n := range b.Next {
			visit(n, st.Clone())
		}
	}
	visit(p.Entry, NewState())
	return out, nil
}

// refKey is the reference machine's own state encoding, deliberately
// written independently of State.key.
func refKey(s *State) string {
	vars := make([]string, 0, len(s.vars))
	for v := range s.vars {
		vars = append(vars, v)
	}
	sort.Strings(vars)
	refs := make([]string, 0, len(s.refs))
	for n, r := range s.refs {
		refs = append(refs, fmt.Sprintf("%s>%s:%v:%v", n, r.owner, r.kind, r.moved))
	}
	sort.Strings(refs)
	return strings.Join(vars, ",") + "#" + strings.Join(refs, ",")
}

// Snapshot is one reachable block-entry state of the finite machine.
type Snapshot struct {
	Block string
	State *State
}

// Enumerate lists every reachable (block, state) pair of the program.
func Enumerate(p *Program) ([]Snapshot, error) {
	if err := p.Validate(); err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	var out []Snapshot
	var visit func(block string, s *State)
	visit = func(block string, s *State) {
		id := block + "|" + refKey(s)
		if seen[id] {
			return
		}
		seen[id] = true
		out = append(out, Snapshot{Block: block, State: s.Clone()})
		b := p.Blocks[block]
		st := s
		for _, c := range b.Cmds {
			_ = c.exec(st)
		}
		for _, n := range b.Next {
			visit(n, st.Clone())
		}
	}
	visit(p.Entry, NewState())
	return out, nil
}

// refStatuses is an independent implementation of the finite status
// enumeration, derived by counting live borrows per owner. Tests compare
// it against State.StatusOf on every reachable state.
func refStatuses(s *State) map[string]Status {
	owners := map[string]bool{}
	for v := range s.vars {
		owners[v] = true
	}
	shared := map[string]int{}
	exclusive := map[string]int{}
	for _, r := range s.refs {
		if r.moved {
			continue
		}
		owners[r.owner] = true
		if r.kind == Exclusive {
			exclusive[r.owner]++
		} else {
			shared[r.owner]++
		}
	}
	out := map[string]Status{}
	for o := range owners {
		switch {
		case !s.vars[o]:
			out[o] = Dead
		case exclusive[o] > 0:
			out[o] = MutBorrowed
		case shared[o] > 0:
			out[o] = Lent
		default:
			out[o] = Owned
		}
	}
	return out
}

// Replay follows a reported path through the machine and returns every
// violation encountered along it. It validates that a path emitted by
// Check is feasible and really triggers the reported rule.
func Replay(p *Program, path Path) ([]Violation, error) {
	if err := p.Validate(); err != nil {
		return nil, err
	}
	if len(path) == 0 || path[0].Index != -1 || path[0].Block != p.Entry {
		return nil, fmt.Errorf("linearck: path must start at entry block %q", p.Entry)
	}
	var out []Violation
	st := NewState()
	cur := p.Entry
	nextCmd := 0
	for _, step := range path[1:] {
		if step.Index == -1 {
			ok := false
			for _, n := range p.Blocks[cur].Next {
				if n == step.Block {
					ok = true
				}
			}
			if !ok {
				return nil, fmt.Errorf("linearck: block %q is not a successor of %q", step.Block, cur)
			}
			cur = step.Block
			nextCmd = 0
			continue
		}
		b := p.Blocks[cur]
		if step.Index != nextCmd || step.Index >= len(b.Cmds) {
			return nil, fmt.Errorf("linearck: expected command %d in block %q, got step %s", nextCmd, cur, step)
		}
		c := b.Cmds[step.Index]
		if v := c.exec(st); v != nil {
			v.Cmd = c.String()
			v.At = step
			out = append(out, *v)
		}
		nextCmd++
	}
	return out, nil
}
