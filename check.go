package linearck

import (
	"fmt"
	"strings"
)

// Violation rules reported by Check and Reference.
const (
	RuleRedeclare              = "redeclare"                // name already live
	RuleBorrowOfDead           = "borrow-of-dead"           // borrow of unknown/dead owner
	RuleShareDuringExclusive   = "share-during-exclusive"   // &x while &mut x active
	RuleExclusiveWhileBorrowed = "exclusive-while-borrowed" // &mut x while any borrow active
	RuleAliasDuringExclusive   = "alias-during-exclusive"   // owner touched while &mut active
	RuleUseOfUnknown           = "use-of-unknown"           // access of unknown name
	RuleUseAfterMove           = "use-after-move"           // borrow used after transfer
	RuleBorrowOutlivesOwner    = "borrow-outlives-owner"    // borrow alive past its owner
	RuleWriteWhileBorrowed     = "write-while-borrowed"     // owner written while borrowed
	RuleWriteThroughShared     = "write-through-shared"     // write through a shared borrow
	RuleMoveOfInvalid          = "move-of-invalid"          // transfer of a non-live borrow
	RuleEndOfInvalid           = "end-of-invalid"           // end of a non-live borrow
	RuleDropOfUnknown          = "drop-of-unknown"          // drop of unknown/dead owner
	RuleMergeIncompatible      = "merge-incompatible"       // branches join with different states
)

// Step is one hop of an execution path: a block entry (Index == -1) or
// the command at Index within Block.
type Step struct {
	Block string
	Index int
}

func (s Step) String() string {
	if s.Index < 0 {
		return s.Block
	}
	return fmt.Sprintf("%s[%d]", s.Block, s.Index)
}

// Path is the sequence of steps leading to a point in the program.
type Path []Step

func (p Path) String() string {
	parts := make([]string, len(p))
	for i, s := range p {
		parts[i] = s.String()
	}
	return strings.Join(parts, " -> ")
}

// Violation describes one broken rule together with the offending path.
// For RuleMergeIncompatible, Path and Other are the two conflicting
// executions that reach At.Block with different borrow states.
type Violation struct {
	Rule  string
	Cmd   string // offending command text (empty for merge violations)
	At    Step
	Path  Path
	Other Path
}

func (v Violation) String() string {
	if v.Rule == RuleMergeIncompatible {
		return fmt.Sprintf("%s: block %s entered with incompatible borrow states\n  path A: %s\n  path B: %s",
			v.Rule, v.At.Block, v.Path, v.Other)
	}
	return fmt.Sprintf("%s: %s at %s\n  path: %s", v.Rule, v.Cmd, v.At, v.Path)
}

// Block is a straight-line command sequence with explicit successors.
// Zero successors means exit; two successors model a branch.
type Block struct {
	Name string
	Cmds []Cmd
	Next []string
}

// Program is a finite control-flow graph of linear commands.
type Program struct {
	Entry  string
	Blocks map[string]*Block
}

// Validate checks the structural well-formedness of the graph.
func (p *Program) Validate() error {
	if p == nil || p.Blocks[p.Entry] == nil {
		return fmt.Errorf("linearck: missing entry block %q", p.Entry)
	}
	for _, b := range p.Blocks {
		for _, n := range b.Next {
			if p.Blocks[n] == nil {
				return fmt.Errorf("linearck: block %q jumps to unknown block %q", b.Name, n)
			}
		}
	}
	return nil
}

// Check runs the borrow checker over the finite command-state machine of
// p and returns every violation, each carrying the path that triggers it.
//
// The analysis explores (block, state) pairs, so it terminates: for a
// finite program the borrow state space is finite. Whenever a block is
// reached with a state that differs from the state first seen there, the
// branches feeding that block are incompatible and a merge violation is
// reported with both paths; exploration continues so later command
// violations are still found.
func Check(p *Program) ([]Violation, error) {
	if err := p.Validate(); err != nil {
		return nil, err
	}
	type item struct {
		block string
		state *State
		path  Path
	}
	var violations []Violation
	seen := map[string]bool{}
	firstKey := map[string]string{}
	firstPath := map[string]Path{}
	queue := []item{{p.Entry, NewState(), Path{{Block: p.Entry, Index: -1}}}}
	for len(queue) > 0 {
		it := queue[0]
		queue = queue[1:]
		key := it.state.key()
		id := it.block + "\x00" + key
		if seen[id] {
			continue
		}
		seen[id] = true
		if fk, ok := firstKey[it.block]; ok && fk != key {
			violations = append(violations, Violation{
				Rule:  RuleMergeIncompatible,
				At:    Step{Block: it.block, Index: -1},
				Path:  it.path,
				Other: firstPath[it.block],
			})
		} else if !ok {
			firstKey[it.block] = key
			firstPath[it.block] = it.path
		}
		b := p.Blocks[it.block]
		st := it.state
		path := it.path
		for i, c := range b.Cmds {
			if v := c.exec(st); v != nil {
				v.Cmd = c.String()
				v.At = Step{Block: b.Name, Index: i}
				v.Path = append(append(Path{}, path...), Step{Block: b.Name, Index: i})
				violations = append(violations, *v)
			}
			path = append(path, Step{Block: b.Name, Index: i})
		}
		for _, nxt := range b.Next {
			nextPath := append(append(Path{}, path...), Step{Block: nxt, Index: -1})
			queue = append(queue, item{nxt, st.Clone(), nextPath})
		}
	}
	return violations, nil
}
