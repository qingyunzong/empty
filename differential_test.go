package rolelib

import (
	"fmt"
	"math/rand"
	"reflect"
	"testing"
)

// TestDifferentialWithFullClosureModel cross-checks Library against Naive,
// the full-closure reference model: random operation sequences must produce
// identical accept/reject decisions, identical conflict chain lengths, and
// identical effective state in both implementations.
func TestDifferentialWithFullClosureModel(t *testing.T) {
	users := []string{"u0", "u1", "u2"}
	roles := []string{"r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7"}

	for seed := int64(0); seed < 60; seed++ {
		rng := rand.New(rand.NewSource(seed))
		lib := New()
		nav := NewNaive()
		live := map[int]bool{}

		role := func() string { return roles[rng.Intn(len(roles))] }
		user := func() string { return users[rng.Intn(len(users))] }
		liveSession := func() (int, bool) {
			if len(live) == 0 {
				return 0, false
			}
			ids := make([]int, 0, len(live))
			for id := range live {
				ids = append(ids, id)
			}
			return ids[rng.Intn(len(ids))], true
		}

		for step := 0; step < 400; step++ {
			desc := ""
			var errL, errN error
			switch rng.Intn(11) {
			case 0:
				c, p := role(), role()
				desc = fmt.Sprintf("AddInheritance(%s,%s)", c, p)
				errL, errN = lib.AddInheritance(c, p), nav.AddInheritance(c, p)
			case 1:
				c, p := role(), role()
				desc = fmt.Sprintf("RemoveInheritance(%s,%s)", c, p)
				lib.RemoveInheritance(c, p)
				nav.RemoveInheritance(c, p)
			case 2:
				a, b := role(), role()
				desc = fmt.Sprintf("AddSSD(%s,%s)", a, b)
				errL, errN = lib.AddSSD(a, b), nav.AddSSD(a, b)
			case 3:
				a, b := role(), role()
				desc = fmt.Sprintf("AddDSD(%s,%s)", a, b)
				errL, errN = lib.AddDSD(a, b), nav.AddDSD(a, b)
			case 4:
				u, r := user(), role()
				desc = fmt.Sprintf("Grant(%s,%s)", u, r)
				errL, errN = lib.Grant(u, r), nav.Grant(u, r)
			case 5:
				u := user()
				n := 1 + rng.Intn(3)
				batch := make([]string, 0, n)
				seen := map[string]bool{}
				for len(batch) < n {
					if r := role(); !seen[r] {
						seen[r] = true
						batch = append(batch, r)
					}
				}
				desc = fmt.Sprintf("GrantBatch(%s,%v)", u, batch)
				errL, errN = lib.GrantBatch(u, batch...), nav.GrantBatch(u, batch...)
			case 6:
				u, r := user(), role()
				desc = fmt.Sprintf("Revoke(%s,%s)", u, r)
				lib.Revoke(u, r)
				nav.Revoke(u, r)
			case 7:
				u := user()
				desc = fmt.Sprintf("OpenSession(%s)", u)
				idL, idN := lib.OpenSession(u), nav.OpenSession(u)
				if idL != idN {
					t.Fatalf("seed %d step %d %s: session ids differ: %d vs %d", seed, step, desc, idL, idN)
				}
				live[idL] = true
			case 8:
				if id, ok := liveSession(); ok {
					r := role()
					desc = fmt.Sprintf("Activate(%d,%s)", id, r)
					errL, errN = lib.Activate(id, r), nav.Activate(id, r)
				}
			case 9:
				if id, ok := liveSession(); ok {
					r := role()
					desc = fmt.Sprintf("Deactivate(%d,%s)", id, r)
					errL, errN = lib.Deactivate(id, r), nav.Deactivate(id, r)
				}
			case 10:
				if id, ok := liveSession(); ok {
					desc = fmt.Sprintf("CloseSession(%d)", id)
					lib.CloseSession(id)
					nav.CloseSession(id)
					delete(live, id)
				}
			}

			if (errL == nil) != (errN == nil) {
				t.Fatalf("seed %d step %d %s: err mismatch: lib=%v naive=%v", seed, step, desc, errL, errN)
			}
			if errL != nil && fmt.Sprintf("%T", errL) != fmt.Sprintf("%T", errN) {
				t.Fatalf("seed %d step %d %s: err type mismatch: lib=%v naive=%v", seed, step, desc, errL, errN)
			}
			if ce, ok := errL.(*ConflictError); ok {
				ne := errN.(*ConflictError)
				lenL := len(ce.Conflict.ChainA) + len(ce.Conflict.ChainB)
				lenN := len(ne.Conflict.ChainA) + len(ne.Conflict.ChainB)
				if lenL != lenN || ce.Conflict.Kind != ne.Conflict.Kind {
					t.Fatalf("seed %d step %d %s: conflict mismatch: lib=%v naive=%v", seed, step, desc, ce, ne)
				}
			}

			for _, u := range users {
				if got, want := lib.EffectiveRoles(u), nav.EffectiveRoles(u); !reflect.DeepEqual(got, want) {
					t.Fatalf("seed %d step %d %s: EffectiveRoles(%s): lib=%v naive=%v", seed, step, desc, u, got, want)
				}
			}
			for id := range live {
				got, err := lib.SessionRoles(id)
				if err != nil {
					t.Fatalf("seed %d step %d %s: lib.SessionRoles(%d): %v", seed, step, desc, id, err)
				}
				want, err := nav.SessionRoles(id)
				if err != nil {
					t.Fatalf("seed %d step %d %s: naive.SessionRoles(%d): %v", seed, step, desc, id, err)
				}
				if !reflect.DeepEqual(got, want) {
					t.Fatalf("seed %d step %d %s: SessionRoles(%d): lib=%v naive=%v", seed, step, desc, id, got, want)
				}
			}
		}
	}
}
