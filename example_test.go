package dataeng_test

import (
	"context"
	"fmt"

	"example.org/dataeng/q0012"
)

func ExampleTracker() {
	ctx := context.Background()
	tracker := dataeng.NewTracker(dataeng.NewMemoryStore())

	opened, err := tracker.Open(ctx, dataeng.OpenRequest{
		Mailbox:       "INBOX",
		UIDValidity:   100,
		UIDNext:       1,
		HighestModSeq: 0,
	})
	if err != nil {
		panic(err)
	}
	fmt.Println("full sync:", opened.ResyncRequired)

	snapshot, err := tracker.Snapshot(ctx, "INBOX")
	if err != nil {
		panic(err)
	}
	if err := tracker.ApplyFetch(ctx, snapshot, []dataeng.Message{
		{UID: 1, ModSeq: 10, MessageID: "<one@example.org>"},
		{UID: 2, ModSeq: 11, MessageID: "<one@example.org>"},
	}); err != nil {
		panic(err)
	}

	point, err := tracker.RecoveryPoint(ctx, "INBOX")
	if err != nil {
		panic(err)
	}
	fmt.Println("records:", 2, "uidnext:", point.UIDNext, "modseq:", point.HighestModSeq)

	request, err := tracker.BeginQResync(ctx, "INBOX")
	if err != nil {
		panic(err)
	}
	if err := tracker.ApplyQResync(ctx, request, dataeng.QResyncResponse{
		Vanished:      []dataeng.UID{1},
		UIDNext:       3,
		HighestModSeq: 20,
	}); err != nil {
		panic(err)
	}
	state, err := tracker.State(ctx, "INBOX")
	if err != nil {
		panic(err)
	}
	fmt.Println("remaining UIDs:", len(state.Messages))

	// Output:
	// full sync: true
	// records: 2 uidnext: 3 modseq: 11
	// remaining UIDs: 1
}
