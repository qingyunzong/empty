package dataeng

import (
	"errors"
	"fmt"
	"sort"
	"sync"
)

var (
	// ErrStaleSession means the response came from a session or subscription
	// that no longer owns this state. No state was changed.
	ErrStaleSession = errors.New("dataeng: stale session or subscription")
	// ErrInvalidSequence means the response did not carry a usable publish
	// sequence number. Zero is never a valid OPC UA publish sequence number.
	ErrInvalidSequence = errors.New("dataeng: invalid publish sequence number")
	// ErrUnknownSequence means the sequence number is not part of the tracked
	// range.
	ErrUnknownSequence = errors.New("dataeng: unknown publish sequence number")
	// ErrNotReceived means persistence or acknowledgement was attempted for a
	// gap that has not been recovered yet.
	ErrNotReceived = errors.New("dataeng: notification has not been received")
	// ErrPermanentMissing means the sequence number was confirmed lost and can
	// no longer be persisted or acknowledged as a notification.
	ErrPermanentMissing = errors.New("dataeng: notification is permanently missing")
	// ErrNotPersisted means an acknowledgement would cover a received
	// notification that has not been durably stored.
	ErrNotPersisted = errors.New("dataeng: notification has not been persisted")
	// ErrAckWentBackwards means an acknowledgement was requested below the
	// current acknowledgement watermark.
	ErrAckWentBackwards = errors.New("dataeng: acknowledgement went backwards")
	// ErrGapTooLarge means one response skipped more sequence numbers than the
	// configured MaxGap. The response was ignored.
	ErrGapTooLarge = errors.New("dataeng: publish sequence gap exceeds limit")
	// ErrBadStatus means a response carried a bad status that does not prove a
	// notification is permanently unavailable.
	ErrBadStatus = errors.New("dataeng: bad status")
)

type recordState uint8

const (
	recordPending recordState = iota
	recordReceived
	recordPersisted
	recordMissing
)

type sequenceRecord struct {
	state recordState
	data  []NotificationData
}

// Subscription tracks the server-side publish sequence for one OPC UA
// subscription as seen by a client. It is safe for concurrent use.
//
// The state machine deliberately separates recovery from acknowledgement:
//
//   - A gap is first queued for Republish.
//   - Only an explicit server answer that the message is unavailable (a
//     RepublishResponse or ConfirmUnavailable) marks it permanently missing.
//   - Transfer changes the owning session and invalidates every response from
//     the old session.
//   - Acknowledge never advances over a received notification until Persist
//     has marked it durable. Permanently missing sequence numbers contain no
//     notification and may be crossed.
type Subscription struct {
	mu sync.Mutex

	sessionID      string
	subscriptionID uint32
	generation     uint64
	maxGap         uint32

	started        bool
	nextSeq        uint32
	lastSeq        uint32
	ackSeq         uint32
	records        map[uint32]*sequenceRecord
	available      map[uint32]struct{}
	availableKnown bool
	keepAlives     uint64
}

// SubscriptionState is an alias kept for callers that prefer the explicit
// name.
type SubscriptionState = Subscription

// State is a short alias for Subscription.
type State = Subscription

// NewSubscription creates a subscription state machine.
//
// The constructor accepts no arguments, a Config, Options, a session ID
// string and/or a subscription ID. This keeps it convenient for both fresh
// subscriptions and restored ingestion state.
func NewSubscription(args ...any) *Subscription {
	cfg := Config{MaxGap: 1 << 20}
	for _, arg := range args {
		switch v := arg.(type) {
		case nil:
		case Config:
			cfg = mergeConfig(cfg, v)
		case *Config:
			if v != nil {
				cfg = mergeConfig(cfg, *v)
			}
		case Option:
			if v != nil {
				v(&cfg)
			}
		case func(*Config):
			if v != nil {
				v(&cfg)
			}
		case string:
			cfg.SessionID = v
		case uint32:
			cfg.SubscriptionID = v
		case uint64:
			cfg.SubscriptionID = uint32(v)
		case int:
			if v >= 0 {
				cfg.SubscriptionID = uint32(v)
			}
		default:
			// Keep the constructor tolerant of an option type defined by a
			// future caller; unknown values are ignored.
		}
	}
	if cfg.MaxGap == 0 {
		cfg.MaxGap = 1 << 20
	}
	return &Subscription{
		sessionID:      cfg.SessionID,
		subscriptionID: cfg.SubscriptionID,
		maxGap:         cfg.MaxGap,
		records:        make(map[uint32]*sequenceRecord),
		available:      make(map[uint32]struct{}),
	}
}

// New creates a Subscription. It is an alias for NewSubscription.
func New(args ...any) *Subscription { return NewSubscription(args...) }

// NewSubscriptionState creates a Subscription. It is an alias for
// NewSubscription.
func NewSubscriptionState(args ...any) *Subscription { return NewSubscription(args...) }

// NewState creates a Subscription. It is an alias for NewSubscription.
func NewState(args ...any) *Subscription { return NewSubscription(args...) }

func mergeConfig(base, override Config) Config {
	if override.SessionID != "" {
		base.SessionID = override.SessionID
	}
	if override.SubscriptionID != 0 {
		base.SubscriptionID = override.SubscriptionID
	}
	if override.MaxGap != 0 {
		base.MaxGap = override.MaxGap
	}
	return base
}

// SessionID returns the session that currently owns the subscription.
func (s *Subscription) SessionID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sessionID
}

// SubscriptionID returns the OPC UA subscription identifier.
func (s *Subscription) SubscriptionID() uint32 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.subscriptionID
}

// Generation returns the transfer generation. It increases on every Transfer.
func (s *Subscription) Generation() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.generation
}

// Transfer moves the subscription to a new session. If two arguments are
// supplied they are interpreted as oldSessionID, newSessionID; a mismatch with
// the current session is rejected.
//
// Transfer keeps the publish sequence, recovered notifications and
// acknowledgement watermark, but invalidates in-flight responses from the old
// session. Pending republish gaps remain pending and may be requested again on
// the new session.
func (s *Subscription) Transfer(sessionIDs ...string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	var newSession string
	switch len(sessionIDs) {
	case 0:
		return errors.New("dataeng: transfer requires a session ID")
	case 1:
		newSession = sessionIDs[0]
	default:
		oldSession := sessionIDs[0]
		newSession = sessionIDs[1]
		if s.sessionID != "" && oldSession != "" && oldSession != s.sessionID {
			return fmt.Errorf("%w: old session %q is not %q", ErrStaleSession, oldSession, s.sessionID)
		}
	}
	if newSession == "" {
		return errors.New("dataeng: transfer requires a non-empty session ID")
	}

	s.sessionID = newSession
	s.generation++
	s.availableKnown = false
	s.available = make(map[uint32]struct{})
	return nil
}

// TransferSubscription is an alias for Transfer.
func (s *Subscription) TransferSubscription(sessionIDs ...string) error {
	return s.Transfer(sessionIDs...)
}

// HandlePublish consumes a PublishResponse (or *PublishResponse).
//
// A keep-alive response updates liveness and can reveal a gap (its sequence
// number is the next notification sequence), but it never advances the
// expected notification sequence by itself.
func (s *Subscription) HandlePublish(args ...any) PublishResult {
	resp, ok := publishResponseFromArgs(args)
	if !ok {
		return PublishResult{Err: fmt.Errorf("dataeng: unsupported publish response %T", args)}
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	res := PublishResult{
		SequenceNumber: resp.sequenceNumber(),
		Status:         resp.statusCode(),
	}
	if !s.acceptIdentityLocked(resp.sessionID(), resp.subscriptionID(), resp.SessionGeneration) {
		res.Stale = true
		res.Err = ErrStaleSession
		return res
	}
	if res.Status.Bad() {
		res.Err = fmt.Errorf("%w: %s", ErrBadStatus, res.Status)
		return res
	}
	s.updateAvailableLocked(resp.availableSequenceNumbers())

	data := resp.notificationData()
	if resp.keepAlive() {
		res.KeepAlive = true
		s.keepAlives++
		s.applyKeepAliveLocked(res.SequenceNumber)
		s.fillResultLocked(&res)
		return res
	}

	if res.SequenceNumber == 0 {
		res.Err = ErrInvalidSequence
		return res
	}
	accepted, duplicate, err := s.applyNotificationLocked(res.SequenceNumber, data, resp.persisted())
	if err != nil {
		res.Err = err
		return res
	}
	res.Accepted = accepted
	res.Duplicate = duplicate
	if accepted {
		res.AcceptedSequenceNumbers = []uint32{res.SequenceNumber}
	}
	s.fillResultLocked(&res)
	return res
}

// HandlePublishResponse is an alias for HandlePublish.
func (s *Subscription) HandlePublishResponse(args ...any) PublishResult {
	return s.HandlePublish(args...)
}

// ProcessPublish is an alias for HandlePublish.
func (s *Subscription) ProcessPublish(args ...any) PublishResult {
	return s.HandlePublish(args...)
}

// ProcessPublishResponse is an alias for HandlePublish.
func (s *Subscription) ProcessPublishResponse(args ...any) PublishResult {
	return s.HandlePublish(args...)
}

// ObservePublish is an alias for HandlePublish.
func (s *Subscription) ObservePublish(args ...any) PublishResult {
	return s.HandlePublish(args...)
}

// ObservePublishResponse is an alias for HandlePublish.
func (s *Subscription) ObservePublishResponse(args ...any) PublishResult {
	return s.HandlePublish(args...)
}

// OnPublish is an alias for HandlePublish.
func (s *Subscription) OnPublish(args ...any) PublishResult {
	return s.HandlePublish(args...)
}

// AcceptPublish is an alias for HandlePublish.
func (s *Subscription) AcceptPublish(args ...any) PublishResult {
	return s.HandlePublish(args...)
}

// HandleRepublish consumes a RepublishResponse (or *RepublishResponse).
//
// A good response recovers the requested sequence number. A response whose
// status confirms the message is unavailable marks the gap permanently
// missing. Session and transport errors leave the gap pending. Responses from
// an old session are ignored completely.
func (s *Subscription) HandleRepublish(args ...any) RepublishResult {
	resp, ok := republishResponseFromArgs(args)
	if !ok {
		return RepublishResult{Err: fmt.Errorf("dataeng: unsupported republish response %T", args)}
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	res := RepublishResult{
		SequenceNumber: resp.sequenceNumber(),
		Status:         resp.statusCode(),
	}
	if !s.acceptIdentityLocked(resp.sessionID(), resp.subscriptionID(), resp.SessionGeneration) {
		res.Stale = true
		res.Err = ErrStaleSession
		return res
	}
	s.updateAvailableLocked(resp.availableSequenceNumbers())

	if res.Status.Bad() {
		if res.Status.ConfirmsUnavailable() {
			newMissing := s.markMissingLocked(res.SequenceNumber)
			res.Permanent = len(newMissing) != 0
			s.fillRepublishResultLocked(&res)
			if !res.Permanent {
				res.Duplicate = true
			}
			return res
		}
		res.Err = fmt.Errorf("%w: %s", ErrBadStatus, res.Status)
		s.fillRepublishResultLocked(&res)
		return res
	}

	if res.SequenceNumber == 0 {
		res.Err = ErrInvalidSequence
		return res
	}
	accepted, duplicate, err := s.applyNotificationLocked(res.SequenceNumber, resp.notificationData(), resp.persisted())
	if err != nil {
		res.Err = err
		return res
	}
	res.Accepted = accepted
	res.Duplicate = duplicate
	if accepted {
		res.AcceptedSequenceNumbers = []uint32{res.SequenceNumber}
	}
	s.fillRepublishResultLocked(&res)
	return res
}

// HandleRepublishResponse is an alias for HandleRepublish.
func (s *Subscription) HandleRepublishResponse(args ...any) RepublishResult {
	return s.HandleRepublish(args...)
}

// ProcessRepublish is an alias for HandleRepublish.
func (s *Subscription) ProcessRepublish(args ...any) RepublishResult {
	return s.HandleRepublish(args...)
}

// ProcessRepublishResponse is an alias for HandleRepublish.
func (s *Subscription) ProcessRepublishResponse(args ...any) RepublishResult {
	return s.HandleRepublish(args...)
}

// ObserveRepublish is an alias for HandleRepublish.
func (s *Subscription) ObserveRepublish(args ...any) RepublishResult {
	return s.HandleRepublish(args...)
}

// ObserveRepublishResponse is an alias for HandleRepublish.
func (s *Subscription) ObserveRepublishResponse(args ...any) RepublishResult {
	return s.HandleRepublish(args...)
}

// OnRepublish is an alias for HandleRepublish.
func (s *Subscription) OnRepublish(args ...any) RepublishResult {
	return s.HandleRepublish(args...)
}

// OnPublishResponse is an alias for HandlePublish.
func (s *Subscription) OnPublishResponse(args ...any) PublishResult {
	return s.HandlePublish(args...)
}

// OnRepublishResponse is an alias for HandleRepublish.
func (s *Subscription) OnRepublishResponse(args ...any) RepublishResult {
	return s.HandleRepublish(args...)
}

// ReceivePublish is an alias for HandlePublish.
func (s *Subscription) ReceivePublish(args ...any) PublishResult {
	return s.HandlePublish(args...)
}

// ReceiveRepublish is an alias for HandleRepublish.
func (s *Subscription) ReceiveRepublish(args ...any) RepublishResult {
	return s.HandleRepublish(args...)
}

// HandleKeepAlive consumes a keep-alive message. It accepts a uint32 sequence
// number, a PublishResponse, or the common (sessionID, sequenceNumber,
// availableSequenceNumbers) argument form.
func (s *Subscription) HandleKeepAlive(args ...any) PublishResult {
	if len(args) == 1 {
		switch v := args[0].(type) {
		case PublishResponse:
			v.KeepAlive = true
			return s.HandlePublish(v)
		case *PublishResponse:
			if v == nil {
				return PublishResult{Err: fmt.Errorf("dataeng: nil keep-alive response")}
			}
			cp := *v
			cp.KeepAlive = true
			return s.HandlePublish(cp)
		}
	}

	var session string
	var seq uint32
	var available []uint32
	var haveSeq bool
	for _, arg := range args {
		switch v := arg.(type) {
		case string:
			session = v
		case uint32:
			seq = v
			haveSeq = true
		case int:
			if v > 0 {
				seq = uint32(v)
				haveSeq = true
			}
		case []uint32:
			available = v
		}
	}
	if !haveSeq {
		return PublishResult{Err: ErrInvalidSequence}
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	res := PublishResult{SequenceNumber: seq, KeepAlive: true}
	if !s.acceptIdentityLocked(session, 0, 0) {
		res.Stale = true
		res.Err = ErrStaleSession
		return res
	}
	s.keepAlives++
	s.updateAvailableLocked(available)
	s.applyKeepAliveLocked(seq)
	s.fillResultLocked(&res)
	return res
}

// HandleKeepalive is an alias for HandleKeepAlive.
func (s *Subscription) HandleKeepalive(args ...any) PublishResult {
	return s.HandleKeepAlive(args...)
}

// KeepAlive records a keep-alive whose sequence number is the next expected
// notification sequence.
func (s *Subscription) KeepAlive(nextSequence uint32) PublishResult {
	return s.HandleKeepAlive(nextSequence)
}

// Persist marks one or more received notification messages as durably stored.
// It is idempotent for already persisted messages.
func (s *Subscription) Persist(seqs ...uint32) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	for _, seq := range seqs {
		rec := s.records[seq]
		if rec == nil {
			return fmt.Errorf("%w: %d", ErrUnknownSequence, seq)
		}
		switch rec.state {
		case recordPending:
			return fmt.Errorf("%w: %d", ErrNotReceived, seq)
		case recordMissing:
			return fmt.Errorf("%w: %d", ErrPermanentMissing, seq)
		}
	}
	for _, seq := range seqs {
		rec := s.records[seq]
		if rec.state == recordReceived {
			rec.state = recordPersisted
		}
	}
	return nil
}

// MarkPersisted is an alias for Persist.
func (s *Subscription) MarkPersisted(seqs ...uint32) error {
	return s.Persist(seqs...)
}

// PersistThrough marks every received notification up to and including seq as
// persisted. Pending and permanently missing sequence numbers contain no
// notification and are skipped.
func (s *Subscription) PersistThrough(seq uint32) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if !s.started || seq == 0 || seqAfter(seq, s.lastSeq) {
		return fmt.Errorf("%w: %d", ErrUnknownSequence, seq)
	}
	for cur := s.firstKnownLocked(); !seqAfter(cur, seq); cur = nextSequence(cur) {
		rec := s.records[cur]
		if rec != nil && rec.state == recordReceived {
			rec.state = recordPersisted
		}
		if cur == seq {
			break
		}
	}
	return nil
}

// MarkUnavailable marks sequence numbers as permanently lost. This is intended
// for an explicit server confirmation (for example, a Republish response with
// BadMessageNotAvailable). It is a no-op for notifications already received.
func (s *Subscription) MarkUnavailable(seqs ...uint32) []uint32 {
	s.mu.Lock()
	defer s.mu.Unlock()
	var changed []uint32
	for _, seq := range seqs {
		changed = append(changed, s.markMissingLocked(seq)...)
	}
	sortSequences(changed)
	return changed
}

// MarkMissing is an alias for MarkUnavailable.
func (s *Subscription) MarkMissing(seqs ...uint32) []uint32 {
	return s.MarkUnavailable(seqs...)
}

// ConfirmUnavailable is an alias for MarkUnavailable.
func (s *Subscription) ConfirmUnavailable(seqs ...uint32) []uint32 {
	return s.MarkUnavailable(seqs...)
}

// PendingRepublish returns the sequence numbers that are still waiting for a
// republish response, in ascending order.
func (s *Subscription) PendingRepublish() []uint32 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.pendingLocked()
}

// Pending is an alias for PendingRepublish.
func (s *Subscription) Pending() []uint32 { return s.PendingRepublish() }

// RepublishRequests returns one request covering all pending gaps. It returns
// an empty slice when there is nothing to recover.
func (s *Subscription) RepublishRequests() []RepublishRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	pending := s.pendingLocked()
	if len(pending) == 0 {
		return nil
	}
	return []RepublishRequest{{
		SessionID:       s.sessionID,
		SubscriptionID:  s.subscriptionID,
		SequenceNumbers: pending,
	}}
}

// NextRepublish returns the lowest pending sequence number.
func (s *Subscription) NextRepublish() (uint32, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	pending := s.pendingLocked()
	if len(pending) == 0 {
		return 0, false
	}
	return pending[0], true
}

// PermanentlyMissing returns the sequence numbers confirmed lost by the
// server, in ascending order.
func (s *Subscription) PermanentlyMissing() []uint32 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.missingLocked()
}

// Missing is an alias for PermanentlyMissing.
func (s *Subscription) Missing() []uint32 { return s.PermanentlyMissing() }

// AvailableSequenceNumbers returns the most recent list advertised by the
// server, in ascending order.
func (s *Subscription) AvailableSequenceNumbers() []uint32 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.availableLocked()
}

// Acknowledge advances the acknowledgement watermark and returns the sequence
// number that may be sent to the server.
//
// With no argument it advances over every contiguous message that is either
// persisted or permanently missing. With an argument it advances only if the
// requested sequence number is at or below that safe watermark. A received but
// not yet persisted notification always blocks advancement.
func (s *Subscription) Acknowledge(through ...uint32) uint32 {
	s.mu.Lock()
	defer s.mu.Unlock()

	safe := s.safeAckLocked()
	target := safe
	if len(through) > 0 {
		want := through[0]
		if seqAfter(want, safe) || seqAfter(want, s.lastSeq) {
			return s.ackSeq
		}
		target = want
	}
	if seqAfter(target, s.ackSeq) {
		s.ackSeq = target
	}
	return s.ackSeq
}

// Ack is an alias for Acknowledge.
func (s *Subscription) Ack(through ...uint32) uint32 { return s.Acknowledge(through...) }

// AcknowledgeNotification is an alias for Acknowledge.
func (s *Subscription) AcknowledgeNotification(through ...uint32) uint32 {
	return s.Acknowledge(through...)
}

// AcknowledgeThrough validates and advances the acknowledgement watermark to
// exactly seq. It returns ErrNotPersisted if doing so would acknowledge a
// received notification that has not been persisted. Permanently missing
// sequence numbers may be crossed because they contain no notification.
func (s *Subscription) AcknowledgeThrough(seq uint32) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if seq == 0 {
		return nil
	}
	if seqAfter(s.ackSeq, seq) {
		return fmt.Errorf("%w: current %d, requested %d", ErrAckWentBackwards, s.ackSeq, seq)
	}
	if !s.started || seqAfter(seq, s.lastSeq) {
		return fmt.Errorf("%w: %d", ErrUnknownSequence, seq)
	}
	for cur := nextSequence(s.ackSeq); !seqAfter(cur, seq); cur = nextSequence(cur) {
		rec := s.records[cur]
		if rec == nil {
			return fmt.Errorf("%w: %d", ErrUnknownSequence, cur)
		}
		switch rec.state {
		case recordReceived:
			return fmt.Errorf("%w: %d", ErrNotPersisted, cur)
		case recordPending:
			return fmt.Errorf("%w: %d", ErrNotReceived, cur)
		}
		if cur == seq {
			break
		}
	}
	s.ackSeq = seq
	return nil
}

// AckThrough is an alias for AcknowledgeThrough.
func (s *Subscription) AckThrough(seq uint32) error {
	return s.AcknowledgeThrough(seq)
}

// AckSequence returns the current acknowledgement watermark.
func (s *Subscription) AckSequence() uint32 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ackSeq
}

// Acknowledged is an alias for AckSequence.
func (s *Subscription) Acknowledged() uint32 { return s.AckSequence() }

// Acknowledgeable returns the subset of seqs that may be acknowledged without
// covering a received notification that is not yet durable. Permanently
// missing sequence numbers are acknowledgeable because they contain no
// notification.
func (s *Subscription) Acknowledgeable(seqs ...uint32) []uint32 {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []uint32
	for _, seq := range seqs {
		rec := s.records[seq]
		if rec != nil && (rec.state == recordPersisted || rec.state == recordMissing) {
			out = append(out, seq)
		}
	}
	sortSequences(out)
	return out
}

// IsPendingRepublish reports whether seq is still awaiting recovery.
func (s *Subscription) IsPendingRepublish(seq uint32) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec := s.records[seq]
	return rec != nil && rec.state == recordPending
}

// IsPermanentlyMissing reports whether the server confirmed that seq was lost.
func (s *Subscription) IsPermanentlyMissing(seq uint32) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec := s.records[seq]
	return rec != nil && rec.state == recordMissing
}

// Notification returns the notification data for a received sequence number.
func (s *Subscription) Notification(seq uint32) ([]NotificationData, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec := s.records[seq]
	if rec == nil || (rec.state != recordReceived && rec.state != recordPersisted) {
		return nil, false
	}
	return append([]NotificationData(nil), rec.data...), true
}

// NextSequenceNumber returns the next notification sequence expected from the
// server. It is zero before the first publish response.
func (s *Subscription) NextSequenceNumber() uint32 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.nextSeq
}

// LastSequenceNumber returns the highest sequence number observed in a
// notification message.
func (s *Subscription) LastSequenceNumber() uint32 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastSeq
}

// Snapshot returns a consistent copy of the state.
func (s *Subscription) Snapshot() Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	return Snapshot{
		SessionID:                s.sessionID,
		SubscriptionID:           s.subscriptionID,
		Generation:               s.generation,
		NextSequenceNumber:       s.nextSeq,
		LastSequenceNumber:       s.lastSeq,
		AckSequenceNumber:        s.ackSeq,
		AvailableSequenceNumbers: s.availableLocked(),
		PendingRepublish:         s.pendingLocked(),
		PermanentlyMissing:       s.missingLocked(),
		KeepAliveCount:           s.keepAlives,
	}
}

func (s *Subscription) acceptIdentityLocked(session string, subscription uint32, generation uint64) bool {
	if session != "" && s.sessionID != "" && session != s.sessionID {
		return false
	}
	if subscription != 0 && s.subscriptionID != 0 && subscription != s.subscriptionID {
		return false
	}
	if generation != 0 && s.generation != 0 && generation != s.generation {
		return false
	}
	if session != "" && s.sessionID == "" {
		s.sessionID = session
	}
	if subscription != 0 && s.subscriptionID == 0 {
		s.subscriptionID = subscription
	}
	return true
}

func (s *Subscription) applyNotificationLocked(seq uint32, data []NotificationData, persisted bool) (accepted, duplicate bool, err error) {
	if seq == 0 {
		return false, false, ErrInvalidSequence
	}

	switch {
	case !s.started:
		s.started = true
		s.ackSeq = previousSequence(seq)
		s.nextSeq = nextSequence(seq)
		s.lastSeq = seq
		s.setRecordLocked(seq, recordReceived, data, persisted)
		return true, false, nil

	case seqEqual(seq, s.nextSeq):
		s.setRecordLocked(seq, recordReceived, data, persisted)
		s.nextSeq = nextSequence(seq)
		s.lastSeq = seq
		return true, false, nil

	case seqAfter(seq, s.nextSeq):
		count := sequenceDistance(s.nextSeq, seq) // number of skipped numbers
		if count > s.maxGap {
			return false, false, fmt.Errorf("%w: %d skipped, limit %d", ErrGapTooLarge, count, s.maxGap)
		}
		for cur := s.nextSeq; !seqEqual(cur, seq); cur = nextSequence(cur) {
			if s.records[cur] == nil {
				s.records[cur] = &sequenceRecord{state: recordPending}
			}
		}
		s.setRecordLocked(seq, recordReceived, data, persisted)
		s.nextSeq = nextSequence(seq)
		s.lastSeq = seq
		return true, false, nil

	default: // older than nextSeq
		rec := s.records[seq]
		if rec == nil {
			// Before the first observed sequence or already discarded. It is
			// safe to treat it as a duplicate rather than resurrecting state.
			return false, true, nil
		}
		switch rec.state {
		case recordPending:
			rec.state = recordReceived
			rec.data = data
			if persisted {
				rec.state = recordPersisted
			}
			return true, false, nil
		case recordReceived:
			if persisted {
				rec.state = recordPersisted
			}
			return false, true, nil
		case recordPersisted:
			// Duplicate of a durable notification; keep it durable.
			return false, true, nil
		case recordMissing:
			// Permanently missing notifications are never accepted later.
			return false, true, nil
		}
		return false, true, nil
	}
}

func (s *Subscription) setRecordLocked(seq uint32, state recordState, data []NotificationData, persisted bool) {
	rec := s.records[seq]
	if rec == nil {
		rec = &sequenceRecord{}
		s.records[seq] = rec
	}
	rec.state = state
	rec.data = data
	if persisted {
		rec.state = recordPersisted
	}
}

func (s *Subscription) applyKeepAliveLocked(next uint32) {
	if next == 0 {
		return
	}
	if !s.started {
		// A keep-alive can be the first message of a fresh subscription. Its
		// sequence is the next notification sequence and is a safe baseline.
		s.started = true
		s.ackSeq = previousSequence(next)
		s.nextSeq = next
		return
	}
	if seqAfter(next, s.nextSeq) {
		count := sequenceDistance(s.nextSeq, next)
		if count > s.maxGap {
			return
		}
		for cur := s.nextSeq; !seqEqual(cur, next); cur = nextSequence(cur) {
			if s.records[cur] == nil {
				s.records[cur] = &sequenceRecord{state: recordPending}
			}
		}
		s.nextSeq = next
		s.lastSeq = previousSequence(next)
	}
}

func (s *Subscription) updateAvailableLocked(seqs []uint32) {
	if seqs == nil {
		return
	}
	s.availableKnown = true
	s.available = make(map[uint32]struct{}, len(seqs))
	for _, seq := range seqs {
		if seq != 0 {
			s.available[seq] = struct{}{}
		}
	}
}

func (s *Subscription) markMissingLocked(seq uint32) []uint32 {
	if seq == 0 {
		return nil
	}
	rec := s.records[seq]
	if rec == nil {
		// Only a sequence inside the observed range can be confirmed missing.
		if !s.started || seqAfter(seq, s.lastSeq) {
			return nil
		}
		rec = &sequenceRecord{state: recordPending}
		s.records[seq] = rec
	}
	if rec.state != recordPending {
		return nil
	}
	rec.state = recordMissing
	rec.data = nil
	return []uint32{seq}
}

func (s *Subscription) fillResultLocked(res *PublishResult) {
	res.AvailableSequenceNumbers = s.availableLocked()
	res.PendingRepublish = s.pendingLocked()
	res.Republish = append([]uint32(nil), res.PendingRepublish...)
	res.PermanentMissing = s.missingLocked()
	res.Missing = append([]uint32(nil), res.PermanentMissing...)
	res.AckSequence = s.safeAckLocked()
}

func (s *Subscription) fillRepublishResultLocked(res *RepublishResult) {
	res.AvailableSequenceNumbers = s.availableLocked()
	res.PendingRepublish = s.pendingLocked()
	res.Republish = append([]uint32(nil), res.PendingRepublish...)
	res.PermanentMissing = s.missingLocked()
	res.Missing = append([]uint32(nil), res.PermanentMissing...)
	res.AckSequence = s.safeAckLocked()
}

func (s *Subscription) pendingLocked() []uint32 {
	var out []uint32
	for seq, rec := range s.records {
		if rec.state == recordPending {
			out = append(out, seq)
		}
	}
	sortSequences(out)
	return out
}

func (s *Subscription) missingLocked() []uint32 {
	var out []uint32
	for seq, rec := range s.records {
		if rec.state == recordMissing {
			out = append(out, seq)
		}
	}
	sortSequences(out)
	return out
}

func (s *Subscription) availableLocked() []uint32 {
	if !s.availableKnown {
		return nil
	}
	out := make([]uint32, 0, len(s.available))
	for seq := range s.available {
		out = append(out, seq)
	}
	sortSequences(out)
	return out
}

func (s *Subscription) safeAckLocked() uint32 {
	cur := s.ackSeq
	for {
		next := nextSequence(cur)
		if !s.started || seqAfter(next, s.lastSeq) {
			return cur
		}
		rec := s.records[next]
		if rec == nil {
			return cur
		}
		switch rec.state {
		case recordPersisted, recordMissing:
			cur = next
		default:
			return cur
		}
	}
}

func (s *Subscription) firstKnownLocked() uint32 {
	if s.ackSeq != 0 {
		return nextSequence(s.ackSeq)
	}
	return 1
}

func publishResponseFromArgs(args []any) (PublishResponse, bool) {
	if len(args) == 0 {
		return PublishResponse{}, false
	}
	for _, arg := range args {
		switch v := arg.(type) {
		case PublishResponse:
			return v, true
		case *PublishResponse:
			if v != nil {
				return *v, true
			}
		case NotificationMessage:
			return PublishResponse{NotificationMessage: v}, true
		case *NotificationMessage:
			if v != nil {
				return PublishResponse{NotificationMessage: *v}, true
			}
		}
	}

	var resp PublishResponse
	var sequenceSet bool
	for _, arg := range args {
		switch v := arg.(type) {
		case string:
			if resp.SessionID == "" {
				resp.SessionID = v
			}
		case uint32:
			if !sequenceSet {
				resp.SequenceNumber = v
				sequenceSet = true
			} else if resp.SubscriptionID == 0 {
				resp.SubscriptionID = v
			}
		case int:
			if v > 0 {
				if !sequenceSet {
					resp.SequenceNumber = uint32(v)
					sequenceSet = true
				} else if resp.SubscriptionID == 0 {
					resp.SubscriptionID = uint32(v)
				}
			}
		case StatusCode:
			resp.Status = v
		case []uint32:
			resp.AvailableSequenceNumbers = v
		case []NotificationData:
			resp.NotificationData = v
		case []byte:
			resp.NotificationData = []NotificationData{{Payload: v}}
		case bool:
			resp.Persisted = v
		}
	}
	return resp, sequenceSet || len(resp.NotificationData) != 0
}

func republishResponseFromArgs(args []any) (RepublishResponse, bool) {
	if len(args) == 0 {
		return RepublishResponse{}, false
	}
	for _, arg := range args {
		switch v := arg.(type) {
		case RepublishResponse:
			return v, true
		case *RepublishResponse:
			if v != nil {
				return *v, true
			}
		case NotificationMessage:
			return RepublishResponse{NotificationMessage: v}, true
		case *NotificationMessage:
			if v != nil {
				return RepublishResponse{NotificationMessage: *v}, true
			}
		}
	}

	var resp RepublishResponse
	var sequenceSet bool
	for _, arg := range args {
		switch v := arg.(type) {
		case string:
			if resp.SessionID == "" {
				resp.SessionID = v
			}
		case uint32:
			if !sequenceSet {
				resp.SequenceNumber = v
				sequenceSet = true
			} else if v&0x80000000 != 0 {
				resp.Status = StatusCode(v)
			} else if resp.SubscriptionID == 0 {
				resp.SubscriptionID = v
			}
		case int:
			if v >= 0 {
				if !sequenceSet {
					resp.SequenceNumber = uint32(v)
					sequenceSet = true
				} else if v&0x80000000 != 0 {
					resp.Status = StatusCode(uint32(v))
				} else if resp.SubscriptionID == 0 {
					resp.SubscriptionID = uint32(v)
				}
			}
		case StatusCode:
			resp.Status = v
		case []uint32:
			resp.AvailableSequenceNumbers = v
		case []NotificationData:
			resp.NotificationData = v
		case []byte:
			resp.NotificationData = []NotificationData{{Payload: v}}
		case bool:
			resp.Persisted = v
		}
	}
	return resp, sequenceSet || resp.Status != 0
}

// OPC UA publish sequence numbers start at 1 and wrap from UINT32_MAX to 1.
func nextSequence(seq uint32) uint32 {
	seq++
	if seq == 0 {
		return 1
	}
	return seq
}

func previousSequence(seq uint32) uint32 {
	if seq <= 1 {
		return 0
	}
	return seq - 1
}

func seqEqual(a, b uint32) bool { return a == b }

// seqAfter reports whether a is after b in the wrapping sequence space.
func seqAfter(a, b uint32) bool {
	if a == b {
		return false
	}
	return int32(a-b) > 0
}

func sequenceDistance(from, to uint32) uint32 {
	// Number of values strictly between from and to when to is after from.
	return to - from
}

func sortSequences(seqs []uint32) {
	sort.Slice(seqs, func(i, j int) bool { return seqs[i] < seqs[j] })
}
