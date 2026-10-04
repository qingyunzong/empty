package cirsim

import (
	"fmt"
	"testing"
)

var allValues = []Value{Zero, One, X, Z}

func TestPublicGateTables(t *testing.T) {
	// Unary tables.
	wantNot := map[Value]Value{Zero: One, One: Zero, X: X, Z: X}
	wantBuf := map[Value]Value{Zero: Zero, One: One, X: X, Z: X}
	for _, v := range allValues {
		if got := Eval(Not, []Value{v}); got != wantNot[v] {
			t.Errorf("NOT %s = %s, want %s", v, got, wantNot[v])
		}
		if got := Eval(Buf, []Value{v}); got != wantBuf[v] {
			t.Errorf("BUF %s = %s, want %s", v, got, wantBuf[v])
		}
	}

	// Binary tables, derived from first principles.
	var want func(Op, Value, Value) Value
	want = func(op Op, a, b Value) Value {
		unk := a == X || a == Z || b == X || b == Z
		bit := func(v Value) int {
			if v == One {
				return 1
			}
			return 0
		}
		switch op {
		case And:
			if a == Zero || b == Zero {
				return Zero
			}
			if unk {
				return X
			}
			return One
		case Or:
			if a == One || b == One {
				return One
			}
			if unk {
				return X
			}
			return Zero
		case Xor:
			if unk {
				return X
			}
			if bit(a)^bit(b) == 1 {
				return One
			}
			return Zero
		case Nand:
			return Eval(Not, []Value{want(And, a, b)})
		case Nor:
			return Eval(Not, []Value{want(Or, a, b)})
		case Xnor:
			return Eval(Not, []Value{want(Xor, a, b)})
		}
		panic("bad op")
	}
	for _, op := range []Op{And, Or, Xor, Nand, Nor, Xnor} {
		for _, a := range allValues {
			for _, b := range allValues {
				if got := Eval(op, []Value{a, b}); got != want(op, a, b) {
					t.Errorf("%s %s %s = %s, want %s", a, op, b, got, want(op, a, b))
				}
			}
		}
	}

	// Spot checks for Z handling.
	if got := Eval(And, []Value{Zero, Z}); got != Zero {
		t.Errorf("AND 0 Z = %s, want 0", got)
	}
	if got := Eval(Or, []Value{One, Z}); got != One {
		t.Errorf("OR 1 Z = %s, want 1", got)
	}
	if got := Eval(Xor, []Value{One, Z}); got != X {
		t.Errorf("XOR 1 Z = %s, want X", got)
	}
}

// halfAdder builds sum = a^b, carry = a&b.
func halfAdder() (*Circuit, int, int, int, int) {
	c := NewCircuit()
	a := c.AddInput()
	b := c.AddInput()
	sum := c.AddGate(Xor, a, b)
	carry := c.AddGate(And, a, b)
	return c, a, b, sum, carry
}

func TestConvergedStableValues(t *testing.T) {
	c, _, _, sum, carry := halfAdder()
	cases := []struct {
		a, b       Value
		sum, carry Value
	}{
		{Zero, Zero, Zero, Zero},
		{Zero, One, One, Zero},
		{One, One, Zero, One},
		{One, X, X, X},
		{Zero, Z, X, Zero},
	}
	for _, tc := range cases {
		r := c.FullSimulate([]Value{tc.a, tc.b}, 64)
		if r.Kind != Converged {
			t.Fatalf("a=%s b=%s: got %s, want converged", tc.a, tc.b, r.Kind)
		}
		if r.State[sum] != tc.sum || r.State[carry] != tc.carry {
			t.Errorf("a=%s b=%s: sum=%s carry=%s, want sum=%s carry=%s",
				tc.a, tc.b, r.State[sum], r.State[carry], tc.sum, tc.carry)
		}
	}
}

func TestCycleWitness(t *testing.T) {
	// Two-inverter ring: a = NOT b, b = NOT a. From (0,0) it oscillates
	// (0,0) -> (1,1) -> (0,0) with period 2.
	c := NewCircuit()
	a := c.AddGate(Not, 1)
	b := c.AddGate(Not, 0)
	_ = b
	r := c.Simulate([]Value{Zero, Zero}, 64)
	if r.Kind != Cycle {
		t.Fatalf("got %s, want cycle", r.Kind)
	}
	if r.Period != 2 {
		t.Errorf("period = %d, want 2", r.Period)
	}
	// The witness state must actually recur after Period rounds.
	state := append([]Value(nil), r.State...)
	for i := 0; i < r.Period; i++ {
		state = c.step(state)
	}
	if !equal(state, r.State) {
		t.Errorf("witness %v does not recur after %d rounds: got %v", r.State, r.Period, state)
	}

	// Same ring from a fixed point converges instead.
	r = c.Simulate([]Value{Zero, One}, 64)
	if r.Kind != Converged {
		t.Fatalf("got %s, want converged", r.Kind)
	}
	if r.State[a] != Zero {
		t.Errorf("node a = %s, want 0", r.State[a])
	}
}

func TestBudgetExhausted(t *testing.T) {
	c := NewCircuit()
	c.AddGate(Not, 1)
	c.AddGate(Not, 0)
	r := c.Simulate([]Value{Zero, Zero}, 1)
	if r.Kind != Undecided {
		t.Fatalf("got %s, want undecided", r.Kind)
	}
	if r.Rounds != 1 {
		t.Errorf("rounds = %d, want 1", r.Rounds)
	}
}

// nandLatch builds an SR latch: q = NAND(s, qb), qb = NAND(r, q).
func nandLatch() (*Circuit, int, int, int, int) {
	c := NewCircuit()
	s := c.AddInput()
	r := c.AddInput()
	q := c.AddGate(Nand, s, 3)
	qb := c.AddGate(Nand, r, 2)
	return c, s, r, q, qb
}

func TestLatchFeedbackConverges(t *testing.T) {
	c, s, r, q, qb := nandLatch()
	_ = s
	_ = r
	res := c.FullSimulate([]Value{Zero, One}, 64) // set
	if res.Kind != Converged {
		t.Fatalf("got %s, want converged", res.Kind)
	}
	if res.State[q] != One || res.State[qb] != Zero {
		t.Errorf("set: q=%s qb=%s, want q=1 qb=0", res.State[q], res.State[qb])
	}
	res = c.FullSimulate([]Value{One, Zero}, 64) // reset
	if res.State[q] != Zero || res.State[qb] != One {
		t.Errorf("reset: q=%s qb=%s, want q=0 qb=1", res.State[q], res.State[qb])
	}
}

// rippleAdder builds an n-bit ripple-carry adder with carry-in 0.
func rippleAdder(n int) (*Circuit, []int, []int, []int) {
	c := NewCircuit()
	as := make([]int, n)
	bs := make([]int, n)
	sums := make([]int, n)
	for i := 0; i < n; i++ {
		as[i] = c.AddInput()
	}
	for i := 0; i < n; i++ {
		bs[i] = c.AddInput()
	}
	carry := c.AddInput() // carry-in
	for i := 0; i < n; i++ {
		x1 := c.AddGate(Xor, as[i], bs[i])
		sums[i] = c.AddGate(Xor, x1, carry)
		a1 := c.AddGate(And, as[i], bs[i])
		a2 := c.AddGate(And, x1, carry)
		carry = c.AddGate(Or, a1, a2)
	}
	return c, as, bs, sums
}

func TestIncrementalMatchesFull(t *testing.T) {
	c, as, bs, sums := rippleAdder(3)
	const budget = 256

	// Enumerate every input vector over {0,1} for a, b (carry-in fixed 0).
	vectors := [][]Value{}
	for bits := 0; bits < 1<<6; bits++ {
		v := make([]Value, 7)
		for i := range v {
			v[i] = Zero
		}
		for i := 0; i < 6; i++ {
			if bits&(1<<i) != 0 {
				v[i] = One
			} else {
				v[i] = Zero
			}
		}
		vectors = append(vectors, v)
	}

	full := make([]Result, len(vectors))
	stable := make([][]Value, len(vectors))
	for i, v := range vectors {
		full[i] = c.FullSimulate(v, budget)
		if full[i].Kind != Converged {
			t.Fatalf("vector %v: full sim got %s, want converged", v, full[i].Kind)
		}
		stable[i] = full[i].State
		// Check arithmetic: sum bits must equal (a + b) mod 8.
		aVal, bVal, sVal := 0, 0, 0
		for b := 0; b < 3; b++ {
			if v[as[b]] == One {
				aVal |= 1 << b
			}
			if v[bs[b]] == One {
				bVal |= 1 << b
			}
			if full[i].State[sums[b]] == One {
				sVal |= 1 << b
			}
		}
		if sVal != (aVal+bVal)%8 {
			t.Errorf("vector %v: sum=%d, want %d", v, sVal, (aVal+bVal)%8)
		}
	}

	// For every single-input change (and every vector pair), warm-start
	// from the previous stable state and cross-check against full iteration.
	for i, from := range vectors {
		for j, to := range vectors {
			if i == j {
				continue
			}
			inc := c.IncrementalSimulate(stable[i], to, budget)
			if inc.Kind != full[j].Kind {
				t.Fatalf("from %v to %v: incremental %s vs full %s",
					from, to, inc.Kind, full[j].Kind)
			}
			if !equal(inc.State, full[j].State) {
				t.Errorf("from %v to %v: incremental state %v != full state %v",
					from, to, inc.State, full[j].State)
			}
		}
	}
}

func TestIncrementalMatchesFullWithFeedback(t *testing.T) {
	// NAND latch: for determined input combinations the fixpoint is unique,
	// so warm-started incremental runs must match cold full iterations.
	c, _, _, q, qb := nandLatch()
	inputs := [][]Value{
		{Zero, One}, {One, Zero}, {Zero, Zero},
	}
	const budget = 64
	var prev []Value
	for i, in := range inputs {
		full := c.FullSimulate(in, budget)
		if full.Kind != Converged {
			t.Fatalf("inputs %v: got %s, want converged", in, full.Kind)
		}
		if i > 0 {
			inc := c.IncrementalSimulate(prev, in, budget)
			if inc.Kind != full.Kind || !equal(inc.State, full.State) {
				t.Errorf("inputs %v: incremental (%s,%v) != full (%s,%v)",
					in, inc.Kind, inc.State, full.Kind, full.State)
			}
		}
		if full.State[q] == full.State[qb] && in[0] != Zero {
			t.Errorf("inputs %v: q and qb both %s", in, full.State[q])
		}
		prev = full.State
	}
}

func ExampleCircuit_Simulate() {
	c := NewCircuit()
	in := c.AddInput()
	out := c.AddGate(Not, in)
	r := c.FullSimulate([]Value{One}, 16)
	fmt.Printf("%s out=%s rounds=%d\n", r.Kind, r.State[out], r.Rounds)
	// Output: converged out=0 rounds=2
}
