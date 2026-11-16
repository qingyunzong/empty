package delivery

import (
	"context"
	"errors"
	"sync"
	"time"
)

// CommitFn durably persists the business payload of a delivery. It is invoked
// at most once per delivery tag.
type CommitFn func(ctx context.Context, rec Record) error

// IncomingResult is returned by Tracker.Incoming. Duplicate is true when a
// record for the tag already existed (a retried or redelivered transfer).
type IncomingResult struct {
	Record    Record
	Duplicate bool
}

// Option customizes a Tracker.
type Option func(*Tracker)

// WithClock overrides the clock used for UpdatedAt timestamps.
func WithClock(now func() time.Time) Option {
	return func(t *Tracker) { t.now = now }
}

// Tracker coordinates delivery state against a Store. It is safe for
// concurrent use; store calls run while the tracker lock is held, so Store
// implementations must not call back into the tracker.
type Tracker struct {
	mu      sync.Mutex
	store   Store
	now     func() time.Time
	current Epoch
	txns    map[string]map[Tag]struct{}
}

// NewTracker rebuilds tracker state from the durable unsettled records. The
// current epoch is restored from the records (and, when supported, the
// store's persisted epoch counter), so generation fencing survives restarts.
func NewTracker(ctx context.Context, store Store, opts ...Option) (*Tracker, error) {
	t := &Tracker{
		store: store,
		now:   time.Now,
		txns:  make(map[string]map[Tag]struct{}),
	}
	for _, opt := range opts {
		opt(t)
	}
	recs, err := store.ListUnsettled(ctx)
	if err != nil {
		return nil, err
	}
	var maxEpoch Epoch
	for _, rec := range recs {
		if rec.LinkEpoch > maxEpoch {
			maxEpoch = rec.LinkEpoch
		}
		if rec.TxnID != "" {
			tags := t.txns[rec.TxnID]
			if tags == nil {
				tags = make(map[Tag]struct{})
				t.txns[rec.TxnID] = tags
			}
			tags[rec.Tag] = struct{}{}
		}
	}
	if epochStore, ok := store.(EpochStore); ok {
		epoch, err := epochStore.LoadEpoch(ctx)
		if err != nil {
			return nil, err
		}
		if epoch > maxEpoch {
			maxEpoch = epoch
		}
	}
	t.current = maxEpoch
	return t, nil
}

// CurrentEpoch returns the active link generation (zero before the first
// BeginGeneration).
func (t *Tracker) CurrentEpoch() Epoch {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.current
}

// BeginGeneration opens a new link generation when the link attaches. When the
// store implements EpochStore the new epoch is persisted before it becomes
// active.
func (t *Tracker) BeginGeneration(ctx context.Context) (Epoch, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	next := t.current + 1
	if epochStore, ok := t.store.(EpochStore); ok {
		if err := epochStore.SaveEpoch(ctx, next); err != nil {
			return 0, err
		}
	}
	t.current = next
	return next, nil
}

// Incoming registers a transfer arriving on the active generation.
//
// A new tag is persisted as an unsettled record. A tag already known on the
// same generation is a duplicate transfer and performs no write at all. A tag
// known from a retired generation is a redelivery after reconnect: the record
// is re-registered under the current epoch with its new delivery-id, without
// re-persisting any business data. A settled record returned again means the
// work already finished; its record is handed back untouched.
func (t *Tracker) Incoming(ctx context.Context, tag Tag, deliveryID DeliveryID) (IncomingResult, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.current == 0 {
		return IncomingResult{}, ErrNoActiveGeneration
	}
	rec, err := t.store.Get(ctx, tag)
	switch {
	case errors.Is(err, ErrNotFound):
		rec = Record{
			Tag:        tag,
			LinkEpoch:  t.current,
			DeliveryID: deliveryID,
			UpdatedAt:  t.now(),
		}
		if err := t.store.Put(ctx, rec); err != nil {
			if !errors.Is(err, ErrAlreadyExists) {
				return IncomingResult{}, err
			}
			// A concurrent insert won the race; use the stored record.
			if rec, err = t.store.Get(ctx, tag); err != nil {
				return IncomingResult{}, err
			}
		} else {
			return IncomingResult{Record: rec}, nil
		}
	case err != nil:
		return IncomingResult{}, err
	}
	return t.existing(ctx, rec, deliveryID)
}

// existing handles a transfer whose tag already has a record.
func (t *Tracker) existing(ctx context.Context, rec Record, deliveryID DeliveryID) (IncomingResult, error) {
	if rec.Settled || rec.LinkEpoch == t.current {
		// Finished work redelivered, or an in-generation duplicate retry:
		// nothing may be written again.
		return IncomingResult{Record: rec, Duplicate: true}, nil
	}
	rec.LinkEpoch = t.current
	rec.DeliveryID = deliveryID
	rec.UpdatedAt = t.now()
	if err := t.store.Update(ctx, rec); err != nil {
		return IncomingResult{}, err
	}
	return IncomingResult{Record: rec, Duplicate: true}, nil
}

// Resume re-registers an unsettled delivery under the active generation during
// a link-resume handshake, assigning the delivery-id negotiated on the new
// link. Settled or already-current records are returned unchanged.
func (t *Tracker) Resume(ctx context.Context, tag Tag, deliveryID DeliveryID) (Record, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	rec, err := t.store.Get(ctx, tag)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return Record{}, ErrUnknownDelivery
		}
		return Record{}, err
	}
	if rec.Settled || rec.LinkEpoch == t.current {
		return rec, nil
	}
	rec.LinkEpoch = t.current
	rec.DeliveryID = deliveryID
	rec.UpdatedAt = t.now()
	if err := t.store.Update(ctx, rec); err != nil {
		return Record{}, err
	}
	return rec, nil
}
