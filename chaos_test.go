package idalloc

import (
	"fmt"
	"math/rand"
	"testing"
)

// TestFaultInjectionUniqueness hammers the allocator and nodes with
// injected disk-write failures, mid-operation crashes (unsynced data lost)
// and lost acknowledgments, then verifies that across the whole history no
// integer was ever delivered twice. Holes are expected and allowed.
func TestFaultInjectionUniqueness(t *testing.T) {
	for _, seed := range []int64{1, 7, 20261005} {
		seed := seed
		t.Run(fmt.Sprintf("seed=%d", seed), func(t *testing.T) {
			runChaos(t, seed)
		})
	}
}

func runChaos(t *testing.T, seed int64) {
	rng := rand.New(rand.NewSource(seed))
	store := NewCrashStorage()
	crashed := false
	store.OnCrash = func() { crashed = true }

	alloc, err := OpenAllocator(store)
	if err != nil {
		t.Fatalf("OpenAllocator: %v", err)
	}
	nodeIDs := []string{"alpha", "bravo", "charlie", "delta"}
	nodes := map[string]*Node{}

	delivered := map[int64]int{} // full history of ids handed to callers
	var crashes, acquires, transfers, issues int

	reopen := func() {
		a, err := OpenAllocator(store)
		if err != nil {
			t.Fatalf("reopen allocator: %v", err)
		}
		alloc = a
		fresh := make(map[string]*Node, len(nodes))
		for id := range nodes {
			n := NewNode(id, store, alloc)
			if err := n.Load(); err != nil {
				t.Fatalf("reload node %s: %v", id, err)
			}
			fresh[id] = n
		}
		nodes = fresh
		crashed = false
	}
	getNode := func(id string) *Node {
		n, ok := nodes[id]
		if !ok {
			n = NewNode(id, store, alloc)
			if err := n.Load(); err != nil {
				t.Fatalf("load node %s: %v", id, err)
			}
			nodes[id] = n
		}
		return n
	}

	for step := 0; step < 4000; step++ {
		if crashed {
			crashes++
			reopen()
		}
		// Inject storage faults.
		switch rng.Intn(16) {
		case 0:
			store.ArmFailWrites(1 + rng.Intn(2))
		case 1:
			store.ArmCrashAfterWrites(1 + rng.Intn(3))
		case 2:
			store.Crash()
		}

		switch rng.Intn(8) {
		case 0, 1: // acquire a fresh range
			acquires++
			_ = getNode(nodeIDs[rng.Intn(len(nodeIDs))]).Acquire(1 + rng.Int63n(16))
		case 2, 3, 4, 5: // issue an id; the ack to the caller may be lost
			issues++
			id, err := getNode(nodeIDs[rng.Intn(len(nodeIDs))]).Issue()
			if err == nil && rng.Intn(5) != 0 {
				delivered[id]++
			}
		case 6: // cooperative handover; the new owner's attach ack may be lost
			transfers++
			target := nodeIDs[rng.Intn(len(nodeIDs))]
			lease, err := getNode(nodeIDs[rng.Intn(len(nodeIDs))]).HandOver(target)
			if err == nil && rng.Intn(4) != 0 {
				_ = getNode(target).Attach(lease)
			}
		case 7: // operator transfers a (possibly dead) owner's range by its
			// durable cursor; the new owner's attach ack may be lost
			transfers++
			ranges := alloc.Ranges()
			if len(ranges) == 0 {
				continue
			}
			rec := ranges[rng.Intn(len(ranges))]
			st, err := LoadNodeState(store, rec.NodeID)
			if err != nil || st.RangeID != rec.ID || st.Generation != rec.Generation {
				continue
			}
			target := nodeIDs[rng.Intn(len(nodeIDs))]
			// The cursor is read by the allocator only after the old
			// generation is durably closed.
			lease, err := alloc.Transfer(rec.ID, target, func() (int64, error) {
				st, err := LoadNodeState(store, rec.NodeID)
				if err != nil {
					return 0, err
				}
				return st.Cursor, nil
			})
			if err == nil && rng.Intn(4) != 0 {
				_ = getNode(target).Attach(lease)
			}
		}
	}
	if crashed {
		crashes++
	}
	reopen()

	// Drain the surviving leases so the tails are actually consumed.
	for _, n := range nodes {
		for {
			id, err := n.Issue()
			if err != nil {
				break
			}
			delivered[id]++
		}
	}

	// The core invariant: no integer was ever delivered twice.
	for id, count := range delivered {
		if count != 1 {
			t.Fatalf("id %d delivered %d times", id, count)
		}
	}
	// Every delivered id comes from reserved space below the high-water mark.
	next := alloc.Next()
	for id := range delivered {
		if id < 1 || id >= next {
			t.Fatalf("id %d outside reserved space [1,%d)", id, next)
		}
	}
	// The final range table is pairwise non-overlapping.
	ranges := alloc.Ranges()
	for i := 1; i < len(ranges); i++ {
		if ranges[i].Start <= ranges[i-1].End {
			t.Fatalf("overlapping ranges: %+v vs %+v", ranges[i-1], ranges[i])
		}
	}
	if len(delivered) < 100 {
		t.Fatalf("chaos run delivered only %d ids; faults too dense to be meaningful", len(delivered))
	}
	holes := next - 1 - int64(len(delivered))
	t.Logf("crashes=%d acquires=%d transfers=%d issue-ops=%d delivered=%d reserved=%d holes=%d",
		crashes, acquires, transfers, issues, len(delivered), next-1, holes)
}

// TestNaiveAckBeforePersistDuplicates is the negative control: an issuer
// that hands out the id before persisting its cursor DOES reissue after a
// crash. It proves the harness detects duplicates and motivates the
// persist-before-ack ordering used by Node.Issue.
func TestNaiveAckBeforePersistDuplicates(t *testing.T) {
	store := NewCrashStorage()
	writeCursor := func(cursor int64) {
		if err := store.Write("naive.json", []byte(fmt.Sprintf(`{"cursor":%d}`, cursor))); err != nil {
			t.Fatal(err)
		}
		if err := store.Sync(); err != nil {
			t.Fatal(err)
		}
	}
	readCursor := func() int64 {
		data, err := store.Read("naive.json")
		if err != nil {
			t.Fatal(err)
		}
		var cursor int64
		if _, err := fmt.Sscanf(string(data), `{"cursor":%d}`, &cursor); err != nil {
			t.Fatal(err)
		}
		return cursor
	}

	delivered := map[int64]int{}
	writeCursor(1)

	// Session 1: ack the id first, then persist (unsynced) — crash hits.
	cursor := readCursor()
	delivered[cursor]++
	if err := store.Write("naive.json", []byte(`{"cursor":2}`)); err != nil {
		t.Fatal(err)
	}
	store.Crash() // unsynced cursor advance is lost

	// Session 2: recovers the stale cursor and reissues the same id.
	cursor = readCursor()
	delivered[cursor]++

	if delivered[1] != 2 {
		t.Fatalf("negative control broken: id 1 delivered %d times, want 2", delivered[1])
	}
}
