package quotadl

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// Source provides the bytes for one download. The declared length may
// differ from the number of bytes the reader actually yields; the
// downloader accounts for the difference.
type Source interface {
	Open(ctx context.Context) (r io.ReadCloser, declaredLen int64, err error)
}

// Downloader writes downloads into a directory while accounting disk
// usage against a Quota via leases.
type Downloader struct {
	q   *Quota
	dir string

	// Rename commits a staged file to its final name. Replaceable in
	// tests to inject commit failures. Defaults to os.Rename.
	Rename func(oldpath, newpath string) error
}

// NewDownloader returns a Downloader writing into dir, accounting
// against q. The directory is created if needed.
func NewDownloader(q *Quota, dir string) (*Downloader, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return &Downloader{q: q, dir: dir, Rename: os.Rename}, nil
}

const copyChunk = 32 * 1024

// Download stages src into a temporary file and commits it to name.
//
// The declared length is reserved up front. If the source delivers
// fewer bytes (short write), the surplus is refunded at commit. If it
// delivers more, the extra is reserved on the fly or the download
// fails with ErrQuotaExceeded. Cancellation, copy errors and commit
// failures all release the reservation in full.
func (d *Downloader) Download(ctx context.Context, name string, src Source) (written int64, err error) {
	r, declared, err := src.Open(ctx)
	if err != nil {
		return 0, fmt.Errorf("quotadl: open source: %w", err)
	}
	defer r.Close()
	if declared < 0 {
		return 0, fmt.Errorf("quotadl: negative declared length %d", declared)
	}

	lease, err := d.q.Reserve(declared)
	if err != nil {
		return 0, err
	}
	committed := false
	defer func() {
		if !committed {
			lease.Release()
		}
	}()

	tmp, err := os.CreateTemp(d.dir, ".staging-*")
	if err != nil {
		return 0, err
	}
	tmpName := tmp.Name()
	defer func() {
		if !committed {
			tmp.Close()
			os.Remove(tmpName)
		}
	}()

	buf := make([]byte, copyChunk)
	for {
		if err := ctx.Err(); err != nil {
			return written, err
		}
		n, readErr := r.Read(buf)
		if n > 0 {
			// The source may deliver more than declared: reserve the
			// overflow before writing it.
			if overflow := written + int64(n) - declared; overflow > 0 {
				if err := lease.extend(overflow); err != nil {
					return written, err
				}
				declared += overflow
			}
			wn, werr := tmp.Write(buf[:n])
			written += int64(wn)
			if werr != nil {
				return written, fmt.Errorf("quotadl: write: %w", werr)
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return written, fmt.Errorf("quotadl: read: %w", readErr)
		}
	}
	if err := tmp.Close(); err != nil {
		return written, fmt.Errorf("quotadl: close: %w", err)
	}

	final := filepath.Join(d.dir, name)
	if err := d.Rename(tmpName, final); err != nil {
		return written, fmt.Errorf("quotadl: commit: %w", err)
	}
	if err := lease.Commit(written); err != nil {
		return written, err
	}
	committed = true
	return written, nil
}

// Delete removes a committed download and frees its used quota.
func (d *Downloader) Delete(name string) error {
	final := filepath.Join(d.dir, name)
	info, err := os.Stat(final)
	if err != nil {
		return err
	}
	if err := os.Remove(final); err != nil {
		return err
	}
	d.q.Free(info.Size())
	return nil
}
