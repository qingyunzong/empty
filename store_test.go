package dataeng

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

func TestMemoryStoreCommitIsAllOrNothing(t *testing.T) {
	store := NewMemoryStore()
	tracker := NewTracker(store)
	ctx := context.Background()
	mustOpen(t, tracker, "A", 100, 5, 0)
	mustOpen(t, tracker, "B", 200, 5, 0)

	stateA := mustState(t, tracker, "A")
	stateB := mustState(t, tracker, "B")
	beforeA := stateA
	beforeB := stateB

	// The second change is invalid (UID 9 is not below UIDNEXT 5). The first
	// change alone would be valid, but the whole batch must be rejected.
	err := store.Commit(ctx, Commit{Mailboxes: []MailboxChange{
		{
			Mailbox:          "A",
			ExpectedRevision: stateA.Revision,
			Generation:       stateA.Generation,
			UIDValidity:      stateA.UIDValidity,
			Upserts:          []Message{{UID: 1, ModSeq: 1}},
			UIDNext:          5,
			HighestModSeq:    1,
		},
		{
			Mailbox:          "B",
			ExpectedRevision: stateB.Revision,
			Generation:       stateB.Generation,
			UIDValidity:      stateB.UIDValidity,
			Upserts:          []Message{{UID: 9, ModSeq: 1}},
			UIDNext:          5,
			HighestModSeq:    1,
		},
	}})
	if !errors.Is(err, ErrInvalidCommit) {
		t.Fatalf("batch error = %v", err)
	}
	if got := mustState(t, tracker, "A"); !reflect.DeepEqual(beforeA, got) {
		t.Fatalf("A changed despite failed batch\nbefore: %+v\nafter:  %+v", beforeA, got)
	}
	if got := mustState(t, tracker, "B"); !reflect.DeepEqual(beforeB, got) {
		t.Fatalf("B changed despite failed batch\nbefore: %+v\nafter:  %+v", beforeB, got)
	}
}

func TestMemoryStoreCommitUpdatesMessageAndRecoveryPointTogether(t *testing.T) {
	store := NewMemoryStore()
	tracker := NewTracker(store)
	ctx := context.Background()
	mustOpen(t, tracker, "INBOX", 100, 5, 0)
	state := mustState(t, tracker, "INBOX")

	err := store.Commit(ctx, Commit{Mailboxes: []MailboxChange{{
		Mailbox:          "INBOX",
		ExpectedRevision: state.Revision,
		Generation:       state.Generation,
		UIDValidity:      state.UIDValidity,
		Upserts:          []Message{{UID: 3, ModSeq: 10, MessageID: "m3"}},
		UIDNext:          8,
		HighestModSeq:    10,
	}}})
	if err != nil {
		t.Fatalf("Commit: %v", err)
	}

	next := mustState(t, tracker, "INBOX")
	if next.Revision != state.Revision+1 {
		t.Fatalf("revision = %d", next.Revision)
	}
	if next.UIDNext != 8 || next.HighestModSeq != 10 {
		t.Fatalf("recovery point = %+v", next)
	}
	if message, ok := next.Messages[3]; !ok || message.MessageID != "m3" || message.ModSeq != 10 {
		t.Fatalf("message = %+v, present=%v", message, ok)
	}
}

func TestMemoryStoreRejectsRevisionConflict(t *testing.T) {
	store := NewMemoryStore()
	tracker := NewTracker(store)
	ctx := context.Background()
	mustOpen(t, tracker, "INBOX", 100, 5, 0)
	state := mustState(t, tracker, "INBOX")

	change := MailboxChange{
		Mailbox:          "INBOX",
		ExpectedRevision: state.Revision,
		Generation:       state.Generation,
		UIDValidity:      state.UIDValidity,
		Upserts:          []Message{{UID: 1, ModSeq: 1}},
		UIDNext:          5,
		HighestModSeq:    1,
	}
	if err := store.Commit(ctx, Commit{Mailboxes: []MailboxChange{change}}); err != nil {
		t.Fatalf("first Commit: %v", err)
	}

	// Reuse the stale expected revision.
	err := store.Commit(ctx, Commit{Mailboxes: []MailboxChange{change}})
	if !errors.Is(err, ErrRevisionConflict) {
		t.Fatalf("second Commit error = %v", err)
	}
	state = mustState(t, tracker, "INBOX")
	if state.Revision != 2 {
		t.Fatalf("revision = %d", state.Revision)
	}
	if message := state.Messages[1]; message.ModSeq != 1 {
		t.Fatalf("message = %+v", message)
	}
}

func TestMemoryStoreValidatesRecoveryPointAndMessages(t *testing.T) {
	store := NewMemoryStore()
	tracker := NewTracker(store)
	ctx := context.Background()
	mustOpen(t, tracker, "INBOX", 100, 5, 10)
	state := mustState(t, tracker, "INBOX")

	cases := []struct {
		name   string
		change MailboxChange
		want   error
	}{
		{
			name: "message modseq above highest",
			change: MailboxChange{
				Mailbox: "INBOX", ExpectedRevision: state.Revision,
				Generation: state.Generation, UIDValidity: state.UIDValidity,
				Upserts: []Message{{UID: 1, ModSeq: 11}},
				UIDNext: 5, HighestModSeq: 10,
			},
			want: ErrInvalidCommit,
		},
		{
			name: "uid not below uidnext",
			change: MailboxChange{
				Mailbox: "INBOX", ExpectedRevision: state.Revision,
				Generation: state.Generation, UIDValidity: state.UIDValidity,
				Upserts: []Message{{UID: 5, ModSeq: 10}},
				UIDNext: 5, HighestModSeq: 10,
			},
			want: ErrInvalidCommit,
		},
		{
			name: "uidnext regression",
			change: MailboxChange{
				Mailbox: "INBOX", ExpectedRevision: state.Revision,
				Generation: state.Generation, UIDValidity: state.UIDValidity,
				UIDNext: 4, HighestModSeq: 10,
			},
			want: ErrCursorRegression,
		},
		{
			name: "highest modseq regression",
			change: MailboxChange{
				Mailbox: "INBOX", ExpectedRevision: state.Revision,
				Generation: state.Generation, UIDValidity: state.UIDValidity,
				UIDNext: 5, HighestModSeq: 9,
			},
			want: ErrCursorRegression,
		},
		{
			name: "delete and upsert same uid",
			change: MailboxChange{
				Mailbox: "INBOX", ExpectedRevision: state.Revision,
				Generation: state.Generation, UIDValidity: state.UIDValidity,
				Deletes: []UID{1}, Upserts: []Message{{UID: 1, ModSeq: 10}},
				UIDNext: 5, HighestModSeq: 10,
			},
			want: ErrInvalidCommit,
		},
		{
			name: "uidvalidity changed without reset",
			change: MailboxChange{
				Mailbox: "INBOX", ExpectedRevision: state.Revision,
				Generation: state.Generation, UIDValidity: 101,
				UIDNext: 5, HighestModSeq: 10,
			},
			want: ErrInvalidCommit,
		},
		{
			name: "reset skips a generation",
			change: MailboxChange{
				Mailbox: "INBOX", ExpectedRevision: state.Revision,
				Reset: true, Generation: state.Generation + 2, UIDValidity: 101,
				UIDNext: 5, HighestModSeq: 1,
			},
			want: ErrInvalidCommit,
		},
		{
			name: "reset without new uidvalidity",
			change: MailboxChange{
				Mailbox: "INBOX", ExpectedRevision: state.Revision,
				Reset: true, Generation: state.Generation + 1, UIDValidity: 100,
				UIDNext: 5, HighestModSeq: 1,
			},
			want: ErrInvalidCommit,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := store.Commit(ctx, Commit{Mailboxes: []MailboxChange{tc.change}})
			if !errors.Is(err, tc.want) {
				t.Fatalf("error = %v, want %v", err, tc.want)
			}
			if got := mustState(t, tracker, "INBOX"); !reflect.DeepEqual(got, state) {
				t.Fatalf("state changed after rejected commit: %+v", got)
			}
		})
	}
}

func TestMemoryStoreDuplicateMailboxInBatch(t *testing.T) {
	store := NewMemoryStore()
	tracker := NewTracker(store)
	ctx := context.Background()
	mustOpen(t, tracker, "INBOX", 100, 5, 0)
	state := mustState(t, tracker, "INBOX")

	change := MailboxChange{
		Mailbox: "INBOX", ExpectedRevision: state.Revision,
		Generation: state.Generation, UIDValidity: state.UIDValidity,
		UIDNext: 5, HighestModSeq: 0,
	}
	err := store.Commit(ctx, Commit{Mailboxes: []MailboxChange{change, change}})
	if !errors.Is(err, ErrInvalidCommit) {
		t.Fatalf("duplicate mailbox error = %v", err)
	}
}
