package cutting

// Inventory persists remnants across orders with stable IDs.
type Inventory struct {
	NextRemnantNum int   `json:"nextRemnantNum"`
	NextOrderNum   int   `json:"nextOrderNum"`
	Remnants       []Bar `json:"remnants"`
}

// ApplyPlan removes remnants consumed by the plan and appends the remnants it
// produced. nextRemnantNum is the value the plan was solved with.
func (inv *Inventory) ApplyPlan(p *Plan, nextRemnantNum int) {
	used := map[string]bool{}
	for _, id := range p.UsedRemnantIDs {
		used[id] = true
	}
	kept := make([]Bar, 0, len(inv.Remnants)+len(p.NewRemnants))
	for _, r := range inv.Remnants {
		if !used[r.ID] {
			kept = append(kept, r)
		}
	}
	inv.Remnants = append(kept, p.NewRemnants...)
	inv.NextRemnantNum = nextRemnantNum + len(p.NewRemnants)
	inv.NextOrderNum++
}
