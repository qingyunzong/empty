// Package rescheck implements a static checker for a tiny imperative IR.
//
// Resource protocol: a resource created by `new x` must be consumed by
// `use x` exactly once on every execution path, including exceptional
// (panic) exits. `move y = x` transfers ownership: x becomes invalid
// (moved) and y becomes the live handle.
package rescheck

// OpKind is the instruction opcode.
type OpKind int

const (
	OpNew    OpKind = iota // new x        : create resource bound to x
	OpUse                  // use x        : consume the resource in x
	OpMove                 // move dst=src : transfer ownership, src becomes invalid
	OpReturn               // return       : normal exit, no live resource allowed
	OpPanic                // panic        : exceptional exit, no live resource allowed
)

// Instr is a single IR instruction. Dst holds the operand for New/Use and
// the move target for Move; Src is the move source.
type Instr struct {
	Op  OpKind
	Dst string
	Src string
}

// Instruction constructors.
func New(v string) Instr         { return Instr{Op: OpNew, Dst: v} }
func Use(v string) Instr         { return Instr{Op: OpUse, Dst: v} }
func Move(dst, src string) Instr { return Instr{Op: OpMove, Dst: dst, Src: src} }
func Ret() Instr                 { return Instr{Op: OpReturn} }
func Panic() Instr               { return Instr{Op: OpPanic} }

// Block is a basic block: a label, a straight-line instruction sequence,
// and successor edges (branch targets or a loop back edge).
type Block struct {
	Label  string
	Instrs []Instr
	Succs  []*Block
	preds  []*Block
}

// Program is a CFG. The first block added is the entry block.
type Program struct {
	Entry     *Block
	Blocks    []*Block
	finalized bool
}

// NewProgram returns an empty program.
func NewProgram() *Program { return &Program{} }

// Block appends a new basic block to the program.
func (p *Program) Block(label string, instrs ...Instr) *Block {
	b := &Block{Label: label, Instrs: instrs}
	p.Blocks = append(p.Blocks, b)
	if p.Entry == nil {
		p.Entry = b
	}
	return b
}

// Link adds a control-flow edge from -> to.
func Link(from, to *Block) { from.Succs = append(from.Succs, to) }

// Finalize computes predecessor lists. It is idempotent and is called
// automatically by the analyses.
func (p *Program) Finalize() {
	if p.finalized {
		return
	}
	for _, b := range p.Blocks {
		for _, s := range b.Succs {
			s.preds = append(s.preds, b)
		}
	}
	p.finalized = true
}
