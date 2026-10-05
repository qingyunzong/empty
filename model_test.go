package seglib

import (
	"errors"
	"fmt"
	"math/rand"
	"reflect"
	"testing"
)

// refModel is a deliberately naive reference implementation built on
// plain sets. The real store must agree with it after every operation.
type refModel struct {
	next     uint64
	segments []Segment
	active   map[string]bool
	exited   map[string]ExitRecord
	start    map[string]uint64
	acked    map[string]map[uint64]bool
}

func newRefModel() *refModel {
	return &refModel{
		active: make(map[string]bool),
		exited: make(map[string]ExitRecord),
		start:  make(map[string]uint64),
		acked:  make(map[string]map[uint64]bool),
	}
}

// equalSegments compares segment slices treating nil and empty as equal.
func equalSegments(a, b []Segment) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].Base != b[i].Base || !reflect.DeepEqual(a[i].Msgs, b[i].Msgs) {
			return false
		}
	}
	return true
}

func (m *refModel) prefix(name string) uint64 {
	p := m.start[name]
	for m.acked[name][p] {
		p++
	}
	return p
}

func (m *refModel) reclaimBound() (uint64, bool) {
	var bound uint64
	ok := false
	for name := range m.active {
		if p := m.prefix(name); !ok || p < bound {
			bound, ok = p, true
		}
	}
	return bound, ok
}

func (m *refModel) reclaim() {
	bound, ok := m.reclaimBound()
	if !ok {
		return
	}
	var kept []Segment
	for _, seg := range m.segments {
		if seg.Base+uint64(len(seg.Msgs)) > bound {
			kept = append(kept, seg)
		}
	}
	m.segments = kept
}

func (m *refModel) replay(name string) []Message {
	p := m.prefix(name)
	var out []Message
	for _, seg := range m.segments {
		for i, body := range seg.Msgs {
			if off := seg.Base + uint64(i); off >= p {
				out = append(out, Message{Offset: off, Body: body})
			}
		}
	}
	return out
}

// TestReplayAgainstSetModel drives the store with a random operation
// mix, including simulated restarts, and checks every observable against
// the set-based reference model.
func TestReplayAgainstSetModel(t *testing.T) {
	for _, seed := range []int64{1, 7, 42, 2024, 999983} {
		t.Run(fmt.Sprintf("seed=%d", seed), func(t *testing.T) {
			runModelSimulation(t, seed, 800)
		})
	}
}

func runModelSimulation(t *testing.T, seed int64, steps int) {
	t.Helper()
	rng := rand.New(rand.NewSource(seed))
	dir := t.TempDir()
	store, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	model := newRefModel()
	names := []string{"alpha", "beta", "gamma", "delta", "epsilon"}
	appended := 0

	check := func(step int) {
		t.Helper()
		for _, name := range names {
			wantP := model.prefix(name)
			gotP, gotErr := store.Prefix(name)
			switch {
			case model.active[name]:
				if gotErr != nil || gotP != wantP {
					t.Fatalf("step %d: prefix(%s)=%d,%v want %d,nil", step, name, gotP, gotErr, wantP)
				}
				wantReplay := model.replay(name)
				gotReplay, err := store.Replay(name)
				if err != nil || !reflect.DeepEqual(gotReplay, wantReplay) {
					t.Fatalf("step %d: replay(%s)=%v,%v want %v", step, name, gotReplay, err, wantReplay)
				}
			case model.exited[name].Name != "":
				if !errors.Is(gotErr, ErrConsumerExited) {
					t.Fatalf("step %d: prefix(%s) err=%v want ErrConsumerExited", step, name, gotErr)
				}
			default:
				if !errors.Is(gotErr, ErrNoConsumer) {
					t.Fatalf("step %d: prefix(%s) err=%v want ErrNoConsumer", step, name, gotErr)
				}
			}
		}
		gotBound, gotOK := store.ReclaimBound()
		wantBound, wantOK := model.reclaimBound()
		if gotOK != wantOK || gotBound != wantBound {
			t.Fatalf("step %d: bound=%d,%v want %d,%v", step, gotBound, gotOK, wantBound, wantOK)
		}
		if got, want := store.Segments(), model.segments; !equalSegments(got, want) {
			t.Fatalf("step %d: segments=%+v want %+v", step, got, want)
		}
		for name, rec := range model.exited {
			got, ok := store.Exited(name)
			if !ok || got != rec {
				t.Fatalf("step %d: exit record %s=%+v,%v want %+v", step, name, got, ok, rec)
			}
		}
	}

	for step := 0; step < steps; step++ {
		switch rng.Intn(6) {
		case 0: // append a segment of 1-4 messages
			n := 1 + rng.Intn(4)
			bodies := make([]string, n)
			for i := range bodies {
				bodies[i] = fmt.Sprintf("m%d", appended)
				appended++
			}
			base := store.Append(bodies...)
			model.segments = append(model.segments, Segment{Base: base, Msgs: bodies})
			model.next += uint64(n)

		case 1: // register
			name := names[rng.Intn(len(names))]
			start := uint64(0)
			if model.next > 0 {
				start = uint64(rng.Intn(int(model.next) + 1))
			}
			err := store.Register(name, start)
			switch {
			case model.exited[name].Name != "":
				if !errors.Is(err, ErrConsumerExited) {
					t.Fatalf("step %d: register(%s)=%v want ErrConsumerExited", step, name, err)
				}
			case model.active[name]:
				if !errors.Is(err, ErrConsumerActive) {
					t.Fatalf("step %d: register(%s)=%v want ErrConsumerActive", step, name, err)
				}
			default:
				if err != nil {
					t.Fatalf("step %d: register(%s)=%v", step, name, err)
				}
				model.active[name] = true
				model.start[name] = start
				model.acked[name] = make(map[uint64]bool)
			}

		case 2, 3: // ack, weighted higher; sometimes out of order
			var actives []string
			for name := range model.active {
				actives = append(actives, name)
			}
			if len(actives) == 0 {
				continue
			}
			name := actives[rng.Intn(len(actives))]
			off := uint64(rng.Intn(int(model.next) + 3))
			if err := store.Ack(name, off); err != nil {
				t.Fatalf("step %d: ack(%s,%d)=%v", step, name, off, err)
			}
			model.acked[name][off] = true

		case 4: // cancel
			name := names[rng.Intn(len(names))]
			err := store.Cancel(name)
			switch {
			case model.exited[name].Name != "":
				if !errors.Is(err, ErrConsumerExited) {
					t.Fatalf("step %d: cancel(%s)=%v want ErrConsumerExited", step, name, err)
				}
			case !model.active[name]:
				if !errors.Is(err, ErrNoConsumer) {
					t.Fatalf("step %d: cancel(%s)=%v want ErrNoConsumer", step, name, err)
				}
			default:
				if err != nil {
					t.Fatalf("step %d: cancel(%s)=%v", step, name, err)
				}
				delete(model.active, name)
				model.exited[name] = ExitRecord{Name: name, FinalPrefix: model.prefix(name)}
				delete(model.acked, name)
				delete(model.start, name)
			}

		case 5: // reclaim, then occasionally restart
			store.Reclaim()
			model.reclaim()
			if rng.Intn(4) == 0 {
				store, err = Open(dir)
				if err != nil {
					t.Fatalf("step %d: reopen: %v", step, err)
				}
				// Restart keeps durable exit records; the volatile log
				// and live consumers are gone.
				kept := newRefModel()
				kept.exited = model.exited
				model = kept
			}
		}
		check(step)
	}
}
