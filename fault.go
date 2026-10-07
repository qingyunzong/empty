package dedup

// Boundary identifies a write boundary at which a FaultVolume can
// simulate a power loss.
type Boundary int

const (
	// BoundaryAppend fires after an Append is staged.
	BoundaryAppend Boundary = iota
	// BoundaryTruncate fires after a Truncate is staged.
	BoundaryTruncate
	// BoundaryReplace fires after a Replace is staged.
	BoundaryReplace
	// BoundaryBeforeSync fires before staged changes are made durable.
	BoundaryBeforeSync
	// BoundaryAfterSync fires after staged changes became durable.
	BoundaryAfterSync
)

func (b Boundary) String() string {
	switch b {
	case BoundaryAppend:
		return "Append"
	case BoundaryTruncate:
		return "Truncate"
	case BoundaryReplace:
		return "Replace"
	case BoundaryBeforeSync:
		return "BeforeSync"
	case BoundaryAfterSync:
		return "AfterSync"
	}
	return "Unknown"
}

// FaultVolume wraps a Volume with crash injection for testing. The
// OnBoundary hook is invoked at every write boundary; panicking from
// the hook simulates a power loss at that exact point. After a
// simulated crash, call Crash to drop the staged (unflushed) state,
// then reopen the store from the same FaultVolume.
type FaultVolume struct {
	inner Volume

	// TornAppend controls how many bytes of staged appends leak into
	// durable storage on Crash, simulating a partially flushed write.
	TornAppend int

	// OnBoundary is called at each write boundary. It may panic to
	// simulate a power loss.
	OnBoundary func(Boundary)

	pending []op
}

// NewFaultVolume wraps inner with crash-injection support.
func NewFaultVolume(inner Volume) *FaultVolume { return &FaultVolume{inner: inner} }

func (f *FaultVolume) fire(b Boundary) {
	if f.OnBoundary != nil {
		f.OnBoundary(b)
	}
}

// ReadAll implements Volume.
func (f *FaultVolume) ReadAll() ([]byte, error) { return f.inner.ReadAll() }

// Append implements Volume.
func (f *FaultVolume) Append(p []byte) error {
	f.pending = append(f.pending, op{kind: opAppend, data: append([]byte(nil), p...)})
	f.fire(BoundaryAppend)
	return nil
}

// Truncate implements Volume.
func (f *FaultVolume) Truncate(size int64) error {
	f.pending = append(f.pending, op{kind: opTruncate, size: size})
	f.fire(BoundaryTruncate)
	return nil
}

// Replace implements Volume.
func (f *FaultVolume) Replace(p []byte) error {
	f.pending = append(f.pending, op{kind: opReplace, data: append([]byte(nil), p...)})
	f.fire(BoundaryReplace)
	return nil
}

// Sync implements Volume.
func (f *FaultVolume) Sync() error {
	f.fire(BoundaryBeforeSync)
	for _, o := range f.pending {
		var err error
		switch o.kind {
		case opAppend:
			err = f.inner.Append(o.data)
		case opTruncate:
			err = f.inner.Truncate(o.size)
		case opReplace:
			err = f.inner.Replace(o.data)
		}
		if err != nil {
			return err
		}
	}
	if err := f.inner.Sync(); err != nil {
		return err
	}
	f.pending = nil
	f.fire(BoundaryAfterSync)
	return nil
}

// Crash simulates the machine state after a power loss: all staged
// changes are discarded, except a torn prefix of up to TornAppend bytes
// of the staged appends, which leaks into durable storage (a partially
// flushed write). The FaultVolume itself remains usable as the "disk".
func (f *FaultVolume) Crash() error {
	if f.TornAppend > 0 && len(f.pending) > 0 {
		var tail []byte
		for _, o := range f.pending {
			if o.kind == opAppend {
				tail = append(tail, o.data...)
			}
		}
		if f.TornAppend < len(tail) {
			tail = tail[:f.TornAppend]
		}
		if len(tail) > 0 {
			if err := f.inner.Append(tail); err != nil {
				return err
			}
			if err := f.inner.Sync(); err != nil {
				return err
			}
		}
	}
	f.pending = nil
	return nil
}
