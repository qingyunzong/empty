package cover

import (
	"bytes"
	"errors"
	"math"
	"math/rand"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// modelTotals is the reference set-accumulation model: each unique run
// ID contributes its edge counts exactly once, summed into a set of
// per-edge totals.
func modelTotals(recs []RunRecord) map[EdgeID]uint64 {
	seen := make(map[RunID]struct{})
	totals := make(map[EdgeID]uint64)
	for _, r := range recs {
		if _, dup := seen[r.RunID]; dup {
			continue
		}
		seen[r.RunID] = struct{}{}
		for id, c := range r.Counts {
			totals[id] += c
		}
	}
	return totals
}

func runID(b byte) RunID {
	var id RunID
	for i := range id {
		id[i] = b
	}
	return id
}

func makeRecords(t *testing.T, src Digest, n int) []RunRecord {
	t.Helper()
	return makeRecordsFrom(t, src, n, 0)
}

// makeRecordsFrom generates n records with run IDs derived from base,
// so different processes never share run IDs.
func makeRecordsFrom(t *testing.T, src Digest, n, base int) []RunRecord {
	t.Helper()
	rng := rand.New(rand.NewSource(int64(n)*7919 + int64(base)*31 + 13))
	recs := make([]RunRecord, n)
	for i := range recs {
		counts := make(map[EdgeID]uint64)
		for j := 0; j < 1+rng.Intn(8); j++ {
			counts[EdgeID(rng.Intn(32))] += uint64(rng.Intn(1000))
		}
		recs[i] = RunRecord{RunID: runID(byte(base + i + 1)), Source: src, Counts: counts}
	}
	return recs
}

func TestMergeMultipleProcesses(t *testing.T) {
	src := DigestOf([]byte("package main // v1"))
	// Simulate several instrumented processes, each with its own
	// in-memory store, flushed to records and merged centrally.
	var all []RunRecord
	for proc := 0; proc < 5; proc++ {
		recs := makeRecordsFrom(t, src, 7, proc*7)
		local := NewStore()
		for _, r := range recs {
			if _, err := local.Merge(r); err != nil {
				t.Fatalf("local merge: %v", err)
			}
		}
		all = append(all, recs...)
	}
	central := NewStore()
	for _, r := range all {
		if _, err := central.Merge(r); err != nil {
			t.Fatalf("central merge: %v", err)
		}
	}
	if want := modelTotals(all); !reflect.DeepEqual(central.Totals(), want) {
		t.Fatalf("totals mismatch:\n got %v\nwant %v", central.Totals(), want)
	}
	if central.Runs() != len(all) {
		t.Fatalf("runs = %d, want %d", central.Runs(), len(all))
	}
}

func TestSourceMismatchRejected(t *testing.T) {
	s := NewStore()
	good := RunRecord{RunID: runID(1), Source: DigestOf([]byte("a")), Counts: map[EdgeID]uint64{1: 5}}
	if _, err := s.Merge(good); err != nil {
		t.Fatal(err)
	}
	bad := RunRecord{RunID: runID(2), Source: DigestOf([]byte("b")), Counts: map[EdgeID]uint64{1: 7}}
	if _, err := s.Merge(bad); !errors.Is(err, ErrSourceMismatch) {
		t.Fatalf("err = %v, want ErrSourceMismatch", err)
	}
	// State must be untouched by the rejected record.
	if s.Total(1) != 5 || s.Runs() != 1 {
		t.Fatalf("store mutated by rejected record: total=%d runs=%d", s.Total(1), s.Runs())
	}
	// The bad run ID must not be consumed; fixing the digest lets it in.
	bad.Source = DigestOf([]byte("a"))
	if ok, err := s.Merge(bad); err != nil || !ok {
		t.Fatalf("re-merge after fix: ok=%v err=%v", ok, err)
	}
	if s.Total(1) != 12 {
		t.Fatalf("total = %d, want 12", s.Total(1))
	}
}

func TestCountOverflow(t *testing.T) {
	src := DigestOf([]byte("src"))
	s := NewStore()
	r1 := RunRecord{RunID: runID(1), Source: src, Counts: map[EdgeID]uint64{9: math.MaxUint64 - 3}}
	r2 := RunRecord{RunID: runID(2), Source: src, Counts: map[EdgeID]uint64{9: 10}}
	if _, err := s.Merge(r1); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Merge(r2); !errors.Is(err, ErrCountOverflow) {
		t.Fatalf("err = %v, want ErrCountOverflow", err)
	}
	// Failed merge is atomic: total unchanged, run not consumed.
	if s.Total(9) != math.MaxUint64-3 || s.Runs() != 1 {
		t.Fatalf("store mutated by overflowing merge: total=%d runs=%d", s.Total(9), s.Runs())
	}
	// Exactly MaxUint64 is still fine.
	r3 := RunRecord{RunID: runID(3), Source: src, Counts: map[EdgeID]uint64{9: 3}}
	if _, err := s.Merge(r3); err != nil {
		t.Fatal(err)
	}
	if s.Total(9) != math.MaxUint64 {
		t.Fatalf("total = %d, want MaxUint64", s.Total(9))
	}
}

func TestDuplicateRunIDCountedOnce(t *testing.T) {
	src := DigestOf([]byte("src"))
	s := NewStore()
	rec := RunRecord{RunID: runID(42), Source: src, Counts: map[EdgeID]uint64{1: 3, 2: 4}}
	for i := 0; i < 3; i++ {
		ok, err := s.Merge(rec)
		if err != nil {
			t.Fatal(err)
		}
		if want := i == 0; ok != want {
			t.Fatalf("merge %d: applied = %v, want %v", i, ok, want)
		}
	}
	if s.Total(1) != 3 || s.Total(2) != 4 || s.Runs() != 1 {
		t.Fatalf("duplicate run counted more than once: %v runs=%d", s.Totals(), s.Runs())
	}
}

func TestRecoverRoundTrip(t *testing.T) {
	src := DigestOf([]byte("package main"))
	recs := makeRecords(t, src, 50)
	path := filepath.Join(t.TempDir(), "cover.log")
	writeLog(t, path, recs)

	live := NewStore()
	for _, r := range recs {
		if _, err := live.Merge(r); err != nil {
			t.Fatal(err)
		}
	}
	got, n, err := Recover(path)
	if err != nil {
		t.Fatal(err)
	}
	if n != len(recs) {
		t.Fatalf("recovered %d records, want %d", n, len(recs))
	}
	if !reflect.DeepEqual(got.Totals(), live.Totals()) {
		t.Fatalf("recovered totals differ from live store:\n got %v\nwant %v", got.Totals(), live.Totals())
	}
	if !reflect.DeepEqual(got.Totals(), modelTotals(recs)) {
		t.Fatal("recovered totals differ from set-accumulation model")
	}
}

func TestRecoverIgnoresCorruptTail(t *testing.T) {
	src := DigestOf([]byte("package main"))
	recs := makeRecords(t, src, 10)
	path := filepath.Join(t.TempDir(), "cover.log")
	writeLog(t, path, recs)

	// Simulate a crash mid-write: append a partial record.
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write([]byte{'C', 'V', 'R', 'C', 0x20, 0x00}); err != nil {
		t.Fatal(err)
	}
	f.Close()

	got, n, err := Recover(path)
	if err != nil {
		t.Fatal(err)
	}
	if n != len(recs) {
		t.Fatalf("recovered %d records, want %d", n, len(recs))
	}
	if !reflect.DeepEqual(got.Totals(), modelTotals(recs)) {
		t.Fatal("totals after truncated-tail recovery differ from model")
	}
}

func TestOutOfOrderReplayMatchesModel(t *testing.T) {
	src := DigestOf([]byte("package main // v2"))
	recs := makeRecords(t, src, 64)
	// Duplicate some records: replays and retries must not double count.
	recs = append(recs, recs[3], recs[3], recs[17], recs[0])
	want := modelTotals(recs)

	for seed := int64(0); seed < 20; seed++ {
		shuffled := make([]RunRecord, len(recs))
		copy(shuffled, recs)
		rand.New(rand.NewSource(seed)).Shuffle(len(shuffled), func(i, j int) {
			shuffled[i], shuffled[j] = shuffled[j], shuffled[i]
		})
		s := NewStore()
		for _, r := range shuffled {
			if _, err := s.Merge(r); err != nil {
				t.Fatalf("seed %d: %v", seed, err)
			}
		}
		if !reflect.DeepEqual(s.Totals(), want) {
			t.Fatalf("seed %d: replay totals differ from model:\n got %v\nwant %v", seed, s.Totals(), want)
		}
	}
}

func TestOutOfOrderReplayThroughLog(t *testing.T) {
	src := DigestOf([]byte("package main // v3"))
	recs := makeRecords(t, src, 40)
	// Persist in one order, replay the file's records in another.
	path := filepath.Join(t.TempDir(), "cover.log")
	writeLog(t, path, recs)

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	fromDisk, n, err := RecoverFrom(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	if n != len(recs) {
		t.Fatalf("read %d records, want %d", n, len(recs))
	}
	if !reflect.DeepEqual(fromDisk.Totals(), modelTotals(recs)) {
		t.Fatal("log replay totals differ from set-accumulation model")
	}
}

func writeLog(t *testing.T, path string, recs []RunRecord) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	lw := NewLogWriter(f)
	for _, r := range recs {
		if err := lw.Append(r); err != nil {
			t.Fatal(err)
		}
	}
	if err := lw.Flush(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
}
