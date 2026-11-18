package formal

import (
	"math"
	"math/rand"
	"testing"
)

// TestReplayHandcrafted runs a fixed sequence with interleaved watermark
// moves, late writes, tombstones and probes through both engines.
func TestReplayHandcrafted(t *testing.T) {
	ops := []Op[int]{
		{Kind: OpUpsert, Key: 1, ValidFrom: 0, Value: 10},
		{Kind: OpUpsert, Key: 2, ValidFrom: 0, Value: 20},
		{Kind: OpProbe, EventID: 1, EventTime: 1, Key: 1},
		{Kind: OpProbe, EventID: 2, EventTime: 2, Key: 2},
		{Kind: OpAdvance, Watermark: 6},                   // horizon 6-4=2
		{Kind: OpProbe, EventID: 3, EventTime: 2, Key: 1}, // at horizon, accepted
		{Kind: OpProbe, EventID: 4, EventTime: 1, Key: 1}, // too late, dropped
		{Kind: OpUpsert, Key: 1, ValidFrom: 3, Value: 11}, // revise future of probe 3? no: 3>2
		{Kind: OpUpsert, Key: 1, ValidFrom: 2, Value: 12}, // revises probe 3 at t=2
		{Kind: OpSweep},
		{Kind: OpDelete, Key: 2, ValidFrom: 2}, // revises probe 2 (t=2) with tombstone
		{Kind: OpSweep},
		{Kind: OpLookup, Key: 2, EventTime: 2},
		{Kind: OpLookup, Key: 2, EventTime: 1},
		{Kind: OpAdvance, Watermark: 20}, // horizon 16, GC
		{Kind: OpUpsert, Key: 1, ValidFrom: 15, Value: 13},
		{Kind: OpProbe, EventID: 5, EventTime: 16, Key: 1},
		{Kind: OpUpsert, Key: 1, ValidFrom: 15, Value: 99}, // same start, replace payload
		{Kind: OpSweep},
		{Kind: OpAdvance, Watermark: 100},
	}

	report, err := Replay(4, ops)
	if err != nil {
		t.Fatalf("replay divergence: %v", err)
	}
	if report.Dropped != 1 {
		t.Errorf("got %d dropped probes, want 1", report.Dropped)
	}
	if report.Emissions == 0 || report.Corrections == 0 {
		t.Errorf("expected emissions and corrections, got %+v", report)
	}

	// Re-run into accessible stores to assert the actual output content.
	fast := NewLookupStore[int](4)
	naive := NewNaiveStore[int](4)
	if _, err := ReplayInto(fast, naive, ops); err != nil {
		t.Fatal(err)
	}
	journal := fast.Journal()
	want := []Emission[int]{
		{Seq: 0, EventID: 1, EventTime: 1, Key: 1, Value: 10},
		{Seq: 1, EventID: 2, EventTime: 2, Key: 2, Value: 20},
		{Seq: 2, EventID: 3, EventTime: 2, Key: 1, Value: 10}, // first picks v10
		{Seq: 3, EventID: 3, EventTime: 2, Key: 1, Value: 12}, // late write revision
		{Seq: 4, EventID: 2, EventTime: 2, Key: 2, Deleted: true},
		{Seq: 5, EventID: 5, EventTime: 16, Key: 1, Value: 11},
		// The same-ValidFrom replacement to 99 starts at 15 and thus does
		// not change the value visible at t=16; no extra emission is added.
	}
	if len(journal) != len(want) {
		t.Fatalf("journal length = %d, want %d: %+v", len(journal), len(want), journal)
	}
	for i := range want {
		if journal[i] != want[i] {
			t.Errorf("journal[%d] = %+v, want %+v", i, journal[i], want[i])
		}
	}
}

// TestReplayRandomized drives many randomized event sequences through both
// engines and asserts identical lookups, drops, sweeps and full journals.
func TestReplayRandomized(t *testing.T) {
	for seed := int64(0); seed < 200; seed++ {
		rng := rand.New(rand.NewSource(seed))
		allowedLateness := int64(rng.Intn(6))
		ops := randomOps(rng, 180)

		report, err := Replay(allowedLateness, ops)
		if err != nil {
			t.Fatalf("seed=%d lateness=%d: %v\nops=%v", seed, allowedLateness, err, ops)
		}
		if report.Ops != len(ops) {
			t.Fatalf("seed=%d: did not replay every op", seed)
		}
	}
}

// randomOps builds an operation mix that deliberately stresses boundary
// times: many timestamps cluster around 0, the current watermark and the
// lateness horizon.
func randomOps(rng *rand.Rand, n int) []Op[int] {
	ops := make([]Op[int], 0, n)
	var watermark int64
	nextEventID := int64(1)

	for i := 0; i < n; i++ {
		roll := rng.Intn(100)
		switch {
		case roll < 30: // advance watermark
			watermark += int64(rng.Intn(4))
			ops = append(ops, Op[int]{Kind: OpAdvance, Watermark: watermark})

		case roll < 62: // upsert (including near-horizon times)
			from := jitteredTime(rng, watermark)
			key := int64(rng.Intn(5))
			ops = append(ops, Op[int]{
				Kind: OpUpsert, Key: key, ValidFrom: from, Value: rng.Intn(1000),
			})

		case roll < 70: // delete
			from := jitteredTime(rng, watermark)
			key := int64(rng.Intn(5))
			ops = append(ops, Op[int]{Kind: OpDelete, Key: key, ValidFrom: from})

		case roll < 90: // probe
			at := jitteredTime(rng, watermark)
			key := int64(rng.Intn(5))
			ops = append(ops, Op[int]{
				Kind: OpProbe, EventID: nextEventID, EventTime: at, Key: key,
			})
			nextEventID++

		default: // lookup at arbitrary historical or future time
			at := jitteredTime(rng, watermark)
			key := int64(rng.Intn(5))
			ops = append(ops, Op[int]{Kind: OpLookup, Key: key, EventTime: at})
		}

		// Periodically drain corrections so both engines batch identically.
		if i%7 == 6 {
			ops = append(ops, Op[int]{Kind: OpSweep})
		}
	}
	return ops
}

// jitteredTime picks a timestamp clustered around the watermark so that
// on-time, boundary and late events all occur frequently.
func jitteredTime(rng *rand.Rand, watermark int64) int64 {
	switch rng.Intn(5) {
	case 0:
		return int64(rng.Intn(4))
	case 1:
		if watermark == 0 {
			return 0
		}
		return watermark - int64(rng.Intn(int(watermark)+1)) // 0..watermark
	case 2:
		return watermark + int64(rng.Intn(5))
	default:
		return int64(rng.Intn(int(watermark) + 8))
	}
}

// TestFastStoreInvariants checks properties the naive cross-check cannot
// phrase directly: half-open partitions, no future-version selection, and an
// append-only journal whose prefix never changes.
func TestFastStoreInvariants(t *testing.T) {
	for seed := int64(0); seed < 100; seed++ {
		rng := rand.New(rand.NewSource(seed))
		allowedLateness := int64(rng.Intn(5))
		fast := NewLookupStore[int](allowedLateness)
		naive := NewNaiveStore[int](allowedLateness)

		var watermark int64
		nextEventID := int64(1)
		var previousJournal []Emission[int]

		for step := 0; step < 150; step++ {
			switch rng.Intn(6) {
			case 0:
				watermark += int64(rng.Intn(3))
				if err := fast.Advance(watermark); err != nil {
					t.Fatal(err)
				}
				if err := naive.Advance(watermark); err != nil {
					t.Fatal(err)
				}
			case 1, 2:
				from := jitteredTime(rng, watermark)
				key := int64(rng.Intn(4))
				value := rng.Intn(100)
				if err := fast.Upsert(key, from, 0, value); err != nil {
					break
				}
				if err := naive.Upsert(key, from, 0, value); err != nil {
					t.Fatalf("seed %d: engines disagreed on write rejection", seed)
				}
			case 3:
				from := jitteredTime(rng, watermark)
				key := int64(rng.Intn(4))
				if err := fast.Delete(key, from, 0); err != nil {
					break
				}
				if err := naive.Delete(key, from, 0); err != nil {
					t.Fatalf("seed %d: engines disagreed on delete rejection", seed)
				}
			case 4, 5:
				at := jitteredTime(rng, watermark)
				key := int64(rng.Intn(4))
				em, ok, err := fast.Probe(nextEventID, at, key)
				if err != nil {
					t.Fatal(err)
				}
				if ok {
					assertProbeVersionEffective(t, fast, key, em)
					nextEventID++
				}
			}

			assertVersionPartitions(t, fast, seed)
			assertJournalPrefixStable(t, fast, previousJournal, seed)
			previousJournal = fast.Journal()

			// Random lookup grid must agree with the naive full scan.
			lookupKey := int64(rng.Intn(4))
			for _, at := range []int64{0, watermark, watermark + 3, watermark + 10} {
				vFast, fFast, errFast := fast.Lookup(lookupKey, at)
				vNaive, fNaive, errNaive := naive.Lookup(lookupKey, at)
				if errFast != nil || errNaive != nil {
					t.Fatalf("seed %d: lookup error fast=%v naive=%v", seed, errFast, errNaive)
				}
				if fFast != fNaive || (fFast && vFast != vNaive) {
					t.Fatalf("seed %d: lookup divergence key=%d t=%d fast=(%v,%v) naive=(%v,%v)",
						seed, lookupKey, at, vFast, fFast, vNaive, fNaive)
				}
			}
			fast.Sweep()
			naive.Sweep()
		}
	}
}

// assertProbeVersionEffective guarantees a probe never selects a version
// whose ValidFrom is after the probe event time.
func assertProbeVersionEffective(t *testing.T, s *LookupStore[int], key int64, em Emission[int]) {
	t.Helper()
	if em.Deleted {
		return
	}
	for _, v := range s.debugVersions(key) {
		if v.Value == em.Value && v.ValidFrom <= em.EventTime {
			return
		}
	}
	t.Errorf("probe %+v selected a version not yet effective at its event time", em)
}

// assertVersionPartitions verifies retained intervals are ordered, half-open
// and contiguous (each ValidTo equals the next ValidFrom).
func assertVersionPartitions(t *testing.T, s *LookupStore[int], seed int64) {
	t.Helper()
	for key := int64(0); key < 4; key++ {
		versions := s.debugVersions(key)
		for i, v := range versions {
			if v.ValidFrom >= v.ValidTo {
				t.Fatalf("seed %d key %d: invalid interval %+v", seed, key, v)
			}
			if i+1 < len(versions) && v.ValidTo != versions[i+1].ValidFrom {
				t.Fatalf("seed %d key %d: non-contiguous intervals %+v -> %+v",
					seed, key, v, versions[i+1])
			}
			if i == len(versions)-1 && v.ValidTo != math.MaxInt64 {
				t.Fatalf("seed %d key %d: newest version is not open-ended: %+v", seed, key, v)
			}
		}
	}
}

// assertJournalPrefixStable ensures corrections only append and never
// overwrite previously emitted outputs.
func assertJournalPrefixStable(t *testing.T, s *LookupStore[int], previous []Emission[int], seed int64) {
	t.Helper()
	current := s.Journal()
	if len(current) < len(previous) {
		t.Fatalf("seed %d: journal shrank from %d to %d", seed, len(previous), len(current))
	}
	for i := range previous {
		if current[i] != previous[i] {
			t.Fatalf("seed %d: journal entry %d rewritten: old=%+v new=%+v",
				seed, i, previous[i], current[i])
		}
	}
}
