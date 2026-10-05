package backupupload

// Op identifies an I/O operation that can be fault-injected.
type Op int

const (
	OpWrite Op = iota
	OpSync
	OpRename
)

func (o Op) String() string {
	switch o {
	case OpWrite:
		return "write"
	case OpSync:
		return "sync"
	case OpRename:
		return "rename"
	}
	return "unknown"
}

// FaultInjector is consulted before every faultable I/O operation.
// Returning a non-nil error makes the operation fail as if the
// underlying storage had failed. A nil FaultInjector disables injection.
type FaultInjector interface {
	// Err is called before each operation. It may return an error to
	// simulate a failure of that single operation.
	Err(op Op) error
}

// FaultFunc adapts a function to FaultInjector.
type FaultFunc func(op Op) error

func (f FaultFunc) Err(op Op) error { return f(op) }
