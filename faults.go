package dualindex

import (
	"errors"
	"fmt"
	"sync"
)

// FaultPoint identifies a step in a generation build where a failure can be
// injected.
type FaultPoint string

const (
	// FaultPersistContent fails the build while the content index is persisted.
	FaultPersistContent FaultPoint = "persist_content"
	// FaultPersistPath fails the build while the path index is persisted.
	FaultPersistPath FaultPoint = "persist_path"
	// FaultPublish fails the build while the new generation is published.
	FaultPublish FaultPoint = "publish"
)

// ErrInjected is returned (wrapped) by Store.Update when an injected fault
// aborts a build.
var ErrInjected = errors.New("dualindex: injected fault")

// Faults arms one-shot or permanent failures at build fault points. It is
// safe for concurrent use.
type Faults struct {
	mu     sync.Mutex
	remain map[FaultPoint]int
}

// Fail makes the next times builds fail at point. A negative times value
// makes every build fail until re-armed with 0.
func (f *Faults) Fail(point FaultPoint, times int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.remain == nil {
		f.remain = make(map[FaultPoint]int)
	}
	f.remain[point] = times
}

func (f *Faults) inject(point FaultPoint) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	n, ok := f.remain[point]
	if !ok || n == 0 {
		return nil
	}
	if n > 0 {
		if n == 1 {
			delete(f.remain, point)
		} else {
			f.remain[point] = n - 1
		}
	}
	return fmt.Errorf("%w at %s", ErrInjected, point)
}
