package dataeng

import (
	"math"
	"time"
)

type solver struct {
	p      *prepared
	m      int
	k      int
	suffix []float64 // remaining class share at each depth

	suffixTotal []float64

	best    []uint8
	bestObj float64
	bestSet bool

	steps       int
	nodeBudget  int
	deadline    time.Time
	hasDeadline bool
	stopReason  string
	complete    bool
	open        []OpenSubproblem
	openCount   int
	openBound   float64

	eps float64
}

type searchNode struct {
	prefix []uint8
	counts []float64
	filled [3]int

	maxTrain time.Time
	minTest  time.Time
	hasTrain bool
	hasTest  bool

	lb float64
}

type frame struct {
	node *searchNode
	next uint8
}

type leafEvaluation struct {
	obj float64
	asn []uint8
}

func newSolver(p *prepared, nodeBudget int, maxDuration time.Duration) *solver {
	s := &solver{
		p:          p,
		m:          len(p.blocks),
		k:          len(p.classes),
		nodeBudget: nodeBudget,
		eps:        p.epsilon,
	}
	s.suffix = make([]float64, (s.m+1)*s.k)
	s.suffixTotal = make([]float64, s.m+1)
	for depth := s.m - 1; depth >= 0; depth-- {
		copy(s.suffix[depth*s.k:(depth+1)*s.k], s.suffix[(depth+1)*s.k:(depth+2)*s.k])
		for class, weight := range p.blocks[depth].classWeights {
			s.suffix[depth*s.k+class] += weight / p.totalWeight
		}
		s.suffixTotal[depth] = s.suffixTotal[depth+1] + p.blocks[depth].weight/p.totalWeight
	}
	if maxDuration > 0 {
		s.deadline = time.Now().Add(maxDuration)
		s.hasDeadline = true
	}
	return s
}

func (s *solver) search() []uint8 {
	if initial := s.initialSolution(); initial != nil {
		s.consider(initial)
	}

	root := &searchNode{
		counts: make([]float64, 3*s.k),
	}
	root.lb = s.lowerBound(root, 0)
	if s.canPrunePrefix(root.prefix, root.lb) {
		s.complete = true
		s.openBound = s.bestObj
		return s.best
	}
	stack := []*frame{{node: root}}
	for len(stack) > 0 {
		f := stack[len(stack)-1]

		if f.node.depthLeaf(s.m) {
			if s.budgetReached() {
				s.stopReason = "search budget exhausted"
				break
			}
			s.steps++
			if s.feasibleNonEmpty(f.node) && !s.canPrunePrefix(f.node.prefix, f.node.lb) {
				s.considerNode(f.node)
			}
			stack = stack[:len(stack)-1]
			continue
		}
		if f.next >= 3 {
			stack = stack[:len(stack)-1]
			continue
		}
		if s.budgetReached() {
			if s.stopReason == "" {
				s.stopReason = "search budget exhausted"
			}
			break
		}

		choice := f.next
		f.next++
		child, ok := s.child(f.node, choice)
		if !ok || s.canPruneNode(child) {
			continue
		}
		s.steps++
		stack = append(stack, &frame{node: child})
	}
	s.open, s.openCount, s.openBound, s.complete = s.frontier(stack)
	return s.best
}

func (n *searchNode) depthLeaf(m int) bool { return len(n.prefix) == m }

func (s *solver) budgetReached() bool {
	if s.nodeBudget != Unlimited && s.steps >= s.nodeBudget {
		return true
	}
	if s.hasDeadline && time.Now().After(s.deadline) {
		return true
	}
	return false
}

func (s *solver) child(parent *searchNode, choice uint8) (*searchNode, bool) {
	b := &s.p.blocks[len(parent.prefix)]
	if s.p.hasTime {
		switch choice {
		case 0:
			if parent.hasTest && !b.latest.Before(parent.minTest) {
				return nil, false
			}
		case 2:
			if parent.hasTrain && !b.earliest.After(parent.maxTrain) {
				return nil, false
			}
		}
	}

	depth := len(parent.prefix)
	child := &searchNode{
		prefix:   make([]uint8, depth+1),
		counts:   make([]float64, len(parent.counts)),
		filled:   parent.filled,
		maxTrain: parent.maxTrain,
		minTest:  parent.minTest,
		hasTrain: parent.hasTrain,
		hasTest:  parent.hasTest,
	}
	copy(child.prefix, parent.prefix)
	child.prefix[depth] = choice
	copy(child.counts, parent.counts)
	child.filled[choice]++

	base := int(choice) * s.k
	for class, weight := range b.classWeights {
		child.counts[base+class] += weight / s.p.totalWeight
	}

	if s.p.hasTime {
		switch choice {
		case 0:
			child.hasTrain = true
			if !parent.hasTrain || b.latest.After(child.maxTrain) {
				child.maxTrain = b.latest
			}
		case 2:
			child.hasTest = true
			if !parent.hasTest || b.earliest.Before(child.minTest) {
				child.minTest = b.earliest
			}
		}
	}

	if !s.p.allowEmptySplits {
		remaining := s.m - len(child.prefix)
		missing := 0
		for _, count := range child.filled {
			if count == 0 {
				missing++
			}
		}
		if missing > remaining {
			return nil, false
		}
	}

	child.lb = s.lowerBound(child, len(child.prefix))
	return child, true
}

func (s *solver) lowerBound(n *searchNode, depth int) float64 {
	var bound float64
	switch s.p.metric {
	case L2:
		bound = s.lowerBoundL2(n, depth)
	case Linf:
		bound = s.lowerBoundLinf(n, depth)
	default:
		bound = s.lowerBoundL1(n, depth)
	}
	if bound < 0 || math.IsNaN(bound) {
		return 0
	}
	return bound
}

func (s *solver) lowerBoundL1(n *searchNode, depth int) float64 {
	classBound := 0.0
	for class := 0; class < s.k; class++ {
		base, under := 0.0, 0.0
		for split := 0; split < 3; split++ {
			d := n.counts[split*s.k+class] - s.p.targetCells[split][class]
			if d < 0 {
				base -= d
				under -= d
			} else {
				base += d
			}
		}
		remaining := math.Max(0, s.suffix[depth*s.k+class])
		if remaining <= under {
			classBound += base - remaining
		} else {
			classBound += base + remaining - 2*under
		}
	}

	splitBound := 0.0
	for split := 0; split < 3; split++ {
		current := 0.0
		for class := 0; class < s.k; class++ {
			current += n.counts[split*s.k+class]
		}
		d := current - s.p.targetSplit[split]
		if d < 0 {
			splitBound -= d
		} else {
			splitBound += d
		}
	}
	remaining := math.Max(0, s.suffixTotal[depth])
	under := 0.0
	for split := 0; split < 3; split++ {
		current := 0.0
		for class := 0; class < s.k; class++ {
			current += n.counts[split*s.k+class]
		}
		if d := current - s.p.targetSplit[split]; d < 0 {
			under -= d
		}
	}
	if remaining <= under {
		splitBound -= remaining
	} else {
		splitBound += remaining - 2*under
	}
	if splitBound > classBound {
		return splitBound
	}
	return classBound
}

func (s *solver) lowerBoundL2(n *searchNode, depth int) float64 {
	bound := 0.0
	for split := 0; split < 3; split++ {
		for class := 0; class < s.k; class++ {
			d := n.counts[split*s.k+class] - s.p.targetCells[split][class]
			remaining := math.Max(0, s.suffix[depth*s.k+class])
			bound += squareCellMin(d, remaining)
		}
	}

	splitBound := 0.0
	remaining := math.Max(0, s.suffixTotal[depth])
	for split := 0; split < 3; split++ {
		current := 0.0
		for class := 0; class < s.k; class++ {
			current += n.counts[split*s.k+class]
		}
		splitBound += squareCellMin(current-s.p.targetSplit[split], remaining)
	}
	if splitBound > bound {
		return splitBound
	}
	return bound
}

func squareCellMin(d, remaining float64) float64 {
	if d >= 0 {
		return d * d
	}
	if -d <= remaining {
		return 0
	}
	rest := d + remaining
	return rest * rest
}

func (s *solver) lowerBoundLinf(n *searchNode, depth int) float64 {
	bound := 0.0
	for split := 0; split < 3; split++ {
		for class := 0; class < s.k; class++ {
			d := n.counts[split*s.k+class] - s.p.targetCells[split][class]
			remaining := math.Max(0, s.suffix[depth*s.k+class])
			if v := absCellMin(d, remaining); v > bound {
				bound = v
			}
		}
	}

	remaining := math.Max(0, s.suffixTotal[depth])
	for split := 0; split < 3; split++ {
		current := 0.0
		for class := 0; class < s.k; class++ {
			current += n.counts[split*s.k+class]
		}
		if v := absCellMin(current-s.p.targetSplit[split], remaining); v > bound {
			bound = v
		}
	}
	return bound
}

func absCellMin(d, remaining float64) float64 {
	if d >= 0 {
		return d
	}
	if -d <= remaining {
		return 0
	}
	return -(d + remaining)
}

func (s *solver) objective(counts []float64) float64 {
	switch s.p.metric {
	case L2:
		total := 0.0
		for split := 0; split < 3; split++ {
			for class := 0; class < s.k; class++ {
				d := counts[split*s.k+class] - s.p.targetCells[split][class]
				total += d * d
			}
		}
		return total
	case Linf:
		maxDev := 0.0
		for split := 0; split < 3; split++ {
			for class := 0; class < s.k; class++ {
				d := math.Abs(counts[split*s.k+class] - s.p.targetCells[split][class])
				if d > maxDev {
					maxDev = d
				}
			}
		}
		return maxDev
	default:
		total := 0.0
		for split := 0; split < 3; split++ {
			for class := 0; class < s.k; class++ {
				total += math.Abs(counts[split*s.k+class] - s.p.targetCells[split][class])
			}
		}
		return total
	}
}

func (s *solver) considerNode(n *searchNode) {
	obj := s.objective(n.counts)
	if s.bestSet {
		if obj > s.bestObj+s.eps {
			return
		}
		if math.Abs(obj-s.bestObj) <= s.eps && compareAssignments(n.prefix, s.best) >= 0 {
			return
		}
	}
	s.bestSet = true
	s.bestObj = obj
	s.best = append([]uint8(nil), n.prefix...)
}

func (s *solver) consider(asn []uint8) {
	counts := s.countsFor(asn)
	obj := s.objective(counts)
	if s.bestSet {
		if obj > s.bestObj+s.eps {
			return
		}
		if math.Abs(obj-s.bestObj) <= s.eps && compareAssignments(asn, s.best) >= 0 {
			return
		}
	}
	s.bestSet = true
	s.bestObj = obj
	s.best = append([]uint8(nil), asn...)
}

func (s *solver) countsFor(asn []uint8) []float64 {
	counts := make([]float64, 3*s.k)
	for i, choice := range asn {
		base := int(choice) * s.k
		for class, weight := range s.p.blocks[i].classWeights {
			counts[base+class] += weight / s.p.totalWeight
		}
	}
	return counts
}

func (s *solver) feasibleNonEmpty(n *searchNode) bool {
	if s.p.allowEmptySplits {
		return true
	}
	for _, count := range n.filled {
		if count == 0 {
			return false
		}
	}
	return true
}

func (s *solver) canPruneNode(n *searchNode) bool {
	return s.canPrunePrefix(n.prefix, n.lb)
}

func (s *solver) canPrunePrefix(prefix []uint8, lower float64) bool {
	if !s.bestSet {
		return false
	}
	if lower > s.bestObj+s.eps {
		return true
	}
	if lower >= s.bestObj-s.eps && compareAssignments(prefix, s.best) > 0 {
		return true
	}
	return false
}

func compareAssignments(a, b []uint8) int {
	n := len(a)
	if len(b) < n {
		n = len(b)
	}
	for i := 0; i < n; i++ {
		if a[i] < b[i] {
			return -1
		}
		if a[i] > b[i] {
			return 1
		}
	}
	switch {
	case len(a) < len(b):
		return -1
	case len(a) > len(b):
		return 1
	default:
		return 0
	}
}

func (s *solver) frontier(stack []*frame) ([]OpenSubproblem, int, float64, bool) {
	var open []OpenSubproblem
	openCount := 0
	minBound := infinite()

	for _, f := range stack {
		if f.node.depthLeaf(s.m) {
			if !s.feasibleNonEmpty(f.node) || s.canPruneNode(f.node) {
				continue
			}
			openCount++
			if f.node.lb < minBound {
				minBound = f.node.lb
			}
			if len(open) < 32 {
				open = append(open, OpenSubproblem{
					Depth:      len(f.node.prefix),
					LowerBound: f.node.lb,
					Prefix:     prefixChoices(s.p, f.node.prefix),
				})
			}
			continue
		}
		for choice := f.next; choice < 3; choice++ {
			child, ok := s.child(f.node, choice)
			if !ok || s.canPruneNode(child) {
				continue
			}
			if child.depthLeaf(s.m) && !s.feasibleNonEmpty(child) {
				continue
			}
			openCount++
			bound := child.lb
			if bound < minBound {
				minBound = bound
			}
			if len(open) < 32 {
				open = append(open, OpenSubproblem{
					Depth:        len(child.prefix),
					NextBlockKey: nextBlockKey(s.p, len(child.prefix)),
					LowerBound:   bound,
					Prefix:       prefixChoices(s.p, child.prefix),
				})
			}
		}
	}
	return open, openCount, minBound, openCount == 0
}

func nextBlockKey(p *prepared, depth int) string {
	if depth >= len(p.blocks) {
		return ""
	}
	return p.blocks[depth].key
}

func prefixChoices(p *prepared, prefix []uint8) []Choice {
	choices := make([]Choice, len(prefix))
	for i, choice := range prefix {
		choices[i] = Choice{
			BlockKey: p.blocks[i].key,
			Split:    SplitOrder[choice],
		}
	}
	return choices
}
