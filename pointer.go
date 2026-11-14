package dataeng

import (
	"encoding/json"
	"fmt"
	"time"
)

// Pointer is the single mutable object that makes a manifest visible.
//
// Manifest is the digest (and object identity) of the new head manifest.
// Previous is the digest of the immediately preceding manifest, duplicated
// from the manifest so readers can detect a pointer/manifest disagreement
// without first walking the full chain.
type Pointer struct {
	Format     string `json:"format"`
	Generation uint64 `json:"generation"`
	Manifest   string `json:"manifest"`
	Previous   string `json:"previous,omitempty"`
	UpdatedAt  string `json:"updated_at"`
	Writer     string `json:"writer,omitempty"`
}

// Bytes returns the canonical JSON representation of the pointer.
func (p *Pointer) Bytes() ([]byte, error) {
	if p == nil {
		return nil, fmt.Errorf("%w: nil pointer", ErrInvalidPointer)
	}
	return json.Marshal(p)
}

// Validate checks the pointer's structural invariants.
func (p *Pointer) Validate() error {
	if p == nil {
		return fmt.Errorf("%w: nil pointer", ErrInvalidPointer)
	}
	if p.Format != PointerFormat {
		return fmt.Errorf("%w: unsupported format %q", ErrInvalidPointer, p.Format)
	}
	if p.Generation == 0 {
		return fmt.Errorf("%w: generation must be at least 1", ErrInvalidPointer)
	}
	if !validDigest(p.Manifest) {
		return fmt.Errorf("%w: invalid manifest digest %q", ErrInvalidPointer, p.Manifest)
	}
	if p.Generation == 1 {
		if p.Previous != "" {
			return fmt.Errorf("%w: generation 1 must not have a previous manifest", ErrInvalidPointer)
		}
	} else if !validDigest(p.Previous) {
		return fmt.Errorf("%w: invalid previous digest %q", ErrInvalidPointer, p.Previous)
	}
	if p.UpdatedAt != "" {
		if _, err := time.Parse(time.RFC3339Nano, p.UpdatedAt); err != nil {
			return fmt.Errorf("%w: invalid updated_at %q", ErrInvalidPointer, p.UpdatedAt)
		}
	}
	return nil
}
