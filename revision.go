package dataeng

import (
	"context"
	"time"
)

// Revision reasons reported in RevisionDecision.Reason.
const (
	ReasonNew              = "new"
	ReasonContentChanged   = "content-changed"
	ReasonUnchanged        = "unchanged"
	ReasonRetryPublish     = "retry-publish"
	ReasonAlreadyConfirmed = "already-confirmed"
)

// RevisionDecision is the result of comparing a page's content fingerprint
// with its persisted revision state. LastMod is carried for observability but
// never influences Publish or Changed.
type RevisionDecision struct {
	URL                 string
	Fingerprint         string
	PreviousFingerprint string
	Revision            int64
	LastMod             time.Time
	Changed             bool
	FirstSeen           bool
	Publish             bool
	LastModHintOnly     bool
	Reason              string
}

// DecideRevision compares a known fingerprint with a stored record.
//
// A changed fingerprint is a new revision. If the fingerprint is unchanged and
// the record is already confirmed, the page is skipped even when lastmod
// changed. If the record is unconfirmed, publication is retried with the same
// revision number.
func DecideRevision(record PageRecord, exists bool, fingerprint string, lastMod time.Time) RevisionDecision {
	decision := RevisionDecision{
		URL:         record.URL,
		Fingerprint: fingerprint,
		LastMod:     lastMod,
		Revision:    record.Revision,
	}
	if decision.Revision < 1 {
		decision.Revision = 1
	}
	if !exists || record.URL == "" {
		decision.FirstSeen = true
		decision.Changed = true
		decision.Publish = true
		decision.Revision = 1
		decision.Reason = ReasonNew
		return decision
	}

	decision.PreviousFingerprint = record.Fingerprint
	decision.LastModHintOnly = !sameTime(record.LastMod, lastMod)
	if record.Fingerprint == "" {
		decision.FirstSeen = true
		decision.Changed = true
		decision.Publish = true
		decision.Revision = 1
		decision.Reason = ReasonNew
		return decision
	}
	if fingerprint != record.Fingerprint {
		decision.Changed = true
		decision.Publish = true
		decision.Revision = record.Revision + 1
		if decision.Revision < 1 {
			decision.Revision = 1
		}
		decision.Reason = ReasonContentChanged
		return decision
	}
	if !record.Confirmed {
		decision.Publish = true
		decision.Reason = ReasonRetryPublish
		return decision
	}
	decision.Reason = ReasonAlreadyConfirmed
	if decision.LastModHintOnly {
		decision.Reason = ReasonUnchanged
	}
	return decision
}

// DecideContentRevision fingerprints content and then calls DecideRevision.
func DecideContentRevision(record PageRecord, exists bool, content []byte, lastMod time.Time) RevisionDecision {
	return DecideRevision(record, exists, ContentFingerprint(content), lastMod)
}

func sameTime(a, b time.Time) bool {
	if a.IsZero() && b.IsZero() {
		return true
	}
	return a.Equal(b)
}

// RevisionTracker combines a StateStore with a fingerprint function. It is
// useful when page fetching and publication are handled outside Scheduler.
type RevisionTracker struct {
	Store         StateStore
	Fingerprinter func([]byte) string
	Now           func() time.Time
}

// NewRevisionTracker creates a tracker using an in-memory store when store is
// nil.
func NewRevisionTracker(store StateStore) *RevisionTracker {
	if store == nil {
		store = NewMemoryStore()
	}
	return &RevisionTracker{
		Store:         store,
		Fingerprinter: ContentFingerprint,
		Now:           time.Now,
	}
}

// Observe computes the revision decision for url/content.
func (t *RevisionTracker) Observe(ctx context.Context, url string, content []byte, lastMod time.Time) (RevisionDecision, error) {
	return t.ObserveFingerprint(ctx, url, t.fingerprint(content), lastMod)
}

// ObserveFingerprint computes a revision decision for an externally computed
// fingerprint.
func (t *RevisionTracker) ObserveFingerprint(ctx context.Context, url, fingerprint string, lastMod time.Time) (RevisionDecision, error) {
	store := t.store()
	record, ok, err := store.Get(ctx, url)
	if err != nil {
		return RevisionDecision{}, err
	}
	if !ok {
		record.URL = ""
	}
	record.URL = url
	return DecideRevision(record, ok, fingerprint, lastMod), nil
}

// Confirm marks a decision's fingerprint as successfully published.
func (t *RevisionTracker) Confirm(ctx context.Context, decision RevisionDecision) error {
	if decision.URL == "" {
		return nil
	}
	store := t.store()
	now := t.now()
	record, ok, err := store.Get(ctx, decision.URL)
	if err != nil {
		return err
	}
	record.URL = decision.URL
	if !ok {
		record.FirstSeen = now
	}
	record.Fingerprint = decision.Fingerprint
	record.Revision = decision.Revision
	if record.Revision < 1 {
		record.Revision = 1
	}
	record.LastMod = decision.LastMod
	record.Confirmed = true
	record.ConfirmedAt = now
	record.UpdatedAt = now
	return store.Put(ctx, record)
}

func (t *RevisionTracker) fingerprint(content []byte) string {
	if t.Fingerprinter != nil {
		return t.Fingerprinter(content)
	}
	return ContentFingerprint(content)
}

func (t *RevisionTracker) store() StateStore {
	if t.Store == nil {
		t.Store = NewMemoryStore()
	}
	return t.Store
}

func (t *RevisionTracker) now() time.Time {
	if t.Now != nil {
		return t.Now()
	}
	return time.Now()
}
