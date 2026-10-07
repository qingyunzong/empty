package robocalib

import (
	"errors"
	"math/rand"
	"sort"
	"testing"
)

// reference recomputes components and potentials from scratch: for every
// connected component it runs BFS from the minimum robot ID and composes
// transforms along the full BFS path to each robot. It is deliberately
// independent of the Calibrator's incremental logic.
type reference struct {
	pot  map[int]Transform
	comp map[int]int
}

func computeReference(constraints []Constraint) reference {
	adj := map[int][]edge{}
	for _, k := range constraints {
		adj[k.From] = append(adj[k.From], edge{to: k.To, id: k.ID, t: k.T})
		adj[k.To] = append(adj[k.To], edge{to: k.From, id: k.ID, t: k.T.Inverse()})
	}
	robots := make([]int, 0, len(adj))
	for r := range adj {
		robots = append(robots, r)
	}
	sort.Ints(robots)

	ref := reference{pot: map[int]Transform{}, comp: map[int]int{}}
	for _, start := range robots {
		if _, seen := ref.pot[start]; seen {
			continue
		}
		// start is the smallest unvisited robot, hence the component origin.
		ref.pot[start] = Identity()
		ref.comp[start] = start
		queue := []int{start}
		for len(queue) > 0 {
			v := queue[0]
			queue = queue[1:]
			for _, e := range adj[v] {
				if _, seen := ref.pot[e.to]; !seen {
					ref.pot[e.to] = e.t.Compose(ref.pot[v])
					ref.comp[e.to] = start
					queue = append(queue, e.to)
				}
			}
		}
	}
	return ref
}

// checkSnapshot verifies one snapshot against the reference model: identical
// components and potentials, every constraint satisfied, and Relative()
// agreeing with the potentials.
func checkSnapshot(t *testing.T, snap Snapshot, ref reference, constraints []Constraint) {
	t.Helper()
	if len(snap.comp) != len(ref.comp) {
		t.Fatalf("tracked robots = %d, reference %d", len(snap.comp), len(ref.comp))
	}
	for robot, wantOrigin := range ref.comp {
		origin, ok := snap.Origin(robot)
		if !ok || origin != wantOrigin {
			t.Fatalf("Origin(%d) = %d,%v; reference %d", robot, origin, ok, wantOrigin)
		}
		pose, ok := snap.Pose(robot)
		if !ok || !pose.Equal(ref.pot[robot]) {
			t.Fatalf("Pose(%d) = %v; reference %v", robot, pose, ref.pot[robot])
		}
	}
	for _, k := range constraints {
		got := k.T.Compose(ref.pot[k.From])
		if !got.Equal(ref.pot[k.To]) {
			t.Fatalf("constraint %+v violated: %v != %v", k, got, ref.pot[k.To])
		}
	}
	// Relative poses between random pairs must match the potentials.
	robots := make([]int, 0, len(ref.pot))
	for r := range ref.pot {
		robots = append(robots, r)
	}
	for _, a := range robots {
		for _, b := range robots {
			rel, ok := snap.Relative(a, b)
			if ref.comp[a] != ref.comp[b] {
				if ok {
					t.Fatalf("Relative(%d,%d) succeeded across components", a, b)
				}
				continue
			}
			want := ref.pot[b].Compose(ref.pot[a].Inverse())
			if !ok || !rel.Equal(want) {
				t.Fatalf("Relative(%d,%d) = %v,%v; want %v", a, b, rel, ok, want)
			}
		}
	}
	// Component() must list exactly the reference members, sorted.
	for _, a := range robots {
		members, ok := snap.Component(a)
		if !ok {
			t.Fatalf("Component(%d) failed", a)
		}
		var want []int
		for r, o := range ref.comp {
			if o == ref.comp[a] {
				want = append(want, r)
			}
		}
		sort.Ints(want)
		if len(members) != len(want) {
			t.Fatalf("Component(%d) = %v, want %v", a, members, want)
		}
		for i := range want {
			if members[i] != want[i] {
				t.Fatalf("Component(%d) = %v, want %v", a, members, want)
			}
		}
	}
}

// TestRandomGraphAgainstReference drives the Calibrator with random adds and
// removes, then checks every retained snapshot against the independently
// computed full-path reference.
func TestRandomGraphAgainstReference(t *testing.T) {
	const robots = 12
	rng := rand.New(rand.NewSource(42))

	// Ground-truth pose per robot; constraints derived from it are
	// consistent by construction.
	truth := make([]Transform, robots)
	for i := range truth {
		truth[i] = randomTransform(rng)
	}
	derive := func(from, to int) Transform {
		// pose(to) = T ∘ pose(from) with T = truth[to] ∘ truth[from]⁻¹.
		return truth[to].Compose(truth[from].Inverse())
	}

	c := New()
	live := map[int]Constraint{} // constraints expected to be stored
	nextID := 1

	snapshotConstraints := func() []Constraint {
		out := make([]Constraint, 0, len(live))
		for _, k := range live {
			out = append(out, k)
		}
		return out
	}

	checkAll := func(step int) {
		t.Helper()
		// Current state must match the reference for the live constraints.
		cur := c.versions[c.Version()]
		checkSnapshot(t, cur, computeReference(snapshotConstraints()), snapshotConstraints())
		_ = step
	}

	for step := 0; step < 400; step++ {
		op := rng.Intn(100)
		switch {
		case op < 45:
			// Add a consistent constraint between random robots.
			from, to := rng.Intn(robots), rng.Intn(robots)
			k := Constraint{ID: nextID, From: from, To: to, T: derive(from, to)}
			nextID++
			if err := c.Add(k); err != nil {
				t.Fatalf("step %d: consistent Add(%+v) failed: %v", step, k, err)
			}
			live[k.ID] = k

		case op < 60:
			// Add a corrupted constraint between two connected robots:
			// it must be rejected with a valid loop certificate.
			cur := c.versions[c.Version()]
			var connected [][2]int
			for a := 0; a < robots; a++ {
				for b := 0; b < robots; b++ {
					if a == b {
						continue
					}
					oa, oka := cur.Origin(a)
					ob, okb := cur.Origin(b)
					if oka && okb && oa == ob {
						connected = append(connected, [2]int{a, b})
					}
				}
			}
			if len(connected) == 0 {
				continue
			}
			pair := connected[rng.Intn(len(connected))]
			bad := Constraint{ID: nextID, From: pair[0], To: pair[1]}
			nextID++
			// Perturb the true transform so it stays non-identity off.
			for {
				bad.T = derive(pair[0], pair[1]).Compose(randomTransform(rng))
				if !bad.T.Compose(cur.mustPot(t, pair[0])).Equal(cur.mustPot(t, pair[1])) {
					break
				}
			}
			err := c.Add(bad)
			var conflict *Conflict
			if !errors.As(err, &conflict) {
				t.Fatalf("step %d: corrupted Add(%+v) not rejected: %v", step, bad, err)
			}
			if conflict.Composite.IsIdentity() {
				t.Fatalf("step %d: certificate composite is identity", step)
			}
			if len(conflict.Cycle) < 1 || conflict.Cycle[0] != bad.ID {
				t.Fatalf("step %d: cycle %v must start with %d", step, conflict.Cycle, bad.ID)
			}
			// Every edge named in the cycle must exist (except the rejected one).
			for _, id := range conflict.Cycle[1:] {
				if _, ok := live[id]; !ok {
					t.Fatalf("step %d: cycle references unknown constraint %d", step, id)
				}
			}
			// Certificate check: T' = T ∘ composite⁻¹ must close the loop,
			// so re-adding with T' has to succeed.
			fixed := bad
			fixed.T = bad.T.Compose(conflict.Composite.Inverse())
			if err := c.Add(fixed); err != nil {
				t.Fatalf("step %d: corrected Add(%+v) failed: %v", step, fixed, err)
			}
			live[fixed.ID] = fixed

		case op < 85:
			// Remove a random live constraint.
			if len(live) == 0 {
				continue
			}
			ids := make([]int, 0, len(live))
			for id := range live {
				ids = append(ids, id)
			}
			id := ids[rng.Intn(len(ids))]
			if !c.Remove(id) {
				t.Fatalf("step %d: Remove(%d) failed", step, id)
			}
			delete(live, id)

		default:
			// No-op: just re-verify.
		}
		checkAll(step)
	}

	// Every historical snapshot must satisfy the reference model computed
	// from its own constraint set.
	for v := 0; v <= c.Version(); v++ {
		snap, ok := c.Snapshot(v)
		if !ok {
			t.Fatalf("snapshot %d missing", v)
		}
		constraints := snap.Constraints()
		checkSnapshot(t, snap, computeReference(constraints), constraints)
	}
}

// mustPot fetches a potential from a snapshot in tests.
func (s Snapshot) mustPot(t *testing.T, robot int) Transform {
	t.Helper()
	pot, ok := s.Pose(robot)
	if !ok {
		t.Fatalf("robot %d not tracked", robot)
	}
	return pot
}
