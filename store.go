package dataeng

import (
	"context"
	"fmt"
)

// Store persists mailbox generations and their recovery points.
//
// Commit is the only write operation and MUST be atomic: it either applies
// every MailboxChange (messages and recovery point) in the supplied Commit,
// or it applies none of them. Implementations backed by a database should use
// one transaction per Commit.
//
// Load must return a stable copy of the state. Commit must reject a change
// whose ExpectedRevision does not match the currently stored Revision.
type Store interface {
	Load(ctx context.Context, mailbox string) (MailboxState, error)
	Commit(ctx context.Context, commit Commit) error
}

func maxUID(a, b UID) UID {
	if a > b {
		return a
	}
	return b
}

func maxModSeq(a, b ModSeq) ModSeq {
	if a > b {
		return a
	}
	return b
}

func cloneStrings(in []string) []string {
	if in == nil {
		return nil
	}
	out := make([]string, len(in))
	copy(out, in)
	return out
}

func cloneKey(in *MessageKey) *MessageKey {
	if in == nil {
		return nil
	}
	out := *in
	return &out
}

func cloneMessage(in Message) Message {
	out := in
	out.Flags = cloneStrings(in.Flags)
	out.MovedFrom = cloneKey(in.MovedFrom)
	return out
}

func cloneMessages(in map[UID]Message) map[UID]Message {
	out := make(map[UID]Message, len(in))
	for uid, msg := range in {
		out[uid] = cloneMessage(msg)
	}
	return out
}

func stateFromRecord(record mailboxRecord) MailboxState {
	return MailboxState{
		Mailbox:       record.mailbox,
		Generation:    record.generation,
		UIDValidity:   record.uidValidity,
		UIDNext:       record.uidNext,
		HighestModSeq: record.highestModSeq,
		Revision:      record.revision,
		Messages:      cloneMessages(record.messages),
	}
}

func invalidCommit(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalidCommit, fmt.Sprintf(format, args...))
}
