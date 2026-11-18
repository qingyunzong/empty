package formal

import (
	"fmt"
	"math/rand"
	"testing"
)

type opKind int

const (
	opBegin opKind = iota
	opWrite
	opCommit
	opScan
	opGC
)

type step struct {
	actor    int
	op       opKind
	key, val string
}

// vrec records every version ever committed, in commit order.
type vrec struct {
	key  string
	ts   uint64
	size int
}

// harness replays one schedule against a fresh engine and cross-checks
// the engine state against a naive recomputation from the raw active
// snapshot set.
type harness struct {
	t        *testing.T
	eng      *Engine
	txns     map[int]*Txn
	pending  map[int][][2]string
	created  []vrec
	lastSafe uint64
}

func newHarness(t *testing.T) *harness {
	return &harness{
		t:       t,
		eng:     NewEngine(),
		txns:    map[int]*Txn{},
		pending: map[int][][2]string{},
	}
}

func (h *harness) exec(s step) {
	h.t.Helper()
	switch s.op {
	case opBegin:
		h.txns[s.actor] = h.eng.Begin()
	case opWrite:
		h.pending[s.actor] = append(h.pending[s.actor], [2]string{s.key, s.val})
		h.txns[s.actor].Write(s.key, s.val)
	case opCommit:
		tx := h.txns[s.actor]
		ts := tx.Commit()
		for _, w := range h.pending[s.actor] {
			h.created = append(h.created, vrec{w[0], ts, len(w[0]) + len(w[1])})
		}
		h.pending[s.actor] = nil
		delete(h.txns, s.actor)
	case opScan:
		h.checkScan(s.actor)
	case opGC:
		st := h.eng.GC()
		if st.SafeTS < h.lastSafe {
			h.t.Fatalf("watermark regressed: %d -> %d", h.lastSafe, st.SafeTS)
		}
		h.lastSafe = st.SafeTS
		h.verify()
	}
}

// visibleAt naively resolves the visible version of every key for a
// snapshot from the full commit history.
func (h *harness) visibleAt(snap uint64) map[string]uint64 {
	out := map[string]uint64{}
	for _, r := range h.created {
		if r.ts <= snap {
			out[r.key] = r.ts // created is in commit order, last write wins
		}
	}
	return out
}

func (h *harness) checkScan(actor int) {
	h.t.Helper()
	tx := h.txns[actor]
	got := tx.Scan("", "")
	want := h.visibleAt(tx.SnapshotTS())
	if len(got) != len(want) {
		h.t.Fatalf("scan at snap %d: got %d versions, want %d", tx.SnapshotTS(), len(got), len(want))
	}
	for _, v := range got {
		if want[v.Key] != v.TS {
			h.t.Fatalf("scan at snap %d: key %s resolved to ts %d, want %d",
				tx.SnapshotTS(), v.Key, v.TS, want[v.Key])
		}
		if v.TS > tx.SnapshotTS() {
			h.t.Fatalf("scan at snap %d returned future version %s@%d", tx.SnapshotTS(), v.Key, v.TS)
		}
	}
}

// verify checks two properties after a GC pass:
//
//  1. Precision: the engine content equals exactly the watermark-rule
//     live set — per key, every version above the safe watermark plus
//     the newest version at or below it. No reclaimable version is
//     skipped, none is evaluated twice.
//  2. Safety: every version visible to any active snapshot (naively
//     recomputed from the raw active set) is still present.
func (h *harness) verify() {
	h.t.Helper()
	st := h.eng.Stats()
	if st.SafeTS < h.lastSafe {
		h.t.Fatalf("watermark regressed: %d -> %d", h.lastSafe, st.SafeTS)
	}
	h.lastSafe = st.SafeTS

	readers := append(h.eng.ActiveSnapshots(), st.Clock)

	byKey := map[string][]vrec{}
	for _, r := range h.created {
		byKey[r.key] = append(byKey[r.key], r)
	}

	wantChain := map[string]map[uint64]bool{} // watermark-rule live set
	naiveLive := map[string]map[uint64]bool{} // visible to some reader
	var wantBytes, wantCount uint64
	for key, recs := range byKey {
		for i, r := range recs {
			next := ^uint64(0)
			if i+1 < len(recs) {
				next = recs[i+1].ts
			}
			// Watermark rule: live iff the successor is above safe.
			if next > st.SafeTS {
				if wantChain[key] == nil {
					wantChain[key] = map[uint64]bool{}
				}
				wantChain[key][r.ts] = true
				wantBytes += uint64(r.size)
				wantCount++
			}
			// Naive rule: live iff some active/future reader sees it.
			for _, s := range readers {
				if r.ts <= s && s < next {
					if naiveLive[key] == nil {
						naiveLive[key] = map[uint64]bool{}
					}
					naiveLive[key][r.ts] = true
					break
				}
			}
		}
	}

	got := h.eng.DumpChains()
	if len(got) != len(wantChain) {
		h.t.Fatalf("chain count mismatch: got %v, want %v", got, wantChain)
	}
	for key, tss := range got {
		if len(tss) != len(wantChain[key]) {
			h.t.Fatalf("chain %s: got %v, want %v", key, tss, wantChain[key])
		}
		for _, ts := range tss {
			if !wantChain[key][ts] {
				h.t.Fatalf("chain %s: version @%d should have been reclaimed (want %v)", key, ts, wantChain[key])
			}
		}
		// No skip: at most one version at or below the safe watermark
		// may survive in each chain.
		below := 0
		for _, ts := range tss {
			if ts <= st.SafeTS {
				below++
			}
		}
		if below > 1 {
			h.t.Fatalf("chain %s: GC skipped reclaimable versions at safe=%d: %v", key, st.SafeTS, tss)
		}
	}

	// Safety: nothing visible to an active snapshot was reclaimed.
	for key, tss := range naiveLive {
		for ts := range tss {
			if !wantChain[key][ts] {
				h.t.Fatalf("chain %s: version @%d visible to an active snapshot was reclaimed", key, ts)
			}
		}
	}

	// Reclaimed bytes and versions correspond one-to-one with the
	// versions missing from the live set.
	if st.LiveVersions != wantCount || st.LiveBytes != wantBytes {
		h.t.Fatalf("live accounting mismatch: got (%d, %d bytes), want (%d, %d bytes)",
			st.LiveVersions, st.LiveBytes, wantCount, wantBytes)
	}
	if st.ReclaimedVersions+st.LiveVersions != st.TotalVersions {
		h.t.Fatalf("version accounting broken: %d reclaimed + %d live != %d total",
			st.ReclaimedVersions, st.LiveVersions, st.TotalVersions)
	}
	if st.ReclaimedBytes+st.LiveBytes != st.TotalBytes {
		h.t.Fatalf("byte accounting broken: %d reclaimed + %d live != %d total",
			st.ReclaimedBytes, st.LiveBytes, st.TotalBytes)
	}
}

func (h *harness) finish() {
	h.t.Helper()
	for _, tx := range h.txns {
		tx.Rollback()
	}
	h.eng.GC()
	h.verify()
}

// interleave enumerates every interleaving of the given scripts and runs
// each one on a fresh harness.
func interleave(t *testing.T, scripts [][]step) {
	t.Helper()
	pos := make([]int, len(scripts))
	var cur []step
	var rec func()
	rec = func() {
		advanced := false
		for i := range scripts {
			if pos[i] < len(scripts[i]) {
				advanced = true
				s := scripts[i][pos[i]]
				pos[i]++
				cur = append(cur, s)
				rec()
				cur = cur[:len(cur)-1]
				pos[i]--
			}
		}
		if !advanced {
			h := newHarness(t)
			for _, s := range cur {
				h.exec(s)
			}
			h.finish()
		}
	}
	rec()
}

// TestExhaustiveSchedules enumerates every interleaving of three small
// transactions and two GC passes, and after every GC cross-checks the
// liveness and reclamation of every version against a naive
// recomputation over the raw active snapshot set.
func TestExhaustiveSchedules(t *testing.T) {
	scripts := [][]step{
		{{0, opBegin, "", ""}, {0, opWrite, "a", "a1"}, {0, opWrite, "b", "b1"}, {0, opCommit, "", ""}},
		{{1, opBegin, "", ""}, {1, opWrite, "a", "a2"}, {1, opCommit, "", ""}},
		{{2, opBegin, "", ""}, {2, opScan, "", ""}, {2, opCommit, "", ""}},
		{{3, opGC, "", ""}, {3, opGC, "", ""}},
	}
	interleave(t, scripts)
}

// TestFuzzRandomSchedules broadens coverage with randomized schedules
// over more keys, actors and GC passes, using the same naive
// cross-checks.
func TestFuzzRandomSchedules(t *testing.T) {
	for seed := int64(0); seed < 300; seed++ {
		r := rand.New(rand.NewSource(seed))
		t.Run(fmt.Sprintf("seed=%d", seed), func(t *testing.T) {
			h := newHarness(t)
			actors := 1 + r.Intn(4)
			open := map[int]bool{}
			used := map[int]map[string]bool{}
			steps := 4 + r.Intn(20)
			for i := 0; i < steps; i++ {
				actor := r.Intn(actors)
				switch {
				case !open[actor] && r.Intn(3) > 0:
					h.exec(step{actor, opBegin, "", ""})
					open[actor] = true
					used[actor] = map[string]bool{}
				case open[actor] && r.Intn(4) == 0:
					h.exec(step{actor, opCommit, "", ""})
					open[actor] = false
				case open[actor] && r.Intn(6) == 0:
					h.exec(step{actor, opScan, "", ""})
				case open[actor] && len(used[actor]) < 4:
					key := string(rune('a' + r.Intn(4)))
					if used[actor][key] {
						continue
					}
					used[actor][key] = true
					val := fmt.Sprintf("s%d-i%d", seed, i)
					h.exec(step{actor, opWrite, key, val})
				default:
					h.exec(step{actor, opGC, "", ""})
				}
			}
			h.finish()
		})
	}
}

// TestScheduleEnumerationCount sanity-checks the enumerator itself.
func TestScheduleEnumerationCount(t *testing.T) {
	count := 0
	scripts := [][]step{
		{{0, opBegin, "", ""}, {0, opCommit, "", ""}},
		{{1, opBegin, "", ""}, {1, opCommit, "", ""}},
	}
	pos := make([]int, len(scripts))
	var rec func()
	rec = func() {
		advanced := false
		for i := range scripts {
			if pos[i] < len(scripts[i]) {
				advanced = true
				pos[i]++
				rec()
				pos[i]--
			}
		}
		if !advanced {
			count++
		}
	}
	rec()
	if count != 6 { // 4! / (2! 2!)
		t.Fatalf("enumerator produced %d interleavings, want 6", count)
	}
}
