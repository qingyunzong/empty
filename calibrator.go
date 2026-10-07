package robocalib

import (
	"fmt"
	"sort"
)

// Constraint fixes the relative pose between two robots: pose(To) = T ∘ pose(From).
type Constraint struct {
	ID   int
	From int
	To   int
	T    Transform
}

// Conflict describes a constraint that contradicts the existing ones.
// It carries a closed loop of constraint IDs and the composite transform
// accumulated around that loop, which differs from the identity exactly
// because the constraints are mutually inconsistent.
type Conflict struct {
	// Cycle lists constraint IDs in traversal order around the closed loop.
	// The first ID is the rejected constraint; the rest already existed.
	Cycle []int
	// Composite is the product of transforms around the loop, composed in
	// traversal order. Consistent constraints would yield the identity.
	Composite Transform
}

func (c *Conflict) Error() string {
	return fmt.Sprintf("robocalib: constraint %d contradicts existing constraints: loop %v composes to %+v instead of identity",
		c.Cycle[0], c.Cycle, c.Composite)
}

// edge is one undirected adjacency entry; T maps the current robot's pose
// to the neighbor's pose along the traversal direction.
type edge struct {
	to int
	id int
	t  Transform
}

// Calibrator maintains a set of relative-pose constraints. Every accepted
// mutation appends an immutable snapshot; old versions stay retrievable.
// The zero value is ready to use.
type Calibrator struct {
	constraints map[int]Constraint
	pot         map[int]Transform // pose(robot) = pot[robot] ∘ pose(origin)
	comp        map[int]int       // robot -> component origin (minimum robot ID)
	versions    []Snapshot
}

// New returns an empty Calibrator.
func New() *Calibrator {
	c := &Calibrator{}
	c.rebuild()
	c.commit()
	return c
}

func (c *Calibrator) ensure() {
	if c.constraints == nil {
		c.constraints = map[int]Constraint{}
	}
}

// commit appends an immutable snapshot of the current state.
func (c *Calibrator) commit() {
	constraints := make(map[int]Constraint, len(c.constraints))
	for id, k := range c.constraints {
		constraints[id] = k
	}
	pot := make(map[int]Transform, len(c.pot))
	for r, t := range c.pot {
		pot[r] = t
	}
	comp := make(map[int]int, len(c.comp))
	for r, o := range c.comp {
		comp[r] = o
	}
	c.versions = append(c.versions, Snapshot{constraints: constraints, pot: pot, comp: comp})
}

// adjacency builds the undirected adjacency list of the current graph.
func (c *Calibrator) adjacency() map[int][]edge {
	adj := map[int][]edge{}
	for _, k := range c.constraints {
		adj[k.From] = append(adj[k.From], edge{to: k.To, id: k.ID, t: k.T})
		adj[k.To] = append(adj[k.To], edge{to: k.From, id: k.ID, t: k.T.Inverse()})
	}
	return adj
}

// findPath returns the edges of a path from a to b in traversal order,
// or nil if a and b are not connected.
func (c *Calibrator) findPath(a, b int) []edge {
	adj := c.adjacency()
	prev := map[int]edge{a: {to: a, id: -1}}
	queue := []int{a}
	for len(queue) > 0 {
		v := queue[0]
		queue = queue[1:]
		if v == b {
			var path []edge
			for cur := b; cur != a; {
				e := prev[cur]
				path = append(path, e)
				cur = e.to // prev stores the edge back to the predecessor
			}
			// edges were collected from b back to a; reverse into a->b order
			for i, j := 0, len(path)-1; i < j; i, j = i+1, j-1 {
				path[i], path[j] = path[j], path[i]
			}
			return path
		}
		for _, e := range adj[v] {
			if _, seen := prev[e.to]; !seen {
				prev[e.to] = edge{to: v, id: e.id, t: e.t}
				queue = append(queue, e.to)
			}
		}
	}
	return nil
}

// Add inserts a constraint. On success it returns nil and commits a new
// version. If the constraint contradicts the existing ones, it returns a
// *Conflict carrying the closed loop and its composite transform, and the
// Calibrator is left unchanged. Adding a duplicate constraint ID is an error.
func (c *Calibrator) Add(k Constraint) error {
	c.ensure()
	if _, dup := c.constraints[k.ID]; dup {
		return fmt.Errorf("robocalib: constraint ID %d already exists", k.ID)
	}
	if k.From == k.To {
		if !k.T.IsIdentity() {
			return &Conflict{Cycle: []int{k.ID}, Composite: k.T}
		}
		c.constraints[k.ID] = k
		if _, known := c.comp[k.From]; !known {
			c.pot[k.From] = Identity()
			c.comp[k.From] = k.From
		}
		c.commit()
		return nil
	}

	_, fromKnown := c.comp[k.From]
	_, toKnown := c.comp[k.To]

	switch {
	case fromKnown && toKnown && c.comp[k.From] == c.comp[k.To]:
		// Both endpoints already share a component: check consistency.
		if !k.T.Compose(c.pot[k.From]).Equal(c.pot[k.To]) {
			return c.buildConflict(k)
		}
		c.constraints[k.ID] = k
		c.commit()
		return nil

	case fromKnown && toKnown:
		c.constraints[k.ID] = k
		c.mergeComponents(k)
		c.commit()
		return nil

	default:
		// At least one endpoint is new; link it into the graph.
		c.constraints[k.ID] = k
		switch {
		case fromKnown:
			origin := c.comp[k.From]
			c.pot[k.To] = k.T.Compose(c.pot[k.From])
			c.comp[k.To] = origin
			if k.To < origin {
				c.rebase(origin, k.To)
			}
		case toKnown:
			origin := c.comp[k.To]
			c.pot[k.From] = k.T.Inverse().Compose(c.pot[k.To])
			c.comp[k.From] = origin
			if k.From < origin {
				c.rebase(origin, k.From)
			}
		default:
			if k.From < k.To {
				c.pot[k.From] = Identity()
				c.pot[k.To] = k.T
				c.comp[k.From], c.comp[k.To] = k.From, k.From
			} else {
				c.pot[k.To] = Identity()
				c.pot[k.From] = k.T.Inverse()
				c.comp[k.From], c.comp[k.To] = k.To, k.To
			}
		}
		c.commit()
		return nil
	}
}

// buildConflict constructs the closed-loop certificate for a rejected
// constraint: new edge From->To, then the existing path from To back to From.
func (c *Calibrator) buildConflict(k Constraint) *Conflict {
	path := c.findPath(k.To, k.From)
	composite := k.T
	cycle := []int{k.ID}
	for _, e := range path {
		composite = e.t.Compose(composite)
		cycle = append(cycle, e.id)
	}
	return &Conflict{Cycle: cycle, Composite: composite}
}

// mergeComponents folds the two components joined by k into one, keeping the
// smaller robot ID as the origin of the merged component.
func (c *Calibrator) mergeComponents(k Constraint) {
	oFrom, oTo := c.comp[k.From], c.comp[k.To]
	if oFrom == oTo {
		return
	}
	if oFrom < oTo {
		// pose(r) for r in To's component, expressed from oFrom:
		// pose(r) = pot[r] ∘ pose(oTo), pose(oTo) = pot[k.To]^-1 ∘ k.T ∘ pot[k.From] ∘ pose(oFrom)
		base := c.pot[k.To].Inverse().Compose(k.T).Compose(c.pot[k.From])
		for r, o := range c.comp {
			if o == oTo {
				c.pot[r] = c.pot[r].Compose(base)
				c.comp[r] = oFrom
			}
		}
	} else {
		// pose(oFrom) = pot[k.From]^-1 ∘ k.T^-1 ∘ pot[k.To] ∘ pose(oTo)
		base := c.pot[k.From].Inverse().Compose(k.T.Inverse()).Compose(c.pot[k.To])
		for r, o := range c.comp {
			if o == oFrom {
				c.pot[r] = c.pot[r].Compose(base)
				c.comp[r] = oTo
			}
		}
	}
}

// rebase shifts every potential in oldOrigin's component so that newOrigin
// (a member of the same component, with a smaller ID) becomes the origin.
func (c *Calibrator) rebase(oldOrigin, newOrigin int) {
	inv := c.pot[newOrigin].Inverse()
	for r, o := range c.comp {
		if o == oldOrigin {
			c.pot[r] = c.pot[r].Compose(inv)
			c.comp[r] = newOrigin
		}
	}
}

// Remove deletes a constraint by ID. It returns false when the ID is
// unknown; otherwise it rebuilds the derived state and commits a version.
func (c *Calibrator) Remove(id int) bool {
	c.ensure()
	if _, ok := c.constraints[id]; !ok {
		return false
	}
	delete(c.constraints, id)
	c.rebuild()
	c.commit()
	return true
}

// rebuild recomputes components and potentials from scratch. Potentials are
// expressed relative to the minimum robot ID of each component.
func (c *Calibrator) rebuild() {
	c.pot = map[int]Transform{}
	c.comp = map[int]int{}
	adj := c.adjacency()
	robots := make([]int, 0, len(adj))
	for r := range adj {
		robots = append(robots, r)
	}
	sort.Ints(robots)
	for _, start := range robots {
		if _, seen := c.pot[start]; seen {
			continue
		}
		// BFS from start, potentials relative to start.
		c.pot[start] = Identity()
		members := []int{start}
		queue := []int{start}
		for len(queue) > 0 {
			v := queue[0]
			queue = queue[1:]
			for _, e := range adj[v] {
				if _, seen := c.pot[e.to]; !seen {
					c.pot[e.to] = e.t.Compose(c.pot[v])
					members = append(members, e.to)
					queue = append(queue, e.to)
				}
			}
		}
		origin := members[0]
		for _, m := range members[1:] {
			if m < origin {
				origin = m
			}
		}
		inv := c.pot[origin].Inverse()
		for _, m := range members {
			c.pot[m] = c.pot[m].Compose(inv)
			c.comp[m] = origin
		}
	}
}

// Version returns the index of the current snapshot (0-based).
func (c *Calibrator) Version() int { return len(c.versions) - 1 }

// Snapshot returns the immutable snapshot committed at version v.
func (c *Calibrator) Snapshot(v int) (Snapshot, bool) {
	if v < 0 || v >= len(c.versions) {
		return Snapshot{}, false
	}
	return c.versions[v], true
}

// Snapshot is an immutable view of one committed version of a Calibrator.
type Snapshot struct {
	constraints map[int]Constraint
	pot         map[int]Transform
	comp        map[int]int
}

// Constraints lists the constraints of this version, sorted by ID.
func (s Snapshot) Constraints() []Constraint {
	out := make([]Constraint, 0, len(s.constraints))
	for _, k := range s.constraints {
		out = append(out, k)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Origin returns the origin (minimum robot ID) of robot's component.
func (s Snapshot) Origin(robot int) (int, bool) {
	o, ok := s.comp[robot]
	return o, ok
}

// Pose returns the transform mapping the component origin's frame to the
// robot's frame: pose(robot) = Pose ∘ pose(origin).
func (s Snapshot) Pose(robot int) (Transform, bool) {
	t, ok := s.pot[robot]
	return t, ok
}

// Relative returns the transform mapping a's frame to b's frame:
// pose(b) = Relative ∘ pose(a). It fails when a and b are not connected.
func (s Snapshot) Relative(a, b int) (Transform, bool) {
	pa, oka := s.pot[a]
	pb, okb := s.pot[b]
	if !oka || !okb || s.comp[a] != s.comp[b] {
		return Transform{}, false
	}
	return pb.Compose(pa.Inverse()), true
}

// Component returns the sorted robot IDs of robot's connected component.
func (s Snapshot) Component(robot int) ([]int, bool) {
	origin, ok := s.comp[robot]
	if !ok {
		return nil, false
	}
	var members []int
	for r, o := range s.comp {
		if o == origin {
			members = append(members, r)
		}
	}
	sort.Ints(members)
	return members, true
}
