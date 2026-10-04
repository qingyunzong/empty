package regex

type op int

const (
	opChar op = iota
	opMatch
	opJmp
	opSplit
	opSave
)

type inst struct {
	op   op
	c    byte
	x, y int
	slot int
}

type prog struct {
	code []inst
}

func (p *prog) add(i inst) int {
	p.code = append(p.code, i)
	return len(p.code) - 1
}

func compile(n *node) *prog {
	p := &prog{}
	p.add(inst{op: opSave, slot: 0})
	emitNode(p, n)
	p.add(inst{op: opSave, slot: 1})
	p.add(inst{op: opMatch})
	return p
}

func emitNode(p *prog, n *node) {
	switch n.kind {
	case kLit:
		p.add(inst{op: opChar, c: n.c})
	case kConcat:
		for _, c := range n.children {
			emitNode(p, c)
		}
	case kGroup:
		p.add(inst{op: opSave, slot: 2 * n.groupIdx})
		emitNode(p, n.children[0])
		p.add(inst{op: opSave, slot: 2*n.groupIdx + 1})
	case kAlt:
		var ends []int
		for i, b := range n.children {
			last := i == len(n.children)-1
			sp := -1
			if !last {
				sp = p.add(inst{op: opSplit})
				p.code[sp].x = len(p.code)
			}
			emitNode(p, b)
			if !last {
				ends = append(ends, p.add(inst{op: opJmp}))
				p.code[sp].y = len(p.code)
			}
		}
		for _, j := range ends {
			p.code[j].x = len(p.code)
		}
	case kQuest:
		sp := p.add(inst{op: opSplit})
		p.code[sp].x = len(p.code)
		emitNode(p, n.children[0])
		p.code[sp].y = len(p.code)
	case kStar:
		sp := p.add(inst{op: opSplit})
		p.code[sp].x = len(p.code)
		emitNode(p, n.children[0])
		p.add(inst{op: opJmp, x: sp})
		p.code[sp].y = len(p.code)
	}
}
