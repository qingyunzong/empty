package formal

import (
	"errors"
	"fmt"
	"sync"
	"time"
)

var (
	// ErrTimeRegression is returned when evaluation moves backwards in time.
	ErrTimeRegression = errors.New("formal: evaluation time moved backwards")
	// ErrInvalidEvaluationTime is returned for a zero evaluation time.
	ErrInvalidEvaluationTime = errors.New("formal: evaluation time must not be zero")
)

// AlertState is the persistent state of an alert pair.
type AlertState int

const (
	// AlertInactive means the pair is not firing.
	AlertInactive AlertState = iota
	// AlertFiring means the pair is firing.
	AlertFiring
)

func (s AlertState) String() string {
	switch s {
	case AlertInactive:
		return "inactive"
	case AlertFiring:
		return "firing"
	default:
		return fmt.Sprintf("AlertState(%d)", int(s))
	}
}

// Transition describes a state change caused by one evaluation.
type Transition int

const (
	// TransitionNone means the alert state did not change.
	TransitionNone Transition = iota
	// TransitionFired means the alert started firing.
	TransitionFired
	// TransitionCleared means the alert stopped firing.
	TransitionCleared
)

func (t Transition) String() string {
	switch t {
	case TransitionNone:
		return "none"
	case TransitionFired:
		return "fired"
	case TransitionCleared:
		return "cleared"
	default:
		return fmt.Sprintf("Transition(%d)", int(t))
	}
}

// Result is the outcome of one evaluation.
type Result struct {
	At         time.Time
	Cut        time.Time
	Revision   uint64
	Short      WindowStats
	Long       WindowStats
	DataOK     bool
	State      AlertState
	Transition Transition

	// RecoveryPending is true while a firing pair is waiting out RecoverFor.
	RecoveryPending  bool
	RecoverSince     time.Time
	RecoverRemaining time.Duration
}

// Firing reports whether the alert is firing after this evaluation.
func (r Result) Firing() bool {
	return r.State == AlertFiring
}

// Evaluator owns an alert pair's data store and state machine.
type Evaluator struct {
	mu           sync.Mutex
	cfg          Config
	store        *Store
	clock        Clock
	state        AlertState
	recoverSince time.Time
	lastEval     time.Time
}

// NewEvaluator validates cfg and creates an evaluator. A nil clock uses the
// system clock.
func NewEvaluator(cfg Config, clock Clock) (*Evaluator, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	store, err := NewStore(cfg.BucketWidth)
	if err != nil {
		return nil, err
	}
	if clock == nil {
		clock = systemClock{}
	}
	return &Evaluator{
		cfg:   cfg.clone(),
		store: store,
		clock: clock,
	}, nil
}

// Config returns a copy of the evaluator configuration.
func (e *Evaluator) Config() Config {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.cfg.clone()
}

// Store returns the underlying bucket store.
func (e *Evaluator) Store() *Store {
	return e.store
}

// State returns the current alert state.
func (e *Evaluator) State() AlertState {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.state
}

// Ingest inserts or replaces one SLI bucket. Buckets may arrive out of order.
func (e *Evaluator) Ingest(bucket Bucket) (bool, error) {
	return e.store.Upsert(bucket)
}

// IngestAll inserts or replaces a batch of buckets in the supplied order.
func (e *Evaluator) IngestAll(buckets ...Bucket) (int, error) {
	changed := 0
	for _, bucket := range buckets {
		ok, err := e.store.Upsert(bucket)
		if err != nil {
			return changed, err
		}
		if ok {
			changed++
		}
	}
	return changed, nil
}

// EvaluateNow evaluates at the injected clock's current time.
func (e *Evaluator) EvaluateNow() (Result, error) {
	return e.Evaluate(e.clock.Now())
}

// Evaluate advances the alert state using completed buckets at or before at.
//
// The cut is at.Truncate(BucketWidth), so a partially elapsed current bucket is
// never observed. Evaluation time must be monotonic; re-evaluating the same
// instant is allowed and is useful after a backfill.
func (e *Evaluator) Evaluate(at time.Time) (Result, error) {
	if at.IsZero() {
		return Result{}, ErrInvalidEvaluationTime
	}
	at = at.UTC()

	e.mu.Lock()
	defer e.mu.Unlock()

	if !e.lastEval.IsZero() && at.Before(e.lastEval) {
		return Result{}, fmt.Errorf("%w: last=%s now=%s", ErrTimeRegression,
			e.lastEval.Format(time.RFC3339Nano), at.Format(time.RFC3339Nano))
	}

	cut := at.Truncate(e.cfg.BucketWidth)
	longFrom := cut.Add(-e.cfg.LongWindow)
	points, revision := e.store.points(longFrom, cut, e.cfg.BucketWidth)

	longStats := aggregateWindow(points, e.cfg.LongWindow, e.cfg)
	shortCount := int(e.cfg.ShortWindow / e.cfg.BucketWidth)
	shortStats := aggregateWindow(points[len(points)-shortCount:], e.cfg.ShortWindow, e.cfg)
	dataOK := shortStats.DataOK && longStats.DataOK

	transition := TransitionNone
	if dataOK {
		switch e.state {
		case AlertInactive:
			if shortStats.BurnRate > e.cfg.FireThreshold &&
				longStats.BurnRate > e.cfg.FireThreshold {
				e.state = AlertFiring
				e.recoverSince = time.Time{}
				transition = TransitionFired
			}
		case AlertFiring:
			belowRecovery := shortStats.BurnRate <= e.cfg.RecoverThreshold &&
				longStats.BurnRate <= e.cfg.RecoverThreshold
			switch {
			case !belowRecovery:
				e.recoverSince = time.Time{}
			case e.cfg.RecoverFor == 0:
				e.state = AlertInactive
				e.recoverSince = time.Time{}
				transition = TransitionCleared
			case e.recoverSince.IsZero():
				e.recoverSince = at
			case at.Sub(e.recoverSince) >= e.cfg.RecoverFor:
				e.state = AlertInactive
				e.recoverSince = time.Time{}
				transition = TransitionCleared
			}
		}
	} else if e.state == AlertFiring {
		// A gap is not evidence of recovery. It also restarts the dwell period
		// so that only continuously observed healthy time can clear the alert.
		e.recoverSince = time.Time{}
	}

	e.lastEval = at
	result := Result{
		At:           at,
		Cut:          cut,
		Revision:     revision,
		Short:        shortStats,
		Long:         longStats,
		DataOK:       dataOK,
		State:        e.state,
		Transition:   transition,
		RecoverSince: e.recoverSince,
	}
	if e.state == AlertFiring && !e.recoverSince.IsZero() {
		result.RecoveryPending = true
		result.RecoverRemaining = e.cfg.RecoverFor - at.Sub(e.recoverSince)
		if result.RecoverRemaining < 0 {
			result.RecoverRemaining = 0
		}
	}
	return result, nil
}
