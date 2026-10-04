package cirsim

import "fmt"

// Gate is one node in a Circuit. In holds indices of driving nodes;
// node indices are assigned by Circuit.AddInput / Circuit.AddGate.
type Gate struct {
	Op Op
	In []int
}

// Circuit is a network of input nodes and gates. Combinational feedback
// loops are permitted; they are resolved by synchronous iteration.
type Circuit struct {
	nodes   []Gate
	nInputs int
}

// NewCircuit returns an empty circuit.
func NewCircuit() *Circuit { return &Circuit{} }

// AddInput adds a primary input and returns its node index.
// Inputs must be added before any gate.
func (c *Circuit) AddInput() int {
	if len(c.nodes) != c.nInputs {
		panic("cirsim: inputs must be added before gates")
	}
	c.nodes = append(c.nodes, Gate{})
	c.nInputs++
	return len(c.nodes) - 1
}

// AddGate adds a gate and returns its node index. Input indices may
// reference any node, including gates added later (feedback loops).
func (c *Circuit) AddGate(op Op, in ...int) int {
	if len(in) == 0 {
		panic("cirsim: gate needs at least one input")
	}
	if (op == Buf || op == Not) && len(in) != 1 {
		panic("cirsim: unary gate needs exactly one input")
	}
	if op != Buf && op != Not && len(in) < 2 {
		panic("cirsim: n-ary gate needs at least two inputs")
	}
	c.nodes = append(c.nodes, Gate{Op: op, In: append([]int(nil), in...)})
	return len(c.nodes) - 1
}

// NumInputs returns the number of primary inputs.
func (c *Circuit) NumInputs() int { return c.nInputs }

// NumNodes returns the total number of nodes (inputs plus gates).
func (c *Circuit) NumNodes() int { return len(c.nodes) }

// Gate returns the gate at node index i (inputs have Op Buf and no inputs).
func (c *Circuit) Gate(i int) Gate { return c.nodes[i] }

func (c *Circuit) validate() error {
	for i, g := range c.nodes {
		for _, src := range g.In {
			if src < 0 || src >= len(c.nodes) {
				return fmt.Errorf("cirsim: node %d references missing node %d", i, src)
			}
		}
	}
	return nil
}

// step computes one synchronous round: every gate is re-evaluated from the
// current state into a fresh next state; primary inputs are held fixed.
func (c *Circuit) step(state []Value) []Value {
	next := make([]Value, len(state))
	copy(next, state[:c.nInputs])
	for i := c.nInputs; i < len(c.nodes); i++ {
		g := c.nodes[i]
		args := make([]Value, len(g.In))
		for j, src := range g.In {
			args[j] = state[src]
		}
		next[i] = Eval(g.Op, args)
	}
	return next
}
