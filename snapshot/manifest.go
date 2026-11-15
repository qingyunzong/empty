// Package snapshot implements an incremental snapshot manifest library for
// state backends. Each checkpoint references immutable shared SST files,
// its own private delta files, and a parent snapshot. Commits are
// published atomically through reference-counted generations; cancelled or
// expired checkpoints only reclaim files that no active descendant still
// references. A corrupt manifest is a hard stop: the parent chain is never
// guessed from object listings.
package snapshot

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// Manifest describes one checkpoint.
type Manifest struct {
	// ID uniquely identifies the checkpoint.
	ID string `json:"id"`
	// Parent is the ID of the parent checkpoint, or "" for a root
	// checkpoint. The parent chain is authoritative and comes only from
	// this field; it is never inferred from object listings.
	Parent string `json:"parent,omitempty"`
	// SSTs lists immutable shared SST files referenced by this checkpoint.
	SSTs []string `json:"ssts,omitempty"`
	// Private lists delta files owned exclusively by this checkpoint.
	Private []string `json:"private,omitempty"`
	// Dropped marks the checkpoint as cancelled or expired. A dropped
	// checkpoint keeps its manifest until no active descendant references
	// its files.
	Dropped bool `json:"dropped,omitempty"`
	// Created records when the checkpoint was committed.
	Created time.Time `json:"created"`
}

// envelope wraps a serialized manifest with a checksum so corruption is
// detected deterministically on load.
type envelope struct {
	Sum     string          `json:"sum"`
	Payload json.RawMessage `json:"payload"`
}

func encodeManifest(m *Manifest) ([]byte, error) {
	payload, err := json.Marshal(m)
	if err != nil {
		return nil, fmt.Errorf("marshal manifest %q: %w", m.ID, err)
	}
	sum := sha256.Sum256(payload)
	env := envelope{Sum: hex.EncodeToString(sum[:]), Payload: payload}
	data, err := json.Marshal(env)
	if err != nil {
		return nil, fmt.Errorf("marshal envelope %q: %w", m.ID, err)
	}
	return data, nil
}

// decodeManifest verifies the checksum and unmarshals the manifest. Any
// mismatch or malformed content yields ErrCorruptManifest.
func decodeManifest(data []byte) (*Manifest, error) {
	var env envelope
	if err := json.Unmarshal(data, &env); err != nil {
		return nil, fmt.Errorf("%w: malformed envelope: %v", ErrCorruptManifest, err)
	}
	sum := sha256.Sum256(env.Payload)
	if got := hex.EncodeToString(sum[:]); got != env.Sum {
		return nil, fmt.Errorf("%w: checksum mismatch", ErrCorruptManifest)
	}
	var m Manifest
	if err := json.Unmarshal(env.Payload, &m); err != nil {
		return nil, fmt.Errorf("%w: malformed payload: %v", ErrCorruptManifest, err)
	}
	if m.ID == "" {
		return nil, fmt.Errorf("%w: empty checkpoint id", ErrCorruptManifest)
	}
	return &m, nil
}

var (
	// ErrCorruptManifest indicates a manifest failed integrity
	// verification or structural validation. It is a hard stop.
	ErrCorruptManifest = errors.New("snapshot: corrupt manifest")
	// ErrNotFound indicates the named object or checkpoint does not exist.
	ErrNotFound = errors.New("snapshot: not found")
	// ErrCheckpointExists indicates a commit reused an existing ID.
	ErrCheckpointExists = errors.New("snapshot: checkpoint already exists")
	// ErrCheckpointDropped indicates an operation targeted a cancelled or
	// expired checkpoint.
	ErrCheckpointDropped = errors.New("snapshot: checkpoint dropped")
	// ErrInvalidID indicates an empty or otherwise unusable checkpoint ID.
	ErrInvalidID = errors.New("snapshot: invalid checkpoint id")
)
