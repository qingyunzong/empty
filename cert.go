package gridmap

// Certificate is a distance certificate for a ShortestPath query. It
// contains the witnessing path plus Dijkstra distance labels for every cell
// reachable from the goal, allowing an independent checker to verify the
// claimed distance without trusting the search.
type Certificate struct {
	Start, Goal Point
	Dist        int
	Path        []Point       // a path from Start to Goal costing Dist
	Labels      map[Point]int // distance-to-Goal label per reachable cell
}

// Verify checks the certificate against m. It confirms that Path is a legal
// walk from Start to Goal of cost Dist (upper bound) and that the labels
// form a valid lower-bound potential: Labels[Goal] == 0, every legal move
// out of a labeled cell lands on a labeled cell, and no move improves a
// label by more than its cost. Together these prove Dist is the true
// shortest-path distance on m.
func (c *Certificate) Verify(m *Map) bool {
	if c == nil || len(c.Path) == 0 || c.Labels == nil {
		return false
	}
	if c.Path[0] != c.Start || c.Path[len(c.Path)-1] != c.Goal {
		return false
	}
	// Upper bound: the exhibited path is legal and costs exactly Dist.
	total := 0
	for i := 1; i < len(c.Path); i++ {
		cost, ok := m.StepCost(c.Path[i-1], c.Path[i])
		if !ok {
			return false
		}
		total += cost
	}
	if total != c.Dist {
		return false
	}
	// Lower bound: labels form a closed, consistent potential.
	if !m.Free(c.Start) || !m.Free(c.Goal) {
		return false
	}
	if c.Labels[c.Goal] != 0 {
		return false
	}
	if d, ok := c.Labels[c.Start]; !ok || d != c.Dist {
		return false
	}
	for v, dv := range c.Labels {
		if dv < 0 || !m.Free(v) {
			return false
		}
		ok := true
		m.forEachNeighbor(v, func(u Point, cost int) {
			du, seen := c.Labels[u]
			if !seen || dv > du+cost {
				ok = false
			}
		})
		if !ok {
			return false
		}
	}
	return true
}
