// Package rescheck implements a checker for a simplified imperative IR.
// Resources must be consumed exactly once after creation; moving a
// resource invalidates the source variable; exceptional exits (Throw)
// must also consume every live resource.
package rescheck

// Stmt is a node of the simplified program IR.
type Stmt interface{ stmtNode() }

// New creates a fresh resource bound to Name.
type New struct{ Name string }

// Move transfers the resource from Src to Dst; Src becomes invalid.
type Move struct{ Dst, Src string }

// Consume consumes the resource held by Name (exactly once required).
type Consume struct{ Name string }

// Seq runs statements in order.
type Seq []Stmt

// If non-deterministically takes Then or Else (both are explored).
type If struct {
	Then, Else Stmt
}

// While runs Body zero or more times (non-deterministic exit).
type While struct{ Body Stmt }

// Throw is an exceptional exit: every live resource must already be
// consumed; control does not continue after it.
type Throw struct{}

func (New) stmtNode()     {}
func (Move) stmtNode()    {}
func (Consume) stmtNode() {}
func (Seq) stmtNode()     {}
func (If) stmtNode()      {}
func (While) stmtNode()   {}
func (Throw) stmtNode()   {}
