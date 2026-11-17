package formal

import (
	"errors"
	"io"
)

// BlockDevice is the stable-storage surface used by the group committer.
//
// WriteAt may return a short count. A short write is retried by the committer,
// but no byte is considered durable until Sync returns nil. The device may
// lose all bytes that were written after the last successful Sync when power
// is lost; that is the crash model used by Recover and by the tests.
type BlockDevice interface {
	io.ReaderAt
	io.WriterAt
	Sync() error
}

// SizeProvider is an optional interface for devices that know their capacity.
// It lets OpenGroupCommitter and Recover discover the capacity when the caller
// passes a non-positive capacity.
type SizeProvider interface {
	Size() (int64, error)
}

// ErrClosed is returned when a commit is submitted after Close.
var ErrClosed = errors.New("formal: group committer is closed")

// ErrLogFull is returned when the configured device capacity cannot hold the
// next commit record.
var ErrLogFull = errors.New("formal: log device capacity exhausted")

// ErrCorruptGroup is returned internally when a group does not validate.
// Recovery treats a corrupt trailing group as the end of the durable prefix.
var ErrCorruptGroup = errors.New("formal: corrupt commit group")

// writeFullAt writes p at off, retrying short writes. A write that reports
// zero bytes without an error is a hard short-write failure: the caller must
// not treat any part of the group as durable.
func writeFullAt(w io.WriterAt, p []byte, off int64) error {
	for len(p) > 0 {
		n, err := w.WriteAt(p, off)
		if n < 0 || n > len(p) {
			return errors.New("formal: invalid write count")
		}
		p = p[n:]
		off += int64(n)
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
	}
	return nil
}

// readFullAt is readFullAt for ReaderAt implementations.
func readFullAt(r io.ReaderAt, p []byte, off int64) error {
	for len(p) > 0 {
		n, err := r.ReadAt(p, off)
		if n < 0 || n > len(p) {
			return errors.New("formal: invalid read count")
		}
		p = p[n:]
		off += int64(n)
		if err != nil {
			if err == io.EOF && len(p) == 0 {
				return nil
			}
			return err
		}
		if n == 0 {
			return io.ErrNoProgress
		}
	}
	return nil
}
