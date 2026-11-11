package q190_test

import (
	"context"
	"errors"
	"sync"
	"testing"

	q190 "example.com/dlks/q190"
)

// countingSink counts every Apply invocation. The caller in these tests only
// records a committed effect after HandlePubrel returns successfully, which
// mirrors what a real transport observes: an effect whose transaction did not
// commit is never visible to the business.
type countingSink struct {
	mu        sync.Mutex
	applied   int
	committed int
	failGen   int64 // when non-zero, Apply fails for this generation
	err       error
	last      q190.Record
}

func (s *countingSink) Apply(_ context.Context, _ q190.Tx, rec q190.Record) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.applied++
	s.last = rec
	if s.failGen != 0 && rec.Generation == s.failGen {
		return s.err
	}
	return nil
}

func (s *countingSink) markCommitted() {
	s.mu.Lock()
	s.committed++
	s.mu.Unlock()
}

func (s *countingSink) counts() (applied, committed int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.applied, s.committed
}

var errInjected = errors.New("injected storage failure")

func deliverOnce(t *testing.T, r *q190.Receiver, sink *countingSink, id uint16, payload string) {
	t.Helper()
	act, err := r.HandlePublish(context.Background(), q190.Publish{PacketID: id, Payload: []byte(payload)})
	if err != nil {
		t.Fatalf("HandlePublish: %v", err)
	}
	if _, ok := act.(q190.PubrecAction); !ok {
		t.Fatalf("want PubrecAction, got %T", act)
	}
	pa, err := r.HandlePubrel(context.Background(), q190.Pubrel{PacketID: id})
	if err != nil {
		t.Fatalf("HandlePubrel: %v", err)
	}
	if !pa.Applied || pa.Unknown {
		t.Fatalf("want applied pubcomp, got %+v", pa)
	}
	sink.markCommitted()
}

func mustRecord(t *testing.T, r *q190.Receiver, id uint16) q190.Record {
	t.Helper()
	rec, err := r.Load(context.Background(), id)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if rec == nil {
		t.Fatalf("record %d missing", id)
	}
	return *rec
}

func TestFullQoS2FlowAndSinkCommitCount(t *testing.T) {
	store := q190.NewMemoryStore()
	sink := &countingSink{}
	r := q190.NewReceiver(store, sink)
	ctx := context.Background()

	act, err := r.HandlePublish(ctx, q190.Publish{PacketID: 7, Payload: []byte("temp=21")})
	if err != nil {
		t.Fatal(err)
	}
	pubrec, ok := act.(q190.PubrecAction)
	if !ok || !pubrec.Stored || pubrec.Generation != 1 {
		t.Fatalf("unexpected action %#v", act)
	}

	rec := mustRecord(t, r, 7)
	if rec.Phase != q190.PhasePublished || string(rec.Payload) != "temp=21" || rec.Generation != 1 {
		t.Fatalf("unexpected persisted record %+v", rec)
	}

	pa, err := r.HandlePubrel(ctx, q190.Pubrel{PacketID: 7})
	if err != nil {
		t.Fatal(err)
	}
	if !pa.Applied || pa.Generation != 1 || pa.Unknown {
		t.Fatalf("unexpected pubcomp %#v", pa)
	}
	sink.markCommitted()

	rec = mustRecord(t, r, 7)
	if rec.Phase != q190.PhaseComplete {
		t.Fatalf("want complete, got %+v", rec)
	}
	if applied, committed := sink.counts(); applied != 1 || committed != 1 {
		t.Fatalf("sink applied=%d committed=%d, want 1/1", applied, committed)
	}
	if got := store.Completions(); len(got) != 1 || got[0].Generation != 1 {
		t.Fatalf("completions = %+v", got)
	}
}

func TestRetransmittedPublishSamePayload(t *testing.T) {
	store := q190.NewMemoryStore()
	sink := &countingSink{}
	r := q190.NewReceiver(store, sink)
	ctx := context.Background()

	for i := 0; i < 3; i++ {
		act, err := r.HandlePublish(ctx, q190.Publish{PacketID: 3, Payload: []byte("same"), Dup: i > 0})
		if err != nil {
			t.Fatal(err)
		}
		pubrec, ok := act.(q190.PubrecAction)
		if !ok {
			t.Fatalf("want pubrec, got %T", act)
		}
		if (i == 0) != pubrec.Stored {
			t.Fatalf("call %d: Stored=%v", i, pubrec.Stored)
		}
	}

	rec := mustRecord(t, r, 3)
	if rec.Generation != 1 || rec.Phase != q190.PhasePublished {
		t.Fatalf("unexpected record %+v", rec)
	}
	if applied, committed := sink.counts(); applied != 0 || committed != 0 {
		t.Fatalf("sink must not run before PUBREL, got %d/%d", applied, committed)
	}
}

func TestRetransmittedPublishDifferentPayloadRejected(t *testing.T) {
	store := q190.NewMemoryStore()
	sink := &countingSink{}
	r := q190.NewReceiver(store, sink)
	ctx := context.Background()

	if _, err := r.HandlePublish(ctx, q190.Publish{PacketID: 9, Payload: []byte("original")}); err != nil {
		t.Fatal(err)
	}
	act, err := r.HandlePublish(ctx, q190.Publish{PacketID: 9, Payload: []byte("tampered"), Dup: true})
	if err != nil {
		t.Fatalf("rejection is an action, not error: %v", err)
	}
	reject, ok := act.(q190.RejectAction)
	if !ok || !errors.Is(reject.Err, q190.ErrPayloadMismatch) || reject.Generation != 1 {
		t.Fatalf("unexpected action %#v", act)
	}

	rec := mustRecord(t, r, 9)
	if string(rec.Payload) != "original" || rec.Phase != q190.PhasePublished {
		t.Fatalf("original state mutated: %+v", rec)
	}
	if applied, committed := sink.counts(); applied != 0 || committed != 0 {
		t.Fatalf("sink must not run on rejection, got %d/%d", applied, committed)
	}

	act, err = r.HandlePublish(ctx, q190.Publish{PacketID: 9, Payload: []byte("original"), Dup: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := act.(q190.PubrecAction); !ok {
		t.Fatalf("want pubrec, got %T", act)
	}
}

func TestRetransmittedPubrelAppliesSinkOnce(t *testing.T) {
	store := q190.NewMemoryStore()
	sink := &countingSink{}
	r := q190.NewReceiver(store, sink)
	ctx := context.Background()

	deliverOnce(t, r, sink, 11, "payload")

	for i := 0; i < 4; i++ {
		pa, err := r.HandlePubrel(ctx, q190.Pubrel{PacketID: 11})
		if err != nil {
			t.Fatal(err)
		}
		if pa.Applied || pa.Unknown || pa.Generation != 1 {
			t.Fatalf("retransmission %d: %#v", i, pa)
		}
	}

	if applied, committed := sink.counts(); applied != 1 || committed != 1 {
		t.Fatalf("want exactly one effect, got applied=%d committed=%d", applied, committed)
	}
}

func TestPacketIDReuseStartsNewGeneration(t *testing.T) {
	store := q190.NewMemoryStore()
	sink := &countingSink{}
	r := q190.NewReceiver(store, sink)
	ctx := context.Background()

	deliverOnce(t, r, sink, 42, "gen1")

	act, err := r.HandlePublish(ctx, q190.Publish{PacketID: 42, Payload: []byte("gen2")})
	if err != nil {
		t.Fatal(err)
	}
	pubrec := act.(q190.PubrecAction)
	if !pubrec.Stored || pubrec.Generation != 2 {
		t.Fatalf("want new generation 2, got %#v", act)
	}
	rec := mustRecord(t, r, 42)
	if rec.Generation != 2 || rec.Phase != q190.PhasePublished || string(rec.Payload) != "gen2" {
		t.Fatalf("unexpected record %+v", rec)
	}

	act, err = r.HandlePublish(ctx, q190.Publish{PacketID: 42, Payload: []byte("gen2"), Dup: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := act.(q190.PubrecAction); !ok {
		t.Fatalf("want pubrec for gen2 duplicate, got %T", act)
	}

	deliverOnce(t, r, sink, 42, "gen2")

	rec = mustRecord(t, r, 42)
	if rec.Generation != 2 || rec.Phase != q190.PhaseComplete {
		t.Fatalf("unexpected final record %+v", rec)
	}
	if applied, committed := sink.counts(); applied != 2 || committed != 2 {
		t.Fatalf("want two committed effects, got applied=%d committed=%d", applied, committed)
	}
	got := store.Completions()
	want := []q190.Completion{{PacketID: 42, Generation: 1}, {PacketID: 42, Generation: 2}}
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("completion history = %+v, want %+v", got, want)
	}
}

func TestUnknownPubrelOnlyPubcomp(t *testing.T) {
	store := q190.NewMemoryStore()
	sink := &countingSink{}
	r := q190.NewReceiver(store, sink)

	pa, err := r.HandlePubrel(context.Background(), q190.Pubrel{PacketID: 99})
	if err != nil {
		t.Fatal(err)
	}
	if !pa.Unknown || pa.Applied || pa.Generation != 0 {
		t.Fatalf("unexpected action %#v", pa)
	}
	if applied, committed := sink.counts(); applied != 0 || committed != 0 {
		t.Fatalf("unknown PUBREL must have no effect, got %d/%d", applied, committed)
	}
	if rec, err := store.Load(context.Background(), 99); err != nil || rec != nil {
		t.Fatalf("unknown PUBREL must not create state, rec=%+v err=%v", rec, err)
	}
}

func TestCleanStartErasesProtocolState(t *testing.T) {
	store := q190.NewMemoryStore()
	sink := &countingSink{}
	r := q190.NewReceiver(store, sink)
	ctx := context.Background()

	deliverOnce(t, r, sink, 5, "a")
	deliverOnce(t, r, sink, 6, "b")
	if err := r.CleanStart(ctx); err != nil {
		t.Fatal(err)
	}

	for _, id := range []uint16{5, 6} {
		rec, err := r.Load(ctx, id)
		if err != nil || rec != nil {
			t.Fatalf("id %d should be cleared, rec=%+v err=%v", id, rec, err)
		}
	}

	pa, err := r.HandlePubrel(ctx, q190.Pubrel{PacketID: 5})
	if err != nil || !pa.Unknown {
		t.Fatalf("want unknown pubcomp, got %#v err=%v", pa, err)
	}
	act, err := r.HandlePublish(ctx, q190.Publish{PacketID: 5, Payload: []byte("fresh")})
	if err != nil {
		t.Fatal(err)
	}
	if pubrec := act.(q190.PubrecAction); pubrec.Generation != 1 || !pubrec.Stored {
		t.Fatalf("want fresh generation 1, got %#v", act)
	}
}

func TestDurableSessionRecoversStateAcrossReceivers(t *testing.T) {
	store := q190.NewMemoryStore()
	sink := &countingSink{}
	r1 := q190.NewReceiver(store, sink)
	ctx := context.Background()

	if _, err := r1.HandlePublish(ctx, q190.Publish{PacketID: 20, Payload: []byte("durable")}); err != nil {
		t.Fatal(err)
	}

	r2 := q190.NewReceiver(store, sink)
	rec := mustRecord(t, r2, 20)
	if rec.Phase != q190.PhasePublished || rec.Generation != 1 || string(rec.Payload) != "durable" {
		t.Fatalf("recovered record mismatch: %+v", rec)
	}

	act, err := r2.HandlePublish(ctx, q190.Publish{PacketID: 20, Payload: []byte("durable"), Dup: true})
	if err != nil {
		t.Fatal(err)
	}
	if pubrec := act.(q190.PubrecAction); pubrec.Stored || pubrec.Generation != 1 {
		t.Fatalf("unexpected recovered pubrec %#v", act)
	}

	pa, err := r2.HandlePubrel(ctx, q190.Pubrel{PacketID: 20})
	if err != nil {
		t.Fatal(err)
	}
	if !pa.Applied || pa.Generation != 1 {
		t.Fatalf("unexpected pubcomp %#v", pa)
	}
	sink.markCommitted()

	if applied, committed := sink.counts(); applied != 1 || committed != 1 {
		t.Fatalf("want one effect after recovery, got applied=%d committed=%d", applied, committed)
	}
}

func TestInvalidPacketID(t *testing.T) {
	store := q190.NewMemoryStore()
	sink := &countingSink{}
	r := q190.NewReceiver(store, sink)

	act, err := r.HandlePublish(context.Background(), q190.Publish{PacketID: 0, Payload: []byte("x")})
	if err != nil {
		t.Fatalf("want reject action, got error %v", err)
	}
	reject, ok := act.(q190.RejectAction)
	if !ok || !errors.Is(reject.Err, q190.ErrInvalidPacketID) {
		t.Fatalf("unexpected action %#v", act)
	}
	if _, err := r.HandlePubrel(context.Background(), q190.Pubrel{PacketID: 0}); !errors.Is(err, q190.ErrInvalidPacketID) {
		t.Fatalf("want ErrInvalidPacketID, got %v", err)
	}
	if applied, committed := sink.counts(); applied != 0 || committed != 0 {
		t.Fatalf("invalid id must have no effect, got %d/%d", applied, committed)
	}
}
