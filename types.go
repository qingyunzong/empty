package dataeng

import "time"

// Digest is a content digest computed over the RFC 5322 body of a message.
// It lets the archiver verify that a UID still points at the same content
// after an incremental sync and detect silent content drift.
type Digest struct {
	// Alg is the digest algorithm, currently only "sha256" is produced.
	Alg string `json:"alg"`

	// Hex is the lowercase hexadecimal encoding of the digest sum.
	Hex string `json:"hex"`

	// Size is the number of body bytes that were hashed.
	Size int64 `json:"size"`
}

// Message is the archived view of one IMAP message in the active generation.
type Message struct {
	// UID is the IMAP UID, unique within (UIDVALIDITY generation).
	UID uint32 `json:"uid"`

	// ModSeq is the CONDSTORE/QRESYNC modification sequence. It is zero when
	// the server does not support CONDSTORE.
	ModSeq uint64 `json:"modseq"`

	// Digest is the body content digest captured at fetch time.
	Digest Digest `json:"digest"`

	// Flags holds the IMAP message flags (\Seen, \Flagged, ...) if observed.
	Flags []string `json:"flags,omitempty"`

	// FirstSeen is when the archiver first recorded this UID.
	FirstSeen time.Time `json:"first_seen"`

	// LastUpdated is when the record was last replaced by a fetch.
	LastUpdated time.Time `json:"last_updated"`
}

// Removal reasons recorded on tombstones.
const (
	// ReasonExpunge marks a classic IMAP EXPUNGE observation.
	ReasonExpunge = "expunge"

	// ReasonVanished marks a QRESYNC VANISHED observation.
	ReasonVanished = "vanished"

	// ReasonReconcile marks a UID that disappeared during a full-list
	// reconciliation without a discrete removal event.
	ReasonReconcile = "reconcile"
)

// Tombstone retains evidence that a UID was removed from a mailbox
// generation. Tombstones are never garbage collected automatically so the
// archive can always prove when and why a UID vanished, even if the discrete
// EXPUNGE/VANISHED event arrived before the message body had been fetched.
type Tombstone struct {
	// UID is the removed IMAP UID.
	UID uint32 `json:"uid"`

	// ModSeq is the modification sequence at or after which the removal took
	// effect. It is zero when the server did not report one.
	ModSeq uint64 `json:"modseq"`

	// Reason is one of ReasonExpunge, ReasonVanished or ReasonReconcile.
	Reason string `json:"reason"`

	// Earlier records a QRESYNC VANISHED (EARLIER) response, meaning the UID had
	// already vanished before the resynchronization window opened.
	Earlier bool `json:"earlier,omitempty"`

	// Digest is the last known body digest. It is the zero value when the
	// archiver never fetched the message before it vanished.
	Digest Digest `json:"digest"`

	// RemovedAt is when the removal evidence was recorded.
	RemovedAt time.Time `json:"removed_at"`
}

// Generation is one UIDVALIDITY epoch of a mailbox. Whenever UIDVALIDITY
// changes a brand new, empty generation is opened: UIDs from the previous
// generation must never be reused as incremental cursors.
type Generation struct {
	// Number is the 1-based generation index, increasing on every
	// UIDVALIDITY change.
	Number int `json:"number"`

	// UIDValidity is the IMAP UIDVALIDITY value for this epoch.
	UIDValidity uint32 `json:"uid_validity"`

	// UIDNext tracks the server's UIDNEXT cursor as observed via SELECT,
	// fetches and sync updates.
	UIDNext uint32 `json:"uid_next"`

	// HighestModSeq tracks the largest MODSEQ observed in the generation.
	HighestModSeq uint64 `json:"highest_modseq"`

	// Initialized reports whether a full-list reconciliation has completed.
	// Until it does, selecting the mailbox requests a full rescan.
	Initialized bool `json:"initialized"`

	// StartedAt is when the generation was opened.
	StartedAt time.Time `json:"started_at"`

	// Messages is the live mailbox snapshot keyed by UID.
	Messages map[uint32]Message `json:"messages"`

	// Tombstones retains removal evidence keyed by UID.
	Tombstones map[uint32]Tombstone `json:"tombstones"`
}

// Mailbox groups every UIDVALIDITY generation observed for one mailbox name.
type Mailbox struct {
	// Name is the IMAP mailbox name.
	Name string `json:"name"`

	// Generations are ordered oldest to newest; the last entry is active.
	Generations []*Generation `json:"generations"`
}
