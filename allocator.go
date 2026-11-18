package formal

import (
	"errors"
	"sync"
)

// Allocator keeps the previous assignment between reconciliations so that
// topology and readiness updates are applied with minimal endpoint movement.
//
// The zero value is ready for use. An Allocator is safe for concurrent use.
type Allocator struct {
	mu          sync.Mutex
	options     Options
	optionsErr  error
	assignments Assignment
}

// NewAllocator returns an Allocator with the supplied options. At most one
// Options value may be provided; invalid options are reported by the first
// call to Allocate. With no options, DefaultMaxDeviation is used.
func NewAllocator(options ...Options) *Allocator {
	allocator := &Allocator{}
	if len(options) > 1 {
		allocator.optionsErr = errors.New("formal: at most one Options value may be supplied")
	} else if len(options) == 1 {
		allocator.options = options[0]
	}
	return allocator
}

// Allocate partitions the endpoints and records the result for the next call.
// If an error is returned, the previous assignment is left unchanged.
//
// Supplying Options to this call temporarily overrides the options given to
// NewAllocator.
func (a *Allocator) Allocate(zones []Zone, endpoints []Endpoint, options ...Options) (Result, error) {
	if a == nil {
		return Result{}, errors.New("formal: nil allocator")
	}
	if len(options) > 1 {
		return Result{}, errors.New("formal: at most one Options value may be supplied")
	}
	a.mu.Lock()
	defer a.mu.Unlock()

	opts := a.options
	if len(options) == 1 {
		opts = options[0]
	} else if a.optionsErr != nil {
		return Result{}, a.optionsErr
	}
	result, err := Partition(zones, endpoints, a.assignments, opts)
	if err != nil {
		return Result{}, err
	}
	a.assignments = cloneAssignment(result.Assignments)
	return result, nil
}

// Assignments returns a copy of the assignment recorded by the last
// successful call to Allocate.
func (a *Allocator) Assignments() Assignment {
	if a == nil {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return cloneAssignment(a.assignments)
}

// Reset discards the recorded assignment. The next call to Allocate behaves
// as a first reconciliation.
func (a *Allocator) Reset() {
	if a == nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.assignments = nil
}
