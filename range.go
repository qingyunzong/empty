package dataeng

import (
	"errors"
	"fmt"
)

// Bounds is the CDC validity window for a capture instance.
type Bounds struct {
	MinLSN LSN `json:"min_lsn"`
	MaxLSN LSN `json:"max_lsn"`
}

// Availability is an alias for Bounds.
type Availability = Bounds

// LSNAvailability is an alias for Bounds.
type LSNAvailability = Bounds

// IsEmpty reports whether the capture instance currently has a usable range.
func (b Bounds) IsEmpty() bool {
	return b.MinLSN.IsZero() || b.MaxLSN.IsZero() || CompareLSN(b.MinLSN, b.MaxLSN) > 0
}

// QueryRange is a closed LSN interval, matching the semantics of
// cdc.fn_cdc_get_all_changes_<capture>.
type QueryRange struct {
	FromLSN LSN `json:"from_lsn"`
	ToLSN   LSN `json:"to_lsn"`
}

// Range is an alias for QueryRange.
type Range = QueryRange

// IsEmpty reports whether either endpoint is unset or the range is inverted.
func (r QueryRange) IsEmpty() bool {
	return r.FromLSN.IsZero() || r.ToLSN.IsZero() || CompareLSN(r.FromLSN, r.ToLSN) > 0
}

// Contains reports whether lsn is inside the closed interval.
func (r QueryRange) Contains(lsn LSN) bool {
	if r.IsEmpty() {
		return false
	}
	return CompareLSN(r.FromLSN, lsn) <= 0 && CompareLSN(lsn, r.ToLSN) <= 0
}

// Validate checks that the range is non-empty and ordered.
func (r QueryRange) Validate() error {
	if r.FromLSN.IsZero() {
		return fmt.Errorf("%w: empty from_lsn", ErrInvalidLSN)
	}
	if r.ToLSN.IsZero() {
		return fmt.Errorf("%w: empty to_lsn", ErrInvalidLSN)
	}
	if CompareLSN(r.FromLSN, r.ToLSN) > 0 {
		return fmt.Errorf("%w: from_lsn %s is after to_lsn %s", ErrInvalidLSN, r.FromLSN, r.ToLSN)
	}
	return nil
}

// NextLowerBound maps the previous upper bound to the next lower bound. The
// SQL CDC query interval is closed, so sys.fn_cdc_increment_lsn is used to
// avoid returning the previous upper bound again.
func NextLowerBound(previousUpper LSN) (LSN, error) {
	return IncrementLSN(previousUpper)
}

// PreviousUpperBound maps a lower bound to the immediately preceding LSN.
func PreviousUpperBound(lower LSN) (LSN, error) {
	return DecrementLSN(lower)
}

// MapRange applies endpoint mapping functions. It is useful when a state
// store persists LSNs in a different boundary convention.
func MapRange(r QueryRange, mapFrom, mapTo func(LSN) (LSN, error)) (QueryRange, error) {
	from, err := mapFrom(r.FromLSN)
	if err != nil {
		return QueryRange{}, fmt.Errorf("map from_lsn: %w", err)
	}
	to, err := mapTo(r.ToLSN)
	if err != nil {
		return QueryRange{}, fmt.Errorf("map to_lsn: %w", err)
	}
	mapped := QueryRange{FromLSN: from, ToLSN: to}
	if err := mapped.Validate(); err != nil {
		return QueryRange{}, err
	}
	return mapped, nil
}

var (
	// ErrLSNGap means rows at the stored checkpoint have been removed by the
	// SQL Server CDC cleanup job.
	ErrLSNGap = errors.New("sqlserver cdc: change retention gap")
	// ErrGap is an alias for ErrLSNGap.
	ErrGap = ErrLSNGap
	// ErrSnapshotRequired means CDC cannot resume from the checkpoint and a
	// new snapshot must be taken.
	ErrSnapshotRequired = errors.New("sqlserver cdc: snapshot required")
)

// GapError reports that cleanup advanced the capture instance's minimum LSN
// past the connector's checkpoint. It deliberately does not suggest jumping
// to the current maximum LSN: doing so would silently lose changes.
type GapError struct {
	RequestedLSN LSN `json:"requested_lsn"`
	Watermark    LSN `json:"watermark"`
	MinLSN       LSN `json:"min_lsn"`
	MaxLSN       LSN `json:"max_lsn"`
}

// Error implements error.
func (e *GapError) Error() string {
	return fmt.Sprintf(
		"sqlserver cdc: retention gap: checkpoint %s is older than minimum available LSN %s (requested %s); snapshot required",
		e.Watermark, e.MinLSN, e.RequestedLSN,
	)
}

// Unwrap allows errors.Is(err, ErrLSNGap).
func (e *GapError) Unwrap() error {
	return ErrLSNGap
}

// Is allows errors.Is(err, ErrLSNGap) and errors.Is(err,
// ErrSnapshotRequired).
func (e *GapError) Is(target error) bool {
	return target == ErrLSNGap || target == ErrSnapshotRequired
}

// SnapshotRequired always returns true for a retention gap.
func (e *GapError) SnapshotRequired() bool {
	return true
}

// CheckGap reports a gap when cleanup has moved minLSN beyond watermark. A
// zero watermark means no checkpoint exists; that is a snapshot condition,
// not a retention gap, and is handled by PlanNext.
func CheckGap(watermark, minLSN, maxLSN LSN) *GapError {
	if watermark.IsZero() || minLSN.IsZero() {
		return nil
	}
	if CompareLSN(watermark, minLSN) >= 0 {
		return nil
	}
	return &GapError{
		RequestedLSN: watermark.Bytes(),
		Watermark:    watermark.Bytes(),
		MinLSN:       minLSN.Bytes(),
		MaxLSN:       maxLSN.Bytes(),
	}
}

// DetectGap is an alias for CheckGap.
func DetectGap(watermark, minLSN, maxLSN LSN) *GapError {
	return CheckGap(watermark, minLSN, maxLSN)
}

// GapFor checks a state against capture-instance bounds.
func GapFor(state State, bounds Bounds) *GapError {
	return CheckGap(state.Watermark, bounds.MinLSN, bounds.MaxLSN)
}

// Action is the next action a connector should take.
type Action int

const (
	// ActionNoop means there are no changes to read.
	ActionNoop Action = iota
	// ActionQuery means read the planned LSN range.
	ActionQuery
	// ActionSnapshot means retention is unusable and a new snapshot must be
	// taken. No CDC range is planned in this case.
	ActionSnapshot
)

// ActionNone is an alias for ActionNoop.
const ActionNone = ActionNoop

// String returns a stable action name.
func (a Action) String() string {
	switch a {
	case ActionNoop:
		return "noop"
	case ActionQuery:
		return "query"
	case ActionSnapshot:
		return "snapshot"
	default:
		return fmt.Sprintf("action(%d)", int(a))
	}
}

// Plan is the result of planning the next CDC read.
type Plan struct {
	Action      Action     `json:"action"`
	Range       QueryRange `json:"range,omitempty"`
	Gap         *GapError  `json:"gap,omitempty"`
	SnapshotLSN LSN        `json:"snapshot_lsn,omitempty"`
	ReplayLSN   bool       `json:"replay_lsn,omitempty"`
	Reason      string     `json:"reason,omitempty"`
}

// RequiresSnapshot reports whether the plan requires a new snapshot.
func (p Plan) RequiresSnapshot() bool {
	return p.Action == ActionSnapshot
}

// SnapshotRequired is an alias for RequiresSnapshot.
func (p Plan) SnapshotRequired() bool {
	return p.RequiresSnapshot()
}

// PlanNext computes the next query interval from a checkpoint. It never
// silently moves the checkpoint to the current maximum LSN. A missing
// checkpoint or a cleanup-induced gap produces ActionSnapshot and an error
// wrapping ErrSnapshotRequired.
func PlanNext(state State, bounds Bounds) (Plan, error) {
	if state.PendingSnapshot {
		return snapshotPlan(bounds, "checkpoint is marked for a new snapshot"), ErrSnapshotRequired
	}
	if state.Watermark.IsZero() {
		return snapshotPlan(bounds, "no checkpoint; an initial snapshot is required"), ErrSnapshotRequired
	}
	if gap := GapFor(state, bounds); gap != nil {
		return Plan{
			Action:      ActionSnapshot,
			Gap:         gap,
			SnapshotLSN: bounds.MaxLSN.Bytes(),
			Reason:      "cleanup advanced min_lsn past the checkpoint",
		}, gap
	}
	if bounds.IsEmpty() {
		return Plan{Action: ActionNoop, Reason: "capture instance has no changes"}, nil
	}

	from, err := IncrementLSN(state.Watermark)
	if err != nil {
		return Plan{}, err
	}
	replay := false

	// If a batch stopped inside an LSN, the watermark is still that LSN.
	// Re-read it and let the composite position filter rows that were already
	// applied. Incrementing here would skip the remaining seqval values.
	if !state.Position.IsZero() && CompareLSN(state.Position.StartLSN, state.Watermark) > 0 {
		from = state.Watermark.Bytes()
		replay = true
	}

	if CompareLSN(from, bounds.MaxLSN) > 0 {
		return Plan{Action: ActionNoop, Reason: "checkpoint is at the current maximum LSN"}, nil
	}

	// This can only happen if the state was written with an LSN outside the
	// reported validity window. Treat it as a gap rather than clamping.
	if CompareLSN(from, bounds.MinLSN) < 0 {
		gap := &GapError{
			RequestedLSN: from.Bytes(),
			Watermark:    state.Watermark.Bytes(),
			MinLSN:       bounds.MinLSN.Bytes(),
			MaxLSN:       bounds.MaxLSN.Bytes(),
		}
		return Plan{
			Action:      ActionSnapshot,
			Gap:         gap,
			SnapshotLSN: bounds.MaxLSN.Bytes(),
			Reason:      "next LSN is below min_lsn",
		}, gap
	}

	return Plan{
		Action:    ActionQuery,
		Range:     QueryRange{FromLSN: from, ToLSN: bounds.MaxLSN.Bytes()},
		ReplayLSN: replay,
		Reason:    "read the next closed CDC interval",
	}, nil
}

// NextRange is PlanNext restricted to the planned query interval.
func NextRange(state State, bounds Bounds) (QueryRange, error) {
	plan, err := PlanNext(state, bounds)
	return plan.Range, err
}

// Decide is an alias for PlanNext.
func Decide(state State, bounds Bounds) (Plan, error) {
	return PlanNext(state, bounds)
}

func snapshotPlan(bounds Bounds, reason string) Plan {
	return Plan{
		Action:      ActionSnapshot,
		SnapshotLSN: bounds.MaxLSN.Bytes(),
		Reason:      reason,
	}
}
