package q190_test

import (
	"context"
	"errors"
	"testing"

	q190 "example.com/dlks/q190"
)

// TestPublishCrashBoundaries crashes at every durable boundary of the PUBLISH
// half and verifies that retrying yields one stored generation and zero
// business effects.
func TestPublishCrashBoundaries(t *testing.T) {
	ctx := context.Background()
	const id uint16 = 31

	t.Run("begin_fails", func(t *testing.T) {
		store := q190.NewMemoryStore()
		sink := &countingSink{}
		r := q190.NewReceiver(store, sink)
		store.SetHooks(q190.MemoryHooks{OnBegin: func(uint16) error { return errInjected }})

		if _, err := r.HandlePublish(ctx, q190.Publish{PacketID: id, Payload: []byte("p")}); !errors.Is(err, errInjected) {
			t.Fatalf("want injected error, got %v", err)
		}
		if rec, _ := store.Load(ctx, id); rec != nil {
			t.Fatalf("nothing must persist when Begin fails: %+v", rec)
		}

		store.SetHooks(q190.MemoryHooks{})
		act, err := r.HandlePublish(ctx, q190.Publish{PacketID: id, Payload: []byte("p")})
		if err != nil {
			t.Fatal(err)
		}
		if pubrec := act.(q190.PubrecAction); !pubrec.Stored || pubrec.Generation != 1 {
			t.Fatalf("unexpected retry action %#v", act)
		}
		if applied, committed := sink.counts(); applied != 0 || committed != 0 {
			t.Fatalf("PUBLISH phase must not touch sink, got %d/%d", applied, committed)
		}
	})

	t.Run("put_publish_fails", func(t *testing.T) {
		store := q190.NewMemoryStore()
		sink := &countingSink{}
		r := q190.NewReceiver(store, sink)
		store.SetHooks(q190.MemoryHooks{OnPutPublish: func(q190.Record) error { return errInjected }})

		if _, err := r.HandlePublish(ctx, q190.Publish{PacketID: id, Payload: []byte("p")}); !errors.Is(err, errInjected) {
			t.Fatalf("want injected error, got %v", err)
		}
		if rec, _ := store.Load(ctx, id); rec != nil {
			t.Fatalf("rolled-back PUBLISH must not persist: %+v", rec)
		}

		store.SetHooks(q190.MemoryHooks{})
		act, err := r.HandlePublish(ctx, q190.Publish{PacketID: id, Payload: []byte("p")})
		if err != nil {
			t.Fatal(err)
		}
		if pubrec := act.(q190.PubrecAction); !pubrec.Stored || pubrec.Generation != 1 {
			t.Fatalf("unexpected retry action %#v", act)
		}
	})

	t.Run("commit_fails", func(t *testing.T) {
		store := q190.NewMemoryStore()
		sink := &countingSink{}
		r := q190.NewReceiver(store, sink)
		store.SetHooks(q190.MemoryHooks{
			OnCommit: func(rec *q190.Record) error {
				if rec.Phase == q190.PhasePublished {
					return errInjected
				}
				return nil
			},
		})

		if _, err := r.HandlePublish(ctx, q190.Publish{PacketID: id, Payload: []byte("p")}); !errors.Is(err, errInjected) {
			t.Fatalf("want injected error, got %v", err)
		}
		if rec, _ := store.Load(ctx, id); rec != nil {
			t.Fatalf("failed commit must behave like a crash: %+v", rec)
		}

		store.SetHooks(q190.MemoryHooks{})
		act, err := r.HandlePublish(ctx, q190.Publish{PacketID: id, Payload: []byte("p")})
		if err != nil {
			t.Fatal(err)
		}
		if pubrec := act.(q190.PubrecAction); !pubrec.Stored || pubrec.Generation != 1 {
			t.Fatalf("post-crash retry must create generation 1, got %#v", act)
		}
	})

	t.Run("load_fails", func(t *testing.T) {
		store := q190.NewMemoryStore()
		sink := &countingSink{}
		r := q190.NewReceiver(store, sink)
		store.SetHooks(q190.MemoryHooks{OnLoad: func(uint16) error { return errInjected }})

		if _, err := r.Load(ctx, id); !errors.Is(err, errInjected) {
			t.Fatalf("want injected error, got %v", err)
		}

		store.SetHooks(q190.MemoryHooks{})
		rec, err := r.Load(ctx, id)
		if err != nil || rec != nil {
			t.Fatalf("want empty state, rec=%+v err=%v", rec, err)
		}
	})
}
