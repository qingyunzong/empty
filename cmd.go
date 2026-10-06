// Package linearchk checks programs of linear commands for borrow-rule
// violations: shared vs. exclusive borrows, aliasing during an exclusive
// borrow, borrows that outlive their owner, and incompatible branch merges.
package linearchk

import "fmt"

// Kind classifies a symbol.
type Kind int

const (
	// Owner is a value that owns a resource.
	Owner Kind = iota
	// Shared is a shared borrow (&T); any number may coexist.
	Shared
	// Exclusive is an exclusive borrow (&mut T); it forbids any
	// other access to the resource while live.
	Exclusive
)

func (k Kind) String() string {
	switch k {
	case Owner:
		return "owner"
	case Shared:
		return "shared"
	case Exclusive:
		return "exclusive"
	}
	return "unknown"
}

// Cmd is a single linear command.
type Cmd interface{ cmd() }

// New creates a fresh owner: new x
type New struct{ Name string }

// Share creates a shared borrow: share r = &x
type Share struct{ Borrow, Owner string }

// Excl creates an exclusive borrow: excl m = &mut x
type Excl struct{ Borrow, Owner string }

// Use reads through a name: use x
type Use struct{ Name string }

// Mut writes through a name: mut x
type Mut struct{ Name string }

// Move transfers an owner or a borrow: move y = x
type Move struct{ Dst, Src string }

// Drop ends a lifetime: drop x
type Drop struct{ Name string }

// If runs one of two branches; their exit states must merge compatibly.
type If struct {
	Then []Cmd
	Else []Cmd
}

func (New) cmd()   {}
func (Share) cmd() {}
func (Excl) cmd()  {}
func (Use) cmd()   {}
func (Mut) cmd()   {}
func (Move) cmd()  {}
func (Drop) cmd()  {}
func (If) cmd()    {}

// CmdString renders a command in source form.
func CmdString(c Cmd) string {
	switch c := c.(type) {
	case New:
		return "new " + c.Name
	case Share:
		return fmt.Sprintf("share %s = &%s", c.Borrow, c.Owner)
	case Excl:
		return fmt.Sprintf("excl %s = &mut %s", c.Borrow, c.Owner)
	case Use:
		return "use " + c.Name
	case Mut:
		return "mut " + c.Name
	case Move:
		return fmt.Sprintf("move %s = %s", c.Dst, c.Src)
	case Drop:
		return "drop " + c.Name
	case If:
		return "if"
	}
	return "?"
}
