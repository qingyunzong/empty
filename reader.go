package dataeng

import (
	"context"
	"fmt"
	"sort"
	"time"
)

// Snapshot is a consistent, immutable view resolved from one pointer value.
type Snapshot struct {
	Generation uint64
	ManifestID string
	ParentID   string
	CreatedAt  time.Time

	// Files is the merged logical view: later versions override earlier
	// versions with the same Path.
	Files []File

	// Batch is only the set of files added by the head manifest.
	Batch []File

	// History lists manifest digests from oldest to newest.
	History []string

	// Head is the resolved head manifest.
	Head *Manifest

	// Pointer is the pointer value the snapshot was resolved from.
	Pointer Pointer
}

// ReaderOption configures a Reader.
type ReaderOption func(*Reader)

// WithReaderDataVerification makes Open verify the contents of every visible
// data object in addition to manifest digests. ReadFile always verifies the
// bytes it returns, independently of this option.
func WithReaderDataVerification(enabled bool) ReaderOption {
	return func(r *Reader) { r.verifyData = enabled }
}

// WithParentVerification controls whether Open walks and validates the full
// manifest parent chain. It is enabled by default because a valid head
// digest alone does not prove the version history is consistent.
func WithParentVerification(enabled bool) ReaderOption {
	return func(r *Reader) { r.verifyParents = enabled }
}

// WithReaderMaxChainDepth bounds parent-chain traversal.
func WithReaderMaxChainDepth(depth int) ReaderOption {
	return func(r *Reader) {
		if depth > 0 {
			r.maxChain = depth
		}
	}
}

// Reader resolves manifests and verifies their content digests, parent links
// and (optionally) data digests.
type Reader struct {
	store         Store
	prefix        string
	publisher     *Publisher
	verifyData    bool
	verifyParents bool
	maxChain      int
}

// NewReader constructs a reader for one table prefix.
func NewReader(store Store, prefix string, opts ...ReaderOption) *Reader {
	reader := &Reader{
		store:         store,
		prefix:        cleanPrefix(prefix),
		publisher:     NewPublisher(store, prefix),
		verifyParents: true,
		maxChain:      100000,
	}
	for _, option := range opts {
		if option != nil {
			option(reader)
		}
	}
	return reader
}

// Prefix returns the cleaned table prefix.
func (r *Reader) Prefix() string {
	return r.prefix
}

// Head reads and validates the current pointer and its head manifest digest.
func (r *Reader) Head(ctx context.Context) (Pointer, error) {
	pointer, exists, _, err := r.publisher.Current(ctx)
	if err != nil {
		return Pointer{}, err
	}
	if !exists {
		return Pointer{}, ErrNoHead
	}
	return pointer, nil
}

// Manifest reads one manifest by digest and verifies both its content digest
// and its structural invariants.
func (r *Reader) Manifest(ctx context.Context, id string) (*Manifest, error) {
	return r.publisher.Manifest(ctx, id)
}

// Open resolves HEAD into a validated snapshot.
func (r *Reader) Open(ctx context.Context) (*Snapshot, error) {
	pointer, exists, _, err := r.publisher.Current(ctx)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, ErrNoHead
	}
	return r.openPointer(ctx, pointer)
}

// Load is an alias for Open.
func (r *Reader) Load(ctx context.Context) (*Snapshot, error) {
	return r.Open(ctx)
}

// Snapshot is an alias for Open.
func (r *Reader) Snapshot(ctx context.Context) (*Snapshot, error) {
	return r.Open(ctx)
}

// OpenAt resolves a specific immutable manifest digest. It remains valid
// after HEAD moves because manifests and data are never overwritten.
func (r *Reader) OpenAt(ctx context.Context, id string) (*Snapshot, error) {
	manifest, err := r.publisher.Manifest(ctx, id)
	if err != nil {
		return nil, err
	}
	pointer := Pointer{
		Format:     PointerFormat,
		Generation: manifest.Generation,
		Manifest:   id,
		Previous:   manifest.Parent,
		UpdatedAt:  manifest.CreatedAt,
		Writer:     manifest.Writer,
	}
	return r.openPointer(ctx, pointer)
}

func (r *Reader) openPointer(ctx context.Context, pointer Pointer) (*Snapshot, error) {
	manifests, err := r.loadChain(ctx, pointer)
	if err != nil {
		return nil, err
	}
	if len(manifests) == 0 {
		return nil, ErrNoHead
	}

	head := manifests[len(manifests)-1]
	history := make([]string, len(manifests))
	live := make(map[string]File)
	for i, manifest := range manifests {
		history[i] = manifest.ID()
		for _, file := range manifest.Files {
			live[file.Path] = file
		}
	}

	files := make([]File, 0, len(live))
	for _, file := range live {
		files = append(files, file)
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })

	created, err := parseOptionalTime(head.CreatedAt)
	if err != nil {
		return nil, err
	}
	snapshot := &Snapshot{
		Generation: head.Generation,
		ManifestID: pointer.Manifest,
		ParentID:   head.Parent,
		CreatedAt:  created,
		Files:      files,
		Batch:      append([]File(nil), head.Files...),
		History:    history,
		Head:       head,
		Pointer:    pointer,
	}

	if r.verifyData {
		for _, file := range files {
			if _, err := readDataFile(ctx, r.store, r.prefix, file); err != nil {
				return nil, err
			}
		}
	}
	return snapshot, nil
}

func (r *Reader) loadChain(ctx context.Context, pointer Pointer) ([]*Manifest, error) {
	if err := pointer.Validate(); err != nil {
		return nil, err
	}
	head, err := r.publisher.Manifest(ctx, pointer.Manifest)
	if err != nil {
		return nil, err
	}
	if head.Generation != pointer.Generation {
		return nil, fmt.Errorf("%w: pointer generation %d, manifest generation %d",
			ErrParentMismatch, pointer.Generation, head.Generation)
	}
	if head.Parent != pointer.Previous {
		return nil, fmt.Errorf("%w: pointer previous %q, manifest parent %q",
			ErrParentMismatch, pointer.Previous, head.Parent)
	}

	// Collect newest-to-oldest, then reverse for a stable chronological view.
	chain := []*Manifest{head}
	if !r.verifyParents {
		return chain, nil
	}

	seen := map[string]struct{}{pointer.Manifest: {}}
	parentID := head.Parent
	expectedGeneration := head.Generation
	for expectedGeneration > 1 {
		if parentID == "" {
			return nil, fmt.Errorf("%w: manifest generation %d has no parent",
				ErrParentMismatch, expectedGeneration)
		}
		if _, duplicate := seen[parentID]; duplicate {
			return nil, fmt.Errorf("%w: parent cycle at %s", ErrParentMismatch, parentID)
		}
		if len(chain) >= r.maxChain {
			return nil, fmt.Errorf("%w: parent chain exceeds %d manifests",
				ErrParentMismatch, r.maxChain)
		}
		parent, err := r.publisher.Manifest(ctx, parentID)
		if err != nil {
			return nil, err
		}
		expectedGeneration--
		if parent.Generation != expectedGeneration {
			return nil, fmt.Errorf("%w: manifest %s has generation %d, expected %d",
				ErrParentMismatch, parentID, parent.Generation, expectedGeneration)
		}
		chain = append(chain, parent)
		seen[parentID] = struct{}{}
		parentID = parent.Parent
	}
	if parentID != "" {
		return nil, fmt.Errorf("%w: chain does not begin at generation 1", ErrParentMismatch)
	}

	// Reverse to oldest-to-newest.
	for left, right := 0, len(chain)-1; left < right; left, right = left+1, right-1 {
		chain[left], chain[right] = chain[right], chain[left]
	}
	return chain, nil
}

// ReadFile reads one data object and verifies its digest and size.
func (r *Reader) ReadFile(ctx context.Context, file File) ([]byte, error) {
	return readDataFile(ctx, r.store, r.prefix, file)
}

// Read returns the bytes of the visible logical path.
func (r *Reader) Read(ctx context.Context, path string) ([]byte, error) {
	snapshot, err := r.Open(ctx)
	if err != nil {
		return nil, err
	}
	for _, file := range snapshot.Files {
		if file.Path == path {
			return r.ReadFile(ctx, file)
		}
	}
	return nil, fmt.Errorf("%w: %s", ErrPathNotFound, path)
}

// Get is an alias for Read.
func (r *Reader) Get(ctx context.Context, path string) ([]byte, error) {
	return r.Read(ctx, path)
}

// Verify checks every visible data object against its recorded digest.
func (r *Reader) Verify(ctx context.Context) error {
	snapshot, err := r.Open(ctx)
	if err != nil {
		return err
	}
	for _, file := range snapshot.Files {
		if _, err := r.ReadFile(ctx, file); err != nil {
			return err
		}
	}
	return nil
}

// History returns manifests from oldest to newest.
func (r *Reader) History(ctx context.Context) ([]*Manifest, error) {
	pointer, exists, _, err := r.publisher.Current(ctx)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, ErrNoHead
	}
	return r.loadChain(ctx, pointer)
}

func parseOptionalTime(value string) (time.Time, error) {
	if value == "" {
		return time.Time{}, nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, fmt.Errorf("%w: %v", ErrInvalidManifest, err)
	}
	return parsed, nil
}
