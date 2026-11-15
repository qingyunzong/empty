package dataeng

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type downloadState uint8

const (
	stateActive downloadState = iota
	statePublishing
	statePublished
	stateCanceled
	stateFailed
)

// Download is a single tracked browser download.
type Download struct {
	coordinator *Coordinator

	mu                 sync.Mutex
	id                 string
	spec               DownloadSpec
	state              downloadState
	completionSignaled bool
	completedAt        time.Time
	artifact           Artifact
	err                error

	completeCh chan struct{}
	cancelCh   chan struct{}
	doneCh     chan struct{}
	stateCh    chan struct{}
}

// ID returns the browser download ID.
func (d *Download) ID() string {
	return d.id
}

// SuggestedName returns the sanitized suggested filename.
func (d *Download) SuggestedName() string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.spec.SuggestedName
}

// TempPath returns the absolute temporary path being watched.
func (d *Download) TempPath() string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.spec.TempPath
}

// Done is closed when the download reaches a terminal published, canceled or
// failed state.
func (d *Download) Done() <-chan struct{} {
	return d.doneCh
}

// Artifact returns the published artifact once it is available.
func (d *Download) Artifact() (Artifact, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.state != statePublished {
		return Artifact{}, false
	}
	return d.artifact, true
}

// MarkComplete records the browser completion event. It is non-blocking.
func (d *Download) MarkComplete() error {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.markCompleteLocked()
}

func (d *Download) markCompleteLocked() error {
	switch d.state {
	case stateCanceled:
		return ErrCanceled
	case statePublished:
		return ErrAlreadyPublished
	case stateFailed:
		return d.err
	case statePublishing:
		if d.completionSignaled {
			return nil
		}
		return ErrPublishing
	case stateActive:
		if d.completionSignaled {
			return nil
		}
		d.completionSignaled = true
		d.completedAt = time.Now()
		close(d.completeCh)
		d.broadcastLocked()
		return nil
	default:
		return fmt.Errorf("%w: unknown state", ErrInvalidSpec)
	}
}

func (d *Download) applyCompletion(event CompletionEvent) error {
	if event.ID != "" && event.ID != d.id {
		return fmt.Errorf("%w: %q != %q", ErrIDMismatch, event.ID, d.id)
	}

	var (
		name      string
		tempPath  string
		digest    string
		err       error
		hasUpdate bool
	)
	if event.SuggestedName != "" {
		name, err = sanitizeSuggestedName(event.SuggestedName)
		if err != nil {
			return err
		}
		hasUpdate = true
	}
	if event.TempPath != "" {
		tempPath, err = filepath.Abs(event.TempPath)
		if err != nil {
			return fmt.Errorf("%w: resolve temporary path: %v", ErrInvalidTempPath, err)
		}
		hasUpdate = true
	}
	if event.ExpectedSize < 0 {
		return fmt.Errorf("%w: %d", ErrInvalidSize, event.ExpectedSize)
	}
	if event.ExpectedSize > 0 {
		hasUpdate = true
	}
	if event.ExpectedSHA256 != "" {
		digest, err = normalizeSHA256(event.ExpectedSHA256)
		if err != nil {
			return err
		}
		hasUpdate = true
	}

	d.mu.Lock()
	defer d.mu.Unlock()

	switch d.state {
	case stateCanceled:
		return ErrCanceled
	case statePublished:
		return ErrAlreadyPublished
	case stateFailed:
		return d.err
	case statePublishing:
		// The completion event has already been accepted. Metadata arriving
		// after verification started is ignored to keep the checked snapshot
		// stable.
		return nil
	case stateActive:
		if hasUpdate {
			if name != "" {
				d.spec.SuggestedName = name
			}
			if tempPath != "" {
				d.spec.TempPath = tempPath
			}
			if event.ExpectedSize > 0 {
				d.spec.ExpectedSize = event.ExpectedSize
			}
			if digest != "" {
				d.spec.ExpectedSHA256 = digest
			}
		}
		return d.markCompleteLocked()
	default:
		return fmt.Errorf("%w: unknown state", ErrInvalidSpec)
	}
}

// Cancel stops a download before it is published. If publication is in
// progress, the committing rename either wins or observes the cancellation.
func (d *Download) Cancel() error {
	d.mu.Lock()
	defer d.mu.Unlock()

	switch d.state {
	case stateCanceled:
		return nil
	case statePublished:
		return ErrAlreadyPublished
	case stateFailed:
		return d.err
	default:
		d.state = stateCanceled
		d.err = ErrCanceled
		close(d.cancelCh)
		close(d.doneCh)
		d.broadcastLocked()
		return nil
	}
}

// Wait waits for completion, a stable file length, digest verification and
// atomic publication. Context cancellation stops the wait without publishing
// the file; a later call can resume publication.
func (d *Download) Wait(ctx context.Context) (Artifact, error) {
	if ctx == nil {
		ctx = context.Background()
	}

	for {
		d.mu.Lock()
		switch d.state {
		case statePublished:
			artifact := d.artifact
			d.mu.Unlock()
			return artifact, nil
		case stateCanceled:
			d.mu.Unlock()
			return Artifact{}, ErrCanceled
		case stateFailed:
			err := d.err
			d.mu.Unlock()
			return Artifact{}, err
		case statePublishing:
			stateCh := d.stateCh
			d.mu.Unlock()
			select {
			case <-stateCh:
				continue
			case <-ctx.Done():
				return Artifact{}, ctx.Err()
			}
		case stateActive:
			if !d.completionSignaled {
				completeCh := d.completeCh
				stateCh := d.stateCh
				d.mu.Unlock()
				select {
				case <-completeCh:
					continue
				case <-stateCh:
					continue
				case <-ctx.Done():
					return Artifact{}, ctx.Err()
				}
			}

			d.state = statePublishing
			spec := d.spec
			d.broadcastLocked()
			d.mu.Unlock()

			artifact, err := d.publish(ctx, spec)
			if err == nil {
				return artifact, nil
			}

			d.mu.Lock()
			if d.state == stateCanceled {
				d.mu.Unlock()
				return Artifact{}, ErrCanceled
			}

			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				// Verification has no visible side effects. Return the
				// download to the completed state so it can be retried.
				if d.state == statePublishing {
					d.state = stateActive
					d.broadcastLocked()
				}
				d.mu.Unlock()
				return Artifact{}, err
			}

			if errors.Is(err, ErrCanceled) {
				if d.state == statePublishing {
					d.state = stateCanceled
					d.err = ErrCanceled
					close(d.cancelCh)
					close(d.doneCh)
					d.broadcastLocked()
				}
				d.mu.Unlock()
				return Artifact{}, ErrCanceled
			}

			if d.state == statePublishing {
				d.state = stateFailed
				d.err = err
				close(d.doneCh)
				d.broadcastLocked()
			}
			d.mu.Unlock()
			return Artifact{}, err
		default:
			d.mu.Unlock()
			return Artifact{}, fmt.Errorf("%w: unknown state", ErrInvalidSpec)
		}
	}
}

func (d *Download) publish(ctx context.Context, spec DownloadSpec) (Artifact, error) {
	for {
		if err := contextError(ctx); err != nil {
			return Artifact{}, err
		}

		info, err := d.coordinator.settle(ctx, spec.TempPath, spec.ExpectedSize, d.cancelCh)
		if err != nil {
			return Artifact{}, err
		}

		digest, size, modTime, err := digestFile(ctx, spec.TempPath, d.cancelCh)
		if errors.Is(err, errFileChanged) {
			continue
		}
		if err != nil {
			return Artifact{}, err
		}

		if spec.ExpectedSize > 0 && size != spec.ExpectedSize {
			return Artifact{}, fmt.Errorf("%w: expected %d bytes, got %d", ErrSizeMismatch, spec.ExpectedSize, size)
		}
		if info.Size() != size {
			// The file changed between settle and hashing; observe it again.
			continue
		}
		if spec.ExpectedSHA256 != "" && digest != spec.ExpectedSHA256 {
			return Artifact{}, fmt.Errorf("%w: expected %s, got %s", ErrDigestMismatch, spec.ExpectedSHA256, digest)
		}

		artifact, err := d.commit(ctx, spec, digest, size, modTime)
		if errors.Is(err, errFileChanged) {
			continue
		}
		return artifact, err
	}
}

func (d *Download) commit(ctx context.Context, spec DownloadSpec, digest string, size int64, modTime time.Time) (Artifact, error) {
	c := d.coordinator

	// The coordinator lock serializes target-name allocation. Holding the
	// download lock across the check and rename makes Cancel linearizable with
	// publication: either the rename wins or the cancellation wins.
	c.mu.Lock()
	d.mu.Lock()

	unlock := func() {
		d.mu.Unlock()
		c.mu.Unlock()
	}

	if d.state == stateCanceled {
		unlock()
		return Artifact{}, ErrCanceled
	}
	if d.state != statePublishing {
		unlock()
		return Artifact{}, fmt.Errorf("%w: unexpected state", ErrInvalidSpec)
	}
	if err := contextError(ctx); err != nil {
		unlock()
		return Artifact{}, err
	}

	info, err := os.Stat(spec.TempPath)
	if err != nil {
		unlock()
		return Artifact{}, fmt.Errorf("dataeng: stat temporary file: %w", err)
	}
	if !info.Mode().IsRegular() {
		unlock()
		return Artifact{}, fmt.Errorf("%w: %s", ErrNotRegularFile, spec.TempPath)
	}
	if info.Size() != size || !info.ModTime().Equal(modTime) {
		unlock()
		return Artifact{}, errFileChanged
	}

	target, err := c.pickTargetLocked(spec.SuggestedName, spec.Overwrite)
	if err != nil {
		unlock()
		return Artifact{}, err
	}

	if err := moveIntoPlace(ctx, spec.TempPath, target, digest); err != nil {
		unlock()
		return Artifact{}, err
	}

	artifact := Artifact{
		DownloadID:    d.id,
		SuggestedName: spec.SuggestedName,
		Path:          target,
		TempPath:      spec.TempPath,
		Size:          size,
		SHA256:        digest,
		CompletedAt:   d.completedAt,
		PublishedAt:   time.Now(),
	}
	d.artifact = artifact
	d.state = statePublished
	d.err = nil
	close(d.doneCh)
	d.broadcastLocked()
	c.addArtifactLocked(artifact)
	unlock()

	return artifact, nil
}

func (d *Download) broadcastLocked() {
	close(d.stateCh)
	d.stateCh = make(chan struct{})
}

func contextError(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
		return nil
	}
}
