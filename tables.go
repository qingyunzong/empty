package circsim

// Public gate truth tables. Binary tables are indexed [a][b] using the
// Value constants (Zero, One, X, Z) as indices. Gate evaluation uses
// exactly these tables, so the tables fully define gate semantics.

var NotTable = [4]Value{One, Zero, X, X}
var BufTable = [4]Value{Zero, One, X, X}

func and2(a, b Value) Value {
	if a == Zero || b == Zero {
		return Zero
	}
	if a == One && b == One {
		return One
	}
	return X
}

func or2(a, b Value) Value {
	if a == One || b == One {
		return One
	}
	if a == Zero && b == Zero {
		return Zero
	}
	return X
}

func xor2(a, b Value) Value {
	if a <= One && b <= One {
		if a != b {
			return One
		}
		return Zero
	}
	return X
}

func table2(f func(a, b Value) Value) [4][4]Value {
	var t [4][4]Value
	for a := Zero; a <= Z; a++ {
		for b := Zero; b <= Z; b++ {
			t[a][b] = f(a, b)
		}
	}
	return t
}

var AndTable = table2(and2)
var OrTable = table2(or2)
var XorTable = table2(xor2)
var NandTable = table2(func(a, b Value) Value { return NotTable[and2(a, b)] })
var NorTable = table2(func(a, b Value) Value { return NotTable[or2(a, b)] })
var XnorTable = table2(func(a, b Value) Value { return NotTable[xor2(a, b)] })
