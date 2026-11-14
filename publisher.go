package dataeng

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
)

// Publisher owns the object-layout and conditional pointer protocol. It can
// be used directly by another manifest producer that already has File
// descriptors and wants this package's atomic publication semantics.
type Publisher struct {
	store  Store
	prefix string
}

// ManifestPublisher is the low-level three-step protocol implemented by
// Publisher. A higher-level manifest publishing library can depend on this
// interface and receive a Publisher directly.
type ManifestPublisher interface {
	Current(ctx context.Context) (Pointer, bool, string, error)
	PutManifest(ctx context.Context, manifest *Manifest) (string, error)
	UpdateHead(ctx context.Context, pointer Pointer, expected string) error
}

var _ ManifestPublisher = (*Publisher)(nil)

// NewPublisher returns a publisher rooted at prefix. An empty prefix uses
// data/, metadata/manifests/ and metadata/HEAD at the bucket root.
func NewPublisher(store Store, prefix string) *Publisher {
	return &Publisher{store: store, prefix: cleanPrefix(prefix)}
}

// Prefix returns the cleaned table prefix.
func (p *Publisher) Prefix() string {
	return p.prefix
}

// Store returns the underlying object store.
func (p *Publisher) Store() Store {
	return p.store
}

// HeadKey returns the absolute object key of the single mutable pointer.
func (p *Publisher) HeadKey() string {
	return headKey(p.prefix)
}

// ReadPointer reads and structurally validates HEAD. The boolean is false
// when no pointer has ever been published.
func (p *Publisher) ReadPointer(ctx context.Context) (Pointer, []byte, bool, error) {
	raw, err := p.store.Get(ctx, p.HeadKey())
	if IsNotFound(err) {
		return Pointer{}, nil, false, nil
	}
	if err != nil {
		return Pointer{}, nil, false, err
	}
	var pointer Pointer
	if err := json.Unmarshal(raw, &pointer); err != nil {
		return Pointer{}, nil, false, fmt.Errorf("%w: %v", ErrInvalidPointer, err)
	}
	if err := pointer.Validate(); err != nil {
		return Pointer{}, nil, false, err
	}
	return pointer, raw, true, nil
}

// Current returns the current head pointer, whether it exists, and the token
// of its exact bytes for a conditional write. The head manifest is read and
// its digest, generation and parent are checked against the pointer before it
// is accepted as a commit base.
func (p *Publisher) Current(ctx context.Context) (Pointer, bool, string, error) {
	pointer, raw, exists, err := p.ReadPointer(ctx)
	if err != nil || !exists {
		return pointer, exists, "", err
	}

	manifest, err := p.Manifest(ctx, pointer.Manifest)
	if err != nil {
		return Pointer{}, false, "", err
	}
	if manifest.Generation != pointer.Generation {
		return Pointer{}, false, "", fmt.Errorf(
			"%w: pointer generation %d, manifest generation %d",
			ErrParentMismatch, pointer.Generation, manifest.Generation)
	}
	if manifest.Parent != pointer.Previous {
		return Pointer{}, false, "", fmt.Errorf(
			"%w: pointer previous %q, manifest parent %q",
			ErrParentMismatch, pointer.Previous, manifest.Parent)
	}
	return pointer, true, objectToken(raw), nil
}

// Manifest reads, digest-checks and validates one immutable manifest.
func (p *Publisher) Manifest(ctx context.Context, id string) (*Manifest, error) {
	key, err := manifestKey(p.prefix, id)
	if err != nil {
		return nil, err
	}
	raw, err := p.store.Get(ctx, key)
	if err != nil {
		if IsNotFound(err) {
			return nil, fmt.Errorf("%w: manifest %s", ErrObjectNotFound, id)
		}
		return nil, err
	}
	actual := Digest(raw)
	if actual != id {
		return nil, fmt.Errorf("%w: manifest %s has digest %s", ErrDigestMismatch, id, actual)
	}
	var manifest Manifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return nil, fmt.Errorf("%w: manifest %s: %v", ErrInvalidManifest, id, err)
	}
	if err := manifest.Validate(); err != nil {
		return nil, fmt.Errorf("manifest %s: %w", id, err)
	}
	if manifest.ID() != id {
		return nil, fmt.Errorf("%w: manifest canonical digest differs from %s", ErrDigestMismatch, id)
	}
	return &manifest, nil
}

// PutManifest writes an immutable manifest and returns its content digest.
// If the object already exists, its bytes are verified rather than replaced.
func (p *Publisher) PutManifest(ctx context.Context, manifest *Manifest) (string, error) {
	if err := manifest.Validate(); err != nil {
		return "", err
	}
	raw, err := manifest.Bytes()
	if err != nil {
		return "", err
	}
	id := Digest(raw)
	key, err := manifestKey(p.prefix, id)
	if err != nil {
		return "", err
	}
	if err := putImmutable(ctx, p.store, key, raw); err != nil {
		return "", err
	}
	return id, nil
}

// UpdateHead conditionally swaps HEAD from the bytes identified by expected
// to pointer. expected is the token returned by Current; "" means HEAD must
// not exist.
func (p *Publisher) UpdateHead(ctx context.Context, pointer Pointer, expected string) error {
	if err := pointer.Validate(); err != nil {
		return err
	}
	raw, err := pointer.Bytes()
	if err != nil {
		return err
	}
	return putIfMatch(ctx, p.store, p.HeadKey(), raw, expected)
}

// Publish writes manifest and then conditionally swaps HEAD. It first checks
// that expected still identifies the current head and that manifest is the
// immediate child of that head. On ErrConflict the caller should re-read
// Current and submit a manifest with the winning parent.
func (p *Publisher) Publish(ctx context.Context, manifest *Manifest, expected string) (Pointer, error) {
	current, exists, token, err := p.Current(ctx)
	if err != nil {
		return Pointer{}, err
	}
	if token != expected {
		return Pointer{}, fmt.Errorf("%w: HEAD changed before publish", ErrConflict)
	}
	if exists {
		if manifest.Generation != current.Generation+1 || manifest.Parent != current.Manifest {
			return Pointer{}, fmt.Errorf(
				"%w: manifest generation %d parent %q is not a child of generation %d manifest %q",
				ErrParentMismatch, manifest.Generation, manifest.Parent,
				current.Generation, current.Manifest)
		}
	} else if manifest.Generation != 1 || manifest.Parent != "" {
		return Pointer{}, fmt.Errorf(
			"%w: first manifest must be generation 1 without a parent",
			ErrParentMismatch)
	}

	id, err := p.PutManifest(ctx, manifest)
	if err != nil {
		return Pointer{}, err
	}
	pointer := Pointer{
		Format:     PointerFormat,
		Generation: manifest.Generation,
		Manifest:   id,
		Previous:   manifest.Parent,
		UpdatedAt:  manifest.CreatedAt,
		Writer:     manifest.Writer,
	}
	if err := p.UpdateHead(ctx, pointer, expected); err != nil {
		return Pointer{}, err
	}
	return pointer, nil
}

func putImmutable(ctx context.Context, store Store, key string, data []byte) error {
	expected := objectToken(data)

	if conditional, ok := store.(ConditionalStore); ok {
		err := conditional.PutIfMatch(ctx, key, data, "")
		if err == nil {
			return nil
		}
		if !errors.Is(err, ErrConflict) {
			return err
		}
		existing, getErr := store.Get(ctx, key)
		if getErr != nil {
			return getErr
		}
		if objectToken(existing) != expected {
			return fmt.Errorf("%w: immutable object %s already has different content", ErrCorrupt, key)
		}
		return nil
	}

	lock := keyedLock(key)
	lock.Lock()
	defer lock.Unlock()

	existing, err := store.Get(ctx, key)
	switch {
	case err == nil:
		if objectToken(existing) != expected {
			return fmt.Errorf("%w: immutable object %s already has different content", ErrCorrupt, key)
		}
		return nil
	case IsNotFound(err):
		return store.Put(ctx, key, data)
	default:
		return err
	}
}
