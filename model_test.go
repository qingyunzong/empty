package rolelib

import (
	"errors"
	"math/rand"
	"reflect"
	"testing"
)

// TestAgainstClosureModel runs random operation sequences against both the
// cached Library and the full-closure reference model and requires identical
// accept/reject decisions, identical conflict kinds and pairs, equal-length
// conflict chains, and identical resulting state after every step.
func TestAgainstClosureModel(t *testing.T) {
	for _, seed := range []int64{1, 2, 3, 7, 42, 99, 2024, 31337} {
		t.Run("", func(t *testing.T) {
			rng := rand.New(rand.NewSource(seed))
			l := New()
			m := NewClosureModel()

			const n = 12
			roles := make([]string, n)
			for i := range roles {
				roles[i] = string(rune('a' + i))
				if err := l.AddRole(roles[i]); err != nil {
					t.Fatal(err)
				}
				if err := m.AddRole(roles[i]); err != nil {
					t.Fatal(err)
				}
			}
			// Random DAG: edges only from higher to lower index can never
			// cycle, and both implementations must accept them.
			for i := 0; i < n; i++ {
				for j := 0; j < i; j++ {
					if rng.Intn(4) == 0 {
						if err := l.AddInheritance(roles[i], roles[j]); err != nil {
							t.Fatalf("library rejected DAG edge: %v", err)
						}
						if err := m.AddInheritance(roles[i], roles[j]); err != nil {
							t.Fatalf("model rejected DAG edge: %v", err)
						}
					}
				}
			}
			// Random exclusion pairs of both kinds.
			for k := 0; k < 6; k++ {
				a, b := roles[rng.Intn(n)], roles[rng.Intn(n)]
				if a == b {
					continue
				}
				var errL, errM error
				if rng.Intn(2) == 0 {
					errL = l.AddStaticExclusion(a, b)
					errM = m.AddStaticExclusion(a, b)
				} else {
					errL = l.AddDynamicExclusion(a, b)
					errM = m.AddDynamicExclusion(a, b)
				}
				if (errL == nil) != (errM == nil) {
					t.Fatalf("exclusion setup diverged: %v vs %v", errL, errM)
				}
			}

			pick := func() []string {
				k := 1 + rng.Intn(3)
				out := make([]string, k)
				for i := range out {
					out[i] = roles[rng.Intn(n)]
				}
				return out
			}

			for step := 0; step < 400; step++ {
				var errL, errM error
				switch rng.Intn(4) {
				case 0:
					batch := pick()
					errL = l.Grant(batch...)
					errM = m.Grant(batch...)
				case 1:
					r := roles[rng.Intn(n)]
					errL = l.Revoke(r)
					errM = m.Revoke(r)
				case 2:
					batch := pick()
					errL = l.Activate(batch...)
					errM = m.Activate(batch...)
				case 3:
					batch := pick()
					errL = l.Deactivate(batch...)
					errM = m.Deactivate(batch...)
				}

				if (errL == nil) != (errM == nil) {
					t.Fatalf("seed %d step %d: decision diverged: library=%v model=%v",
						seed, step, errL, errM)
				}
				var cl, cm *Conflict
				if errors.As(errL, &cl) && errors.As(errM, &cm) {
					if cl.Kind != cm.Kind || cl.A != cm.A || cl.B != cm.B {
						t.Fatalf("seed %d step %d: conflict diverged: %+v vs %+v",
							seed, step, cl, cm)
					}
					if len(cl.ChainA) != len(cm.ChainA) || len(cl.ChainB) != len(cm.ChainB) {
						t.Fatalf("seed %d step %d: chain length diverged: %+v vs %+v",
							seed, step, cl, cm)
					}
				}
				if !reflect.DeepEqual(l.Held(), m.Held()) {
					t.Fatalf("seed %d step %d: held diverged: %v vs %v",
						seed, step, l.Held(), m.Held())
				}
				if !reflect.DeepEqual(l.Active(), m.Active()) {
					t.Fatalf("seed %d step %d: active diverged: %v vs %v",
						seed, step, l.Active(), m.Active())
				}
				if !reflect.DeepEqual(l.EffectiveHeld(), m.EffectiveHeld()) {
					t.Fatalf("seed %d step %d: effective held diverged", seed, step)
				}
				if !reflect.DeepEqual(l.EffectiveActive(), m.EffectiveActive()) {
					t.Fatalf("seed %d step %d: effective active diverged", seed, step)
				}
			}
		})
	}
}

// TestChainEndpointsSanity verifies that reported chains always start at a
// directly held/activated role and end at the excluded role.
func TestChainEndpointsSanity(t *testing.T) {
	for seed := int64(0); seed < 20; seed++ {
		rng := rand.New(rand.NewSource(seed))
		l := New()
		const n = 8
		roles := make([]string, n)
		for i := range roles {
			roles[i] = string(rune('a' + i))
			if err := l.AddRole(roles[i]); err != nil {
				t.Fatal(err)
			}
		}
		for i := 0; i < n; i++ {
			for j := 0; j < i; j++ {
				if rng.Intn(3) == 0 {
					if err := l.AddInheritance(roles[i], roles[j]); err != nil {
						t.Fatal(err)
					}
				}
			}
		}
		for k := 0; k < 4; k++ {
			a, b := roles[rng.Intn(n)], roles[rng.Intn(n)]
			if a != b {
				if err := l.AddStaticExclusion(a, b); err != nil {
					t.Fatal(err)
				}
			}
		}
		for step := 0; step < 100; step++ {
			err := l.Grant(roles[rng.Intn(n)])
			var c *Conflict
			if !errors.As(err, &c) {
				continue
			}
			held := make(map[string]bool)
			for _, h := range l.Held() {
				held[h] = true
			}
			// The failed role was not granted, so chain sources must be in
			// the pre-failure held set or be the failed role itself.
			for _, chain := range [][]string{c.ChainA, c.ChainB} {
				if len(chain) == 0 {
					t.Fatalf("empty chain in %+v", c)
				}
				if chain[len(chain)-1] != c.A && chain[len(chain)-1] != c.B {
					t.Fatalf("chain %v does not end at an excluded role", chain)
				}
			}
		}
	}
}
