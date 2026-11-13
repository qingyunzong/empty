package dataeng

import (
	"context"
	"fmt"
	"sync"
)

type mailboxRecord struct {
	mailbox       string
	generation    Generation
	uidValidity   UIDValidity
	uidNext       UID
	highestModSeq ModSeq
	revision      uint64
	messages      map[UID]Message
}

// MemoryStore is an in-memory reference Store. Commit validates the complete
// batch before changing any mailbox, so a failed Commit leaves all mailboxes
// untouched.
type MemoryStore struct {
	mu        sync.RWMutex
	mailboxes map[string]mailboxRecord
}

// NewMemoryStore returns an empty in-memory store.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{mailboxes: make(map[string]mailboxRecord)}
}

// Load implements Store.
func (s *MemoryStore) Load(ctx context.Context, mailbox string) (MailboxState, error) {
	if err := ctx.Err(); err != nil {
		return MailboxState{}, err
	}
	if mailbox == "" {
		return MailboxState{}, fmt.Errorf("%w: empty mailbox", ErrInvalidRequest)
	}

	s.mu.RLock()
	defer s.mu.RUnlock()

	record, ok := s.mailboxes[mailbox]
	if !ok {
		return MailboxState{}, fmt.Errorf("%w: %q", ErrMailboxNotFound, mailbox)
	}
	return stateFromRecord(record), nil
}

// Commit implements Store. The validation phase and the apply phase happen
// under one lock, so either every mailbox change is visible or none is.
func (s *MemoryStore) Commit(ctx context.Context, commit Commit) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if len(commit.Mailboxes) == 0 {
		return invalidCommit("empty batch")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	seen := make(map[string]struct{}, len(commit.Mailboxes))
	replacements := make([]mailboxRecord, 0, len(commit.Mailboxes))
	for _, change := range commit.Mailboxes {
		if change.Mailbox == "" {
			return invalidCommit("change with empty mailbox")
		}
		if _, duplicate := seen[change.Mailbox]; duplicate {
			return invalidCommit("mailbox %q occurs more than once", change.Mailbox)
		}
		seen[change.Mailbox] = struct{}{}

		var current *mailboxRecord
		if record, ok := s.mailboxes[change.Mailbox]; ok {
			copy := record
			copy.messages = cloneMessages(record.messages)
			current = &copy
		}
		next, err := applyChange(current, change)
		if err != nil {
			return err
		}
		replacements = append(replacements, next)
	}

	// All changes validated. Applying them cannot fail.
	for _, record := range replacements {
		s.mailboxes[record.mailbox] = record
	}
	return nil
}

func applyChange(current *mailboxRecord, change MailboxChange) (mailboxRecord, error) {
	var (
		currentRevision uint64
		messages        map[UID]Message
	)

	if current == nil {
		if change.ExpectedRevision != 0 {
			return mailboxRecord{}, fmt.Errorf("%w: expected revision %d for absent mailbox",
				ErrRevisionConflict, change.ExpectedRevision)
		}
		if !change.Reset {
			return mailboxRecord{}, invalidCommit("mailbox %q has no state; Reset must be true", change.Mailbox)
		}
		if change.Generation != 1 {
			return mailboxRecord{}, invalidCommit("first generation must be 1, got %d", change.Generation)
		}
		messages = make(map[UID]Message)
	} else {
		if change.ExpectedRevision != current.revision {
			return mailboxRecord{}, fmt.Errorf("%w: mailbox %q expected %d, have %d",
				ErrRevisionConflict, change.Mailbox, change.ExpectedRevision, current.revision)
		}
		currentRevision = current.revision
		if change.Reset {
			if change.Generation != current.generation+1 {
				return mailboxRecord{}, invalidCommit("generation must advance from %d to %d, got %d",
					current.generation, current.generation+1, change.Generation)
			}
			if change.UIDValidity == current.uidValidity {
				return mailboxRecord{}, invalidCommit("new generation must have a new UIDVALIDITY")
			}
			if len(change.Deletes) != 0 {
				return mailboxRecord{}, invalidCommit("a reset generation must not contain Deletes")
			}
			messages = make(map[UID]Message)
		} else {
			if change.Generation != current.generation {
				return mailboxRecord{}, invalidCommit("generation changed without Reset")
			}
			if change.UIDValidity != current.uidValidity {
				return mailboxRecord{}, invalidCommit("UIDVALIDITY changed without starting a new generation")
			}
			if change.UIDNext < current.uidNext {
				return mailboxRecord{}, fmt.Errorf("%w: mailbox %q UIDNEXT %d is below %d",
					ErrCursorRegression, change.Mailbox, change.UIDNext, current.uidNext)
			}
			if change.HighestModSeq < current.highestModSeq {
				return mailboxRecord{}, fmt.Errorf("%w: mailbox %q HIGHESTMODSEQ %d is below %d",
					ErrCursorRegression, change.Mailbox, change.HighestModSeq, current.highestModSeq)
			}
			messages = cloneMessages(current.messages)
		}
	}

	if change.UIDValidity == 0 {
		return mailboxRecord{}, invalidCommit("UIDVALIDITY must be non-zero")
	}
	if change.UIDNext == 0 {
		return mailboxRecord{}, invalidCommit("UIDNEXT must be non-zero")
	}

	deleted := make(map[UID]struct{}, len(change.Deletes))
	for _, uid := range change.Deletes {
		if uid == 0 {
			return mailboxRecord{}, invalidCommit("delete with UID 0")
		}
		if _, duplicate := deleted[uid]; duplicate {
			return mailboxRecord{}, invalidCommit("UID %d deleted more than once", uid)
		}
		deleted[uid] = struct{}{}
		delete(messages, uid)
	}

	upserted := make(map[UID]struct{}, len(change.Upserts))
	for _, message := range change.Upserts {
		if message.UID == 0 {
			return mailboxRecord{}, invalidCommit("upsert with UID 0")
		}
		if _, duplicate := upserted[message.UID]; duplicate {
			return mailboxRecord{}, invalidCommit("UID %d upserted more than once", message.UID)
		}
		upserted[message.UID] = struct{}{}
		if _, conflict := deleted[message.UID]; conflict {
			return mailboxRecord{}, invalidCommit("UID %d is both deleted and upserted", message.UID)
		}
		if message.UID >= change.UIDNext {
			return mailboxRecord{}, invalidCommit("UID %d is not below UIDNEXT %d", message.UID, change.UIDNext)
		}
		if message.ModSeq > change.HighestModSeq {
			return mailboxRecord{}, invalidCommit("message UID %d MODSEQ %d exceeds HIGHESTMODSEQ %d",
				message.UID, message.ModSeq, change.HighestModSeq)
		}
		messages[message.UID] = cloneMessage(message)
	}

	for uid, message := range messages {
		if uid >= change.UIDNext {
			return mailboxRecord{}, invalidCommit("stored UID %d is not below UIDNEXT %d", uid, change.UIDNext)
		}
		if message.ModSeq > change.HighestModSeq {
			return mailboxRecord{}, invalidCommit("stored message UID %d MODSEQ %d exceeds HIGHESTMODSEQ %d",
				uid, message.ModSeq, change.HighestModSeq)
		}
	}

	return mailboxRecord{
		mailbox:       change.Mailbox,
		generation:    change.Generation,
		uidValidity:   change.UIDValidity,
		uidNext:       change.UIDNext,
		highestModSeq: change.HighestModSeq,
		revision:      currentRevision + 1,
		messages:      messages,
	}, nil
}
