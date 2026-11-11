package q190_test

import (
	"context"
	"errors"
	"fmt"
	"testing"

	q190 "example.com/dlks/q190"
)

// TestPubrelCrashBoundaries verifies the atomicity requirement: until the
// transaction containing both the sink effect and the completion marker
// commits, the exchange stays PhasePublished with zero committed effects;
// after a successful retry there is exactly one.
func TestPubrelCrashBoundaries(t *testing.T) {
	ctx := context.Background()
	const id uint16 = 47

	cases := []struct {
		name  string
		hooks q190.MemoryHooks
		sink  *countingSink
	}{
		{
			name: "sink_apply_fails",
			sink: &countingSink{failGen: 1, err: errInjected},
		},
		{
			name:  "put_complete_fails",
			sink:  &countingSink{},
			hooks: q190.MemoryHooks{OnPutComplete: func(q190.Record) error { return errInjected }},
		},
		{
			name: "commit_fails",
			sink: &countingSink{},
			hooks: q190.MemoryHooks{
				OnCommit: func(rec *q190.Record) error {
					if rec.Phase == q190.PhaseComplete {
						return errInjected
					}
					return nil
				},
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := q190.NewMemoryStore()
			r := q190.NewReceiver(store, tc.sink)

			if _, err := r.HandlePublish(ctx, q190.Publish{PacketID: id, Payload: []byte("p")}); err != nil {
				t.Fatal(err)
			}
			store.SetHooks(tc.hooks)

			if _, err := r.HandlePubrel(ctx, q190.Pubrel{PacketID: id}); !errors.Is(err, errInjected) {
				t.Fatalf("want injected error, got %v", err)
			}

			rec, err := store.Load(ctx, id)
			if err != nil || rec == nil || rec.Phase != q190.PhasePublished {
				t.Fatalf("after crash the exchange must remain published, rec=%+v err=%v", rec, err)
			}
			if got := store.Completions(); len(got) != 0 {
				t.Fatalf("no completion before commit, got %+v", got)
			}
			if applied, committed := tc.sink.counts(); committed != 0 {
				t.Fatalf("zero committed effects allowed before commit, applied=%d committed=%d", applied, committed)
			}

			store.SetHooks(q190.MemoryHooks{})
			tc.sink.failGen = 0
			pa, err := r.HandlePubrel(ctx, q190.Pubrel{PacketID: id})
			if err != nil {
				t.Fatal(err)
			}
			if !pa.Applied || pa.Generation != 1 {
				t.Fatalf("retry must apply once, got %#v", pa)
			}
			tc.sink.markCommitted()

			for i := 0; i < 3; i++ {
				if pa, err := r.HandlePubrel(ctx, q190.Pubrel{PacketID: id}); err != nil || pa.Applied {
					t.Fatalf("retransmission %d must not reapply: %#v err=%v", i, pa, err)
				}
			}

			rec, _ = store.Load(ctx, id)
			if rec.Phase != q190.PhaseComplete {
				t.Fatalf("want complete, got %+v", rec)
			}
			// The aborted attempt invoked Apply once but rolled back; the retry
			// invoked it once more and committed. Only the second one is a
			// business effect, which is why committed and Completions are 1.
			if applied, committed := tc.sink.counts(); applied != 2 || committed != 1 {
				t.Fatalf("want 2 Apply attempts but 1 commit, got applied=%d committed=%d", applied, committed)
			}
			if got := store.Completions(); len(got) != 1 || got[0].Generation != 1 {
				t.Fatalf("completions = %+v", got)
			}
		})
	}
}

func TestClearCrashBoundaryKeepsState(t *testing.T) {
	ctx := context.Background()
	store := q190.NewMemoryStore()
	sink := &countingSink{}
	r := q190.NewReceiver(store, sink)
	deliverOnce(t, r, sink, 8, "p")

	store.SetHooks(q190.MemoryHooks{OnClear: func() error { return errInjected }})
	if err := r.CleanStart(ctx); !errors.Is(err, errInjected) {
		t.Fatalf("want injected error, got %v", err)
	}

	store.SetHooks(q190.MemoryHooks{})
	rec := mustRecord(t, r, 8)
	if rec.Phase != q190.PhaseComplete {
		t.Fatalf("failed clean start must preserve state, got %+v", rec)
	}
	if applied, committed := sink.counts(); applied != 1 || committed != 1 {
		t.Fatalf("clean start must not touch sink, got %d/%d", applied, committed)
	}

	if err := r.CleanStart(ctx); err != nil {
		t.Fatal(err)
	}
	if rec, _ := store.Load(ctx, 8); rec != nil {
		t.Fatalf("state must be gone after successful clean start: %+v", rec)
	}
}

func TestRepeatedCrashesAcrossGenerationsCountEffects(t *testing.T) {
	ctx := context.Background()
	store := q190.NewMemoryStore()
	sink := &countingSink{}
	r := q190.NewReceiver(store, sink)
	const id uint16 = 55

	for gen := int64(1); gen <= 3; gen++ {
		store.SetHooks(q190.MemoryHooks{
			OnCommit: func(rec *q190.Record) error {
				if rec.Phase == q190.PhaseComplete && rec.Generation == gen {
					return errInjected
				}
				return nil
			},
		})
		payload := fmt.Sprintf("payload-%d", gen)
		if _, err := r.HandlePublish(ctx, q190.Publish{PacketID: id, Payload: []byte(payload)}); err != nil {
			t.Fatalf("gen %d publish: %v", gen, err)
		}
		if _, err := r.HandlePubrel(ctx, q190.Pubrel{PacketID: id}); !errors.Is(err, errInjected) {
			t.Fatalf("gen %d want injected error", gen)
		}

		store.SetHooks(q190.MemoryHooks{})
		pa, err := r.HandlePubrel(ctx, q190.Pubrel{PacketID: id})
		if err != nil {
			t.Fatal(err)
		}
		if !pa.Applied || pa.Generation != gen {
			t.Fatalf("gen %d unexpected pubcomp %#v", gen, pa)
		}
		sink.markCommitted()

		rec := mustRecord(t, r, id)
		if rec.Generation != gen || rec.Phase != q190.PhaseComplete || string(rec.Payload) != payload {
			t.Fatalf("gen %d bad record %+v", gen, rec)
		}
		// Each generation has one aborted Apply (commit crashed) and one
		// successful Apply, but exactly one committed business effect.
		if applied, committed := sink.counts(); int64(applied) != 2*gen || int64(committed) != gen {
			t.Fatalf("gen %d want applied=%d committed=%d, got applied=%d committed=%d", gen, 2*gen, gen, applied, committed)
		}
	}

	got := store.Completions()
	if len(got) != 3 {
		t.Fatalf("completions = %+v", got)
	}
	for i, c := range got {
		if c.PacketID != id || c.Generation != int64(i+1) {
			t.Fatalf("completion %d = %+v", i, c)
		}
	}
}
