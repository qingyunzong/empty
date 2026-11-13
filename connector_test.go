package dataeng

import (
	"context"
	"errors"
	"io"
	"reflect"
	"testing"
)

type openResult struct {
	stream Stream
	err    error
}

type fakeOpener struct {
	t       *testing.T
	results []openResult
	reqs    []OpenRequest
}

func (o *fakeOpener) Open(_ context.Context, req OpenRequest) (Stream, error) {
	o.t.Helper()
	o.reqs = append(o.reqs, req)
	if len(o.results) == 0 {
		o.t.Fatalf("unexpected Open call: %+v", req)
	}
	result := o.results[0]
	o.results = o.results[1:]
	return result.stream, result.err
}

type fakeStream struct {
	batches []Batch
	err     error
	index   int
	acks    []Ack
	ackErr  error
	closed  bool
}

func (s *fakeStream) Recv() (Batch, error) {
	if s.index < len(s.batches) {
		batch := s.batches[s.index]
		s.index++
		return batch, nil
	}
	if s.err != nil {
		err := s.err
		s.err = nil
		return Batch{}, err
	}
	return Batch{}, io.EOF
}

func (s *fakeStream) Close() error {
	s.closed = true
	return nil
}

func (s *fakeStream) Ack(_ context.Context, ack Ack) error {
	s.acks = append(s.acks, ack)
	return s.ackErr
}

type fakeStarter struct {
	t           *testing.T
	snapshots   []Snapshot
	previousIDs []string
}

func (s *fakeStarter) StartSnapshot(_ context.Context, previous string) (Snapshot, error) {
	s.t.Helper()
	s.previousIDs = append(s.previousIDs, previous)
	if len(s.snapshots) == 0 {
		s.t.Fatalf("unexpected StartSnapshot call, previous=%q", previous)
	}
	snapshot := s.snapshots[0]
	s.snapshots = s.snapshots[1:]
	return snapshot, nil
}

type recordingSink struct {
	batches       []DeliveredBatch
	began         []SnapshotEvent
	ended         []SnapshotEvent
	abandoned     []SnapshotEvent
	reconciles    []Reconciliation
	failApplyAt   int
	failReconcile error
}

func (s *recordingSink) ApplyBatch(_ context.Context, batch DeliveredBatch) error {
	if s.failApplyAt > 0 && len(s.batches)+1 == s.failApplyAt {
		return errors.New("sink rejected batch")
	}
	batch.Records = append([]Record(nil), batch.Records...)
	s.batches = append(s.batches, batch)
	return nil
}

func (s *recordingSink) Reconcile(_ context.Context, result Reconciliation) error {
	if s.failReconcile != nil {
		return s.failReconcile
	}
	s.reconciles = append(s.reconciles, result)
	return nil
}

func (s *recordingSink) BeginSnapshot(_ context.Context, event SnapshotEvent) error {
	s.began = append(s.began, event)
	return nil
}

func (s *recordingSink) EndSnapshot(_ context.Context, event SnapshotEvent) error {
	s.ended = append(s.ended, event)
	return nil
}

func (s *recordingSink) AbandonSnapshot(_ context.Context, event SnapshotEvent) error {
	s.abandoned = append(s.abandoned, event)
	return nil
}

func newTestConnector(t *testing.T, opener StreamOpener, starter SnapshotStarter, store CheckpointStore, sink Sink) *Connector {
	t.Helper()
	connector, err := NewConnector(Config{
		Opener:    opener,
		Snapshots: starter,
		Store:     store,
		Sink:      sink,
		Retry:     RetryPolicy{MaxAttempts: 10},
	})
	if err != nil {
		t.Fatalf("NewConnector: %v", err)
	}
	return connector
}

func rec(id string, version uint64, data string) Record {
	return Record{ID: id, Version: version, Data: []byte(data)}
}

func batch(snapshot string, generation uint64, token string, records ...Record) Batch {
	return Batch{
		SnapshotID:  snapshot,
		Generation:  generation,
		ResumeToken: token,
		Records:     records,
	}
}

func TestResumeTokenAdvancesOnlyAfterBatchConfirmation(t *testing.T) {
	store := NewMemoryStore()
	starter := &fakeStarter{t: t, snapshots: []Snapshot{{ID: "s1"}}}
	first := &fakeStream{batches: []Batch{
		batch("s1", 1, "t1", rec("a", 1, "a1")),
		batch("s1", 1, "t2", rec("b", 1, "b1")),
	}}
	opener := &fakeOpener{t: t, results: []openResult{{stream: first}}}
	sink := &recordingSink{failApplyAt: 2}
	connector := newTestConnector(t, opener, starter, store, sink)

	if err := connector.Run(context.Background()); err == nil {
		t.Fatal("Run succeeded despite sink rejection")
	}

	checkpoint, err := store.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if checkpoint.ResumeToken != "t1" {
		t.Fatalf("checkpoint token = %q, want t1", checkpoint.ResumeToken)
	}
	if checkpoint.Generation != 1 {
		t.Fatalf("checkpoint generation = %d, want 1", checkpoint.Generation)
	}
	if checkpoint.Complete {
		t.Fatal("checkpoint marked complete after failed batch")
	}

	sink.failApplyAt = 0
	second := &fakeStream{batches: []Batch{
		batch("s1", 2, "t2", rec("b", 1, "b1")),
	}}
	opener.results = append(opener.results, openResult{stream: second})

	if err := connector.Run(context.Background()); err != nil {
		t.Fatalf("resume Run: %v", err)
	}
	if got, want := opener.reqs[1], (OpenRequest{SnapshotID: "s1", ResumeToken: "t1", Generation: 2}); got != want {
		t.Fatalf("resume request = %+v, want %+v", got, want)
	}
	checkpoint, err = store.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if checkpoint.ResumeToken != "t2" || !checkpoint.Complete {
		t.Fatalf("final checkpoint = %+v, want token t2 complete", checkpoint)
	}
	if got := len(sink.batches); got != 2 {
		t.Fatalf("sink got %d batches, want 2", got)
	}
	if got := sink.batches[1].Records; len(got) != 1 || got[0].ID != "b" {
		t.Fatalf("resumed batch records = %+v, want record b", got)
	}
}

func TestNetworkReconnectUsesLastAckAndDedupesBoundaryByVersion(t *testing.T) {
	store := NewMemoryStore()
	starter := &fakeStarter{t: t, snapshots: []Snapshot{{ID: "s1"}}}
	first := &fakeStream{
		batches: []Batch{batch("s1", 1, "t1", rec("a", 2, "a-v2"))},
		err:     errors.New("network reset"),
	}
	second := &fakeStream{batches: []Batch{
		batch("s1", 2, "t1",
			rec("a", 1, "a-v1"),
			rec("a", 2, "a-v2"),
			rec("a", 3, "a-v3"),
		),
		batch("s1", 2, "t2", rec("b", 1, "b-v1")),
	}}
	opener := &fakeOpener{t: t, results: []openResult{
		{stream: first},
		{stream: second},
	}}
	sink := &recordingSink{}
	connector := newTestConnector(t, opener, starter, store, sink)

	if err := connector.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}

	if got, want := opener.reqs, []OpenRequest{
		{SnapshotID: "s1", ResumeToken: "", Generation: 1},
		{SnapshotID: "s1", ResumeToken: "t1", Generation: 2},
	}; !reflect.DeepEqual(got, want) {
		t.Fatalf("open requests = %+v, want %+v", got, want)
	}

	if got := len(sink.batches); got != 3 {
		t.Fatalf("sink got %d batches, want 3", got)
	}
	if got := sink.batches[1].Records; len(got) != 1 || got[0].Version != 3 || string(got[0].Data) != "a-v3" {
		t.Fatalf("replayed boundary records = %+v, want only a v3", got)
	}
	if got := sink.batches[2].Records; len(got) != 1 || got[0].ID != "b" {
		t.Fatalf("post-boundary records = %+v, want record b", got)
	}

	stats := connector.Stats()
	if stats.Connections != 2 {
		t.Fatalf("connections = %d, want 2", stats.Connections)
	}
	if stats.DuplicateRecords != 2 {
		t.Fatalf("duplicate records = %d, want 2", stats.DuplicateRecords)
	}

	checkpoint, err := store.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got, want := checkpoint, (Checkpoint{SnapshotID: "s1", ResumeToken: "t2", Generation: 2, Complete: true}); got != want {
		t.Fatalf("checkpoint = %+v, want %+v", got, want)
	}
}

func TestInvalidTokenStartsNewSnapshotAndReconciles(t *testing.T) {
	store := NewMemoryStore()
	starter := &fakeStarter{t: t, snapshots: []Snapshot{
		{ID: "s1"},
		{ID: "s2", ResumeToken: "s2-start"},
	}}
	first := &fakeStream{
		batches: []Batch{batch("s1", 1, "t1", rec("a", 1, "a-old"), rec("b", 1, "b-old"))},
		err:     ErrResumeTokenInvalid,
	}
	second := &fakeStream{batches: []Batch{
		batch("s2", 2, "u1", rec("a", 2, "a-new"), rec("c", 1, "c-new")),
	}}
	opener := &fakeOpener{t: t, results: []openResult{
		{stream: first},
		{stream: second},
	}}
	sink := &recordingSink{}
	connector := newTestConnector(t, opener, starter, store, sink)

	if err := connector.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}

	if got, want := opener.reqs[1], (OpenRequest{SnapshotID: "s2", ResumeToken: "s2-start", Generation: 2}); got != want {
		t.Fatalf("replacement request = %+v, want %+v", got, want)
	}
	if got, want := starter.previousIDs, []string{"", "s1"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("StartSnapshot previous IDs = %v, want %v", got, want)
	}

	if len(sink.began) != 2 {
		t.Fatalf("BeginSnapshot events = %+v, want 2", sink.began)
	}
	if event := sink.began[1]; event.SnapshotID != "s2" || event.Reason != SnapshotReplacement || event.Replaces != "s1" {
		t.Fatalf("replacement BeginSnapshot = %+v", event)
	}
	for i, delivered := range sink.batches {
		if delivered.SnapshotID == "s2" && (!delivered.Replacement || delivered.Replaces != "s1") {
			t.Fatalf("replacement batch %d not marked as replacement: %+v", i, delivered)
		}
	}

	if len(sink.reconciles) != 1 {
		t.Fatalf("Reconcile calls = %d, want 1", len(sink.reconciles))
	}
	result := sink.reconciles[0]
	if result.PreviousSnapshotID != "s1" || result.SnapshotID != "s2" {
		t.Fatalf("reconciliation snapshots = %+v", result)
	}
	if got := ids(result.Added); !reflect.DeepEqual(got, []string{"c"}) {
		t.Fatalf("added = %v, want [c]", got)
	}
	if got := ids(result.Removed); !reflect.DeepEqual(got, []string{"b"}) {
		t.Fatalf("removed = %v, want [b]", got)
	}
	if len(result.Changed) != 1 || result.Changed[0].Before.ID != "a" ||
		result.Changed[0].Before.Version != 1 || result.Changed[0].After.Version != 2 {
		t.Fatalf("changed = %+v, want a v1 -> v2", result.Changed)
	}

	checkpoint, err := store.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got, want := checkpoint, (Checkpoint{SnapshotID: "s2", ResumeToken: "u1", Generation: 2, Complete: true}); got != want {
		t.Fatalf("checkpoint = %+v, want %+v", got, want)
	}
	if connector.Stats().SnapshotRestarts != 1 {
		t.Fatalf("snapshot restarts = %d, want 1", connector.Stats().SnapshotRestarts)
	}
}

func TestRepeatedInvalidationReconcilesAgainstLastCompleteSnapshot(t *testing.T) {
	store := NewMemoryStore()
	starter := &fakeStarter{t: t, snapshots: []Snapshot{
		{ID: "s1"},
		{ID: "s2", ResumeToken: "s2-start"},
		{ID: "s3", ResumeToken: "s3-start"},
	}}
	first := &fakeStream{
		batches: []Batch{batch("s1", 1, "t1", rec("a", 1, "a-old"))},
		err:     ErrResumeTokenInvalid,
	}
	second := &fakeStream{
		batches: []Batch{batch("s2", 2, "u1", rec("z", 1, "partial-z"))},
		err:     ErrResumeTokenInvalid,
	}
	third := &fakeStream{batches: []Batch{
		batch("s3", 3, "v1", rec("a", 2, "a-new")),
	}}
	opener := &fakeOpener{t: t, results: []openResult{
		{stream: first},
		{stream: second},
		{stream: third},
	}}
	sink := &recordingSink{}
	connector := newTestConnector(t, opener, starter, store, sink)

	if err := connector.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}

	if len(sink.abandoned) != 1 || sink.abandoned[0].SnapshotID != "s2" {
		t.Fatalf("abandoned snapshots = %+v, want s2", sink.abandoned)
	}
	if len(sink.reconciles) != 1 {
		t.Fatalf("Reconcile calls = %d, want 1", len(sink.reconciles))
	}
	result := sink.reconciles[0]
	if result.PreviousSnapshotID != "s1" || result.SnapshotID != "s3" {
		t.Fatalf("reconciliation snapshots = %+v, want s1 -> s3", result)
	}
	if len(result.Added) != 0 || len(result.Removed) != 0 || len(result.Changed) != 1 {
		t.Fatalf("reconciliation = %+v, want only changed a", result)
	}
	for _, value := range result.Added {
		if value.ID == "z" {
			t.Fatal("partial replacement record z leaked into reconciliation")
		}
	}
}

func TestStaleGenerationBatchIsIgnored(t *testing.T) {
	store := NewMemoryStore()
	starter := &fakeStarter{t: t, snapshots: []Snapshot{{ID: "s1"}}}
	stream := &fakeStream{batches: []Batch{
		batch("s1", 7, "bad", rec("stale", 1, "stale")),
		batch("s1", 1, "t1", rec("good", 1, "good")),
	}}
	opener := &fakeOpener{t: t, results: []openResult{{stream: stream}}}
	sink := &recordingSink{}
	connector := newTestConnector(t, opener, starter, store, sink)

	if err := connector.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}

	if len(sink.batches) != 1 {
		t.Fatalf("sink got %d batches, want 1", len(sink.batches))
	}
	if got := sink.batches[0].Records; len(got) != 1 || got[0].ID != "good" {
		t.Fatalf("delivered records = %+v, want only good", got)
	}
	if connector.Stats().StaleBatches != 1 {
		t.Fatalf("stale batches = %d, want 1", connector.Stats().StaleBatches)
	}
}

func TestAckFailureReconnectsAndDoesNotRedeliverConfirmedRecords(t *testing.T) {
	store := NewMemoryStore()
	starter := &fakeStarter{t: t, snapshots: []Snapshot{{ID: "s1"}}}
	first := &fakeStream{
		batches: []Batch{batch("s1", 1, "t1", rec("a", 1, "a1"))},
		ackErr:  errors.New("ack transport failure"),
	}
	second := &fakeStream{batches: []Batch{
		batch("s1", 2, "t1", rec("a", 1, "a1")),
		batch("s1", 2, "t2", rec("b", 1, "b1")),
	}}
	opener := &fakeOpener{t: t, results: []openResult{
		{stream: first},
		{stream: second},
	}}
	sink := &recordingSink{}
	connector := newTestConnector(t, opener, starter, store, sink)

	if err := connector.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}

	if got, want := opener.reqs[1], (OpenRequest{SnapshotID: "s1", ResumeToken: "t1", Generation: 2}); got != want {
		t.Fatalf("reconnect request = %+v, want %+v", got, want)
	}
	if len(sink.batches) != 2 {
		t.Fatalf("sink got %d batches, want 2", len(sink.batches))
	}
	if got := sink.batches[1].Records; len(got) != 1 || got[0].ID != "b" {
		t.Fatalf("second delivered batch = %+v, want only b", got)
	}
	if got, want := first.acks[0], (Ack{SnapshotID: "s1", ResumeToken: "t1", Generation: 1}); got != want {
		t.Fatalf("first ack = %+v, want %+v", got, want)
	}
	if got, want := second.acks[0], (Ack{SnapshotID: "s1", ResumeToken: "t1", Generation: 2}); got != want {
		t.Fatalf("replayed ack = %+v, want %+v", got, want)
	}
}

func TestTokenInvalidOnOpenStartsReplacement(t *testing.T) {
	store := NewMemoryStore()
	starter := &fakeStarter{t: t, snapshots: []Snapshot{
		{ID: "s1"},
		{ID: "s2", ResumeToken: "s2-start"},
	}}
	opener := &fakeOpener{t: t, results: []openResult{
		{err: ErrResumeTokenInvalid},
		{stream: &fakeStream{batches: []Batch{batch("s2", 2, "u1", rec("a", 1, "a1"))}}},
	}}
	sink := &recordingSink{}
	connector := newTestConnector(t, opener, starter, store, sink)

	if err := connector.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got, want := opener.reqs[1], (OpenRequest{SnapshotID: "s2", ResumeToken: "s2-start", Generation: 2}); got != want {
		t.Fatalf("replacement open = %+v, want %+v", got, want)
	}
	if len(sink.reconciles) != 1 || sink.reconciles[0].PreviousSnapshotID != "s1" {
		t.Fatalf("reconciliations = %+v, want s1 -> s2", sink.reconciles)
	}
}

func TestFailedReconciliationIsNotSilentlyCompleted(t *testing.T) {
	store := NewMemoryStore()
	starter := &fakeStarter{t: t, snapshots: []Snapshot{
		{ID: "s1"},
		{ID: "s2", ResumeToken: "s2-start"},
	}}
	first := &fakeStream{
		batches: []Batch{batch("s1", 1, "t1", rec("a", 1, "a-old"))},
		err:     ErrResumeTokenInvalid,
	}
	second := &fakeStream{batches: []Batch{
		batch("s2", 2, "u1", rec("a", 2, "a-new")),
	}}
	opener := &fakeOpener{t: t, results: []openResult{
		{stream: first},
		{stream: second},
	}}
	sink := &recordingSink{failReconcile: errors.New("reconcile store unavailable")}
	connector := newTestConnector(t, opener, starter, store, sink)

	if err := connector.Run(context.Background()); err == nil {
		t.Fatal("Run succeeded despite reconciliation failure")
	}
	checkpoint, err := store.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if checkpoint.Complete || checkpoint.PendingReconcile != "s1" {
		t.Fatalf("checkpoint = %+v, want pending reconciliation against s1", checkpoint)
	}

	err = connector.Run(context.Background())
	if !errors.Is(err, ErrReconciliationPending) {
		t.Fatalf("second Run error = %v, want ErrReconciliationPending", err)
	}
}

func ids(refs []RecordRef) []string {
	result := make([]string, len(refs))
	for i, ref := range refs {
		result[i] = ref.ID
	}
	return result
}
