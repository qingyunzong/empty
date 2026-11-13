package dataeng

import (
	"bytes"
	"fmt"
	"sync"
)

// Validator tracks the assignment and completion state for worker intervals.
// It is safe for concurrent use.
type Validator struct {
	mu        sync.Mutex
	intervals []Interval
	statuses  []Status
}

// Set is an alias for Validator.
type Set = Validator

// NewValidator creates a validator for the supplied intervals.
//
// It fails immediately if an interval has Start > End or if two intervals
// have the same start. Intervals with different starts may overlap. Within an
// overlap, the interval with the smaller start owns every shared key; the
// other interval may only report keys after that owner's end.
func NewValidator(intervals []Interval) (*Validator, error) {
	if err := ValidateIntervals(intervals); err != nil {
		return nil, err
	}

	copied := make([]Interval, len(intervals))
	for i, interval := range intervals {
		copied[i] = Interval{
			Start: cloneKey(interval.Start),
			End:   cloneKey(interval.End),
		}
	}

	return &Validator{
		intervals: copied,
		statuses:  make([]Status, len(copied)),
	}, nil
}

// NewSet creates a validator for the supplied intervals. It is an alias for
// NewValidator.
func NewSet(intervals []Interval) (*Validator, error) {
	return NewValidator(intervals)
}

// Len returns the number of assigned worker intervals.
func (v *Validator) Len() int {
	v.mu.Lock()
	defer v.mu.Unlock()
	return len(v.intervals)
}

// Interval returns a copy of the interval assigned to worker index.
func (v *Validator) Interval(index int) (Interval, bool) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if index < 0 || index >= len(v.intervals) {
		return Interval{}, false
	}
	interval := v.intervals[index]
	return Interval{
		Start: cloneKey(interval.Start),
		End:   cloneKey(interval.End),
	}, true
}

// Status returns the current status of worker index.
func (v *Validator) Status(index int) (Status, bool) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if index < 0 || index >= len(v.statuses) {
		return StatusIncomplete, false
	}
	return v.statuses[index], true
}

// Accept validates and applies one report for worker index. The report is
// atomic: if a key is outside the worker's interval or belongs to an overlap
// owned by an interval with a smaller start, an error is returned and the
// interval's status is unchanged.
//
// A successful call returns the resulting status. Rejection errors leave an
// incomplete interval incomplete. An exhausted report whose last key equals
// the interval end transitions the interval to StatusFailed.
func (v *Validator) Accept(index int, keys []Key, exhausted bool) (Status, error) {
	v.mu.Lock()
	defer v.mu.Unlock()

	if index < 0 || index >= len(v.intervals) {
		return StatusIncomplete, fmt.Errorf("%w: %d", ErrUnknownWorker, index)
	}
	if v.statuses[index] != StatusIncomplete {
		return v.statuses[index], fmt.Errorf("%w: worker %d is %s",
			ErrIntervalFinal, index, v.statuses[index])
	}

	status, err := v.validateLocked(index, keys, exhausted)
	if err != nil {
		// Invalid batches do not change state. The one report-level failure,
		// exhaustion at the interval end, is permanent.
		if status == StatusFailed {
			v.statuses[index] = StatusFailed
		}
		return status, err
	}
	if status != StatusIncomplete {
		v.statuses[index] = status
	}
	return status, nil
}

// AcceptReport validates and applies report for worker index. It is an alias
// for Accept(index, report.Keys, report.Exhausted).
func (v *Validator) AcceptReport(index int, report Report) (Status, error) {
	return v.Accept(index, report.Keys, report.Exhausted)
}

// ValidateReport validates report for worker index without changing state.
func (v *Validator) ValidateReport(index int, report Report) (Status, error) {
	v.mu.Lock()
	defer v.mu.Unlock()

	if index < 0 || index >= len(v.intervals) {
		return StatusIncomplete, fmt.Errorf("%w: %d", ErrUnknownWorker, index)
	}
	return v.validateLocked(index, report.Keys, report.Exhausted)
}

// overlapOwner reports whether an interval with a strictly smaller start owns
// key. Such an owner wins every key in the overlap, including the later
// interval's start and any keys through the owner's end.
func (v *Validator) overlapOwner(index int, key Key) bool {
	interval := v.intervals[index]
	for otherIndex, other := range v.intervals {
		if otherIndex == index {
			continue
		}
		if bytes.Compare(other.Start, interval.Start) >= 0 {
			continue
		}
		// The key is in an overlap exactly when it is inside the earlier
		// interval. Since the key is already in this interval, and this
		// interval starts later, comparing with other.End is sufficient.
		if bytes.Compare(key, other.End) <= 0 {
			return true
		}
	}
	return false
}

func (v *Validator) validateLocked(index int, keys []Key, exhausted bool) (Status, error) {
	interval := v.intervals[index]
	for _, key := range keys {
		if !interval.Contains(key) {
			return StatusIncomplete, fmt.Errorf(
				"%w: worker %d, key %q, interval %s",
				ErrKeyOutsideInterval, index, key, interval)
		}
		if v.overlapOwner(index, key) {
			return StatusIncomplete, fmt.Errorf(
				"%w: worker %d, key %q, interval %s",
				ErrOverlappingKey, index, key, interval)
		}
	}
	status, err := ValidateReport(interval, keys, exhausted)
	if err != nil {
		return status, fmt.Errorf(
			"%w: worker %d, key %q, interval %s",
			err, index, keys[len(keys)-1], interval)
	}
	return status, nil
}

func cloneKey(key Key) Key {
	if key == nil {
		return nil
	}
	copied := make(Key, len(key))
	copy(copied, key)
	return copied
}
