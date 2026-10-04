package seglog

import (
	"errors"
	"fmt"
	"math/rand"
	"path/filepath"
	"reflect"
	"sort"
	"testing"
)

// setModel is the reference implementation: it tracks acks as a plain
// set of segment indices per consumer and derives prefixes and the
// reclamation watermark directly from those sets.
type setModel struct {
	segments  int
	base      int
	cancelled map[string]bool
	acked     map[string]map[int]bool
}

func newSetModel() *setModel {
	return &setModel{
		cancelled: make(map[string]bool),
		acked:     make(map[string]map[int]bool),
	}
}

func (m *setModel) append(n int) { m.segments += n }

func (m *setModel) ack(c string, id int) error {
	if m.cancelled[c] {
		return ErrConsumerCancelled
	}
	if id >= m.segments {
		return ErrSegmentOutOfRange
	}
	if id < m.base {
		return nil
	}
	set := m.acked[c]
	if set == nil {
		set = make(map[int]bool)
		m.acked[c] = set
	}
	set[id] = true
	return nil
}

func (m *setModel) cancel(c string) {
	m.cancelled[c] = true
	delete(m.acked, c)
}

func (m *setModel) prefix(c string) int {
	if m.cancelled[c] {
		return m.base
	}
	p := m.base
	for m.acked[c][p] {
		p++
	}
	return p
}

func (m *setModel) reclaim() int {
	min := m.segments
	active := false
	for c := range m.acked {
		active = true
		if p := m.prefix(c); p < min {
			min = p
		}
	}
	// Consumers known only via cancel tombstones are inactive; consumers
	// that acked nothing retain everything below base, so they pin the
	// watermark at base. Mirror that: only consumers present in acked
	// count as active, matching Store's registration-on-ack.
	if !active || min <= m.base {
		return m.base
	}
	m.base = min
	for c, set := range m.acked {
		for id := range set {
			if id < min {
				delete(set, id)
			}
		}
		m.acked[c] = set
	}
	return m.base
}

func (m *setModel) activeConsumers() []string {
	var names []string
	for c := range m.acked {
		names = append(names, c)
	}
	sort.Strings(names)
	return names
}

// TestReplayAgainstSetModel drives the real store (with periodic
// close/reopen restarts that replay the WAL) and the set reference model
// through the same random operation sequences, then compares prefixes,
// active sets, and the reclamation watermark after every step.
func TestReplayAgainstSetModel(t *testing.T) {
	consumers := []string{"alpha", "beta", "gamma", "delta"}
	for seed := int64(1); seed <= 25; seed++ {
		t.Run(fmt.Sprintf("seed=%d", seed), func(t *testing.T) {
			rng := rand.New(rand.NewSource(seed))
			path := filepath.Join(t.TempDir(), "store.wal")
			store, err := Open(path)
			if err != nil {
				t.Fatal(err)
			}
			model := newSetModel()

			reopen := func() {
				if err := store.Close(); err != nil {
					t.Fatal(err)
				}
				store, err = Open(path)
				if err != nil {
					t.Fatalf("reopen: %v", err)
				}
			}
			defer store.Close()

			check := func(step int) {
				t.Helper()
				if store.Base() != model.base {
					t.Fatalf("step %d: base = %d, model = %d", step, store.Base(), model.base)
				}
				if store.Segments() != model.segments {
					t.Fatalf("step %d: segments = %d, model = %d", step, store.Segments(), model.segments)
				}
				for _, c := range consumers {
					if got, want := store.Cancelled(c), model.cancelled[c]; got != want {
						t.Fatalf("step %d: cancelled(%s) = %v, model = %v", step, c, got, want)
					}
					if got, want := store.Prefix(c), model.prefix(c); got != want {
						t.Fatalf("step %d: prefix(%s) = %d, model = %d", step, c, got, want)
					}
				}
				if got, want := store.ActiveConsumers(), model.activeConsumers(); !reflect.DeepEqual(got, want) {
					t.Fatalf("step %d: active = %v, model = %v", step, got, want)
				}
			}

			for step := 0; step < 400; step++ {
				switch rng.Intn(10) {
				case 0, 1: // append
					n := 1 + rng.Intn(4)
					if _, err := store.Append(n); err != nil {
						t.Fatalf("step %d: append: %v", step, err)
					}
					model.append(n)
				case 2, 3, 4, 5, 6: // ack
					c := consumers[rng.Intn(len(consumers))]
					id := rng.Intn(model.segments + 2) // sometimes out of range
					gotErr := store.Ack(c, id)
					wantErr := model.ack(c, id)
					if !errors.Is(gotErr, wantErr) {
						t.Fatalf("step %d: ack(%s,%d) err = %v, model = %v", step, c, id, gotErr, wantErr)
					}
				case 7: // cancel
					c := consumers[rng.Intn(len(consumers))]
					if err := store.Cancel(c); err != nil {
						t.Fatalf("step %d: cancel: %v", step, err)
					}
					model.cancel(c)
				case 8: // reclaim
					got, err := store.Reclaim()
					if err != nil {
						t.Fatalf("step %d: reclaim: %v", step, err)
					}
					if want := model.reclaim(); got != want {
						t.Fatalf("step %d: reclaim base = %d, model = %d", step, got, want)
					}
				case 9: // restart: replay the WAL from scratch
					reopen()
				}
				check(step)
			}

			// Final restart and one last comparison.
			reopen()
			check(400)
		})
	}
}
