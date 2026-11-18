package formal

import "fmt"

// CrashPoint names a durable or visibility boundary at which a test can inject
// a process failure. The normal operation order is:
//
//	begin log -> prepare log -> commit log -> committed view
//	          -> sink apply -> acknowledgement log
//
// A crash before CrashAfterCommitLog cannot make records visible. A crash after
// it leaves a committed transaction that recovery completes.
type CrashPoint uint8

const (
	CrashAfterBeginLog CrashPoint = iota + 1
	CrashAfterPrepareLog
	CrashAfterCommitLog
	CrashAfterCommitVisible
	CrashAfterSinkApply
	CrashAfterAckLog
	CrashAfterAbortLog
)

// String returns the stable crash-point name used in test names and errors.
func (p CrashPoint) String() string {
	switch p {
	case CrashAfterBeginLog:
		return "after-begin-log"
	case CrashAfterPrepareLog:
		return "after-prepare-log"
	case CrashAfterCommitLog:
		return "after-commit-log"
	case CrashAfterCommitVisible:
		return "after-commit-visible"
	case CrashAfterSinkApply:
		return "after-sink-apply"
	case CrashAfterAckLog:
		return "after-ack-log"
	case CrashAfterAbortLog:
		return "after-abort-log"
	default:
		return fmt.Sprintf("crash-point(%d)", uint8(p))
	}
}

// CheckpointFunc may return ErrCrash (or any error) to fail the coordinator at
// the named boundary. It is called while the coordinator lock is held, so it
// must not call back into the same Coordinator.
type CheckpointFunc func(CrashPoint) error

// AllCrashPoints returns every crash boundary in protocol order. Callers get a
// fresh slice that they may modify.
func AllCrashPoints() []CrashPoint {
	return []CrashPoint{
		CrashAfterBeginLog,
		CrashAfterPrepareLog,
		CrashAfterCommitLog,
		CrashAfterCommitVisible,
		CrashAfterSinkApply,
		CrashAfterAckLog,
		CrashAfterAbortLog,
	}
}
