package searchre

type op int

const (
	opChar op = iota
	opMatch
	opJmp
	opSplit
	opSave
	opLoop
)

type inst struct {
	op   op
	ch   rune
	x, y int // jump/split targets; opLoop: x = loop head, y = exit
	slot int // save slot
}

type prog struct {
	code []inst
}

type compiler struct {
	code []inst
}

func (c *compiler) emit(i inst) int {
	c.code = append(c.code, i)
	return len(c.code) - 1
}

func compile(n *node, ngroups int) *prog {
	c := &compiler{}
	c.emit(inst{op: opSave, slot: 0})
	c.gen(n)
	c.emit(inst{op: opSave, slot: 1})
	c.emit(inst{op: opMatch})
	return &prog{code: c.code}
}

func (c *compiler) gen(n *node) {
	switch n.kind {
	case kEmpty:
	case kChar:
		c.emit(inst{op: opChar, ch: n.ch})
	case kConcat:
		for _, k := range n.kids {
			c.gen(k)
		}
	case kAlt:
		c.genAlt(n.kids)
	case kStar:
		// L: split body, end
		// body: <sub>; loop L, end
		// end:
		// The loop-back is a conditional jump: if the loop head has
		// already been visited with the same captures at this input
		// position, the thread goes to the exit instead of looping
		// forever. This mirrors the backtracking checker's guard and
		// makes the exit happen at the same point in priority order.
		l := c.emit(inst{op: opSplit})
		body := len(c.code)
		c.gen(n.sub)
		j := c.emit(inst{op: opLoop, x: l})
		end := len(c.code)
		c.code[l] = inst{op: opSplit, x: body, y: end}
		c.code[j] = inst{op: opLoop, x: l, y: end}
	case kQuest:
		s := c.emit(inst{op: opSplit})
		body := len(c.code)
		c.gen(n.sub)
		end := len(c.code)
		c.code[s] = inst{op: opSplit, x: body, y: end}
	case kGroup:
		c.emit(inst{op: opSave, slot: 2 * n.gid})
		c.gen(n.sub)
		c.emit(inst{op: opSave, slot: 2*n.gid + 1})
	}
}

func (c *compiler) genAlt(branches []*node) {
	if len(branches) == 1 {
		c.gen(branches[0])
		return
	}
	s := c.emit(inst{op: opSplit})
	first := len(c.code)
	c.gen(branches[0])
	j := c.emit(inst{op: opJmp})
	second := len(c.code)
	c.genAlt(branches[1:])
	end := len(c.code)
	c.code[s] = inst{op: opSplit, x: first, y: second}
	c.code[j] = inst{op: opJmp, x: end}
}
