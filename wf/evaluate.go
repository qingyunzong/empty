package wf

import "sort"

// RuleWitness is closed-support evidence for one original rule of a false
// head. Exactly one of the two failure modes applies per witness:
//
//   - Kind "pos_false": the positive body Atom is itself false. InCycle marks
//     witnesses that only point at another atom of the same false positive
//     component, so the material can present the cycle's collective
//     unfoundedness instead of pretending one cycle member was independently
//     proven false first.
//   - Kind "neg_true": the negative body literal not Atom is false in the
//     final interpretation because Atom is true.
type RuleWitness struct {
	RuleID  string
	Kind    string
	Atom    string
	InCycle bool
}

// FalseSupport collects the closed-support material for one false atom.
// NoRules is true when the atom has no defining rule at all.
type FalseSupport struct {
	Head      string
	NoRules   bool
	Witnesses []RuleWitness
}

// Round captures one simultaneous (K, U) update. KTrace is Gamma(U) and
// UTrace is Gamma(Knext), each carrying the S it was invoked with.
type Round struct {
	Index  int
	K      []string
	U      []string
	KTrace GammaTrace
	UTrace GammaTrace
}

// Result is the immutable well-founded evaluation of one Program snapshot.
type Result struct {
	program *Program

	True    []string
	False   []string
	Unknown []string

	Rounds []Round

	FalseSupports []FalseSupport
}

// Program returns the immutable snapshot this result belongs to.
func (r *Result) Program() *Program { return r.program }

// Evaluate runs the alternating fixed point:
//
//	K0 = empty, U0 = B
//	K_{i+1} = Gamma(U_i), U_{i+1} = Gamma(K_{i+1})
//
// with simultaneous updates, stopping once both sets stop changing. The final
// K is true, B\\U is false and U\\K is unknown.
func Evaluate(p *Program) *Result {
	K := []string{}
	U := append([]string(nil), p.universe...)

	var rounds []Round
	index := 0
	for {
		index++
		kTrace := gamma(p, U)
		kNext := append([]string(nil), kTrace.Closure...)
		uTrace := gamma(p, kNext)
		uNext := append([]string(nil), uTrace.Closure...)

		rounds = append(rounds, Round{
			Index:  index,
			K:      kNext,
			U:      uNext,
			KTrace: kTrace,
			UTrace: uTrace,
		})

		if sameSet(K, kNext) && sameSet(U, uNext) {
			K, U = kNext, uNext
			break
		}
		K, U = kNext, uNext
	}

	trueSet := toSet(K)
	uSet := toSet(U)
	falseSet := make(map[string]bool)
	unknownSet := make(map[string]bool)
	for _, atom := range p.universe {
		switch {
		case trueSet[atom]:
		case uSet[atom]:
			unknownSet[atom] = true
		default:
			falseSet[atom] = true
		}
	}

	falseList := sortedKeys(falseSet)
	unknownList := sortedKeys(unknownSet)

	return &Result{
		program:       p,
		True:          append([]string(nil), K...),
		False:         falseList,
		Unknown:       unknownList,
		Rounds:        rounds,
		FalseSupports: buildFalseSupports(p, falseList, falseSet, trueSet),
	}
}

func buildFalseSupports(p *Program, falseList []string, falseSet, trueSet map[string]bool) []FalseSupport {
	cyclic := cyclicFalseComponents(p, falseSet)
	supports := make([]FalseSupport, 0, len(falseList))
	for _, head := range falseList {
		rules := p.rulesFor(head)
		if len(rules) == 0 {
			supports = append(supports, FalseSupport{Head: head, NoRules: true})
			continue
		}
		fs := FalseSupport{Head: head}
		for _, rule := range rules {
			var witnesses []RuleWitness
			for _, premise := range rule.pos {
				if falseSet[premise] {
					witnesses = append(witnesses, RuleWitness{
						RuleID:  rule.id,
						Kind:    "pos_false",
						Atom:    premise,
						InCycle: cyclic[rule.head] != "" && cyclic[rule.head] == cyclic[premise],
					})
				}
			}
			for _, neg := range rule.neg {
				if trueSet[neg] {
					witnesses = append(witnesses, RuleWitness{
						RuleID: rule.id,
						Kind:   "neg_true",
						Atom:   neg,
					})
				}
			}
			sort.Slice(witnesses, func(i, j int) bool {
				if witnesses[i].Kind != witnesses[j].Kind {
					return witnesses[i].Kind < witnesses[j].Kind
				}
				return witnesses[i].Atom < witnesses[j].Atom
			})
			fs.Witnesses = append(fs.Witnesses, witnesses...)
		}
		supports = append(supports, fs)
	}
	return supports
}

// cyclicFalseComponents returns a map from false atom to an SCC identifier,
// restricted to the positive dependency graph induced by false atoms. Only
// members of non-trivial cyclic components (including self-loops such as
// a :- a) receive an identifier.
func cyclicFalseComponents(p *Program, falseSet map[string]bool) map[string]string {
	ids := make([]string, 0, len(falseSet))
	for atom := range falseSet {
		ids = append(ids, atom)
	}
	sort.Strings(ids)
	indexOf := make(map[string]int, len(ids))
	for i, atom := range ids {
		indexOf[atom] = i
	}

	adj := make([][]int, len(ids))
	selfLoop := make([]bool, len(ids))
	for _, head := range ids {
		h := indexOf[head]
		for _, rule := range p.rulesFor(head) {
			for _, premise := range rule.pos {
				if !falseSet[premise] {
					continue
				}
				j := indexOf[premise]
				if j == h {
					selfLoop[h] = true
				}
				adj[h] = append(adj[h], j)
			}
		}
	}

	component := tarjanSCC(adj, len(ids))
	out := make(map[string]string)
	componentSize := make(map[int]int)
	for _, c := range component {
		componentSize[c]++
	}
	for i, atom := range ids {
		if componentSize[component[i]] > 1 || selfLoop[i] {
			out[atom] = "scc" + itoa(component[i])
		}
	}
	return out
}

func tarjanSCC(adj [][]int, n int) []int {
	index := make([]int, n)
	low := make([]int, n)
	onStack := make([]bool, n)
	for i := range index {
		index[i] = -1
	}
	stack := make([]int, 0, n)
	component := make([]int, n)
	nextIndex, componentCount := 0, 0

	var visit func(v int)
	visit = func(v int) {
		index[v] = nextIndex
		low[v] = nextIndex
		nextIndex++
		stack = append(stack, v)
		onStack[v] = true
		for _, w := range adj[v] {
			if index[w] == -1 {
				visit(w)
				if low[w] < low[v] {
					low[v] = low[w]
				}
			} else if onStack[w] && index[w] < low[v] {
				low[v] = index[w]
			}
		}
		if low[v] == index[v] {
			for {
				w := stack[len(stack)-1]
				stack = stack[:len(stack)-1]
				onStack[w] = false
				component[w] = componentCount
				if w == v {
					break
				}
			}
			componentCount++
		}
	}
	for v := 0; v < n; v++ {
		if index[v] == -1 {
			visit(v)
		}
	}
	return component
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [24]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

func sameSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func toSet(xs []string) map[string]bool {
	m := make(map[string]bool, len(xs))
	for _, x := range xs {
		m[x] = true
	}
	return m
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
