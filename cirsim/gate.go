package cirsim

// Op identifies a gate's logic function. Truth tables are public and fixed;
// see the package documentation and Eval for the exact semantics.
type Op int

const (
	Buf Op = iota
	Not
	And
	Or
	Xor
	Nand
	Nor
	Xnor
)

// String returns the gate name.
func (op Op) String() string {
	switch op {
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

// notTable is the public NOT truth table. Z is treated as unknown.
var notTable = [4]Value{One, Zero, X, X}

// andTable/orTable/xorTable are the public binary truth tables, indexed by
// [a][b] with the order 0,1,X,Z. Z is treated as unknown (conservative).
var andTable = [4][4]Value{
	{Zero, Zero, Zero, Zero},
	{Zero, One, X, X},
	{Zero, X, X, X},
	{Zero, X, X, X},
}

var orTable = [4][4]Value{
	{Zero, One, X, X},
	{One, One, One, One},
	{X, One, X, X},
	{X, One, X, X},
}

var xorTable = [4][4]Value{
	{Zero, One, X, X},
	{One, Zero, X, X},
	{X, X, X, X},
	{X, X, X, X},
}

func idx(v Value) int {
	switch v {
	case Zero:
		return 0
	case One:
		return 1
	case X:
		return 2
	default: // Z
		return 3
	}
}

func invert(v Value) Value { return notTable[idx(v)] }

// Eval applies a gate's public truth table to its inputs.
// Unary gates (Buf, Not) use in[0]; the rest are n-ary (n >= 1).
func Eval(op Op, in []Value) Value {
	switch op {
	case Buf:
		if in[0] == Z {
			return X
		}
		return in[0]
	case Not:
		return notTable[idx(in[0])]
	case And, Nand:
		v := andTable[idx(in[0])][idx(in[1])]
		for _, w := range in[2:] {
			v = andTable[idx(v)][idx(w)]
		}
		if op == Nand {
			return invert(v)
		}
		return v
	case Or, Nor:
		v := orTable[idx(in[0])][idx(in[1])]
		for _, w := range in[2:] {
			v = orTable[idx(v)][idx(w)]
		}
		if op == Nor {
			return invert(v)
		}
		return v
	default: // Xor, Xnor
		v := xorTable[idx(in[0])][idx(in[1])]
		for _, w := range in[2:] {
			v = xorTable[idx(v)][idx(w)]
		}
		if op == Xnor {
			return invert(v)
		}
		return v
	}
}
