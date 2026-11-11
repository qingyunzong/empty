package q190_test

import (
	"context"
	"testing"

	q190 "example.com/dlks/q190"
)

func TestPhaseString(t *testing.T) {
	cases := map[q190.Phase]string{
		q190.PhaseUnknown:   "unknown",
		q190.PhasePublished: "published",
		q190.PhaseComplete:  "complete",
	}
	for phase, want := range cases {
		if got := phase.String(); got != want {
			t.Fatalf("Phase(%d).String() = %q, want %q", phase, got, want)
		}
	}
}

func TestSinkFuncAndUnderlying(t *testing.T) {
	ctx := context.Background()
	store := q190.NewMemoryStore()
	called := false
	sink := q190.SinkFunc(func(_ context.Context, tx q190.Tx, rec q190.Record) error {
		called = true
		if _, ok := tx.Underlying().(*q190.MemoryTx); !ok {
			t.Fatalf("Underlying = %T, want *MemoryTx", tx.Underlying())
		}
		return nil
	})
	r := q190.NewReceiver(store, sink)

	if _, err := r.HandlePublish(ctx, q190.Publish{PacketID: 77, Payload: []byte("p")}); err != nil {
		t.Fatal(err)
	}
	if pa, err := r.HandlePubrel(ctx, q190.Pubrel{PacketID: 77}); err != nil || !pa.Applied {
		t.Fatalf("unexpected pubcomp %#v err=%v", pa, err)
	}
	if !called {
		t.Fatal("SinkFunc was not invoked")
	}
}

func TestNewReceiverRequiresDependencies(t *testing.T) {
	t.Run("nil store", func(t *testing.T) {
		defer func() {
			if recover() == nil {
				t.Fatal("expected panic for nil store")
			}
		}()
		q190.NewReceiver(nil, &countingSink{})
	})
	t.Run("nil sink", func(t *testing.T) {
		defer func() {
			if recover() == nil {
				t.Fatal("expected panic for nil sink")
			}
		}()
		q190.NewReceiver(q190.NewMemoryStore(), nil)
	})
}
