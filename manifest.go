package dataeng

import (
	"encoding/json"
	"fmt"
	"sort"
	"time"
)

const (
	// ManifestFormat is the on-object format identifier for manifests.
	ManifestFormat = "dataeng.manifest.v1"

	// PointerFormat is the on-object format identifier for HEAD.
	PointerFormat = "dataeng.pointer.v1"
)

// File describes one immutable data object referenced by a manifest.
//
// Path is the logical name visible to readers. Object is the key of the
// immutable data object relative to the table prefix. Digest is the sha256
// digest of the object bytes and Size is their exact length.
type File struct {
	Path   string `json:"path"`
	Object string `json:"object"`
	Digest string `json:"digest"`
	Size   int64  `json:"size"`
}

// Entry is an alias for File.
type Entry = File

// Manifest is one immutable version of a table. Files is the batch added by
// this version. Parent is the manifest digest of the immediately preceding
// version; it is empty only for generation 1.
//
// A manifest's identity is the sha256 digest of its canonical JSON
// representation. Manifests are therefore content-addressed and immutable.
type Manifest struct {
	Format     string `json:"format"`
	Generation uint64 `json:"generation"`
	Parent     string `json:"parent,omitempty"`
	CreatedAt  string `json:"created_at"`
	Writer     string `json:"writer,omitempty"`
	Files      []File `json:"files"`
}

// Bytes returns the canonical JSON representation of the manifest.
func (m *Manifest) Bytes() ([]byte, error) {
	if m == nil {
		return nil, fmt.Errorf("%w: nil manifest", ErrInvalidManifest)
	}
	return json.Marshal(m)
}

// ID returns the content digest that identifies the manifest.
func (m *Manifest) ID() string {
	data, err := m.Bytes()
	if err != nil {
		return ""
	}
	return Digest(data)
}

// Validate checks the manifest's structural invariants. It does not read
// any objects.
func (m *Manifest) Validate() error {
	if m == nil {
		return fmt.Errorf("%w: nil manifest", ErrInvalidManifest)
	}
	if m.Format != ManifestFormat {
		return fmt.Errorf("%w: unsupported format %q", ErrInvalidManifest, m.Format)
	}
	if m.Generation == 0 {
		return fmt.Errorf("%w: generation must be at least 1", ErrInvalidManifest)
	}
	if m.Generation == 1 {
		if m.Parent != "" {
			return fmt.Errorf("%w: generation 1 must not have a parent", ErrInvalidManifest)
		}
	} else if !validDigest(m.Parent) {
		return fmt.Errorf("%w: invalid parent %q", ErrInvalidManifest, m.Parent)
	}
	if m.CreatedAt != "" {
		if _, err := time.Parse(time.RFC3339Nano, m.CreatedAt); err != nil {
			return fmt.Errorf("%w: invalid created_at %q", ErrInvalidManifest, m.CreatedAt)
		}
	}

	seen := make(map[string]struct{}, len(m.Files))
	for i := range m.Files {
		file := &m.Files[i]
		if err := validateFile(file); err != nil {
			return fmt.Errorf("%w: file %q: %v", ErrInvalidManifest, file.Path, err)
		}
		if _, ok := seen[file.Path]; ok {
			return fmt.Errorf("%w: %w: %s", ErrInvalidManifest, ErrDuplicatePath, file.Path)
		}
		seen[file.Path] = struct{}{}
	}
	return nil
}

func validateFile(file *File) error {
	if file == nil {
		return fmt.Errorf("%w: nil file", ErrInvalidManifest)
	}
	if !validLogicalPath(file.Path) {
		return fmt.Errorf("%w: invalid logical path %q", ErrInvalidManifest, file.Path)
	}
	if !validDigest(file.Digest) {
		return fmt.Errorf("%w: invalid data digest %q", ErrInvalidManifest, file.Digest)
	}
	if !validObjectKey(file.Object) {
		return fmt.Errorf("%w: invalid object key %q", ErrInvalidManifest, file.Object)
	}
	if file.Size < 0 {
		return fmt.Errorf("%w: negative size", ErrInvalidManifest)
	}
	return nil
}

func normalizeFiles(files []File) []File {
	out := append([]File(nil), files...)
	sort.Slice(out, func(i, j int) bool {
		return out[i].Path < out[j].Path
	})
	return out
}
