package dataeng

import (
	"errors"
	"fmt"
)

func ExampleStore() {
	store := New()

	// Two regions fork from common history and write concurrently.
	us := Record{Key: "acct:1", Region: "us", Vector: VersionVector{"us": 2, "eu": 1}, Value: []byte("us-value")}
	eu := Record{Key: "acct:1", Region: "eu", Vector: VersionVector{"us": 1, "eu": 2}, Value: []byte("eu-value")}

	first, _ := store.Apply(us)
	second, _ := store.Apply(eu)
	fmt.Println("accepted:", first.Accepted, "conflicts:", second.Conflicts)

	// A later region write that dominates both forks converges the key.
	merged := Record{Key: "acct:1", Region: "us", Vector: VersionVector{"us": 3, "eu": 2}, Value: []byte("merged"), EventID: "evt-42"}
	_, _ = store.Apply(merged)
	value, _, _ := store.Lookup("acct:1")
	fmt.Println("converged:", string(value))

	// Replaying an already-seen EventID is a no-op.
	replay, _ := store.Apply(merged)
	fmt.Println("replay duplicate:", replay.Duplicate)

	// An unreachable region returns an error and never triggers deletion.
	outage := errors.New("eu region offline")
	source := SourceFunc{ID: "eu", PullFn: func() ([]Record, error) { return nil, outage }}
	summary, err := store.Ingest(source)
	fmt.Println("offline:", summary.Offline, "error:", err != nil)

	// After recovery the same source log replays idempotently.
	source.PullFn = func() ([]Record, error) { return []Record{merged}, nil }
	recovered, _ := store.Replay(source)
	fmt.Println("recovered duplicates:", recovered.Duplicate)

	// Output:
	// accepted: true conflicts: 2
	// converged: merged
	// replay duplicate: true
	// offline: true error: true
	// recovered duplicates: 1
}

func ExampleRegionPriorityPolicy() {
	store := New()
	_, _ = store.Apply(Record{Key: "acct:1", Region: "us", Vector: VersionVector{"us": 1}, Value: []byte("a")})
	_, _ = store.Apply(Record{Key: "acct:1", Region: "eu", Vector: VersionVector{"eu": 1}, Value: []byte("b")})

	winner, decided, _ := store.Resolve("acct:1", RegionPriorityPolicy{Priority: []string{"eu"}})
	fmt.Println("decided:", decided, "winner:", string(winner.Value))

	// Output:
	// decided: true winner: b
}
