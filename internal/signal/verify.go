package signal

import "fmt"

// Check verifies a certificate against a problem: slot count within the
// cycle, conflict-freedom of every slot, phase minimums, consistency of
// the declared green vector, and the declared total cost.
func Check(p *Problem, cert *Certificate) error {
	n := len(p.Phases)
	if cert.Cycle != p.Cycle {
		return fmt.Errorf("certificate cycle %d != problem cycle %d", cert.Cycle, p.Cycle)
	}
	if len(cert.Slots) > p.Cycle {
		return fmt.Errorf("certificate uses %d slots > cycle %d", len(cert.Slots), p.Cycle)
	}
	adj := p.adjacency()
	green := make([]int, n)
	for s, slot := range cert.Slots {
		var mask uint64
		for _, idx := range slot {
			if idx < 0 || idx >= n {
				return fmt.Errorf("slot %d: phase index %d out of range", s, idx)
			}
			if mask&(1<<idx) != 0 {
				return fmt.Errorf("slot %d: phase %d listed twice", s, idx)
			}
			if adj[idx]&mask != 0 {
				return fmt.Errorf("slot %d: phase %q conflicts with another phase released in the same slot", s, p.Phases[idx].Name)
			}
			mask |= 1 << idx
			green[idx]++
		}
	}
	if cert.Green != nil {
		if len(cert.Green) != n {
			return fmt.Errorf("green vector has %d entries, want %d", len(cert.Green), n)
		}
		for i := range green {
			if cert.Green[i] != green[i] {
				return fmt.Errorf("phase %q: declared green %d != actual %d", p.Phases[i].Name, cert.Green[i], green[i])
			}
		}
	}
	for i := 0; i < n; i++ {
		if green[i] < p.Phases[i].Min {
			return fmt.Errorf("phase %q: green %d below minimum %d", p.Phases[i].Name, green[i], p.Phases[i].Min)
		}
	}
	cost := 0
	for i := 0; i < n; i++ {
		cost += p.Phases[i].Cost[green[i]]
	}
	if cost != cert.Cost {
		return fmt.Errorf("declared cost %d != recomputed cost %d", cert.Cost, cost)
	}
	return nil
}
