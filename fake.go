package planexec

import (
	"errors"
	"sync"
)

// FakeStore wraps a Store with deterministic fault injection for tests.
// Call index counting is global across all operations; when the counter
// reaches FailAt the operation returns ErrInjected without touching the
// inner store. FailAt < 0 disables injection.
type FakeStore struct {
	inner Store

	mu      sync.Mutex
	FailAt  int
	calls   int
	ErrFail error
}

func NewFakeStore(inner Store) *FakeStore {
	return &FakeStore{inner: inner, FailAt: -1, ErrFail: errors.New("injected fault")}
}

// Calls returns how many operations have been attempted so far.
func (f *FakeStore) Calls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func (f *FakeStore) trip() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := f.calls
	f.calls++
	if f.FailAt >= 0 && n == f.FailAt {
		return f.ErrFail
	}
	return nil
}

func (f *FakeStore) Get(key string) (string, bool) {
	if err := f.trip(); err != nil {
		return "", false
	}
	return f.inner.Get(key)
}

func (f *FakeStore) Set(key, value string) error {
	if err := f.trip(); err != nil {
		return err
	}
	return f.inner.Set(key, value)
}

func (f *FakeStore) Delete(key string) error {
	if err := f.trip(); err != nil {
		return err
	}
	return f.inner.Delete(key)
}
