package dedup

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"math/rand"
	"testing"
)

func mustNew(t *testing.T, retention int64) *Deduper {
	t.Helper()
	d, err := New(retention)
	if err != nil {
		t.Fatalf("New(%d): %v", retention, err)
	}
	return d
}

func TestNewDuplicateConflict(t *testing.T) {
	d := mustNew(t, 10)
	if got := d.Ingest(Event{Key: "a", Payload: []byte("p1"), Time: 100}); got != ResultNew {
		t.Fatalf("first ingest = %v, want New", got)
	}
	if got := d.Ingest(Event{Key: "a", Payload: []byte("p1"), Time: 100}); got != ResultDuplicate {
		t.Fatalf("same key+payload = %v, want Duplicate", got)
	}
	if got := d.Ingest(Event{Key: "a", Payload: []byte("p2"), Time: 101}); got != ResultConflict {
		t.Fatalf("same key, other payload = %v, want Conflict", got)
	}
	if got := d.Ingest(Event{Key: "b", Payload: []byte("p2"), Time: 101}); got != ResultNew {
		t.Fatalf("other key = %v, want New", got)
	}
}

func TestLateRejectedNotTreatedAsNew(t *testing.T) {
	d := mustNew(t, 5)
	d.Ingest(Event{Key: "a", Payload: []byte("p"), Time: 100}) // watermark 100
	before := d.Len()
	// 95 <= 100-5: beyond the bound, must be rejected even for a fresh key.
	if got := d.Ingest(Event{Key: "fresh", Payload: []byte("p"), Time: 95}); got != ResultLate {
		t.Fatalf("late fresh key = %v, want Late", got)
	}
	// Late rejection wins even when the key is still live.
	if got := d.Ingest(Event{Key: "a", Payload: []byte("p"), Time: 90}); got != ResultLate {
		t.Fatalf("late known key = %v, want Late", got)
	}
	if d.Len() != before {
		t.Fatalf("late event mutated window: len %d, want %d", d.Len(), before)
	}
	w, _ := d.Watermark()
	if w != 100 {
		t.Fatalf("late event advanced watermark to %d, want 100", w)
	}
	// Boundary: 96 > 100-5 is still inside the window.
	if got := d.Ingest(Event{Key: "edge", Payload: []byte("p"), Time: 96}); got != ResultNew {
		t.Fatalf("boundary event = %v, want New", got)
	}
}

func TestWatermarkEvictsKeys(t *testing.T) {
	d := mustNew(t, 5)
	d.Ingest(Event{Key: "old", Payload: []byte("p1"), Time: 100})
	d.Ingest(Event{Key: "adv", Payload: []byte("p"), Time: 200}) // watermark 200, cutoff 195
	if d.Len() != 1 {
		t.Fatalf("len after eviction = %d, want 1 (only adv)", d.Len())
	}
	// Key was evicted, so an in-window re-arrival is New again...
	if got := d.Ingest(Event{Key: "old", Payload: []byte("p2"), Time: 199}); got != ResultNew {
		t.Fatalf("re-arrival of evicted key = %v, want New", got)
	}
	// ...and now conflicts against the re-recorded payload.
	if got := d.Ingest(Event{Key: "old", Payload: []byte("p1"), Time: 199}); got != ResultConflict {
		t.Fatalf("after re-record = %v, want Conflict", got)
	}
}

func TestNewRejectsNonPositiveRetention(t *testing.T) {
	if _, err := New(0); err == nil {
		t.Fatal("New(0) succeeded, want error")
	}
	if _, err := New(-3); err == nil {
		t.Fatal("New(-3) succeeded, want error")
	}
}

func snapshotRestore(t *testing.T, d *Deduper) *Deduper {
	t.Helper()
	var buf bytes.Buffer
	if err := d.Snapshot(&buf); err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	r, err := Restore(&buf)
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	return r
}

func equalState(t *testing.T, a, b *Deduper) {
	t.Helper()
	aw, as := a.Watermark()
	bw, bs := b.Watermark()
	if aw != bw || as != bs {
		t.Fatalf("watermark mismatch: (%d,%v) vs (%d,%v)", aw, as, bw, bs)
	}
	if a.Retention() != b.Retention() {
		t.Fatalf("retention mismatch: %d vs %d", a.Retention(), b.Retention())
	}
	if a.Len() != b.Len() {
		t.Fatalf("window size mismatch: %d vs %d", a.Len(), b.Len())
	}
	for k, v := range a.entries {
		if b.entries[k] != v {
			t.Fatalf("entry %q mismatch after restore", k)
		}
	}
}

func TestSnapshotRestoreRoundTrip(t *testing.T) {
	d := mustNew(t, 7)
	for i := 0; i < 50; i++ {
		d.Ingest(Event{Key: fmt.Sprintf("k%d", i%9), Payload: []byte(fmt.Sprintf("p%d", i)), Time: int64(100 + i)})
	}
	r := snapshotRestore(t, d)
	equalState(t, d, r)
}

func TestRestoreRejectsCorruptSnapshot(t *testing.T) {
	if _, err := Restore(bytes.NewReader([]byte(`{"retention":0}`))); err == nil {
		t.Fatal("restore of retention=0 succeeded, want error")
	}
	if _, err := Restore(bytes.NewReader([]byte(`{"retention":5,"entries":{"k":{"time":1,"hash":"zz"}}}`))); err == nil {
		t.Fatal("restore of bad hash succeeded, want error")
	}
	if _, err := Restore(bytes.NewReader([]byte(`not json`))); err == nil {
		t.Fatal("restore of garbage succeeded, want error")
	}
}

// model is an independent full-history reference implementation. It keeps
// every key ever accepted (first sighting wins) and derives expected
// decisions from the recorded event times and the watermark.
type model struct {
	retention int64
	watermark int64
	started   bool
	seen      map[string]modelEntry
}

type modelEntry struct {
	time int64
	hash [sha256.Size]byte
}

func newModel(retention int64) *model {
	return &model{retention: retention, seen: make(map[string]modelEntry)}
}

func (m *model) expect(e Event) Result {
	h := sha256.Sum256(e.Payload)
	if m.started && e.Time <= m.watermark-m.retention {
		return ResultLate
	}
	if !m.started || e.Time > m.watermark {
		m.watermark = e.Time
		m.started = true
	}
	// Classification happens after the watermark advance and the eviction
	// it triggers: only records inside the new window count.
	res := ResultNew
	if cur, ok := m.seen[e.Key]; ok && cur.time > m.watermark-m.retention {
		if cur.hash != h {
			res = ResultConflict
		} else {
			res = ResultDuplicate
		}
	}
	if res == ResultNew {
		// Full history: first sighting sticks, but a key whose record fell
		// out of the window is re-recorded, mirroring bounded retention.
		m.seen[e.Key] = modelEntry{time: e.Time, hash: h}
	}
	return res
}

// liveWindow returns the subset of full history the bounded deduper must
// still hold: records whose event time is inside the retention window.
func (m *model) liveWindow() map[string]modelEntry {
	out := make(map[string]modelEntry)
	for k, v := range m.seen {
		if !m.started || v.time > m.watermark-m.retention {
			out[k] = v
		}
	}
	return out
}

// TestOutOfOrderReplayAgainstFullHistoryModel drives the bounded deduper
// with a randomized out-of-order stream and checks every decision, plus
// the exact live window, against a full-history model.
func TestOutOfOrderReplayAgainstFullHistoryModel(t *testing.T) {
	const retention = 10
	for _, seed := range []int64{1, 2, 3} {
		t.Run(fmt.Sprintf("seed=%d", seed), func(t *testing.T) {
			rng := rand.New(rand.NewSource(seed))
			d := mustNew(t, retention)
			m := newModel(retention)
			var maxTime int64
			counts := map[Result]int{}
			for i := 0; i < 20000; i++ {
				// Mostly jitter around the frontier, sometimes jump ahead,
				// sometimes land far behind the retention bound.
				var ts int64
				switch rng.Intn(10) {
				case 0:
					ts = maxTime + 1 + rng.Int63n(20)
				case 1, 2:
					ts = maxTime - rng.Int63n(4*retention)
				default:
					ts = maxTime - rng.Int63n(retention+2) + rng.Int63n(3)
				}
				e := Event{
					Key:     fmt.Sprintf("k%d", rng.Intn(40)),
					Payload: []byte(fmt.Sprintf("p%d", rng.Intn(6))),
					Time:    ts,
				}
				if ts > maxTime {
					maxTime = ts
				}
				want := m.expect(e)
				got := d.Ingest(e)
				if got != want {
					t.Fatalf("event %d %+v: got %v, model wants %v", i, e, got, want)
				}
				counts[got]++
			}
			for _, r := range []Result{ResultNew, ResultDuplicate, ResultConflict, ResultLate} {
				if counts[r] == 0 {
					t.Fatalf("stream never exercised %v", r)
				}
			}
			// The live window must match the model's in-window history
			// exactly, key for key.
			live := m.liveWindow()
			if d.Len() != len(live) {
				t.Fatalf("live window size %d, model has %d", d.Len(), len(live))
			}
			for k, v := range live {
				got, ok := d.entries[k]
				if !ok {
					t.Fatalf("key %q missing from live window", k)
				}
				if got.Time != v.time || got.Hash != v.hash {
					t.Fatalf("key %q: deduper has %+v, model has %+v", k, got, v)
				}
			}
			t.Logf("decisions: %v", counts)
		})
	}
}

// TestRestartPreservesDecisions replays the same out-of-order stream
// twice: once uninterrupted, once with snapshot/restore cycles in the
// middle. Decisions after each restart must be identical.
func TestRestartPreservesDecisions(t *testing.T) {
	const retention = 8
	rng := rand.New(rand.NewSource(42))
	var stream []Event
	var maxTime int64 = 1000
	for i := 0; i < 4000; i++ {
		var ts int64
		switch rng.Intn(10) {
		case 0:
			ts = maxTime + 1 + rng.Int63n(15)
		case 1, 2:
			ts = maxTime - rng.Int63n(3*retention)
		default:
			ts = maxTime - rng.Int63n(retention+2) + rng.Int63n(3)
		}
		if ts > maxTime {
			maxTime = ts
		}
		stream = append(stream, Event{
			Key:     fmt.Sprintf("k%d", rng.Intn(30)),
			Payload: []byte(fmt.Sprintf("p%d", rng.Intn(5))),
			Time:    ts,
		})
	}

	restartAt := map[int]bool{500: true, 1500: true, 1501: true, 3999: true}
	run := func(withRestarts bool) []Result {
		d := mustNew(t, retention)
		out := make([]Result, 0, len(stream))
		for i, e := range stream {
			if withRestarts && restartAt[i] {
				d = snapshotRestore(t, d)
			}
			out = append(out, d.Ingest(e))
		}
		return out
	}

	base := run(false)
	restarted := run(true)
	for i := range base {
		if base[i] != restarted[i] {
			t.Fatalf("event %d %+v: uninterrupted=%v, after-restart=%v", i, stream[i], base[i], restarted[i])
		}
	}
}
