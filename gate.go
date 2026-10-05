package circsim

// GateKind identifies a gate type. Evaluation semantics come from the
// public truth tables in tables.go.
type GateKind int

const (
	Buf GateKind = iota
	Not
	And
	Or
	Xor
	Nand
	Nor
	Xnor
)

func (k GateKind) String() string {
	switch k {
	case Buf:
		return "BUF"
	case Not:
		return "NOT"
	case And:
		return "AND"
	case Or:
		return "OR"
	case Xor:
		return "XOR"
	case Nand:
		return "NAND"
	case Nor:
		return "NOR"
	case Xnor:
		return "XNOR"
	}
	return "?"
}

// Arity reports how many input nets the gate kind takes.
func (k GateKind) Arity() int {
	switch k {
	case Buf, Not:
		return 1
	default:
		return 2
	}
}

// Eval applies the public truth table for the gate kind.
func (k GateKind) Eval(in []Value) Value {
	switch k {
	case Buf:
		return BufTable[in[0]]
	case Not:
		return NotTable[in[0]]
	case And:
		return AndTable[in[0]][in[1]]
	case Or:
		return OrTable[in[0]][in[1]]
	case Xor:
		return XorTable[in[0]][in[1]]
	case Nand:
		return NandTable[in[0]][in[1]]
	case Nor:
		return NorTable[in[0]][in[1]]
	case Xnor:
		return XnorTable[in[0]][in[1]]
	}
	return X
}
