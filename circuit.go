package circsim

import "fmt"

// Gate is a single combinational gate driving one net.
type Gate struct {
	Kind GateKind
	Out  int   // index of the driven net
	In   []int // indices of the input nets
}

// Circuit is a flat netlist. External inputs drive their nets
// exclusively: a gate output connected to an input net is ignored.
// A net driven by several gates resolves its drivers with Resolve.
type Circuit struct {
	NumNets int
	Inputs  []int
	Gates   []Gate

	drivers [][]int // gate indices driving each net
	readers [][]int // gate indices reading each net
	isInput []bool
}

// NewCircuit validates the netlist and builds driver/reader indexes.
// It panics on out-of-range nets or wrong gate arity.
func NewCircuit(numNets int, inputs []int, gates []Gate) *Circuit {
	if numNets <= 0 {
		panic("circsim: circuit needs at least one net")
	}
	c := &Circuit{
		NumNets: numNets,
		Inputs:  append([]int(nil), inputs...),
		Gates:   append([]Gate(nil), gates...),
	}
	c.drivers = make([][]int, numNets)
	c.readers = make([][]int, numNets)
	c.isInput = make([]bool, numNets)
	checkNet := func(n int) {
		if n < 0 || n >= numNets {
			panic(fmt.Sprintf("circsim: net index %d out of range [0,%d)", n, numNets))
		}
	}
	for _, n := range c.Inputs {
		checkNet(n)
		c.isInput[n] = true
	}
	for i, g := range c.Gates {
		if len(g.In) != g.Kind.Arity() {
			panic(fmt.Sprintf("circsim: gate %d (%s) wants %d inputs, got %d",
				i, g.Kind, g.Kind.Arity(), len(g.In)))
		}
		checkNet(g.Out)
		for _, n := range g.In {
			checkNet(n)
			c.readers[n] = append(c.readers[n], i)
		}
		c.drivers[g.Out] = append(c.drivers[g.Out], i)
	}
	return c
}

// InitialState returns the default starting state: input nets hold
// their input value, undriven nets are Z, everything else is X.
func (c *Circuit) InitialState(inputs map[int]Value) []Value {
	st := make([]Value, c.NumNets)
	for n := 0; n < c.NumNets; n++ {
		switch {
		case c.isInput[n]:
			if v, ok := inputs[n]; ok {
				st[n] = v
			} else {
				st[n] = X
			}
		case len(c.drivers[n]) == 0:
			st[n] = Z
		default:
			st[n] = X
		}
	}
	return st
}

// netValue computes a net's resolved value from cached gate outputs.
// External inputs force their nets.
func (c *Circuit) netValue(inputs map[int]Value, gateOut []Value, net int) Value {
	if c.isInput[net] {
		if v, ok := inputs[net]; ok {
			return v
		}
		return X
	}
	v := Z
	for _, gi := range c.drivers[net] {
		v = Resolve(v, gateOut[gi])
	}
	return v
}
