package dualidx

import (
	"errors"
	"fmt"
	"sync/atomic"
)

// ErrInjected is returned (wrapped) when a build step fails because a
// fault was injected through the store's FaultInjector.
var ErrInjected = errors.New("dualidx: injected fault")

// FaultInjector lets tests force failures at the two index persistence
// points and at the publish point of a rebuild. All switches are safe to
// toggle concurrently with a running Rebuild.
type FaultInjector struct {
	persistContent atomic.Bool
	persistPath    atomic.Bool
	publish        atomic.Bool
}

// NewFaultInjector returns an injector with all faults disabled.
func NewFaultInjector() *FaultInjector { return &FaultInjector{} }

// SetPersistContentFail makes the next content-index persistence step fail.
func (f *FaultInjector) SetPersistContentFail(on bool) { f.persistContent.Store(on) }

// SetPersistPathFail makes the next path-index persistence step fail.
func (f *FaultInjector) SetPersistPathFail(on bool) { f.persistPath.Store(on) }

// SetPublishFail makes the next generation publish step fail.
func (f *FaultInjector) SetPublishFail(on bool) { f.publish.Store(on) }

func (f *FaultInjector) checkPersistContent() error {
	if f.persistContent.Load() {
		return fmt.Errorf("%w: persist content index", ErrInjected)
	}
	return nil
}

func (f *FaultInjector) checkPersistPath() error {
	if f.persistPath.Load() {
		return fmt.Errorf("%w: persist path index", ErrInjected)
	}
	return nil
}

func (f *FaultInjector) checkPublish() error {
	if f.publish.Load() {
		return fmt.Errorf("%w: publish generation", ErrInjected)
	}
	return nil
}
