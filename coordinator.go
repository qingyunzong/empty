package dataeng

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	defaultPollInterval = 10 * time.Millisecond
	defaultStableWindow = 100 * time.Millisecond
	maxNameAttempts     = 100000
)

// Option configures a Coordinator.
type Option func(*options) error

type options struct {
	pollInterval time.Duration
	stableWindow time.Duration
}

// WithPollInterval sets how often the temporary file's length is sampled while
// waiting for a download to settle. The value must be positive.
func WithPollInterval(d time.Duration) Option {
	return func(o *options) error {
		if d <= 0 {
			return fmt.Errorf("%w: poll interval must be positive", ErrInvalidSpec)
		}
		o.pollInterval = d
		return nil
	}
}

// WithStableWindow sets how long the temporary file's length must remain
// unchanged before it is considered complete. A zero duration accepts the first
// successful stat as stable. Negative values are rejected.
func WithStableWindow(d time.Duration) Option {
	return func(o *options) error {
		if d < 0 {
			return fmt.Errorf("%w: stable window must not be negative", ErrInvalidSpec)
		}
		o.stableWindow = d
		return nil
	}
}

// DownloadSpec associates a browser download ID with the file that the browser
// is writing. ExpectedSize and ExpectedSHA256 are optional integrity checks;
// a positive ExpectedSize requires an exact file length.
type DownloadSpec struct {
	// ID is the browser's download identifier. It must be unique among the
	// downloads tracked by one Coordinator.
	ID string
	// SuggestedName is the browser-provided filename. Only its final path
	// element is used.
	SuggestedName string
	// TempPath is the file being written by the browser. It does not need to
	// exist when the download is registered.
	TempPath string
	// ExpectedSize, when positive, is the exact final file size in bytes.
	ExpectedSize int64
	// ExpectedSHA256 is an optional hexadecimal SHA-256 digest. A "sha256:"
	// prefix is accepted.
	ExpectedSHA256 string
	// Overwrite allows an existing destination file to be replaced atomically.
	// Without it, a collision-free numbered name is allocated instead.
	Overwrite bool
}

// CompletionEvent is the browser's signal that a download has finished. Its
// metadata fields are optional and refine the values supplied to Track.
type CompletionEvent struct {
	ID             string
	TempPath       string
	SuggestedName  string
	ExpectedSize   int64
	ExpectedSHA256 string
}

// Artifact is the immutable collection object published after a file has been
// verified and moved into the destination directory.
type Artifact struct {
	DownloadID    string
	SuggestedName string
	Path          string
	TempPath      string
	Size          int64
	SHA256        string
	CompletedAt   time.Time
	PublishedAt   time.Time
}

// Coordinator tracks browser downloads and publishes their verified files.
// It is safe for concurrent use.
type Coordinator struct {
	dir          string
	pollInterval time.Duration
	stableWindow time.Duration

	mu        sync.Mutex
	downloads map[string]*Download
	artifacts map[string]Artifact
	order     []string
}

// New creates a Coordinator that publishes files into destination. The
// directory is created when necessary.
func New(destination string, opts ...Option) (*Coordinator, error) {
	if strings.TrimSpace(destination) == "" {
		return nil, fmt.Errorf("%w: empty destination directory", ErrInvalidSpec)
	}

	dir, err := filepath.Abs(destination)
	if err != nil {
		return nil, fmt.Errorf("dataeng: resolve destination: %w", err)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("dataeng: create destination: %w", err)
	}
	info, err := os.Stat(dir)
	if err != nil {
		return nil, fmt.Errorf("dataeng: stat destination: %w", err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("%w: destination is not a directory", ErrInvalidSpec)
	}

	cfg := options{
		pollInterval: defaultPollInterval,
		stableWindow: defaultStableWindow,
	}
	for _, opt := range opts {
		if opt == nil {
			continue
		}
		if err := opt(&cfg); err != nil {
			return nil, err
		}
	}

	return &Coordinator{
		dir:          dir,
		pollInterval: cfg.pollInterval,
		stableWindow: cfg.stableWindow,
		downloads:    make(map[string]*Download),
		artifacts:    make(map[string]Artifact),
	}, nil
}

// NewCoordinator is an alias for New.
func NewCoordinator(destination string, opts ...Option) (*Coordinator, error) {
	return New(destination, opts...)
}

// Destination returns the absolute directory into which artifacts are
// published.
func (c *Coordinator) Destination() string {
	return c.dir
}

// Track registers a download before or after its completion event. Registering
// the same ID twice is an error.
func (c *Coordinator) Track(spec DownloadSpec) (*Download, error) {
	normalized, err := normalizeSpec(spec)
	if err != nil {
		return nil, err
	}

	d := &Download{
		coordinator: c,
		id:          normalized.ID,
		spec:        normalized,
		completeCh:  make(chan struct{}),
		cancelCh:    make(chan struct{}),
		doneCh:      make(chan struct{}),
		stateCh:     make(chan struct{}),
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	if _, exists := c.downloads[normalized.ID]; exists {
		return nil, fmt.Errorf("%w: %q", ErrDuplicateDownload, normalized.ID)
	}
	c.downloads[normalized.ID] = d
	return d, nil
}

// Register is an alias for Track.
func (c *Coordinator) Register(spec DownloadSpec) (*Download, error) {
	return c.Track(spec)
}

// Lookup returns the tracked download with the given ID.
func (c *Coordinator) Lookup(id string) (*Download, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	d, ok := c.downloads[id]
	return d, ok
}

// Wait waits for the download's completion event, settles its temporary file,
// verifies it and publishes it atomically. Wait may be called by multiple
// goroutines; they all receive the same artifact or terminal error.
func (c *Coordinator) Wait(ctx context.Context, id string) (Artifact, error) {
	d, ok := c.Lookup(id)
	if !ok {
		return Artifact{}, fmt.Errorf("%w: %q", ErrUnknownDownload, id)
	}
	return d.Wait(ctx)
}

// MarkComplete records the completion event for a download.
func (c *Coordinator) MarkComplete(id string) error {
	d, ok := c.Lookup(id)
	if !ok {
		return fmt.Errorf("%w: %q", ErrUnknownDownload, id)
	}
	return d.MarkComplete()
}

// OnComplete applies a browser completion event. Repeated events are
// idempotent as long as they do not contradict terminal state.
func (c *Coordinator) OnComplete(event CompletionEvent) error {
	if strings.TrimSpace(event.ID) == "" {
		return fmt.Errorf("%w: empty id", ErrInvalidID)
	}
	d, ok := c.Lookup(event.ID)
	if !ok {
		return fmt.Errorf("%w: %q", ErrUnknownDownload, event.ID)
	}
	return d.applyCompletion(event)
}

// Complete records the completion event and waits for publication. It is a
// convenience wrapper around MarkComplete and Wait.
func (c *Coordinator) Complete(ctx context.Context, id string) (Artifact, error) {
	d, ok := c.Lookup(id)
	if !ok {
		return Artifact{}, fmt.Errorf("%w: %q", ErrUnknownDownload, id)
	}
	// A terminal state is reported by Wait, which keeps this operation
	// idempotent after a repeated completion event.
	_ = d.MarkComplete()
	return d.Wait(ctx)
}

// Cancel cancels a download before publication and wakes any waiting callers.
// Canceling an already canceled download is a no-op. A published download
// cannot be canceled.
func (c *Coordinator) Cancel(id string) error {
	d, ok := c.Lookup(id)
	if !ok {
		return fmt.Errorf("%w: %q", ErrUnknownDownload, id)
	}
	return d.Cancel()
}

// Artifact returns a previously published artifact by download ID.
func (c *Coordinator) Artifact(id string) (Artifact, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	a, ok := c.artifacts[id]
	return a, ok
}

// Artifacts returns a snapshot of all published artifacts in publication
// order.
func (c *Coordinator) Artifacts() []Artifact {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]Artifact, 0, len(c.order))
	for _, id := range c.order {
		out = append(out, c.artifacts[id])
	}
	return out
}

func normalizeSpec(spec DownloadSpec) (DownloadSpec, error) {
	id := strings.TrimSpace(spec.ID)
	if id == "" {
		return DownloadSpec{}, fmt.Errorf("%w: empty id", ErrInvalidID)
	}

	name, err := sanitizeSuggestedName(spec.SuggestedName)
	if err != nil {
		return DownloadSpec{}, err
	}

	if strings.TrimSpace(spec.TempPath) == "" {
		return DownloadSpec{}, fmt.Errorf("%w: empty path", ErrInvalidTempPath)
	}
	tempPath, err := filepath.Abs(spec.TempPath)
	if err != nil {
		return DownloadSpec{}, fmt.Errorf("%w: resolve temporary path: %v", ErrInvalidTempPath, err)
	}

	if spec.ExpectedSize < 0 {
		return DownloadSpec{}, fmt.Errorf("%w: %d", ErrInvalidSize, spec.ExpectedSize)
	}

	digest, err := normalizeSHA256(spec.ExpectedSHA256)
	if err != nil {
		return DownloadSpec{}, err
	}

	return DownloadSpec{
		ID:             id,
		SuggestedName:  name,
		TempPath:       tempPath,
		ExpectedSize:   spec.ExpectedSize,
		ExpectedSHA256: digest,
		Overwrite:      spec.Overwrite,
	}, nil
}

func (c *Coordinator) addArtifactLocked(a Artifact) {
	if _, exists := c.artifacts[a.DownloadID]; !exists {
		c.order = append(c.order, a.DownloadID)
	}
	c.artifacts[a.DownloadID] = a
}
