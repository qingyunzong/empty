package dataeng

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"sort"
	"testing"
)

// fakeSource is a deterministic cursor-paginated in-memory snapshot.
type fakeSource struct {
	name       string
	pages      map[string][]Record
	order      []string
	failAfter  int // total successful Fetch calls before reads start failing
	failCursor string
	fetches    int
}

func (f *fakeSource) Name() string { return f.name }

func (f *fakeSource) Fetch(_ context.Context, cursor string) ([]Record, string, error) {
	page, ok := f.pages[cursor]
	if !ok {
		return nil, "", fmt.Errorf("source %s: unknown cursor %q", f.name, cursor)
	}
	if f.failCursor != "" && f.failCursor == cursor {
		return nil, "", fmt.Errorf("source %s: injected read failure at %q", f.name, cursor)
	}
	if f.failAfter > 0 && f.fetches >= f.failAfter {
		return nil, "", fmt.Errorf("source %s: injected read failure", f.name)
	}
	f.fetches++
	index := -1
	for i, c := range f.order {
		if c == cursor {
			index = i
			break
		}
	}
	if index < 0 {
		return nil, "", fmt.Errorf("source %s: cursor %q out of order", f.name, cursor)
	}
	next := ""
	if index+1 < len(f.order) {
		next = f.order[index+1]
	}
	return append([]Record(nil), page...), next, nil
}

func rec(time int64, id string, payload string) Record {
	return Record{ID: id, Time: time, Content: []byte(payload)}
}

// buildSource cuts records into pages of the given size and wires cursors.
func buildSource(name string, records []Record, pageSize int) *fakeSource {
	if pageSize <= 0 {
		pageSize = len(records)
	}
	pages := map[string][]Record{}
	order := []string{}
	for start := 0; start < len(records); start += pageSize {
		end := start + pageSize
		if end > len(records) {
			end = len(records)
		}
		cursor := fmt.Sprintf("%s-c%d", name, start)
		pages[cursor] = append([]Record(nil), records[start:end]...)
		order = append(order, cursor)
	}
	return &fakeSource{name: name, pages: pages, order: order}
}

func initialCursors(sources []*fakeSource) map[string]string {
	cursors := map[string]string{}
	for _, source := range sources {
		cursors[source.name] = source.order[0]
	}
	return cursors
}

// referenceMerge computes the expected globally sorted, deduplicated output.
func referenceMerge(groups ...[]Record) []Record {
	seen := map[string]Record{}
	for _, group := range groups {
		for _, record := range group {
			if existing, ok := seen[record.ID]; ok {
				if existing.Time != record.Time || !bytes.Equal(existing.Content, record.Content) {
					panic("reference input violates same-ID invariant")
				}
				continue
			}
			seen[record.ID] = record
		}
	}
	out := make([]Record, 0, len(seen))
	for _, record := range seen {
		out = append(out, record)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].Key().Compare(out[j].Key()) < 0
	})
	return out
}

func flatten(batches [][]Record) []Record {
	out := []Record{}
	for _, batch := range batches {
		out = append(out, batch...)
	}
	return out
}

func assertRecordsEqual(t *testing.T, got, want []Record) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("record count = %d, want %d; got=%v want=%v", len(got), len(want), got, want)
	}
	for i := range got {
		if got[i].Key().Compare(want[i].Key()) != 0 || !bytes.Equal(got[i].Content, want[i].Content) {
			t.Fatalf("record[%d] = %v, want %v", i, got[i], want[i])
		}
	}
}

func assertStrictlyOrderedUnique(t *testing.T, records []Record) {
	t.Helper()
	for i := 1; i < len(records); i++ {
		if records[i-1].Key().Compare(records[i].Key()) >= 0 {
			t.Fatalf("records not strictly ascending at %d: %v then %v", i, records[i-1], records[i])
		}
	}
}

func asInterfaces(fakes []*fakeSource) []Source {
	sources := make([]Source, len(fakes))
	for i, fake := range fakes {
		sources[i] = fake
	}
	return sources
}

func drainMerger(t *testing.T, merger *Merger) [][]Record {
	t.Helper()
	batches := [][]Record{}
	ctx := context.Background()
	for {
		batch, err := merger.Next(ctx)
		if errors.Is(err, ErrComplete) {
			return batches
		}
		if err != nil {
			t.Fatalf("unexpected Next error: %v", err)
		}
		if len(batch) == 0 {
			t.Fatal("delivered an empty batch before completion")
		}
		batches = append(batches, batch)
	}
}

func TestMergeMatchesSortedDedupReference(t *testing.T) {
	groupA := []Record{
		rec(1, "a", "A1"), rec(2, "b", "B2"), rec(4, "d", "D4"),
		rec(6, "f", "F6"), rec(8, "h", "H8"),
	}
	groupB := []Record{
		rec(2, "b", "B2"), rec(3, "c", "C3"), rec(5, "e", "E5"), rec(7, "g", "G7"),
	}
	groupC := []Record{
		rec(1, "a", "A1"), rec(4, "d", "D4"), rec(9, "i", "I9"),
	}
	fakes := []*fakeSource{
		buildSource("A", groupA, 2),
		buildSource("B", groupB, 3),
		buildSource("C", groupC, 1),
	}
	want := referenceMerge(groupA, groupB, groupC)

	tx := NewMemoryTransaction()
	merger, err := NewMerger(asInterfaces(fakes), initialCursors(fakes), 3, tx)
	if err != nil {
		t.Fatalf("NewMerger: %v", err)
	}

	batches := drainMerger(t, merger)
	got := flatten(batches)
	assertRecordsEqual(t, got, want)
	assertStrictlyOrderedUnique(t, got)

	for i, batch := range batches {
		if len(batch) > 3 {
			t.Fatalf("batch %d has %d records, exceeds batch size", i, len(batch))
		}
	}

	final := tx.Current()
	if final == nil || !final.Complete {
		t.Fatal("final checkpoint must carry the completion marker")
	}
	if final.LastDelivered == nil || final.LastDelivered.Compare(want[len(want)-1].Key()) != 0 {
		t.Fatalf("LastDelivered = %v, want %v", final.LastDelivered, want[len(want)-1].Key())
	}
	for name, state := range final.Sources {
		if state.Cursor != "" || state.NextCursor != "" || state.Consumed != 0 {
			t.Fatalf("source %s not reset on completion: %+v", name, state)
		}
	}

	if _, err := merger.Next(context.Background()); !errors.Is(err, ErrComplete) {
		t.Fatalf("Next after completion = %v, want ErrComplete", err)
	}
}

func TestDuplicatesAcrossPagesDeduped(t *testing.T) {
	groupA := []Record{
		rec(10, "x", "X"), rec(20, "y", "Y"), rec(30, "z", "Z"),
		rec(40, "q", "Q"), rec(50, "r", "R"),
	}
	groupB := []Record{
		rec(20, "y", "Y"), rec(30, "z", "Z"), rec(60, "s", "S"),
	}
	fakes := []*fakeSource{
		buildSource("A", groupA, 1),
		buildSource("B", groupB, 2),
	}
	want := referenceMerge(groupA, groupB)

	tx := NewMemoryTransaction()
	merger, err := NewMerger(asInterfaces(fakes), initialCursors(fakes), 2, tx)
	if err != nil {
		t.Fatalf("NewMerger: %v", err)
	}

	got := flatten(drainMerger(t, merger))
	assertRecordsEqual(t, got, want)

	// No batch may contain two records sharing an ordering key.
	for i, batch := range tx.Delivered() {
		for j := 1; j < len(batch); j++ {
			if batch[j-1].Key().Compare(batch[j].Key()) == 0 {
				t.Fatalf("batch %d contains duplicate key %v", i, batch[j].Key())
			}
		}
	}
}

func TestSourceExhaustedEarly(t *testing.T) {
	short := []Record{rec(1, "p", "P"), rec(3, "r", "R")}
	long := []Record{
		rec(2, "q", "Q"), rec(4, "s", "S"), rec(5, "t", "T"),
		rec(6, "u", "U"), rec(7, "v", "V"),
	}
	fakes := []*fakeSource{
		buildSource("short", short, 5),
		buildSource("long", long, 2),
	}
	want := referenceMerge(short, long)

	tx := NewMemoryTransaction()
	merger, err := NewMerger(asInterfaces(fakes), initialCursors(fakes), 2, tx)
	if err != nil {
		t.Fatalf("NewMerger: %v", err)
	}

	got := flatten(drainMerger(t, merger))
	assertRecordsEqual(t, got, want)

	// Once the short source is exhausted, later checkpoints record it as
	// exhausted while the long source keeps advancing.
	confirmed := tx.Confirmed()
	sawExhausted := false
	for _, checkpoint := range confirmed {
		state := checkpoint.Sources["short"]
		if state.Cursor == "" {
			sawExhausted = true
			if state.NextCursor != "" || state.Consumed != 0 {
				t.Fatalf("exhausted source checkpoint malformed: %+v", state)
			}
		}
	}
	if !sawExhausted {
		t.Fatal("expected an intermediate checkpoint showing the short source exhausted")
	}
}

func TestNewMergerValidation(t *testing.T) {
	source := buildSource("A", []Record{rec(1, "a", "A")}, 1)
	sources := asInterfaces([]*fakeSource{source})
	tx := NewMemoryTransaction()

	if _, err := NewMerger(nil, map[string]string{"A": "A-c0"}, 1, tx); err == nil {
		t.Fatal("expected error for no sources")
	}
	if _, err := NewMerger(sources, initialCursors([]*fakeSource{source}), 0, tx); err == nil {
		t.Fatal("expected error for non-positive batch size")
	}
	if _, err := NewMerger(sources, map[string]string{}, 1, tx); err == nil {
		t.Fatal("expected error for missing initial cursor")
	}
	if _, err := NewMerger(sources, map[string]string{"A": ""}, 1, tx); err == nil {
		t.Fatal("expected error for empty initial cursor")
	}
	if _, err := NewMerger(sources, initialCursors([]*fakeSource{source}), 1, nil); err == nil {
		t.Fatal("expected error for nil transaction")
	}
	dup := asInterfaces([]*fakeSource{source, source})
	if _, err := NewMerger(dup, map[string]string{"A": "A-c0"}, 1, tx); err == nil {
		t.Fatal("expected error for duplicate source names")
	}
}

func TestReadFailureAbortsBatchAndRetries(t *testing.T) {
	groupA := []Record{
		rec(1, "a", "A"), rec(3, "c", "C"), rec(5, "e", "E"), rec(7, "g", "G"),
	}
	groupB := []Record{
		rec(2, "b", "B"), rec(4, "d", "D"), rec(6, "f", "F"), rec(8, "h", "H"),
	}
	fakes := []*fakeSource{
		buildSource("A", groupA, 2),
		buildSource("B", groupB, 2),
	}
	want := referenceMerge(groupA, groupB)

	tx := NewMemoryTransaction()
	merger, err := NewMerger(asInterfaces(fakes), initialCursors(fakes), 3, tx)
	if err != nil {
		t.Fatalf("NewMerger: %v", err)
	}

	// First batch succeeds; the second batch needs new pages and fails there.
	_, err = merger.Next(context.Background())
	if err != nil {
		t.Fatalf("first Next: %v", err)
	}
	first := tx.Delivered()[0]
	committedAfterFirst := merger.CommittedCheckpoint()

	// A-c2 is the first page required beyond the first confirmed batch.
	fakes[0].failCursor = "A-c2"
	if _, err := merger.Next(context.Background()); err == nil {
		t.Fatal("expected injected read error")
	}

	// Nothing was delivered or committed by the failed batch.
	if len(tx.Delivered()) != 1 {
		t.Fatalf("delivered batches = %d, want 1 after read failure", len(tx.Delivered()))
	}
	current := tx.Current()
	if current == nil || current.LastDelivered == nil ||
		current.LastDelivered.Compare(first[len(first)-1].Key()) != 0 {
		t.Fatal("checkpoint must not advance on read failure")
	}

	// Clearing the failure allows an identical retry from the same position.
	fakes[0].failCursor = ""
	batches := drainMerger(t, merger)
	got := append(append([]Record{}, first...), flatten(batches)...)
	assertRecordsEqual(t, got, want)

	retryCheckpoint := merger.CommittedCheckpoint()
	if retryCheckpoint.LastDelivered.Compare(*committedAfterFirst.LastDelivered) <= 0 {
		t.Fatal("merge should progress after the read failure is cleared")
	}
}

func TestExplicitRejectionResendsSameBatch(t *testing.T) {
	groupA := []Record{rec(1, "a", "A"), rec(4, "d", "D"), rec(5, "e", "E")}
	groupB := []Record{rec(2, "b", "B"), rec(3, "c", "C"), rec(6, "f", "F")}
	fakes := []*fakeSource{
		buildSource("A", groupA, 2),
		buildSource("B", groupB, 2),
	}
	want := referenceMerge(groupA, groupB)

	tx := NewMemoryTransaction()
	merger, err := NewMerger(asInterfaces(fakes), initialCursors(fakes), 1, tx)
	if err != nil {
		t.Fatalf("NewMerger: %v", err)
	}

	tx.RejectNext = true
	_, err = merger.Next(context.Background())
	if !errors.Is(err, ErrRejected) {
		t.Fatalf("Next = %v, want ErrRejected", err)
	}
	if len(tx.Delivered()) != 0 || tx.Current() != nil {
		t.Fatal("explicit rejection must not deliver or checkpoint")
	}

	// Retry produces the exact same batch and then succeeds.
	retried, err := merger.Next(context.Background())
	if err != nil {
		t.Fatalf("retry Next: %v", err)
	}
	assertRecordsEqual(t, retried, tx.Attempts()[0])

	got := flatten(append([][]Record{retried}, drainMerger(t, merger)...))
	assertRecordsEqual(t, got, want)

	// The rejected batch was retried exactly once and never duplicated.
	all := flatten(tx.Delivered())
	assertRecordsEqual(t, all, want)
}

func TestUnknownOutcomeReloadsAndSkipsCommittedBatch(t *testing.T) {
	groupA := []Record{rec(1, "a", "A"), rec(3, "c", "C"), rec(5, "e", "E"), rec(7, "g", "G")}
	groupB := []Record{rec(2, "b", "B"), rec(4, "d", "D"), rec(6, "f", "F"), rec(8, "h", "H")}
	fakes := []*fakeSource{
		buildSource("A", groupA, 2),
		buildSource("B", groupB, 2),
	}
	want := referenceMerge(groupA, groupB)

	tx := NewMemoryTransaction()
	merger, err := NewMerger(asInterfaces(fakes), initialCursors(fakes), 2, tx)
	if err != nil {
		t.Fatalf("NewMerger: %v", err)
	}

	first, err := merger.Next(context.Background())
	if err != nil {
		t.Fatalf("first Next: %v", err)
	}

	// Simulate an ambiguous result that had actually committed durably: the
	// checkpoint is saved before the caller loses the confirmation response.
	atx := &committedAmbiguousTransaction{MemoryTransaction: tx}
	merger.tx = atx
	atx.UnknownNext = true
	_, err = merger.Next(context.Background())
	if !errors.Is(err, ErrAmbiguous) {
		t.Fatalf("Next = %v, want ErrAmbiguous", err)
	}

	// The reload must adopt the advanced checkpoint and never redeliver it.
	if len(tx.Delivered()) != 2 {
		t.Fatalf("committed batches = %d, want 2", len(tx.Delivered()))
	}
	rest := drainMerger(t, merger)
	ambiguous := tx.Delivered()[1]
	got := append(append(append([]Record{}, first...), ambiguous...), flatten(rest)...)
	assertRecordsEqual(t, got, want)

	all := flatten(tx.Delivered())
	assertRecordsEqual(t, all, want)
}

func TestUnknownOutcomeNotCommittedResendsBatch(t *testing.T) {
	groupA := []Record{rec(1, "a", "A"), rec(3, "c", "C")}
	groupB := []Record{rec(2, "b", "B"), rec(4, "d", "D")}
	fakes := []*fakeSource{
		buildSource("A", groupA, 1),
		buildSource("B", groupB, 1),
	}
	want := referenceMerge(groupA, groupB)

	// A transaction whose ambiguous confirm truly persisted nothing.
	tx := &volatileTransaction{MemoryTransaction: NewMemoryTransaction()}
	merger, err := NewMerger(asInterfaces(fakes), initialCursors(fakes), 1, tx)
	if err != nil {
		t.Fatalf("NewMerger: %v", err)
	}

	_, err = merger.Next(context.Background())
	if err != nil {
		t.Fatalf("first Next: %v", err)
	}
	first := tx.Delivered()[0]

	tx.MemoryTransaction.UnknownNext = true
	if _, err := merger.Next(context.Background()); !errors.Is(err, ErrAmbiguous) {
		t.Fatalf("Next = %v, want ErrAmbiguous", err)
	}
	if tx.Current() == nil {
		t.Fatal("reload should succeed and report no durable checkpoint")
	}

	retried, err := merger.Next(context.Background())
	if err != nil {
		t.Fatalf("retry Next: %v", err)
	}
	assertRecordsEqual(t, retried, tx.Attempts()[1])

	got := append(append([]Record{}, first...), flatten(append([][]Record{retried}, drainMerger(t, merger)...))...)
	assertRecordsEqual(t, got, want)
}

// volatileTransaction overrides Confirm so an ambiguous outcome performs no
// save at all, while Load still reads the durable store.
type volatileTransaction struct {
	*MemoryTransaction
}

func (t *volatileTransaction) Confirm(ctx context.Context, records []Record, checkpoint *Checkpoint) error {
	t.mu.Lock()
	unknown := t.UnknownNext
	t.UnknownNext = false
	t.mu.Unlock()
	if unknown {
		return ErrAmbiguous
	}
	return t.MemoryTransaction.Confirm(ctx, records, checkpoint)
}

// committedAmbiguousTransaction saves the checkpoint and records before
// returning an ambiguous error, modeling a request whose commit succeeded
// but whose response was lost.
type committedAmbiguousTransaction struct {
	*MemoryTransaction
}

func (t *committedAmbiguousTransaction) Confirm(ctx context.Context, records []Record, checkpoint *Checkpoint) error {
	t.mu.Lock()
	unknown := t.UnknownNext
	t.UnknownNext = false
	t.mu.Unlock()
	if !unknown {
		return t.MemoryTransaction.Confirm(ctx, records, checkpoint)
	}
	if err := t.MemoryStore.Save(ctx, checkpoint); err != nil {
		return err
	}
	t.mu.Lock()
	t.delivered = append(t.delivered, cloneRecords(records))
	t.confirmed = append(t.confirmed, checkpoint.Clone())
	t.attempts = append(t.attempts, cloneRecords(records))
	t.mu.Unlock()
	return ErrAmbiguous
}

func TestCheckpointLoadFailureStopsMerger(t *testing.T) {
	fakes := []*fakeSource{
		buildSource("A", []Record{rec(1, "a", "A"), rec(3, "c", "C")}, 1),
		buildSource("B", []Record{rec(2, "b", "B"), rec(4, "d", "D")}, 1),
	}
	tx := NewMemoryTransaction()
	merger, err := NewMerger(asInterfaces(fakes), initialCursors(fakes), 1, tx)
	if err != nil {
		t.Fatalf("NewMerger: %v", err)
	}

	first, err := merger.Next(context.Background())
	if err != nil {
		t.Fatalf("first Next: %v", err)
	}

	loadErr := errors.New("durable store unavailable")
	tx.UnknownNext = true
	tx.SetLoadFailure(loadErr)
	if _, err := merger.Next(context.Background()); !errors.Is(err, loadErr) {
		t.Fatalf("Next = %v, want load failure %v", err, loadErr)
	}

	// While reads fail, the merger must stop rather than redeliver.
	if _, err := merger.Next(context.Background()); !errors.Is(err, loadErr) {
		t.Fatalf("Next while load broken = %v, want %v", err, loadErr)
	}

	// Once the store is readable again, recovery resumes without duplicates.
	tx.ClearLoadFailure()
	got := append(append([]Record{}, first...), flatten(drainMerger(t, merger))...)
	want := referenceMerge(
		[]Record{rec(1, "a", "A"), rec(3, "c", "C")},
		[]Record{rec(2, "b", "B"), rec(4, "d", "D")},
	)
	assertRecordsEqual(t, got, want)
}

func TestResumeMergerFromDurableCheckpoint(t *testing.T) {
	groupA := []Record{
		rec(1, "a", "A"), rec(3, "c", "C"), rec(5, "e", "E"),
		rec(7, "g", "G"), rec(9, "i", "I"),
	}
	groupB := []Record{
		rec(1, "a", "A"), rec(2, "b", "B"), rec(4, "d", "D"),
		rec(6, "f", "F"), rec(8, "h", "H"),
	}
	want := referenceMerge(groupA, groupB)

	fakes := []*fakeSource{
		buildSource("A", groupA, 2),
		buildSource("B", groupB, 2),
	}
	tx := NewMemoryTransaction()
	merger, err := NewMerger(asInterfaces(fakes), initialCursors(fakes), 2, tx)
	if err != nil {
		t.Fatalf("NewMerger: %v", err)
	}

	// Run two confirmed batches, then simulate a process restart.
	first, err := merger.Next(context.Background())
	if err != nil {
		t.Fatalf("first Next: %v", err)
	}
	second, err := merger.Next(context.Background())
	if err != nil {
		t.Fatalf("second Next: %v", err)
	}
	checkpoint := tx.Current()

	// Fresh sources and a fresh merger resume from the durable checkpoint.
	resumedFakes := []*fakeSource{
		buildSource("A", groupA, 2),
		buildSource("B", groupB, 2),
	}
	resumed, err := ResumeMerger(asInterfaces(resumedFakes), checkpoint, 2, tx)
	if err != nil {
		t.Fatalf("ResumeMerger: %v", err)
	}
	rest := drainMerger(t, resumed)
	got := append(append(append([]Record{}, first...), second...), flatten(rest)...)
	assertRecordsEqual(t, got, want)
	assertStrictlyOrderedUnique(t, flatten(tx.Delivered()))

	// Checkpoint fields describe live per-source positions before completion.
	mid := tx.Confirmed()[1]
	for name, state := range mid.Sources {
		if state.Cursor == "" {
			continue
		}
		if state.Consumed < 0 {
			t.Fatalf("source %s has negative consumed offset", name)
		}
	}

	// Resuming a completed checkpoint returns ErrComplete immediately.
	completed := tx.Current()
	done, err := ResumeMerger(asInterfaces(resumedFakes), completed, 2, tx)
	if err != nil {
		t.Fatalf("ResumeMerger completed: %v", err)
	}
	if _, err := done.Next(context.Background()); !errors.Is(err, ErrComplete) {
		t.Fatalf("resumed completed merger = %v, want ErrComplete", err)
	}
}
