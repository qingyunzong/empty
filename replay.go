// Replay drives an identical event sequence through both LookupStore and
// NaiveStore and asserts that every observable result matches. It is the
// differential-testing harness: the indexed half-open interval engine is
// checked against the engine that scans the full retained history every time.
package formal

import (
	"errors"
	"fmt"
)

// temporalEngine is the common surface exercised by replay.
type temporalEngine[V comparable] interface {
	Upsert(key int64, validFrom, validTo int64, value V) error
	Delete(key int64, validFrom, validTo int64) error
	Lookup(key int64, eventTime int64) (V, bool, error)
	Probe(eventID int64, eventTime int64, key int64) (Emission[V], bool, error)
	Advance(w int64) error
	Sweep() []Emission[V]
	Journal() []Emission[V]
}

// Op is one step of a replayed event sequence.
type Op[V any] struct {
	Kind string

	// Write fields (Upsert, Delete).
	Key       int64
	ValidFrom int64
	ValidTo   int64
	Value     V

	// Probe fields.
	EventID   int64
	EventTime int64

	// Advance field.
	Watermark int64

	// Lookup fields reuse Key and EventTime.
}

// Supported op kinds.
const (
	OpUpsert  = "upsert"
	OpDelete  = "delete"
	OpProbe   = "probe"
	OpLookup  = "lookup"
	OpAdvance = "advance"
	OpSweep   = "sweep"
)

// Report summarizes one replay run.
type Report struct {
	Ops         int
	Writes      int
	Probes      int
	Dropped     int
	Rejected    int
	Emissions   int
	Corrections int
}

// Replay runs ops against freshly constructed engines and returns the first
// divergence as an error. The two stores share allowedLateness so that their
// watermark horizons and late-event windows are identical.
func Replay[V comparable](allowedLateness int64, ops []Op[V]) (Report, error) {
	fast := NewLookupStore[V](allowedLateness)
	naive := NewNaiveStore[V](allowedLateness)
	return ReplayInto(fast, naive, ops)
}

// ReplayInto runs ops against caller-provided engines, which lets tests reuse
// a sequence against preconfigured stores.
func ReplayInto[V comparable](fast *LookupStore[V], naive *NaiveStore[V], ops []Op[V]) (Report, error) {
	var report Report

	for step, op := range ops {
		report.Ops++
		switch op.Kind {
		case OpUpsert:
			report.Writes++
			errFast := fast.Upsert(op.Key, op.ValidFrom, op.ValidTo, op.Value)
			errNaive := naive.Upsert(op.Key, op.ValidFrom, op.ValidTo, op.Value)
			if err := compareErrors(step, op, errFast, errNaive); err != nil {
				return report, err
			}
			if errFast != nil {
				report.Rejected++
			}

		case OpDelete:
			report.Writes++
			errFast := fast.Delete(op.Key, op.ValidFrom, op.ValidTo)
			errNaive := naive.Delete(op.Key, op.ValidFrom, op.ValidTo)
			if err := compareErrors(step, op, errFast, errNaive); err != nil {
				return report, err
			}
			if errFast != nil {
				report.Rejected++
			}

		case OpLookup:
			valueFast, foundFast, errFast := fast.Lookup(op.Key, op.EventTime)
			valueNaive, foundNaive, errNaive := naive.Lookup(op.Key, op.EventTime)
			if err := compareErrors(step, op, errFast, errNaive); err != nil {
				return report, err
			}
			if foundFast != foundNaive || (foundFast && valueFast != valueNaive) {
				return report, fmt.Errorf("step %d lookup divergence for key=%d t=%d: fast=(%v,%v) naive=(%v,%v)",
					step, op.Key, op.EventTime, valueFast, foundFast, valueNaive, foundNaive)
			}

		case OpProbe:
			report.Probes++
			emFast, okFast, errFast := fast.Probe(op.EventID, op.EventTime, op.Key)
			emNaive, okNaive, errNaive := naive.Probe(op.EventID, op.EventTime, op.Key)
			if err := compareErrors(step, op, errFast, errNaive); err != nil {
				return report, err
			}
			if okFast != okNaive {
				return report, fmt.Errorf("step %d probe drop divergence for event=%d t=%d: fast=%v naive=%v",
					step, op.EventID, op.EventTime, okFast, okNaive)
			}
			if !okFast {
				report.Dropped++
				continue
			}
			if !emissionEquivalent(emFast, emNaive) {
				return report, fmt.Errorf("step %d probe emission divergence: fast=%+v naive=%+v",
					step, emFast, emNaive)
			}

		case OpAdvance:
			errFast := fast.Advance(op.Watermark)
			errNaive := naive.Advance(op.Watermark)
			if err := compareErrors(step, op, errFast, errNaive); err != nil {
				return report, err
			}
			if fast.Watermark() != naive.Watermark() {
				return report, fmt.Errorf("step %d watermark divergence: fast=%d naive=%d",
					step, fast.Watermark(), naive.Watermark())
			}

		case OpSweep:
			corrFast := fast.Sweep()
			corrNaive := naive.Sweep()
			if len(corrFast) != len(corrNaive) {
				return report, fmt.Errorf("step %d sweep length divergence: fast=%d naive=%d",
					step, len(corrFast), len(corrNaive))
			}
			for i := range corrFast {
				if corrFast[i] != corrNaive[i] {
					return report, fmt.Errorf("step %d sweep correction %d divergence: fast=%+v naive=%+v",
						step, i, corrFast[i], corrNaive[i])
				}
			}
			report.Corrections += len(corrFast)

		default:
			return report, fmt.Errorf("step %d: unknown op kind %q", step, op.Kind)
		}

		if err := compareJournals(step, fast, naive); err != nil {
			return report, err
		}
	}

	report.Emissions = len(fast.Journal())
	return report, nil
}

func compareErrors[V any](step int, op Op[V], errFast, errNaive error) error {
	if errors.Is(errFast, ErrInvalidTime) != errors.Is(errNaive, ErrInvalidTime) {
		return fmt.Errorf("step %d (%s) error divergence: fast=%v naive=%v", step, op.Kind, errFast, errNaive)
	}
	return nil
}

// emissionEquivalent compares all business fields. Seq is validated
// separately through the strict full-journal comparison after every step.
func emissionEquivalent[V comparable](a, b Emission[V]) bool {
	return a.EventID == b.EventID &&
		a.EventTime == b.EventTime &&
		a.Key == b.Key &&
		a.Deleted == b.Deleted &&
		(a.Deleted || a.Value == b.Value)
}

func compareJournals[V comparable](step int, fast temporalEngine[V], naive temporalEngine[V]) error {
	jFast := fast.Journal()
	jNaive := naive.Journal()
	if len(jFast) != len(jNaive) {
		return fmt.Errorf("step %d journal length divergence: fast=%d naive=%d", step, len(jFast), len(jNaive))
	}
	for i := range jFast {
		if jFast[i] != jNaive[i] {
			return fmt.Errorf("step %d journal entry %d divergence: fast=%+v naive=%+v",
				step, i, jFast[i], jNaive[i])
		}
	}
	return nil
}
