package dataeng

// ReconcileReport summarizes one full-list reconciliation.
type ReconcileReport struct {
	// Present is the number of UIDs present in the authoritative listing.
	Present int

	// Added is the number of UIDs newly recorded as live messages.
	Added int

	// Updated is the number of already-known UIDs replaced by the listing.
	Updated int

	// Revived is the number of UIDs that carried a tombstone but reappear in
	// the listing, which can happen when VANISHED/fetch events arrive
	// out of order during a QRESYNC resync.
	Revived int

	// Removed is the number of previously live UIDs missing from the
	// listing; each one receives a reconcile tombstone.
	Removed int

	// UIDNext and HighestModSeq are the cursors after reconciliation.
	UIDNext       uint32
	HighestModSeq uint64
}

// Reconcile replaces the live set of the active generation with the
// authoritative full message listing for the mailbox (for example the result
// of UID FETCH 1:* FLAGS, MODSEQ, BODY.PEEK[]).
//
// Missing UIDs gain a reconcile tombstone so their removal evidence survives,
// re-appearing tombstoned UIDs are revived, and the generation is marked
// initialized which ends the FullRescan requirement.
func (s *State) Reconcile(mailbox string, messages []Message) (ReconcileReport, error) {
	if mailbox == "" {
		return ReconcileReport{}, ErrInvalidArgument
	}
	seen := make(map[uint32]struct{}, len(messages))
	for _, msg := range messages {
		if msg.UID == 0 || msg.Digest.IsZero() {
			return ReconcileReport{}, ErrInvalidArgument
		}
		if _, dup := seen[msg.UID]; dup {
			return ReconcileReport{}, ErrInvalidArgument
		}
		seen[msg.UID] = struct{}{}
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	gen, err := s.activeGenerationForLocked(mailbox)
	if err != nil {
		return ReconcileReport{}, err
	}

	report := ReconcileReport{Present: len(messages)}

	// Revive any tombstoned UID that the authoritative listing still
	// contains. Revival happens before fetch application so the fetch is
	// not rejected as a UID reuse.
	for uid := range seen {
		if _, tombstoned := gen.Tombstones[uid]; tombstoned {
			delete(gen.Tombstones, uid)
			report.Revived++
		}
	}

	for _, msg := range messages {
		_, existed := gen.Messages[msg.UID]
		if err := s.applyFetchLocked(gen, msg); err != nil {
			return ReconcileReport{}, err
		}
		if existed {
			report.Updated++
		} else {
			report.Added++
		}
	}

	// Any live UID absent from the authoritative listing has vanished
	// without a discrete EXPUNGE/VANISHED event.
	for uid, msg := range gen.Messages {
		if _, ok := seen[uid]; ok {
			continue
		}
		s.removeLocked(gen, uid, msg.ModSeq, ReasonReconcile, false)
		report.Removed++
	}

	gen.Initialized = true
	report.UIDNext = gen.UIDNext
	report.HighestModSeq = gen.HighestModSeq
	return report, nil
}
