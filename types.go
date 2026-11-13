package dataeng

import "time"

// UIDValidity is the IMAP UIDVALIDITY value of a mailbox incarnation.
type UIDValidity uint32

// UID is an IMAP unique identifier within one UIDVALIDITY generation.
type UID uint32

// ModSeq is an IMAP CONDSTORE/QRESYNC modification sequence.
type ModSeq uint64

// Generation is the local, monotonically increasing number of a mailbox
// incarnation. A new generation starts whenever UIDVALIDITY changes. Zero
// means that no generation has been opened.
type Generation uint64

// MessageKey is the identity of one archived message record. Message-ID is
// deliberately not part of the identity: a move or copy creates a new UID and
// therefore a new record, even when the Message-ID header is unchanged.
type MessageKey struct {
	Mailbox     string
	Generation  Generation
	UIDValidity UIDValidity
	UID         UID
}

// Message is the incremental state of one message.
//
// MessageID is retained as metadata only. It is never used to deduplicate or
// merge records.
type Message struct {
	UID          UID
	ModSeq       ModSeq
	MessageID    string
	Flags        []string
	InternalDate time.Time
	Size         uint32

	// MovedFrom records the record from which this message was moved or
	// copied. It is provenance, not identity: the new UID remains a distinct
	// record even if MessageID equals the source record's MessageID.
	MovedFrom *MessageKey
}

// RecoveryPoint is the durable incremental cursor for a mailbox generation.
//
// UIDNext is the durable UID watermark from which the next incremental fetch
// starts. HighestModSeq is the highest modification sequence observed for the
// generation. Both are persisted together with message changes by
// Store.Commit.
type RecoveryPoint struct {
	Mailbox       string
	Generation    Generation
	UIDValidity   UIDValidity
	UIDNext       UID
	HighestModSeq ModSeq
	Revision      uint64
}

// Snapshot is an immutable view of a mailbox at one revision. Every response
// that mutates incremental state must carry the Snapshot on which it is based.
// Revision is opaque to callers; it is used for optimistic concurrency and for
// QRESYNC snapshot isolation.
type Snapshot struct {
	Mailbox       string
	Generation    Generation
	UIDValidity   UIDValidity
	UIDNext       UID
	HighestModSeq ModSeq
	Revision      uint64
}

// MailboxState is the complete persisted state of one mailbox generation.
// Messages is keyed by UID. A caller must not mutate the returned value.
type MailboxState struct {
	Mailbox       string
	Generation    Generation
	UIDValidity   UIDValidity
	UIDNext       UID
	HighestModSeq ModSeq
	Revision      uint64
	Messages      map[UID]Message
}

// Key returns the identity of uid in this mailbox generation. It is suitable
// as the archive record key; Message-ID must not be used instead.
func (s MailboxState) Key(uid UID) MessageKey {
	return MessageKey{
		Mailbox:     s.Mailbox,
		Generation:  s.Generation,
		UIDValidity: s.UIDValidity,
		UID:         uid,
	}
}

// OpenRequest describes a SELECT/EXAMINE response used to open a mailbox.
// UIDNext and HighestModSeq may be zero when the server did not report them.
type OpenRequest struct {
	Mailbox       string
	UIDValidity   UIDValidity
	UIDNext       UID
	HighestModSeq ModSeq
}

// OpenResult reports what happened while opening a mailbox.
type OpenResult struct {
	RecoveryPoint       RecoveryPoint
	PreviousGeneration  Generation
	PreviousUIDValidity UIDValidity
	UIDValidityChanged  bool

	// ServerUIDNext and ServerHighestModSeq echo the values supplied in the
	// SELECT response. For an already-open generation they are informational;
	// the durable cursors in RecoveryPoint are intentionally left at the last
	// committed values so the next QRESYNC can replay the missing window.
	ServerUIDNext       UID
	ServerHighestModSeq ModSeq

	// ResyncRequired is true for a first open and for every UIDVALIDITY
	// change. In both cases no incremental state from an older generation may
	// be reused.
	ResyncRequired bool
}

// QResyncRequest is the request-side snapshot for RFC 7162 QRESYNC. It binds
// the subsequent response to one mailbox generation and revision.
type QResyncRequest struct {
	Mailbox     string
	Generation  Generation
	UIDValidity UIDValidity
	UIDNext     UID
	Since       ModSeq
	KnownUIDs   []UID
	Revision    uint64
}

// QResyncResponse is the state-changing part of a QRESYNC response.
//
// Vanished contains UIDs reported as expunged. Messages contains FETCH
// updates. UIDNext and HighestModSeq are zero when the server did not report
// them.
type QResyncResponse struct {
	// UIDValidity is the SELECT-reported UIDVALIDITY, when available. A non-
	// zero value that differs from the request snapshot means the mailbox
	// changed generations; the response must not be applied to the old
	// snapshot.
	UIDValidity   UIDValidity
	Vanished      []UID
	Messages      []Message
	UIDNext       UID
	HighestModSeq ModSeq
}

// MoveRequest maps message records to newly assigned UIDs in another mailbox.
//
// SourceUIDs and DestinationUIDs are parallel. A move always creates new
// records in the destination generation; Message-ID is copied as metadata but
// never causes the new record to replace or merge with an existing one.
type MoveRequest struct {
	DestinationMailbox string
	SourceUIDs         []UID
	DestinationUIDs    []UID

	// DestinationModSeq is stamped on every newly created destination record.
	// Zero means that the server did not report a MODSEQ.
	DestinationModSeq ModSeq

	// DestinationHighestModSeq advances the destination recovery point. Zero
	// leaves the current value unchanged. A non-zero value must not be lower
	// than the destination snapshot's HighestModSeq.
	DestinationHighestModSeq ModSeq
}

// MailboxChange is one mailbox's part of an atomic Commit. It contains both
// message mutations and the recovery point that must be committed with them.
//
// If Reset is true, the active generation is closed and the new generation
// starts with Upserts. A production Store may retain messages from older
// generations for archive queries, but it must not expose them as members of
// the new generation. Otherwise Generation and UIDValidity must equal the
// currently stored generation.
type MailboxChange struct {
	Mailbox          string
	ExpectedRevision uint64
	Reset            bool
	Generation       Generation
	UIDValidity      UIDValidity
	Deletes          []UID
	Upserts          []Message
	UIDNext          UID
	HighestModSeq    ModSeq
}

// Commit is an atomic batch of mailbox changes.
//
// A Store must persist every MailboxChange in the batch and every recovery
// point together, or persist none of them. This is what makes a move between
// two mailboxes and the corresponding recovery-point advance atomic.
type Commit struct {
	Mailboxes []MailboxChange
}
