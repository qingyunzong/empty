package conveyor

import (
	"fmt"
	"math/rand"
	"sort"
	"testing"
)

// refModel is an independent package-centric reference implementation of a
// single belt. It tracks package positions in a list instead of rotating a
// slot array, so the property test cross-checks the real implementation
// (including wrap-around) against a structurally different model.
type refPkg struct {
	pkg Package
	pos int
}

type refModel struct {
	n, insertAt int
	pkgs        []refPkg
	queue       []Package
	paused      bool
}

func (m *refModel) move() {
	if m.paused {
		return
	}
	for i := range m.pkgs {
		m.pkgs[i].pos = (m.pkgs[i].pos + 1) % m.n
	}
}

func (m *refModel) insert() {
	if len(m.queue) == 0 {
		return
	}
	for _, rp := range m.pkgs {
		if rp.pos == m.insertAt {
			return // insert slot blocked: stay queued
		}
	}
	m.pkgs = append(m.pkgs, refPkg{pkg: m.queue[0], pos: m.insertAt})
	m.queue = m.queue[1:]
}

func (m *refModel) remove() []Package {
	sort.Slice(m.pkgs, func(i, j int) bool { return m.pkgs[i].pos < m.pkgs[j].pos })
	var out []Package
	kept := m.pkgs[:0]
	for _, rp := range m.pkgs {
		if rp.pkg.DestBelt == 0 && rp.pkg.DestSlot == rp.pos {
			out = append(out, rp.pkg)
		} else {
			kept = append(kept, rp)
		}
	}
	m.pkgs = kept
	return out
}

func (m *refModel) tick() []Package {
	m.move()
	m.insert()
	return m.remove()
}

func beltPositions(b *Belt) map[int]int {
	pos := make(map[int]int)
	for i := 0; i < b.Size(); i++ {
		if p := b.Slot(i); p != nil {
			pos[p.ID] = i
		}
	}
	return pos
}

// TestListModelWrapAround runs random single-belt scenarios and compares the
// slot-array implementation against the list reference model tick by tick.
func TestListModelWrapAround(t *testing.T) {
	for seed := int64(0); seed < 60; seed++ {
		rng := rand.New(rand.NewSource(seed))
		n := 1 + rng.Intn(8)
		insertAt := rng.Intn(n)
		belt := NewBelt(0, n, insertAt)
		sys := NewSystem([]*Belt{belt}, nil)
		model := &refModel{n: n, insertAt: insertAt}

		nextID := 1
		var injected []int
		for tick := 0; tick < 300; tick++ {
			for k := 0; k < rng.Intn(3); k++ {
				p := Package{ID: nextID, DestBelt: 0, DestSlot: rng.Intn(n)}
				nextID++
				sys.Inject(0, p)
				model.queue = append(model.queue, p)
				injected = append(injected, p.ID)
			}
			if rng.Intn(10) == 0 {
				on := rng.Intn(2) == 0
				belt.SetFault(rng.Intn(n), on)
				model.paused = len(belt.faulty) > 0
			}

			gotOut := sys.Tick()
			wantOut := model.tick()

			if fmt.Sprint(gotOut) != fmt.Sprint(wantOut) {
				t.Fatalf("seed %d tick %d: outputs %v, model %v", seed, tick, gotOut, wantOut)
			}
			// Cross-check on-belt positions (wrap-around included).
			pos := beltPositions(belt)
			if len(pos) != len(model.pkgs) {
				t.Fatalf("seed %d tick %d: %d on belt, model has %d", seed, tick, len(pos), len(model.pkgs))
			}
			for _, rp := range model.pkgs {
				if pos[rp.pkg.ID] != rp.pos {
					t.Fatalf("seed %d tick %d: pkg %d at slot %d, model says %d",
						seed, tick, rp.pkg.ID, pos[rp.pkg.ID], rp.pos)
				}
			}
			if belt.QueueLen() != len(model.queue) {
				t.Fatalf("seed %d tick %d: queue %d, model %d", seed, tick, belt.QueueLen(), len(model.queue))
			}
			if err := sys.VerifyConservation(injected); err != nil {
				t.Fatalf("seed %d tick %d: %v", seed, tick, err)
			}
		}
	}
}
