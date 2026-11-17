package formal

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"slices"
	"sync"
)

var (
	ErrUnknownUpload    = errors.New("unknown upload")
	ErrUploadClosed     = errors.New("upload already completed")
	ErrDigestMismatch   = errors.New("part digest mismatch")
	ErrInvalidRange     = errors.New("invalid part range")
	ErrStaleGeneration  = errors.New("stale part generation")
	ErrManifestMismatch = errors.New("manifest does not match stored parts")
	ErrManifestInvalid  = errors.New("manifest ranges invalid")
)

// PartSpec describes an uploaded part: its number, byte offset within the
// final object, and the hex SHA-256 digest of its payload.
type PartSpec struct {
	Number int
	Offset int64
	Digest string
}

// PartRef is a manifest entry presented at Complete time. It pins a part by
// number and generation so that concurrent overwrites invalidate stale
// complete requests.
type PartRef struct {
	Number int
	Gen    uint64
	Offset int64
	Size   int64
	Digest string
}

// DigestOf returns the hex SHA-256 digest of data.
func DigestOf(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

type part struct {
	gen    uint64
	offset int64
	digest string
	data   []byte
}

type upload struct {
	key      string
	parts    map[int]*part
	closed   bool
	manifest []PartRef
	version  uint64
}

type committedObject struct {
	version  uint64
	manifest []PartRef
	data     []byte
}

// Gateway is the multipart commit component called by the upload service.
// All methods are safe for concurrent use; each is atomic, so a concurrent
// reader always observes exactly one committed version of an object.
type Gateway struct {
	mu      sync.Mutex
	nextID  uint64
	version uint64
	uploads map[string]*upload
	objects map[string]*committedObject
}

func NewGateway() *Gateway {
	return &Gateway{
		uploads: make(map[string]*upload),
		objects: make(map[string]*committedObject),
	}
}

// BeginUpload opens a multipart upload session for key.
func (g *Gateway) BeginUpload(key string) string {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.nextID++
	id := "u" + hex.EncodeToString([]byte{byte(g.nextID >> 24), byte(g.nextID >> 16), byte(g.nextID >> 8), byte(g.nextID)})
	g.uploads[id] = &upload{key: key, parts: make(map[int]*part)}
	return id
}

// PutPart stores one part of an upload. The digest must match the payload
// and the offset must be non-negative. Re-uploading a part with the same
// digest and offset is idempotent and returns the existing generation.
// Overwriting a part with different content bumps its generation, which
// invalidates any previously assembled manifest for a complete request.
func (g *Gateway) PutPart(uploadID string, spec PartSpec, data []byte) (uint64, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	up, ok := g.uploads[uploadID]
	if !ok {
		return 0, ErrUnknownUpload
	}
	if up.closed {
		return 0, ErrUploadClosed
	}
	if spec.Number <= 0 || spec.Offset < 0 {
		return 0, ErrInvalidRange
	}
	if DigestOf(data) != spec.Digest {
		return 0, ErrDigestMismatch
	}
	if p, ok := up.parts[spec.Number]; ok {
		if p.digest == spec.Digest && p.offset == spec.Offset {
			return p.gen, nil
		}
		p.gen++
		p.offset = spec.Offset
		p.digest = spec.Digest
		p.data = slices.Clone(data)
		return p.gen, nil
	}
	up.parts[spec.Number] = &part{gen: 1, offset: spec.Offset, digest: spec.Digest, data: slices.Clone(data)}
	return 1, nil
}

// Complete validates the final manifest against the stored parts and, on
// success, atomically publishes the concatenated object. The manifest must
// cover a contiguous byte range starting at 0, and every entry must match
// the stored part's generation, digest, offset and size; a stale generation
// (the part was overwritten after the manifest was assembled) fails with
// ErrStaleGeneration. Completing an already-completed upload with the same
// manifest is idempotent; a different manifest fails with ErrUploadClosed.
// Concurrent completes are serialized by the gateway lock, so the visible
// object is always exactly the concatenation of one committed manifest.
func (g *Gateway) Complete(uploadID string, manifest []PartRef) (uint64, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	up, ok := g.uploads[uploadID]
	if !ok {
		return 0, ErrUnknownUpload
	}
	if up.closed {
		if slices.Equal(up.manifest, manifest) {
			return up.version, nil
		}
		return 0, ErrUploadClosed
	}
	if err := validateManifest(manifest); err != nil {
		return 0, err
	}
	for _, ref := range manifest {
		p, ok := up.parts[ref.Number]
		if !ok {
			return 0, ErrManifestMismatch
		}
		if p.gen != ref.Gen {
			return 0, ErrStaleGeneration
		}
		if p.digest != ref.Digest || p.offset != ref.Offset || int64(len(p.data)) != ref.Size {
			return 0, ErrManifestMismatch
		}
	}
	var data []byte
	for _, ref := range manifest {
		data = append(data, up.parts[ref.Number].data...)
	}
	g.version++
	g.objects[up.key] = &committedObject{
		version:  g.version,
		manifest: slices.Clone(manifest),
		data:     data,
	}
	up.closed = true
	up.manifest = slices.Clone(manifest)
	up.version = g.version
	return g.version, nil
}

// GetObject returns an atomic snapshot of the visible object for key: the
// exact concatenation of the parts of one committed manifest, together with
// its version.
func (g *Gateway) GetObject(key string) ([]byte, uint64, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	obj, ok := g.objects[key]
	if !ok {
		return nil, 0, false
	}
	return slices.Clone(obj.data), obj.version, true
}

func validateManifest(manifest []PartRef) error {
	if len(manifest) == 0 {
		return ErrManifestInvalid
	}
	seen := make(map[int]bool, len(manifest))
	var next int64
	for _, ref := range manifest {
		if ref.Number <= 0 || ref.Size <= 0 || ref.Offset != next || seen[ref.Number] {
			return ErrManifestInvalid
		}
		seen[ref.Number] = true
		next += ref.Size
	}
	return nil
}
