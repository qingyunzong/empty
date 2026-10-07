package scheduler

import "fmt"

// Check verifies that s is a feasible schedule for p: one ordered pair
// of distinct, qualified people per slot, at least one shared person
// between adjacent slots, and no person working more than MaxConsec
// consecutive slots. It returns nil when every constraint holds and a
// descriptive error naming the first violated constraint otherwise.
func Check(p Problem, s Schedule) error {
	if err := p.Validate(); err != nil {
		return err
	}
	if len(s) != p.NumSlots {
		return fmt.Errorf("scheduler: schedule has %d slots, want %d", len(s), p.NumSlots)
	}
	for slot, pr := range s {
		a, b := pr[0], pr[1]
		if a < 0 || a >= p.NumPeople || b < 0 || b >= p.NumPeople {
			return fmt.Errorf("scheduler: slot %d: person index out of range in pair %v", slot, pr)
		}
		if a == b {
			return fmt.Errorf("scheduler: slot %d: pair %v names the same person twice", slot, pr)
		}
		if a > b {
			return fmt.Errorf("scheduler: slot %d: pair %v is not ordered (first < second)", slot, pr)
		}
		if !p.Qualified[a][slot] {
			return fmt.Errorf("scheduler: slot %d: person %d is not qualified", slot, a)
		}
		if !p.Qualified[b][slot] {
			return fmt.Errorf("scheduler: slot %d: person %d is not qualified", slot, b)
		}
		if slot > 0 && !sharesPerson(s[slot-1], pr) {
			return fmt.Errorf("scheduler: slots %d and %d share no person", slot-1, slot)
		}
	}
	for person := 0; person < p.NumPeople; person++ {
		run := 0
		for slot := 0; slot < p.NumSlots; slot++ {
			if contains(s[slot], person) {
				run++
				if run > MaxConsec {
					return fmt.Errorf("scheduler: person %d works %d consecutive slots ending at slot %d (max %d)", person, run, slot, MaxConsec)
				}
			} else {
				run = 0
			}
		}
	}
	return nil
}
