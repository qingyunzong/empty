package formal

import "errors"

var (
	// ErrInvalidState reports an operation that is not legal in the current
	// coordinator state.
	ErrInvalidState = errors.New("formal: invalid coordinator state")

	// ErrCanceled reports that the build was canceled, either explicitly via
	// Cancel or because the caller's context expired.
	ErrCanceled = errors.New("formal: build canceled")

	// ErrIndexNotEmpty reports that Scan was given an index that already
	// contains entries. A fresh build needs an empty index.
	ErrIndexNotEmpty = errors.New("formal: index is not empty")

	// ErrStaleCertificate reports that the change log advanced after the
	// certificate was issued. The caller must Seal again to cover the new
	// commits before switching visibility.
	ErrStaleCertificate = errors.New("formal: certificate is stale")

	// ErrInvalidCertificate reports a certificate not issued by this
	// coordinator, or one that does not describe its current build.
	ErrInvalidCertificate = errors.New("formal: invalid certificate")

	// ErrWatermarkRegression reports a log high watermark that moved backwards.
	ErrWatermarkRegression = errors.New("formal: watermark regression")

	// ErrFutureWatermark reports a request for a watermark beyond the log's
	// committed high watermark.
	ErrFutureWatermark = errors.New("formal: watermark is in the future")

	// ErrLogOrder reports out-of-order commits in a page. Duplicate records are
	// allowed; decreasing sequence numbers are not.
	ErrLogOrder = errors.New("formal: change log is not ordered")

	// ErrLogBeyondBarrier reports a log reader returning a commit beyond the
	// requested barrier.
	ErrLogBeyondBarrier = errors.New("formal: commit beyond requested barrier")

	// ErrLogStalled reports that a log reader returned Done=false but made no
	// progress, so the drain cannot terminate safely.
	ErrLogStalled = errors.New("formal: change log made no progress")

	// ErrInvalidCommit reports a malformed commit record.
	ErrInvalidCommit = errors.New("formal: invalid commit")

	// ErrTxnDone reports an operation on a committed or rolled-back
	// transaction.
	ErrTxnDone = errors.New("formal: transaction is already finished")

	// ErrSnapshotDuplicate reports a snapshot that visited the same key twice.
	// A valid snapshot must contain each key exactly once.
	ErrSnapshotDuplicate = errors.New("formal: snapshot visited duplicate key")

	// ErrVerification reports that an index did not match the authoritative
	// table state at the audited watermark.
	ErrVerification = errors.New("formal: index verification failed")

	// ErrNoAuditor reports that a coordinator was created without a coverage
	// auditor. Visibility cannot be granted without a table-vs-index proof.
	ErrNoAuditor = errors.New("formal: coverage auditor is required")
)

func canceledError(cause error) error {
	if cause == nil {
		cause = ErrCanceled
	}
	return errors.Join(ErrCanceled, cause)
}
