package linearck

import "fmt"

// Kind classifies a borrow: shared (many readers) or exclusive (one writer).
type Kind int

const (
	Shared Kind = iota
	Exclusive
)

func (k Kind) String() string {
	if k == Exclusive {
		return "exclusive"
	}
	return "shared"
}

// Cmd is a single linear command. exec applies the command to s and
// returns a Violation when a borrow rule is broken. On violation the
// command has no effect (except Drop, which always drops), so analysis
// can continue deterministically past the offending command.
type Cmd interface {
	String() string
	exec(s *State) *Violation
}

// New declares a fresh owner: new x
type New struct{ Name string }

func (c New) String() string { return "new " + c.Name }

func (c New) exec(s *State) *Violation {
	if s.vars[c.Name] {
		return &Violation{Rule: RuleRedeclare}
	}
	if r, ok := s.refs[c.Name]; ok && !r.moved {
		return &Violation{Rule: RuleRedeclare}
	}
	delete(s.refs, c.Name)
	s.vars[c.Name] = true
	return nil
}

// Share creates a shared borrow: share r = &x
type Share struct{ Ref, Owner string }

func (c Share) String() string { return fmt.Sprintf("share %s = &%s", c.Ref, c.Owner) }

func (c Share) exec(s *State) *Violation {
	if !s.vars[c.Owner] {
		return &Violation{Rule: RuleBorrowOfDead}
	}
	if _, ok := s.exclusiveOn(c.Owner); ok {
		return &Violation{Rule: RuleShareDuringExclusive}
	}
	if v := checkFresh(s, c.Ref); v != nil {
		return v
	}
	s.refs[c.Ref] = refInfo{owner: c.Owner, kind: Shared}
	return nil
}

// Mut creates an exclusive borrow: mut m = &mut x
type Mut struct{ Ref, Owner string }

func (c Mut) String() string { return fmt.Sprintf("mut %s = &mut %s", c.Ref, c.Owner) }

func (c Mut) exec(s *State) *Violation {
	if !s.vars[c.Owner] {
		return &Violation{Rule: RuleBorrowOfDead}
	}
	if len(s.borrowsOf(c.Owner)) > 0 {
		return &Violation{Rule: RuleExclusiveWhileBorrowed}
	}
	if v := checkFresh(s, c.Ref); v != nil {
		return v
	}
	s.refs[c.Ref] = refInfo{owner: c.Owner, kind: Exclusive}
	return nil
}

// Use reads through an owner or a reference: use n
type Use struct{ Name string }

func (c Use) String() string { return "use " + c.Name }

func (c Use) exec(s *State) *Violation {
	if s.vars[c.Name] {
		if _, ok := s.exclusiveOn(c.Name); ok {
			return &Violation{Rule: RuleAliasDuringExclusive}
		}
		return nil
	}
	if r, ok := s.refs[c.Name]; ok {
		if r.moved {
			return &Violation{Rule: RuleUseAfterMove}
		}
		if !s.vars[r.owner] {
			return &Violation{Rule: RuleBorrowOutlivesOwner}
		}
		return nil
	}
	return &Violation{Rule: RuleUseOfUnknown}
}

// Write mutates through an owner or a reference: write n
type Write struct{ Name string }

func (c Write) String() string { return "write " + c.Name }

func (c Write) exec(s *State) *Violation {
	if s.vars[c.Name] {
		if len(s.borrowsOf(c.Name)) > 0 {
			return &Violation{Rule: RuleWriteWhileBorrowed}
		}
		return nil
	}
	if r, ok := s.refs[c.Name]; ok {
		if r.moved {
			return &Violation{Rule: RuleUseAfterMove}
		}
		if !s.vars[r.owner] {
			return &Violation{Rule: RuleBorrowOutlivesOwner}
		}
		if r.kind != Exclusive {
			return &Violation{Rule: RuleWriteThroughShared}
		}
		return nil
	}
	return &Violation{Rule: RuleUseOfUnknown}
}

// Move transfers a borrow to a fresh name: move d = s
// The source name becomes invalid; the borrow itself keeps living.
type Move struct{ Dst, Src string }

func (c Move) String() string { return fmt.Sprintf("move %s = %s", c.Dst, c.Src) }

func (c Move) exec(s *State) *Violation {
	r, ok := s.refs[c.Src]
	if !ok || r.moved {
		return &Violation{Rule: RuleMoveOfInvalid}
	}
	if v := checkFresh(s, c.Dst); v != nil {
		return v
	}
	s.refs[c.Src] = refInfo{owner: r.owner, kind: r.kind, moved: true}
	s.refs[c.Dst] = r
	return nil
}

// End terminates a borrow: end r
type End struct{ Ref string }

func (c End) String() string { return "end " + c.Ref }

func (c End) exec(s *State) *Violation {
	r, ok := s.refs[c.Ref]
	if !ok || r.moved {
		return &Violation{Rule: RuleEndOfInvalid}
	}
	delete(s.refs, c.Ref)
	return nil
}

// Drop retires an owner: drop x. Any borrow still alive on x outlives
// its owner, which is reported; the owner is dropped regardless and the
// dangling references remain so later misuse is also reported.
type Drop struct{ Owner string }

func (c Drop) String() string { return "drop " + c.Owner }

func (c Drop) exec(s *State) *Violation {
	if !s.vars[c.Owner] {
		return &Violation{Rule: RuleDropOfUnknown}
	}
	delete(s.vars, c.Owner)
	if len(s.borrowsOf(c.Owner)) > 0 {
		return &Violation{Rule: RuleBorrowOutlivesOwner}
	}
	return nil
}

// checkFresh enforces that a newly introduced name is not already live.
func checkFresh(s *State, name string) *Violation {
	if s.vars[name] {
		return &Violation{Rule: RuleRedeclare}
	}
	if r, ok := s.refs[name]; ok && !r.moved {
		return &Violation{Rule: RuleRedeclare}
	}
	return nil
}
