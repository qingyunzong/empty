package circsim

import (
	"math/rand"
	"testing"
)

func valuesString(vs []Value) string {
	s := ""
	for _, v := range vs {
		s += v.String()
	}
	return s
}

func assertState(t *testing.T, got []Value, want ...Value) {
	t.Helper()
	if !statesEqual(got, want) {
		t.Fatalf("state = %s, want %s", valuesString(got), valuesString(want))
	}
}

func TestResolve(t *testing.T) {
	for _, v := range []Value{Zero, One, X, Z} {
		if got := Resolve(Z, v); got != v {
			t.Errorf("Resolve(Z, %v) = %v", v, got)
		}
		if got := Resolve(v, Z); got != v {
			t.Errorf("Resolve(%v, Z) = %v", v, got)
		}
		if got := Resolve(v, v); got != v {
			t.Errorf("Resolve(%v, %v) = %v", v, v, got)
		}
	}
	if got := Resolve(Zero, One); got != X {
		t.Errorf("Resolve(0, 1) = %v, want X", got)
	}
	if got := Resolve(One, Zero); got != X {
		t.Errorf("Resolve(1, 0) = %v, want X", got)
	}
	if got := Resolve(X, One); got != X {
		t.Errorf("Resolve(X, 1) = %v, want X", got)
	}
}

func TestPublicTables(t *testing.T) {
	// Spot-check defining entries.
	if NotTable[Zero] != One || NotTable[One] != Zero || NotTable[X] != X || NotTable[Z] != X {
		t.Errorf("bad NotTable: %v", NotTable)
	}
	if AndTable[Zero][X] != Zero || AndTable[One][One] != One || AndTable[One][Z] != X {
		t.Errorf("bad AndTable entries")
	}
	if OrTable[One][X] != One || OrTable[Zero][Zero] != Zero || OrTable[Zero][Z] != X {
		t.Errorf("bad OrTable entries")
	}
	if XorTable[Zero][One] != One || XorTable[One][One] != Zero || XorTable[X][One] != X {
		t.Errorf("bad XorTable entries")
	}
	// Derived tables must be the negation of their base tables.
	for a := Zero; a <= Z; a++ {
		for b := Zero; b <= Z; b++ {
			if NandTable[a][b] != NotTable[AndTable[a][b]] {
				t.Errorf("NandTable[%v][%v] inconsistent", a, b)
			}
			if NorTable[a][b] != NotTable[OrTable[a][b]] {
				t.Errorf("NorTable[%v][%v] inconsistent", a, b)
			}
			if XnorTable[a][b] != NotTable[XorTable[a][b]] {
				t.Errorf("XnorTable[%v][%v] inconsistent", a, b)
			}
		}
	}
	// GateKind.Eval must be driven by the public tables.
	kinds := []GateKind{Buf, Not, And, Or, Xor, Nand, Nor, Xnor}
	for _, k := range kinds {
		for a := Zero; a <= Z; a++ {
			if k.Arity() == 1 {
				if got := k.Eval([]Value{a}); got != []Value{BufTable[a], NotTable[a]}[k] {
					t.Errorf("%v.Eval(%v) = %v", k, a, got)
				}
				continue
			}
			for b := Zero; b <= Z; b++ {
				want := [][4][4]Value{AndTable, OrTable, XorTable, NandTable, NorTable, XnorTable}[k-And][a][b]
				if got := k.Eval([]Value{a, b}); got != want {
					t.Errorf("%v.Eval(%v,%v) = %v, want %v", k, a, b, got, want)
				}
			}
		}
	}
}

func TestCombinationalConverges(t *testing.T) {
	// out = (a AND b) OR (b XOR c)
	c := NewCircuit(6, []int{0, 1, 2}, []Gate{
		{Kind: And, Out: 3, In: []int{0, 1}},
		{Kind: Xor, Out: 4, In: []int{1, 2}},
		{Kind: Or, Out: 5, In: []int{3, 4}},
	})
	inputs := map[int]Value{0: One, 1: One, 2: Zero}
	res := IterateFull(c, inputs, c.InitialState(inputs), 100)
	if res.Status != Converged {
		t.Fatalf("status = %v, want converged", res.Status)
	}
	assertState(t, res.Values, One, One, Zero, One, One, One)
}

func TestLatchLoopConverges(t *testing.T) {
	// NAND RS latch: q = NAND(r, qb), qb = NAND(s, q).
	c := NewCircuit(4, []int{0, 1}, []Gate{
		{Kind: Nand, Out: 2, In: []int{0, 3}},
		{Kind: Nand, Out: 3, In: []int{1, 2}},
	})
	sim := NewSimulator(c, map[int]Value{0: Zero, 1: One}) // reset
	res := sim.Run(100)
	if res.Status != Converged {
		t.Fatalf("status = %v, want converged", res.Status)
	}
	assertState(t, res.Values, Zero, One, One, Zero)

	sim.SetInput(0, One) // release: state must be held by the loop
	res = sim.Run(100)
	if res.Status != Converged {
		t.Fatalf("status = %v, want converged", res.Status)
	}
	assertState(t, res.Values, One, One, One, Zero)

	sim.SetInput(1, Zero) // set
	res = sim.Run(100)
	if res.Status != Converged {
		t.Fatalf("status = %v, want converged", res.Status)
	}
	assertState(t, res.Values, One, Zero, Zero, One)
}

func TestRingOscillatorCycle(t *testing.T) {
	// Three-inverter ring: a=NOT(c), b=NOT(a), c=NOT(b).
	c := NewCircuit(3, nil, []Gate{
		{Kind: Not, Out: 0, In: []int{2}},
		{Kind: Not, Out: 1, In: []int{0}},
		{Kind: Not, Out: 2, In: []int{1}},
	})
	initial := []Value{Zero, One, Zero}
	res := IterateFull(c, nil, initial, 100)
	if res.Status != Cyclic {
		t.Fatalf("status = %v, want cyclic", res.Status)
	}
	if res.Period != 6 {
		t.Fatalf("period = %d, want 6", res.Period)
	}
	if len(res.Witness) != 6 {
		t.Fatalf("witness length = %d, want 6", len(res.Witness))
	}
	assertState(t, res.Witness[0], Zero, One, Zero)
	assertState(t, res.Witness[3], One, Zero, One)
	// The witness must be a real cycle: one more step from the last
	// witness state returns to the first.
	next := IterateFull(c, nil, res.Witness[5], 1)
	assertState(t, next.Values, res.Witness[0][0], res.Witness[0][1], res.Witness[0][2])
}

func TestGatedRingCycleViaSimulator(t *testing.T) {
	// a = NAND(en, c); b = NOT(a); c = NOT(b). en=0 holds a=1.
	c := NewCircuit(4, []int{0}, []Gate{
		{Kind: Nand, Out: 1, In: []int{0, 3}},
		{Kind: Not, Out: 2, In: []int{1}},
		{Kind: Not, Out: 3, In: []int{2}},
	})
	sim := NewSimulator(c, map[int]Value{0: Zero})
	res := sim.Run(100)
	if res.Status != Converged {
		t.Fatalf("status = %v, want converged", res.Status)
	}
	assertState(t, res.Values, Zero, One, Zero, One)

	sim.SetInput(0, One) // release the ring: it oscillates
	res = sim.Run(100)
	if res.Status != Cyclic {
		t.Fatalf("status = %v, want cyclic", res.Status)
	}
	if res.Period != 6 {
		t.Fatalf("period = %d, want 6", res.Period)
	}

	res = sim.Run(100) // re-running measures the same period
	if res.Status != Cyclic || res.Period != 6 {
		t.Fatalf("second run: status = %v, period = %d", res.Status, res.Period)
	}
}

func TestBudgetExhausted(t *testing.T) {
	// Five-buffer delay chain from input net 0.
	var gates []Gate
	for i := 1; i <= 5; i++ {
		gates = append(gates, Gate{Kind: Buf, Out: i, In: []int{i - 1}})
	}
	c := NewCircuit(6, []int{0}, gates)
	inputs := map[int]Value{0: One}

	res := IterateFull(c, inputs, c.InitialState(inputs), 5)
	if res.Status != Exhausted {
		t.Fatalf("status = %v, want exhausted", res.Status)
	}
	if res.Rounds != 5 {
		t.Fatalf("rounds = %d, want 5", res.Rounds)
	}

	res = IterateFull(c, inputs, c.InitialState(inputs), 10)
	if res.Status != Converged {
		t.Fatalf("status = %v, want converged", res.Status)
	}
	assertState(t, res.Values, One, One, One, One, One, One)

	res = IterateFull(c, inputs, c.InitialState(inputs), 0)
	if res.Status != Exhausted || res.Rounds != 0 {
		t.Fatalf("budget 0: status = %v, rounds = %d", res.Status, res.Rounds)
	}
}

func TestUndrivenNetIsZ(t *testing.T) {
	c := NewCircuit(2, []int{0}, nil)
	st := c.InitialState(map[int]Value{0: One})
	assertState(t, st, One, Z)
}

func assertSameResult(t *testing.T, got, want Result) {
	t.Helper()
	if got.Status != want.Status {
		t.Fatalf("status: incremental %v, full %v", got.Status, want.Status)
	}
	if got.Rounds != want.Rounds {
		t.Fatalf("rounds: incremental %d, full %d", got.Rounds, want.Rounds)
	}
	if !statesEqual(got.Values, want.Values) {
		t.Fatalf("values: incremental %s, full %s",
			valuesString(got.Values), valuesString(want.Values))
	}
	if got.Period != want.Period {
		t.Fatalf("period: incremental %d, full %d", got.Period, want.Period)
	}
	if len(got.Witness) != len(want.Witness) {
		t.Fatalf("witness length: incremental %d, full %d",
			len(got.Witness), len(want.Witness))
	}
	for i := range got.Witness {
		if !statesEqual(got.Witness[i], want.Witness[i]) {
			t.Fatalf("witness[%d]: incremental %s, full %s",
				i, valuesString(got.Witness[i]), valuesString(want.Witness[i]))
		}
	}
}

func TestIncrementalMatchesFull(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	const budget = 40
	for trial := 0; trial < 200; trial++ {
		numNets := 4 + rng.Intn(5)
		numInputs := 1 + rng.Intn(2)
		inputs := make([]int, numInputs)
		for i := range inputs {
			inputs[i] = i
		}
		numGates := 2 + rng.Intn(6)
		gates := make([]Gate, numGates)
		for i := range gates {
			kind := GateKind(rng.Intn(8))
			g := Gate{Kind: kind, Out: numInputs + rng.Intn(numNets-numInputs)}
			for j := 0; j < kind.Arity(); j++ {
				g.In = append(g.In, rng.Intn(numNets))
			}
			gates[i] = g
		}
		c := NewCircuit(numNets, inputs, gates)
		inVals := map[int]Value{}
		for _, n := range inputs {
			inVals[n] = Value(rng.Intn(3)) // 0, 1 or X
		}

		sim := NewSimulator(c, inVals)
		assertSameResult(t, sim.Run(budget),
			IterateFull(c, inVals, c.InitialState(inVals), budget))

		for change := 0; change < 5; change++ {
			net := inputs[rng.Intn(len(inputs))]
			inVals[net] = Value(rng.Intn(3))
			sim.SetInput(net, inVals[net])
			fromState := sim.State()
			assertSameResult(t, sim.Run(budget),
				IterateFull(c, inVals, fromState, budget))
		}
	}
}
