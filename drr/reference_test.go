package drr_test

import (
	"fmt"
	"math/rand"
	"testing"

	"scheduler/drr"
)

// refModel is an independent, list-based reference implementation of the
// scheduling spec. It shares no code with drr.Scheduler: tenants live in a
// plain slice and the active set is an explicit list of indexes, appended
// on activation and shrunk on drain. Property tests cross-check the real
// scheduler against it.
type refModel struct {
	round  int
	ten    []refTenant
	active []int
	ledger []drr.LedgerEntry
}

type refTenant struct {
	id         string
	weight     int64
	nextWeight int64
	deficit    int64
	queue      []drr.Task
}

func (m *refModel) idx(id string) int {
	for i := range m.ten {
		if m.ten[i].id == id {
			return i
		}
	}
	return -1
}

func (m *refModel) addTenant(id string, w int64) {
	m.ten = append(m.ten, refTenant{id: id, weight: w, nextWeight: w})
}

func (m *refModel) setWeight(id string, w int64) {
	m.ten[m.idx(id)].nextWeight = w
}

func (m *refModel) enqueue(id string, task drr.Task) {
	i := m.idx(id)
	if len(m.ten[i].queue) == 0 {
		m.active = append(m.active, i)
	}
	m.ten[i].queue = append(m.ten[i].queue, task)
}

func (m *refModel) runRound() {
	m.round++
	for i := range m.ten {
		m.ten[i].weight = m.ten[i].nextWeight
	}
	for i := 0; i < len(m.active); {
		t := &m.ten[m.active[i]]
		t.deficit += t.weight
		for len(t.queue) > 0 && t.queue[0].Cost <= t.deficit {
			task := t.queue[0]
			before := t.deficit
			t.deficit -= task.Cost
			t.queue = t.queue[1:]
			m.ledger = append(m.ledger, drr.LedgerEntry{
				Round:         m.round,
				Tenant:        t.id,
				Task:          task.ID,
				Cost:          task.Cost,
				Weight:        t.weight,
				DeficitBefore: before,
				DeficitAfter:  t.deficit,
			})
		}
		if len(t.queue) == 0 {
			t.deficit = 0
			m.active = append(m.active[:i], m.active[i+1:]...)
		} else {
			i++
		}
	}
}

// TestAgainstReferenceModel drives both implementations through identical
// random operation sequences — including huge tasks and mid-run weight
// changes — and requires identical ledgers and zero starvation.
func TestAgainstReferenceModel(t *testing.T) {
	for seed := int64(0); seed < 30; seed++ {
		t.Run(fmt.Sprintf("seed=%d", seed), func(t *testing.T) {
			rng := rand.New(rand.NewSource(seed))
			s := drr.New()
			ref := &refModel{}

			tenantIDs := []string{"t0", "t1", "t2", "t3"}
			for _, id := range tenantIDs {
				w := int64(1 + rng.Intn(5))
				mustAdd(t, s, id, w)
				ref.addTenant(id, w)
			}

			taskSeq := 0
			for step := 0; step < 200; step++ {
				switch rng.Intn(10) {
				case 0, 1: // weight update, effective next round
					id := tenantIDs[rng.Intn(len(tenantIDs))]
					w := int64(1 + rng.Intn(8))
					if err := s.SetWeight(id, w); err != nil {
						t.Fatal(err)
					}
					ref.setWeight(id, w)
				case 2: // occasionally a huge task (starvation probe)
					id := tenantIDs[rng.Intn(len(tenantIDs))]
					task := drr.Task{ID: fmt.Sprintf("huge-%d", taskSeq), Cost: int64(100 + rng.Intn(900))}
					taskSeq++
					mustEnqueue(t, s, id, task)
					ref.enqueue(id, task)
				default: // regular small/medium task
					id := tenantIDs[rng.Intn(len(tenantIDs))]
					task := drr.Task{ID: fmt.Sprintf("task-%d", taskSeq), Cost: int64(rng.Intn(12))}
					taskSeq++
					mustEnqueue(t, s, id, task)
					ref.enqueue(id, task)
				}
				s.RunRound()
				ref.runRound()
			}
			// Drain: keep running until both are idle.
			for i := 0; i < 200000; i++ {
				empty := true
				for _, id := range tenantIDs {
					if n, _ := s.QueueLen(id); n > 0 {
						empty = false
					}
				}
				if empty {
					break
				}
				s.RunRound()
				ref.runRound()
			}

			got, want := s.Ledger(), ref.ledger
			if len(got) != len(want) {
				t.Fatalf("ledger length %d != reference %d", len(got), len(want))
			}
			for i := range got {
				if got[i] != want[i] {
					t.Fatalf("ledger[%d] = %+v, reference = %+v", i, got[i], want[i])
				}
			}
			if len(got) != taskSeq {
				t.Fatalf("served %d tasks, enqueued %d: some task starved", len(got), taskSeq)
			}
		})
	}
}
