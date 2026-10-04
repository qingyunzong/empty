package routeinsert

// Candidate is one fully evaluated interleaving of the new stops into the
// fixed old sequence.
type Candidate struct {
	Seq      []Stop
	Distance float64
	Violated map[Rule]bool
}

// Feasible reports whether the candidate violates no rule.
func (c Candidate) Feasible() bool { return len(c.Violated) == 0 }

// EnumerateAll generates every interleaving of the new stops into the old
// sequence (old relative order preserved, new stops in every order) and
// evaluates each one independently. It performs no pruning and serves as
// the ground-truth cross-check for Solve.
func EnumerateAll(p Problem) []Candidate {
	var out []Candidate
	seq := make([]Stop, 0, len(p.Old)+len(p.New))
	used := make([]bool, len(p.New))
	var rec func(nextOld int)
	rec = func(nextOld int) {
		if nextOld == len(p.Old) && allUsed(used) {
			d, v := Simulate(p.Vehicle, seq)
			out = append(out, Candidate{
				Seq:      append([]Stop(nil), seq...),
				Distance: d,
				Violated: v,
			})
			return
		}
		if nextOld < len(p.Old) {
			seq = append(seq, p.Old[nextOld])
			rec(nextOld + 1)
			seq = seq[:len(seq)-1]
		}
		for i := range p.New {
			if used[i] {
				continue
			}
			used[i] = true
			seq = append(seq, p.New[i])
			rec(nextOld)
			seq = seq[:len(seq)-1]
			used[i] = false
		}
	}
	rec(0)
	return out
}
