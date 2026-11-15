package dataeng

import (
	"sort"
	"sync"
	"time"
)

// State is the thread-safe incremental IMAP state for an archiver. It keeps
// a snapshot per mailbox, split into UIDVALIDITY generations, and preserves
// removal evidence as tombstones.
type State struct {
	mu        sync.RWMutex
	mailboxes map[string]*Mailbox
	now       func() time.Time
}

// Selection is the outcome of selecting a mailbox.
type Selection struct {
	// Mailbox is the selected mailbox name.
	Mailbox string

	// Generation is the active 1-based generation number.
	Generation int

	// UIDValidity is the UIDVALIDITY of the active generation.
	UIDValidity uint32

	// FullRescan is true when a full listing must be fetched. It is true on
	// the very first selection and whenever UIDVALIDITY changed, in which
	// case the old UID/MODSEQ cursors must not be reused.
	FullRescan bool

	// UIDNext and HighestModSeq are the incremental cursors for the active
	// generation; both are zero before the first successful rescan.
	UIDNext       uint32
	HighestModSeq uint64
}

// Cursor is an incremental sync position within one mailbox generation.
type Cursor struct {
	Generation    int    `json:"generation"`
	UIDValidity   uint32 `json:"uid_validity"`
	UIDNext       uint32 `json:"uid_next"`
	HighestModSeq uint64 `json:"highest_modseq"`
	Initialized   bool   `json:"initialized"`
}

// Option customizes a State at construction time.
type Option func(*State)

// WithClock overrides the clock used for FirstSeen, LastUpdated and
// RemovedAt timestamps. It is primarily useful for deterministic tests.
func WithClock(now func() time.Time) Option {
	return func(s *State) {
		if now != nil {
			s.now = now
		}
	}
}

// New creates an empty State. Timestamps default to time.Now in UTC.
func New(opts ...Option) *State {
	s := &State{
		mailboxes: map[string]*Mailbox{},
		now:       func() time.Time { return time.Now().UTC() },
	}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

// Select marks a mailbox as active for the given UIDVALIDITY epoch and
// returns the sync position to resume from.
//
// If the mailbox is unknown or its UIDVALIDITY changed, a new empty
// generation is opened and Selection.FullRescan is true: the caller must run
// a full UID listing/rescanning pass instead of reusing old UID cursors.
// When UIDVALIDITY matches the active generation the existing cursors are
// returned and incremental sync may continue.
func (s *State) Select(mailbox string, uidValidity uint32) (Selection, error) {
	if mailbox == "" || uidValidity == 0 {
		return Selection{}, ErrInvalidArgument
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	mb := s.mailboxes[mailbox]
	if mb == nil {
		mb = &Mailbox{Name: mailbox}
		s.mailboxes[mailbox] = mb
		gen := s.newGenerationLocked(mb, uidValidity)
		return selectionForLocked(mb, gen, true), nil
	}
	gen := activeGenerationLocked(mb)
	if gen.UIDValidity != uidValidity {
		gen = s.newGenerationLocked(mb, uidValidity)
		return selectionForLocked(mb, gen, true), nil
	}
	return selectionForLocked(mb, gen, !gen.Initialized), nil
}

// SyncCursor updates the observed cursor values for the active generation of
// a previously selected mailbox and returns the resulting sync position.
// Values only move forward: zero arguments leave the stored cursor untouched
// and smaller values are clamped to the stored ones.
func (s *State) SyncCursor(mailbox string, uidNext uint32, highestModSeq uint64) (Cursor, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	gen, err := s.activeGenerationForLocked(mailbox)
	if err != nil {
		return Cursor{}, err
	}
	bumpCursorsLocked(gen, uidNext, highestModSeq)
	return cursorLocked(gen), nil
}

// ApplyFetch records one fetched message in the active generation.
//
// It is an error to fetch a UID that currently carries a tombstone without
// reviving it first, because within one UIDVALIDITY a UID is never reused; a
// re-appearing UID signals out-of-order QRESYNC events and must flow through
// Replay, which orders events by MODSEQ before applying them.
func (s *State) ApplyFetch(mailbox string, msg Message) error {
	if mailbox == "" || msg.UID == 0 || msg.Digest.IsZero() {
		return ErrInvalidArgument
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	gen, err := s.activeGenerationForLocked(mailbox)
	if err != nil {
		return err
	}
	return s.applyFetchLocked(gen, msg)
}

// ApplyExpunge records a classic IMAP EXPUNGE for a UID. The UID is the
// resolved UID of the expunged sequence number; EXPUNGE responses themselves
// only carry sequence numbers, so the caller performs sequence->UID mapping.
// A tombstone is retained even when the UID was never fetched.
func (s *State) ApplyExpunge(mailbox string, uid uint32, modSeq uint64) error {
	if mailbox == "" || uid == 0 {
		return ErrInvalidArgument
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	gen, err := s.activeGenerationForLocked(mailbox)
	if err != nil {
		return err
	}
	s.removeLocked(gen, uid, modSeq, ReasonExpunge, false)
	return nil
}

// ApplyVanished records a QRESYNC VANISHED response for a UID. Earlier marks
// VANISHED (EARLIER) responses observed during a QRESYNC selection. A
// tombstone is retained in all cases.
func (s *State) ApplyVanished(mailbox string, uid uint32, modSeq uint64, earlier bool) error {
	if mailbox == "" || uid == 0 {
		return ErrInvalidArgument
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	gen, err := s.activeGenerationForLocked(mailbox)
	if err != nil {
		return err
	}
	s.removeLocked(gen, uid, modSeq, ReasonVanished, earlier)
	return nil
}

// Message returns a copy of the stored message for a UID in the active
// generation. ok is false when the UID is absent (never seen or expunged).
func (s *State) Message(mailbox string, uid uint32) (Message, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	mb := s.mailboxes[mailbox]
	if mb == nil {
		return Message{}, false
	}
	msg, ok := activeGenerationLocked(mb).Messages[uid]
	return msg, ok
}

// Tombstone returns a copy of the removal evidence for a UID in the active
// generation. ok is false when no tombstone exists.
func (s *State) Tombstone(mailbox string, uid uint32) (Tombstone, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	mb := s.mailboxes[mailbox]
	if mb == nil {
		return Tombstone{}, false
	}
	ts, ok := activeGenerationLocked(mb).Tombstones[uid]
	return ts, ok
}

// Cursor returns the incremental cursor for the active generation.
func (s *State) Cursor(mailbox string) (Cursor, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	gen, err := s.activeGenerationForLocked(mailbox)
	if err != nil {
		return Cursor{}, err
	}
	return cursorLocked(gen), nil
}

// GenerationView is an immutable snapshot view of one mailbox generation.
type GenerationView struct {
	Number        int
	UIDValidity   uint32
	UIDNext       uint32
	HighestModSeq uint64
	Initialized   bool
	StartedAt     time.Time
	Messages      []Message
	Tombstones    []Tombstone
}

// Generation returns a copy of one generation of a mailbox. Generation
// numbers are 1-based; use Mailboxes or Generations to discover them.
func (s *State) Generation(mailbox string, number int) (GenerationView, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	mb := s.mailboxes[mailbox]
	if mb == nil {
		return GenerationView{}, ErrUnknownMailbox
	}
	if number < 1 || number > len(mb.Generations) {
		return GenerationView{}, ErrGenerationNotFound
	}
	return viewForGenerationLocked(mb.Generations[number-1]), nil
}

// Generations returns the 1-based generation numbers of a mailbox.
func (s *State) Generations(mailbox string) ([]int, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	mb := s.mailboxes[mailbox]
	if mb == nil {
		return nil, ErrUnknownMailbox
	}
	numbers := make([]int, len(mb.Generations))
	for i, gen := range mb.Generations {
		numbers[i] = gen.Number
	}
	return numbers, nil
}

// Mailboxes returns the names of every mailbox ever selected, sorted.
func (s *State) Mailboxes() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()

	names := make([]string, 0, len(s.mailboxes))
	for name := range s.mailboxes {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func (s *State) newGenerationLocked(mb *Mailbox, uidValidity uint32) *Generation {
	gen := &Generation{
		Number:      len(mb.Generations) + 1,
		UIDValidity: uidValidity,
		StartedAt:   s.now(),
		Messages:    map[uint32]Message{},
		Tombstones:  map[uint32]Tombstone{},
	}
	mb.Generations = append(mb.Generations, gen)
	return gen
}

func (s *State) activeGenerationForLocked(mailbox string) (*Generation, error) {
	if mailbox == "" {
		return nil, ErrInvalidArgument
	}
	mb := s.mailboxes[mailbox]
	if mb == nil {
		return nil, ErrUnknownMailbox
	}
	return activeGenerationLocked(mb), nil
}

// applyFetchLocked upserts a message. The caller has already validated the
// fetch arguments and holds the write lock.
func (s *State) applyFetchLocked(gen *Generation, msg Message) error {
	if _, tombstoned := gen.Tombstones[msg.UID]; tombstoned {
		return ErrInvalidArgument
	}

	now := s.now()
	existing, seen := gen.Messages[msg.UID]
	if seen {
		// Zero MODSEQ means the server lacks CONDSTORE; always accept the
		// fetch. Otherwise only accept equal-or-newer modification state.
		if msg.ModSeq != 0 && existing.ModSeq != 0 && msg.ModSeq < existing.ModSeq {
			return nil
		}
		msg.FirstSeen = existing.FirstSeen
		msg.LastUpdated = now
	} else {
		msg.FirstSeen = now
		msg.LastUpdated = now
	}

	gen.Messages[msg.UID] = msg
	if msg.UID+1 > gen.UIDNext {
		gen.UIDNext = msg.UID + 1
	}
	if msg.ModSeq > gen.HighestModSeq {
		gen.HighestModSeq = msg.ModSeq
	}
	return nil
}

// removeLocked records a removal, creating or refreshing the tombstone and
// deleting the live message if it was present.
func (s *State) removeLocked(gen *Generation, uid uint32, modSeq uint64, reason string, earlier bool) {
	var digest Digest
	if existing, ok := gen.Messages[uid]; ok {
		digest = existing.Digest
		delete(gen.Messages, uid)
	}

	ts := gen.Tombstones[uid]
	if ts.UID == 0 {
		ts = Tombstone{
			UID:       uid,
			Digest:    digest,
			RemovedAt: s.now(),
		}
	} else if digest.IsZero() {
		digest = ts.Digest
	}
	ts.ModSeq = modSeq
	ts.Reason = reason
	ts.Earlier = earlier
	if !digest.IsZero() {
		ts.Digest = digest
	}
	gen.Tombstones[uid] = ts

	if modSeq > gen.HighestModSeq {
		gen.HighestModSeq = modSeq
	}
}

func activeGenerationLocked(mb *Mailbox) *Generation {
	return mb.Generations[len(mb.Generations)-1]
}

func selectionForLocked(mb *Mailbox, gen *Generation, fullRescan bool) Selection {
	return Selection{
		Mailbox:       mb.Name,
		Generation:    gen.Number,
		UIDValidity:   gen.UIDValidity,
		FullRescan:    fullRescan,
		UIDNext:       gen.UIDNext,
		HighestModSeq: gen.HighestModSeq,
	}
}

func cursorLocked(gen *Generation) Cursor {
	return Cursor{
		Generation:    gen.Number,
		UIDValidity:   gen.UIDValidity,
		UIDNext:       gen.UIDNext,
		HighestModSeq: gen.HighestModSeq,
		Initialized:   gen.Initialized,
	}
}

func bumpCursorsLocked(gen *Generation, uidNext uint32, highestModSeq uint64) {
	if uidNext > gen.UIDNext {
		gen.UIDNext = uidNext
	}
	if highestModSeq > gen.HighestModSeq {
		gen.HighestModSeq = highestModSeq
	}
}

func viewForGenerationLocked(gen *Generation) GenerationView {
	msgs := make([]Message, 0, len(gen.Messages))
	for _, msg := range gen.Messages {
		msgs = append(msgs, msg)
	}
	sort.Slice(msgs, func(i, j int) bool { return msgs[i].UID < msgs[j].UID })

	stones := make([]Tombstone, 0, len(gen.Tombstones))
	for _, ts := range gen.Tombstones {
		stones = append(stones, ts)
	}
	sort.Slice(stones, func(i, j int) bool { return stones[i].UID < stones[j].UID })

	return GenerationView{
		Number:        gen.Number,
		UIDValidity:   gen.UIDValidity,
		UIDNext:       gen.UIDNext,
		HighestModSeq: gen.HighestModSeq,
		Initialized:   gen.Initialized,
		StartedAt:     gen.StartedAt,
		Messages:      msgs,
		Tombstones:    stones,
	}
}
