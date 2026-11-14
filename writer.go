package dataeng

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"
)

// Input is one logical file in an atomic batch.
type Input struct {
	Path string
	Data []byte
}

// Version describes the manifest published by a successful commit.
type Version struct {
	Generation uint64
	Manifest   string
	Parent     string
	Files      []File
	CreatedAt  time.Time
	Writer     string
	Pointer    Pointer
}

// WriterOption configures a Writer.
type WriterOption func(*Writer)

// WithWriterID records a human-readable writer identity in manifests and
// pointers. It does not participate in conflict arbitration.
func WithWriterID(id string) WriterOption {
	return func(w *Writer) { w.writerID = id }
}

// WithMaxAttempts sets the maximum number of conditional-head attempts.
// Values below one are treated as one.
func WithMaxAttempts(n int) WriterOption {
	return func(w *Writer) { w.maxAttempts = n }
}

// WithClock injects the clock used for manifest timestamps.
func WithClock(clock func() time.Time) WriterOption {
	return func(w *Writer) {
		if clock != nil {
			w.now = clock
		}
	}
}

// WithDataVerification controls whether uploaded objects are read back and
// digest-checked. It is enabled by default.
func WithDataVerification(enabled bool) WriterOption {
	return func(w *Writer) { w.verifyData = enabled }
}

// Writer stages immutable data objects and publishes them as one manifest
// batch. A Writer is safe for concurrent use.
type Writer struct {
	store       Store
	prefix      string
	publisher   *Publisher
	writerID    string
	maxAttempts int
	now         func() time.Time
	verifyData  bool

	mu      sync.Mutex
	pending []File
	byPath  map[string]struct{}
}

// NewWriter constructs a writer for one table prefix.
func NewWriter(store Store, prefix string, opts ...WriterOption) *Writer {
	writer := &Writer{
		store:       store,
		prefix:      cleanPrefix(prefix),
		publisher:   NewPublisher(store, prefix),
		maxAttempts: 16,
		now:         time.Now,
		verifyData:  true,
		byPath:      make(map[string]struct{}),
	}
	for _, option := range opts {
		if option != nil {
			option(writer)
		}
	}
	if writer.maxAttempts < 1 {
		writer.maxAttempts = 1
	}
	return writer
}

// Prefix returns the cleaned table prefix.
func (w *Writer) Prefix() string {
	return w.prefix
}

// Add uploads data and stages it for the next Commit.
func (w *Writer) Add(ctx context.Context, path string, data []byte) (File, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !validLogicalPath(path) {
		return File{}, fmt.Errorf("%w: invalid logical path %q", ErrInvalidManifest, path)
	}
	if _, exists := w.byPath[path]; exists {
		return File{}, fmt.Errorf("%w: %s", ErrDuplicatePath, path)
	}
	file, err := w.Upload(ctx, path, data)
	if err != nil {
		return File{}, err
	}
	w.pending = append(w.pending, file)
	w.byPath[file.Path] = struct{}{}
	return file, nil
}

// AddReader reads r, uploads it and stages it for the next Commit.
func (w *Writer) AddReader(ctx context.Context, path string, r io.Reader) (File, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !validLogicalPath(path) {
		return File{}, fmt.Errorf("%w: invalid logical path %q", ErrInvalidManifest, path)
	}
	if _, exists := w.byPath[path]; exists {
		return File{}, fmt.Errorf("%w: %s", ErrDuplicatePath, path)
	}
	if r == nil {
		return File{}, fmt.Errorf("dataeng: nil reader")
	}
	data, err := io.ReadAll(r)
	if err != nil {
		return File{}, err
	}
	file, err := w.Upload(ctx, path, data)
	if err != nil {
		return File{}, err
	}
	w.pending = append(w.pending, file)
	w.byPath[file.Path] = struct{}{}
	return file, nil
}

// Append is an alias for Add.
func (w *Writer) Append(ctx context.Context, path string, data []byte) (File, error) {
	return w.Add(ctx, path, data)
}

// Put is an alias for Add. It stages the file; it does not publish HEAD.
func (w *Writer) Put(ctx context.Context, path string, data []byte) (File, error) {
	return w.Add(ctx, path, data)
}

// Stage is an alias for Add.
func (w *Writer) Stage(ctx context.Context, path string, data []byte) (File, error) {
	return w.Add(ctx, path, data)
}

// Pending returns a copy of the currently staged files.
func (w *Writer) Pending() []File {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]File(nil), w.pending...)
}

// Abort discards staged files. Already uploaded immutable objects remain in
// the store as unreferenced data.
func (w *Writer) Abort() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.pending = nil
	w.byPath = make(map[string]struct{})
}

// Commit publishes all staged files as one atomically visible manifest. On
// conflict it re-reads the winning head and rebuilds the manifest with that
// head as its parent, retrying up to the configured attempt limit.
func (w *Writer) Commit(ctx context.Context) (Version, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.pending) == 0 {
		return Version{}, ErrEmptyBatch
	}
	files := append([]File(nil), w.pending...)
	version, err := w.publish(ctx, files)
	if err != nil {
		return Version{}, err
	}
	w.pending = nil
	w.byPath = make(map[string]struct{})
	return version, nil
}

// WriteBatch uploads and publishes inputs as one atomic batch. It does not
// include previously staged files.
func (w *Writer) WriteBatch(ctx context.Context, inputs []Input) (Version, error) {
	if len(inputs) == 0 {
		return Version{}, ErrEmptyBatch
	}
	seen := make(map[string]struct{}, len(inputs))
	files := make([]File, 0, len(inputs))
	for _, input := range inputs {
		if _, exists := seen[input.Path]; exists {
			return Version{}, fmt.Errorf("%w: %s", ErrDuplicatePath, input.Path)
		}
		seen[input.Path] = struct{}{}
		file, err := w.Upload(ctx, input.Path, input.Data)
		if err != nil {
			return Version{}, err
		}
		files = append(files, file)
	}
	return w.publish(ctx, files)
}

// Publish is an alias for WriteBatch.
func (w *Writer) Publish(ctx context.Context, inputs []Input) (Version, error) {
	return w.WriteBatch(ctx, inputs)
}

// PublishFiles publishes descriptors that are already resident in the store.
// This is the integration point for another manifest producer: it may upload
// content-addressed objects itself, then hand the descriptors here for an
// atomic HEAD swap. By default each object is read back and digest-checked.
func (w *Writer) PublishFiles(ctx context.Context, files []File) (Version, error) {
	if len(files) == 0 {
		return Version{}, ErrEmptyBatch
	}
	files = append([]File(nil), files...)
	seen := make(map[string]struct{}, len(files))
	for i := range files {
		if files[i].Object == "" {
			object, err := DataObjectKey(files[i].Digest)
			if err != nil {
				return Version{}, err
			}
			files[i].Object = object
		}
		if err := validateFile(&files[i]); err != nil {
			return Version{}, err
		}
		if _, exists := seen[files[i].Path]; exists {
			return Version{}, fmt.Errorf("%w: %s", ErrDuplicatePath, files[i].Path)
		}
		seen[files[i].Path] = struct{}{}
		if w.verifyData {
			if _, err := readDataFile(ctx, w.store, w.prefix, files[i]); err != nil {
				return Version{}, err
			}
		}
	}
	return w.publish(ctx, files)
}

// PublishManifest is an alias for PublishFiles.
func (w *Writer) PublishManifest(ctx context.Context, files []File) (Version, error) {
	return w.PublishFiles(ctx, files)
}

func (w *Writer) publish(ctx context.Context, files []File) (Version, error) {
	if len(files) == 0 {
		return Version{}, ErrEmptyBatch
	}
	files = normalizeFiles(files)
	var lastErr error

	for attempt := 1; attempt <= w.maxAttempts; attempt++ {
		head, exists, token, err := w.publisher.Current(ctx)
		if err != nil {
			return Version{}, err
		}

		generation := uint64(1)
		parent := ""
		if exists {
			generation = head.Generation + 1
			parent = head.Manifest
		}
		created := w.now().UTC()
		manifest := &Manifest{
			Format:     ManifestFormat,
			Generation: generation,
			Parent:     parent,
			CreatedAt:  created.Format(time.RFC3339Nano),
			Writer:     w.writerID,
			Files:      append([]File(nil), files...),
		}

		pointer, err := w.publisher.Publish(ctx, manifest, token)
		if err == nil {
			return Version{
				Generation: pointer.Generation,
				Manifest:   pointer.Manifest,
				Parent:     pointer.Previous,
				Files:      append([]File(nil), files...),
				CreatedAt:  created,
				Writer:     w.writerID,
				Pointer:    pointer,
			}, nil
		}
		if !errors.Is(err, ErrConflict) {
			return Version{}, err
		}
		lastErr = err
	}

	return Version{}, fmt.Errorf("%w after %d attempts: %v", ErrConflict, w.maxAttempts, lastErr)
}
