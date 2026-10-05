package auditlog

import (
	"fmt"
	"os"
)

// Append opens path (creating it if needed) and appends one frame.
// It returns the offset at which the frame was written.
func Append(path string, seq uint64, payload []byte) (int64, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return 0, err
	}
	if _, err := f.Write(EncodeFrame(seq, payload)); err != nil {
		return 0, err
	}
	return st.Size(), f.Sync()
}

// ScanFile opens path and scans it. A missing file scans as empty.
func ScanFile(path string) (entries []Entry, validLen int64, size int64, err error) {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, 0, 0, nil
		}
		return nil, 0, 0, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, 0, 0, err
	}
	entries, validLen, err = Scan(f, st.Size())
	return entries, validLen, st.Size(), err
}

// Verify checks that path consists entirely of complete, well-checksummed
// frames. Trailing incomplete bytes (a torn tail) are reported via
// truncated=true but are not an error; corruption is.
func Verify(path string) (entries []Entry, truncated bool, err error) {
	entries, validLen, size, err := ScanFile(path)
	if err != nil {
		return nil, false, err
	}
	return entries, validLen < size, nil
}

// Recover repairs path after a crash. The ONLY modification it ever
// performs is truncating an incomplete tail frame left by a torn write.
// If a complete frame fails validation (mid-log or at the tail), the
// file is left untouched and a *CorruptError is returned.
//
// It reports whether the file was truncated and the new length.
func Recover(path string) (truncated bool, newLen int64, err error) {
	entries, validLen, size, err := ScanFile(path)
	_ = entries
	if err != nil {
		// Corruption: never modify the original file.
		return false, size, err
	}
	if validLen == size {
		return false, size, nil
	}
	if err := os.Truncate(path, validLen); err != nil {
		return false, size, fmt.Errorf("auditlog: truncate %s: %w", path, err)
	}
	return true, validLen, nil
}
