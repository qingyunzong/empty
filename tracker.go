package dataeng

import (
	"context"
	"errors"
	"fmt"
	"slices"
)

// Tracker coordinates UIDVALIDITY, UID, MODSEQ and VANISHED changes for one
// or more mailboxes. All mutations are written through Store.Commit, so a
// message change and its recovery point always become durable together.
//
// Tracker itself is stateless; concurrency control is optimistic and is
// carried by Snapshot.Revision. Multiple Trackers may share one Store.
type Tracker struct {
	store Store
}

// NewTracker returns a Tracker backed by store.
func NewTracker(store Store) *Tracker {
	if store == nil {
		panic("dataeng: nil Store")
	}
	return &Tracker{store: store}
}

// New returns a Tracker backed by store and is an alias for NewTracker.
func New(store Store) *Tracker { return NewTracker(store) }

// Open reconciles a SELECT/EXAMINE response with the stored state.
//
// If UIDVALIDITY is unchanged, Open only verifies that the server did not
// move its cursors backwards. It deliberately does not advance the stored
// UIDNEXT or HIGHESTMODSEQ: those values define the window that the following
// QRESYNC or UID FETCH must replay after a restart.
//
// If UIDVALIDITY differs, Open atomically closes the previous generation and
// starts a new one with the supplied cursors. All previous messages and
// snapshots become unusable, and ResyncRequired is true.
func (t *Tracker) Open(ctx context.Context, req OpenRequest) (OpenResult, error) {
	if req.Mailbox == "" {
		return OpenResult{}, fmt.Errorf("%w: empty mailbox", ErrInvalidRequest)
	}
	if req.UIDValidity == 0 {
		return OpenResult{}, fmt.Errorf("%w: UIDVALIDITY must be non-zero", ErrInvalidRequest)
	}

	state, err := t.store.Load(ctx, req.Mailbox)
	if errors.Is(err, ErrMailboxNotFound) {
		return t.openNew(ctx, req)
	}
	if err != nil {
		return OpenResult{}, err
	}

	if state.UIDValidity != req.UIDValidity {
		return t.openGeneration(ctx, state, req)
	}

	if req.UIDNext != 0 && req.UIDNext < state.UIDNext {
		return OpenResult{}, fmt.Errorf("%w: mailbox %q reported UIDNEXT %d below stored %d",
			ErrCursorRegression, req.Mailbox, req.UIDNext, state.UIDNext)
	}
	if req.HighestModSeq != 0 && req.HighestModSeq < state.HighestModSeq {
		return OpenResult{}, fmt.Errorf("%w: mailbox %q reported HIGHESTMODSEQ %d below stored %d",
			ErrCursorRegression, req.Mailbox, req.HighestModSeq, state.HighestModSeq)
	}

	return OpenResult{
		RecoveryPoint:       recoveryPoint(state),
		PreviousGeneration:  state.Generation,
		PreviousUIDValidity: state.UIDValidity,
		ServerUIDNext:       req.UIDNext,
		ServerHighestModSeq: req.HighestModSeq,
	}, nil
}

func (t *Tracker) openNew(ctx context.Context, req OpenRequest) (OpenResult, error) {
	uidNext := req.UIDNext
	if uidNext == 0 {
		uidNext = 1
	}
	change := MailboxChange{
		Mailbox:          req.Mailbox,
		ExpectedRevision: 0,
		Reset:            true,
		Generation:       1,
		UIDValidity:      req.UIDValidity,
		UIDNext:          uidNext,
		HighestModSeq:    req.HighestModSeq,
	}
	if err := t.commit(ctx, Commit{Mailboxes: []MailboxChange{change}}); err != nil {
		return OpenResult{}, err
	}

	state, err := t.store.Load(ctx, req.Mailbox)
	if err != nil {
		return OpenResult{}, err
	}
	return OpenResult{
		RecoveryPoint:       recoveryPoint(state),
		ResyncRequired:      true,
		ServerUIDNext:       req.UIDNext,
		ServerHighestModSeq: req.HighestModSeq,
	}, nil
}

func (t *Tracker) openGeneration(ctx context.Context, state MailboxState, req OpenRequest) (OpenResult, error) {
	uidNext := req.UIDNext
	if uidNext == 0 {
		uidNext = 1
	}
	change := MailboxChange{
		Mailbox:          req.Mailbox,
		ExpectedRevision: state.Revision,
		Reset:            true,
		Generation:       state.Generation + 1,
		UIDValidity:      req.UIDValidity,
		UIDNext:          uidNext,
		HighestModSeq:    req.HighestModSeq,
	}
	if err := t.commit(ctx, Commit{Mailboxes: []MailboxChange{change}}); err != nil {
		return OpenResult{}, err
	}

	next, err := t.store.Load(ctx, req.Mailbox)
	if err != nil {
		return OpenResult{}, err
	}
	return OpenResult{
		RecoveryPoint:       recoveryPoint(next),
		PreviousGeneration:  state.Generation,
		PreviousUIDValidity: state.UIDValidity,
		UIDValidityChanged:  true,
		ResyncRequired:      true,
		ServerUIDNext:       req.UIDNext,
		ServerHighestModSeq: req.HighestModSeq,
	}, nil
}

// State returns a stable copy of the persisted mailbox state.
func (t *Tracker) State(ctx context.Context, mailbox string) (MailboxState, error) {
	if mailbox == "" {
		return MailboxState{}, fmt.Errorf("%w: empty mailbox", ErrInvalidRequest)
	}
	return t.store.Load(ctx, mailbox)
}

// RecoveryPoint returns the durable incremental cursor for mailbox.
func (t *Tracker) RecoveryPoint(ctx context.Context, mailbox string) (RecoveryPoint, error) {
	state, err := t.State(ctx, mailbox)
	if err != nil {
		return RecoveryPoint{}, err
	}
	return recoveryPoint(state), nil
}

// Snapshot returns the current mailbox view and revision token.
func (t *Tracker) Snapshot(ctx context.Context, mailbox string) (Snapshot, error) {
	state, err := t.State(ctx, mailbox)
	if err != nil {
		return Snapshot{}, err
	}
	return snapshot(state), nil
}

// BeginQResync builds a QRESYNC request from the durable recovery point. The
// returned request binds the eventual response to this exact revision.
func (t *Tracker) BeginQResync(ctx context.Context, mailbox string) (QResyncRequest, error) {
	state, err := t.State(ctx, mailbox)
	if err != nil {
		return QResyncRequest{}, err
	}

	known := make([]UID, 0, len(state.Messages))
	for uid := range state.Messages {
		known = append(known, uid)
	}
	slices.Sort(known)

	return QResyncRequest{
		Mailbox:     state.Mailbox,
		Generation:  state.Generation,
		UIDValidity: state.UIDValidity,
		UIDNext:     state.UIDNext,
		Since:       state.HighestModSeq,
		KnownUIDs:   known,
		Revision:    state.Revision,
	}, nil
}

// ApplyFetch applies one or more FETCH records to the supplied snapshot.
//
// The snapshot is an optimistic lock: if any state was committed after the
// snapshot was taken, the whole response is rejected with ErrStaleSnapshot
// and nothing is modified.
//
// When a UID already exists, zero-valued fields inherit the stored metadata
// (ModSeq 0 means "not reported", empty MessageID/InternalDate/Size are
// treated as unspecified, and nil Flags inherit). A non-nil empty Flags slice
// clears the flags. A reported lower MODSEQ is rejected with ErrStaleMessage.
func (t *Tracker) ApplyFetch(ctx context.Context, snapshot Snapshot, messages []Message) error {
	state, err := t.checkSnapshot(ctx, snapshot)
	if err != nil {
		return err
	}
	if len(messages) == 0 {
		return nil
	}

	newUIDNext := state.UIDNext
	newHighest := state.HighestModSeq
	upserts := make([]Message, 0, len(messages))
	seen := make(map[UID]struct{}, len(messages))
	changed := false

	for _, incoming := range messages {
		if incoming.UID == 0 {
			return fmt.Errorf("%w: FETCH with UID 0", ErrInvalidRequest)
		}
		if _, duplicate := seen[incoming.UID]; duplicate {
			return fmt.Errorf("%w: UID %d fetched more than once", ErrConflictingResponse, incoming.UID)
		}
		seen[incoming.UID] = struct{}{}

		var existing *Message
		if message, ok := state.Messages[incoming.UID]; ok {
			copy := message
			existing = &copy
		}
		merged, err := mergeMessage(existing, incoming)
		if err != nil {
			return err
		}
		if existing == nil || !messagesEqual(*existing, merged) {
			changed = true
		}
		next, err := uidAfter(merged.UID)
		if err != nil {
			return err
		}
		newUIDNext = maxUID(newUIDNext, next)
		newHighest = maxModSeq(newHighest, merged.ModSeq)
		upserts = append(upserts, merged)
	}

	if !changed {
		return nil
	}

	return t.commit(ctx, Commit{Mailboxes: []MailboxChange{{
		Mailbox:          state.Mailbox,
		ExpectedRevision: state.Revision,
		Generation:       state.Generation,
		UIDValidity:      state.UIDValidity,
		Upserts:          upserts,
		UIDNext:          newUIDNext,
		HighestModSeq:    newHighest,
	}}})
}

// ApplyVanished removes UIDs reported by a VANISHED response from the supplied
// snapshot. Earlier is informational; both live and QRESYNC EARLIER sets are
// applied as expunges within the snapshot's generation.
func (t *Tracker) ApplyVanished(ctx context.Context, snapshot Snapshot, uids []UID, earlier bool) error {
	state, err := t.checkSnapshot(ctx, snapshot)
	if err != nil {
		return err
	}
	_ = earlier

	deletes := make([]UID, 0, len(uids))
	seen := make(map[UID]struct{}, len(uids))
	for _, uid := range uids {
		if uid == 0 {
			return fmt.Errorf("%w: VANISHED with UID 0", ErrInvalidRequest)
		}
		if _, duplicate := seen[uid]; duplicate {
			continue
		}
		seen[uid] = struct{}{}
		if _, exists := state.Messages[uid]; exists {
			deletes = append(deletes, uid)
		}
	}
	if len(deletes) == 0 {
		return nil
	}
	slices.Sort(deletes)

	return t.commit(ctx, Commit{Mailboxes: []MailboxChange{{
		Mailbox:          state.Mailbox,
		ExpectedRevision: state.Revision,
		Generation:       state.Generation,
		UIDValidity:      state.UIDValidity,
		Deletes:          deletes,
		UIDNext:          state.UIDNext,
		HighestModSeq:    state.HighestModSeq,
	}}})
}

// ApplyQResync applies a QRESYNC response only to the request snapshot from
// BeginQResync.
//
// If the mailbox has advanced to another generation, ErrStaleGeneration is
// returned. If any commit happened after the request snapshot, ErrStaleSnapshot
// is returned. In both cases no VANISHED deletion and no FETCH update is
// applied, and the recovery point is not changed.
func (t *Tracker) ApplyQResync(ctx context.Context, request QResyncRequest, response QResyncResponse) error {
	state, err := t.checkSnapshot(ctx, Snapshot{
		Mailbox:       request.Mailbox,
		Generation:    request.Generation,
		UIDValidity:   request.UIDValidity,
		UIDNext:       request.UIDNext,
		HighestModSeq: request.Since,
		Revision:      request.Revision,
	})
	if err != nil {
		return err
	}
	if request.Since > state.HighestModSeq {
		return fmt.Errorf("%w: QRESYNC since %d is ahead of stored HIGHESTMODSEQ %d",
			ErrInvalidRequest, request.Since, state.HighestModSeq)
	}
	if response.UIDValidity != 0 && response.UIDValidity != state.UIDValidity {
		return fmt.Errorf("%w: QRESYNC response UIDVALIDITY %d, request snapshot has %d",
			ErrStaleGeneration, response.UIDValidity, state.UIDValidity)
	}
	if response.UIDNext != 0 && response.UIDNext < state.UIDNext {
		return fmt.Errorf("%w: QRESYNC UIDNEXT %d is below stored %d",
			ErrCursorRegression, response.UIDNext, state.UIDNext)
	}
	if response.HighestModSeq != 0 && response.HighestModSeq < state.HighestModSeq {
		return fmt.Errorf("%w: QRESYNC HIGHESTMODSEQ %d is below stored %d",
			ErrCursorRegression, response.HighestModSeq, state.HighestModSeq)
	}

	vanished := make(map[UID]struct{}, len(response.Vanished))
	for _, uid := range response.Vanished {
		if uid == 0 {
			return fmt.Errorf("%w: QRESYNC VANISHED with UID 0", ErrInvalidRequest)
		}
		vanished[uid] = struct{}{}
	}

	upserts := make(map[UID]Message, len(response.Messages))
	for _, incoming := range response.Messages {
		if incoming.UID == 0 {
			return fmt.Errorf("%w: QRESYNC FETCH with UID 0", ErrInvalidRequest)
		}
		if _, conflict := vanished[incoming.UID]; conflict {
			return fmt.Errorf("%w: UID %d is both VANISHED and FETCHed",
				ErrConflictingResponse, incoming.UID)
		}
		if _, duplicate := upserts[incoming.UID]; duplicate {
			return fmt.Errorf("%w: UID %d appears in more than one QRESYNC FETCH",
				ErrConflictingResponse, incoming.UID)
		}

		var existing *Message
		if message, ok := state.Messages[incoming.UID]; ok {
			copy := message
			existing = &copy
		}
		merged, err := mergeMessage(existing, incoming)
		if err != nil {
			return err
		}
		upserts[incoming.UID] = merged
	}

	newUIDNext := maxUID(state.UIDNext, response.UIDNext)
	newHighest := maxModSeq(state.HighestModSeq, response.HighestModSeq)
	changed := newUIDNext != state.UIDNext || newHighest != state.HighestModSeq

	for uid := range vanished {
		if _, exists := state.Messages[uid]; exists {
			changed = true
		}
	}
	for uid, message := range upserts {
		if message.ModSeq > newHighest {
			newHighest = message.ModSeq
			changed = true
		}
		if existing, ok := state.Messages[uid]; !ok || !messagesEqual(existing, message) {
			changed = true
		}
	}
	if !changed {
		return nil
	}

	deletes := make([]UID, 0, len(vanished))
	for uid := range vanished {
		deletes = append(deletes, uid)
	}
	slices.Sort(deletes)

	updates := make([]Message, 0, len(upserts))
	for _, message := range upserts {
		next, err := uidAfter(message.UID)
		if err != nil {
			return err
		}
		newUIDNext = maxUID(newUIDNext, next)
		updates = append(updates, message)
	}

	return t.commit(ctx, Commit{Mailboxes: []MailboxChange{{
		Mailbox:          state.Mailbox,
		ExpectedRevision: state.Revision,
		Generation:       state.Generation,
		UIDValidity:      state.UIDValidity,
		Deletes:          deletes,
		Upserts:          updates,
		UIDNext:          newUIDNext,
		HighestModSeq:    newHighest,
	}}})
}

// ApplyMove atomically records a UIDPLUS/RFC 6851 move from source to the
// destination mailbox.
//
// Each source record is deleted and a new destination record is created under
// the assigned destination UID. Message-ID is copied as metadata, never used
// to merge with an existing destination record. Both mailbox changes and both
// recovery points are submitted in one Commit. The destination mailbox must
// already have been opened.
func (t *Tracker) ApplyMove(ctx context.Context, source, destination Snapshot, move MoveRequest) error {
	if move.DestinationMailbox == "" {
		return fmt.Errorf("%w: empty destination mailbox", ErrInvalidRequest)
	}
	if destination.Mailbox != move.DestinationMailbox {
		return fmt.Errorf("%w: destination snapshot is for %q, request targets %q",
			ErrInvalidRequest, destination.Mailbox, move.DestinationMailbox)
	}
	if source.Mailbox == destination.Mailbox {
		return fmt.Errorf("%w: source and destination are the same mailbox", ErrInvalidRequest)
	}
	if len(move.SourceUIDs) == 0 || len(move.SourceUIDs) != len(move.DestinationUIDs) {
		return fmt.Errorf("%w: SourceUIDs and DestinationUIDs must be non-empty and parallel",
			ErrInvalidRequest)
	}

	sourceState, err := t.checkSnapshot(ctx, source)
	if err != nil {
		return err
	}
	destinationState, err := t.checkSnapshot(ctx, destination)
	if err != nil {
		return err
	}
	if move.DestinationHighestModSeq != 0 && move.DestinationHighestModSeq < destinationState.HighestModSeq {
		return fmt.Errorf("%w: destination HIGHESTMODSEQ %d is below stored %d",
			ErrCursorRegression, move.DestinationHighestModSeq, destinationState.HighestModSeq)
	}

	sourceSeen := make(map[UID]struct{}, len(move.SourceUIDs))
	destinationSeen := make(map[UID]struct{}, len(move.DestinationUIDs))
	sourceMessages := make([]Message, len(move.SourceUIDs))
	for i, sourceUID := range move.SourceUIDs {
		if sourceUID == 0 {
			return fmt.Errorf("%w: source UID 0", ErrInvalidRequest)
		}
		if _, duplicate := sourceSeen[sourceUID]; duplicate {
			return fmt.Errorf("%w: source UID %d appears more than once", ErrConflictingResponse, sourceUID)
		}
		sourceSeen[sourceUID] = struct{}{}

		message, ok := sourceState.Messages[sourceUID]
		if !ok {
			return fmt.Errorf("%w: source UID %d", ErrMessageNotFound, sourceUID)
		}
		sourceMessages[i] = message

		destinationUID := move.DestinationUIDs[i]
		if destinationUID == 0 {
			return fmt.Errorf("%w: destination UID 0", ErrInvalidRequest)
		}
		if _, duplicate := destinationSeen[destinationUID]; duplicate {
			return fmt.Errorf("%w: destination UID %d appears more than once",
				ErrConflictingResponse, destinationUID)
		}
		destinationSeen[destinationUID] = struct{}{}
		if _, exists := destinationState.Messages[destinationUID]; exists {
			return fmt.Errorf("%w: %d", ErrUIDConflict, destinationUID)
		}
	}

	newDestinationModSeq := destinationState.HighestModSeq
	if move.DestinationHighestModSeq != 0 {
		newDestinationModSeq = maxModSeq(newDestinationModSeq, move.DestinationHighestModSeq)
	}
	newDestinationModSeq = maxModSeq(newDestinationModSeq, move.DestinationModSeq)
	newDestinationUIDNext := destinationState.UIDNext

	upserts := make([]Message, 0, len(sourceMessages))
	for i, sourceMessage := range sourceMessages {
		destinationUID := move.DestinationUIDs[i]
		next, err := uidAfter(destinationUID)
		if err != nil {
			return err
		}
		newDestinationUIDNext = maxUID(newDestinationUIDNext, next)

		key := MessageKey{
			Mailbox:     sourceState.Mailbox,
			Generation:  sourceState.Generation,
			UIDValidity: sourceState.UIDValidity,
			UID:         move.SourceUIDs[i],
		}
		upserts = append(upserts, Message{
			UID:          destinationUID,
			ModSeq:       move.DestinationModSeq,
			MessageID:    sourceMessage.MessageID,
			Flags:        cloneStrings(sourceMessage.Flags),
			InternalDate: sourceMessage.InternalDate,
			Size:         sourceMessage.Size,
			MovedFrom:    &key,
		})
	}

	return t.commit(ctx, Commit{Mailboxes: []MailboxChange{
		{
			Mailbox:          sourceState.Mailbox,
			ExpectedRevision: sourceState.Revision,
			Generation:       sourceState.Generation,
			UIDValidity:      sourceState.UIDValidity,
			Deletes:          slices.Clone(move.SourceUIDs),
			UIDNext:          sourceState.UIDNext,
			HighestModSeq:    sourceState.HighestModSeq,
		},
		{
			Mailbox:          destinationState.Mailbox,
			ExpectedRevision: destinationState.Revision,
			Generation:       destinationState.Generation,
			UIDValidity:      destinationState.UIDValidity,
			Upserts:          upserts,
			UIDNext:          newDestinationUIDNext,
			HighestModSeq:    newDestinationModSeq,
		},
	}})
}

func (t *Tracker) checkSnapshot(ctx context.Context, snapshot Snapshot) (MailboxState, error) {
	if snapshot.Mailbox == "" {
		return MailboxState{}, fmt.Errorf("%w: empty snapshot mailbox", ErrInvalidRequest)
	}
	if snapshot.Generation == 0 || snapshot.UIDValidity == 0 || snapshot.Revision == 0 {
		return MailboxState{}, fmt.Errorf("%w: incomplete snapshot", ErrInvalidRequest)
	}

	state, err := t.store.Load(ctx, snapshot.Mailbox)
	if err != nil {
		return MailboxState{}, err
	}
	if state.Generation != snapshot.Generation || state.UIDValidity != snapshot.UIDValidity {
		return MailboxState{}, fmt.Errorf("%w: mailbox %q generation %d/UIDVALIDITY %d is now %d/%d",
			ErrStaleGeneration, snapshot.Mailbox,
			snapshot.Generation, snapshot.UIDValidity, state.Generation, state.UIDValidity)
	}
	if state.Revision != snapshot.Revision {
		return MailboxState{}, fmt.Errorf("%w: mailbox %q revision %d is now %d",
			ErrStaleSnapshot, snapshot.Mailbox, snapshot.Revision, state.Revision)
	}
	return state, nil
}

func (t *Tracker) commit(ctx context.Context, commit Commit) error {
	err := t.store.Commit(ctx, commit)
	if errors.Is(err, ErrRevisionConflict) {
		return fmt.Errorf("%w: %w", ErrStaleSnapshot, err)
	}
	return err
}

func recoveryPoint(state MailboxState) RecoveryPoint {
	return RecoveryPoint{
		Mailbox:       state.Mailbox,
		Generation:    state.Generation,
		UIDValidity:   state.UIDValidity,
		UIDNext:       state.UIDNext,
		HighestModSeq: state.HighestModSeq,
		Revision:      state.Revision,
	}
}

func snapshot(state MailboxState) Snapshot {
	return Snapshot{
		Mailbox:       state.Mailbox,
		Generation:    state.Generation,
		UIDValidity:   state.UIDValidity,
		UIDNext:       state.UIDNext,
		HighestModSeq: state.HighestModSeq,
		Revision:      state.Revision,
	}
}

func mergeMessage(existing *Message, incoming Message) (Message, error) {
	merged := cloneMessage(incoming)
	if existing == nil {
		return merged, nil
	}

	if incoming.ModSeq == 0 {
		merged.ModSeq = existing.ModSeq
	} else if incoming.ModSeq < existing.ModSeq {
		return Message{}, fmt.Errorf("%w: UID %d has MODSEQ %d, update is %d",
			ErrStaleMessage, incoming.UID, existing.ModSeq, incoming.ModSeq)
	}
	if incoming.MessageID == "" {
		merged.MessageID = existing.MessageID
	}
	if incoming.Flags == nil {
		merged.Flags = cloneStrings(existing.Flags)
	}
	if incoming.InternalDate.IsZero() {
		merged.InternalDate = existing.InternalDate
	}
	if incoming.Size == 0 {
		merged.Size = existing.Size
	}
	if incoming.MovedFrom == nil {
		merged.MovedFrom = cloneKey(existing.MovedFrom)
	}
	return merged, nil
}

func uidAfter(uid UID) (UID, error) {
	next := uid + 1
	if next == 0 {
		return 0, fmt.Errorf("%w: UID space exhausted after %d", ErrInvalidRequest, uid)
	}
	return next, nil
}

func messagesEqual(a, b Message) bool {
	if a.UID != b.UID ||
		a.ModSeq != b.ModSeq ||
		a.MessageID != b.MessageID ||
		!a.InternalDate.Equal(b.InternalDate) ||
		a.Size != b.Size ||
		!slices.Equal(a.Flags, b.Flags) {
		return false
	}
	if a.MovedFrom == nil || b.MovedFrom == nil {
		return a.MovedFrom == nil && b.MovedFrom == nil
	}
	return *a.MovedFrom == *b.MovedFrom
}
