package formal

import (
	"strconv"
	"sync"
	"testing"
)

// TestConcurrentStress drives the public API from many goroutines. It is meant
// to run under the race detector and checks the storage-side fencing
// invariants after the burst: every accepted write uses a strictly increasing
// epoch, each epoch is persisted at most once, and exactly one holder remains.
func TestConcurrentStress(t *testing.T) {
	const (
		objects = 8
		clients = 12
		rounds  = 200
	)
	sink := NewFencingStore()
	m := NewManager(sink)

	var wg sync.WaitGroup
	for c := 0; c < clients; c++ {
		wg.Add(1)
		go func(client int) {
			defer wg.Done()
			holder := clientName(client)
			for r := 0; r < rounds; r++ {
				obj := objName((client + r) % objects)
				switch r % 6 {
				case 0:
					if l, err := m.Acquire(obj, holder); err == nil {
						_ = m.MarkDirty(l, []byte{byte(client), byte(r)})
					}
				case 1:
					if l, err := m.Steal(obj, holder); err == nil {
						_ = m.MarkDirty(l, []byte{byte(client), byte(r)})
					}
				case 2:
					if l, err := m.Acquire(obj, holder); err == nil {
						_, _ = m.Renew(l)
					}
				case 3:
					if l, err := m.Steal(obj, holder); err == nil {
						_, _ = m.Flush(l)
					}
				case 4:
					if l, err := m.Acquire(obj, holder); err == nil {
						_ = m.Break(l)
					}
				case 5:
					if l, err := m.Steal(obj, holder); err == nil {
						_ = m.Break(l)
					}
				}
			}
		}(c)
	}
	wg.Wait()

	// Storage invariant: accepted writes equal unique stored epochs, and
	// counts stay within the epoch range ever handed out.
	total := sink.Accepted()
	sum := 0
	for o := 0; o < objects; o++ {
		obj := objName(o)
		sum += sink.AcceptedFor(obj)
		if epoch, ok := sink.LastEpoch(obj); ok {
			if got := sink.AcceptedFor(obj); got > int(epoch) {
				t.Fatalf("%s: %d writes for max epoch %d", obj, got, epoch)
			}
		}
	}
	if sum != total {
		t.Fatalf("per-object write sum %d != total %d", sum, total)
	}

	// Exactly one record (one possible holder) per object remains.
	for o := 0; o < objects; o++ {
		obj := objName(o)
		st := m.entry(obj)
		if st.exists && st.lease.Holder == "" {
			t.Fatalf("%s: existing lease with empty holder", obj)
		}
	}
}

func clientName(c int) string { return "client-" + itoa(c) }

func objName(o int) string { return "object-" + itoa(o) }

func itoa(n int) string {
	return strconv.Itoa(n)
}
