package dataeng

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
)

var (
	// ErrInvalidManifest reports malformed shard metadata.
	ErrInvalidManifest = errors.New("dataeng: invalid manifest")
	// ErrSchemaMismatch reports shards that do not share the global schema
	// version.
	ErrSchemaMismatch = errors.New("dataeng: schema version mismatch")
	// ErrShardConflict reports two entries for the same sequence number whose
	// metadata differs.
	ErrShardConflict = errors.New("dataeng: conflicting shard metadata")
)

// Shard describes one compressed NDJSON shard.
//
// Sequence numbers order the shards and start at Manifest.Start(); internal
// gaps are treated as missing shards. Digest is the SHA-256 of the compressed
// bytes. LineCount is the number of newline-terminated lines after
// decompression, including empty lines. SchemaVersion is the global schema
// version shared by every shard in the export.
type Shard struct {
	Sequence      int64  `json:"sequence"`
	Digest        string `json:"digest"`
	LineCount     int64  `json:"line_count"`
	SchemaVersion string `json:"schema_version"`
}

// Manifest describes one export. Shards may be supplied in any order and may
// contain exact duplicate entries; Normalize sorts and deduplicates them.
type Manifest struct {
	SchemaVersion string  `json:"schema_version"`
	Shards        []Shard `json:"shards"`
}

// ParseManifest decodes and normalizes a JSON manifest.
func ParseManifest(r io.Reader) (Manifest, error) {
	dec := json.NewDecoder(r)
	var m Manifest
	if err := dec.Decode(&m); err != nil {
		return Manifest{}, fmt.Errorf("%w: %v", ErrInvalidManifest, err)
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		if err == nil {
			err = errors.New("unexpected trailing JSON value")
		}
		return Manifest{}, fmt.Errorf("%w: %v", ErrInvalidManifest, err)
	}
	return m.Normalize()
}

// Validate checks the manifest without returning its normalized form.
func (m Manifest) Validate() error {
	_, err := m.Normalize()
	return err
}

// Normalize validates the manifest and returns a canonical copy: shards are
// sorted by sequence, exact duplicate entries are removed, digests are
// canonicalized, and every shard carries the manifest's global schema version.
//
// A sequence gap is allowed and is reported later by the reader as a missing
// shard. This is important for resume: shards after a gap can still be verified
// and cached, but they cannot advance the global watermark.
func (m Manifest) Normalize() (Manifest, error) {
	global := strings.TrimSpace(m.SchemaVersion)
	if len(m.Shards) == 0 {
		if global == "" {
			return Manifest{}, fmt.Errorf("%w: schema version is empty", ErrInvalidManifest)
		}
		return Manifest{SchemaVersion: global}, nil
	}

	shards := make([]Shard, 0, len(m.Shards))
	for i, s := range m.Shards {
		if s.Sequence < 0 {
			return Manifest{}, fmt.Errorf("%w: shard %d has negative sequence %d", ErrInvalidManifest, i, s.Sequence)
		}
		if s.LineCount < 0 {
			return Manifest{}, fmt.Errorf("%w: shard %d has negative line count %d", ErrInvalidManifest, s.Sequence, s.LineCount)
		}
		digest, err := NormalizeDigest(s.Digest)
		if err != nil {
			return Manifest{}, fmt.Errorf("%w: shard %d: %v", ErrInvalidManifest, s.Sequence, err)
		}
		s.Digest = digest
		s.SchemaVersion = strings.TrimSpace(s.SchemaVersion)
		if global == "" && s.SchemaVersion != "" {
			global = s.SchemaVersion
		}
		shards = append(shards, s)
	}
	if global == "" {
		return Manifest{}, fmt.Errorf("%w: schema version is empty", ErrInvalidManifest)
	}

	for i := range shards {
		if shards[i].SchemaVersion == "" {
			shards[i].SchemaVersion = global
			continue
		}
		if shards[i].SchemaVersion != global {
			return Manifest{}, fmt.Errorf(
				"%w: shard %d has %q, global version is %q",
				ErrSchemaMismatch, shards[i].Sequence, shards[i].SchemaVersion, global,
			)
		}
	}

	sort.Slice(shards, func(i, j int) bool {
		return shards[i].Sequence < shards[j].Sequence
	})

	out := make([]Shard, 0, len(shards))
	for _, s := range shards {
		if len(out) > 0 && out[len(out)-1].Sequence == s.Sequence {
			prev := out[len(out)-1]
			if prev.Digest == s.Digest && prev.LineCount == s.LineCount && prev.SchemaVersion == s.SchemaVersion {
				continue
			}
			return Manifest{}, fmt.Errorf(
				"%w: sequence %d has digest %s/%s and line counts %d/%d",
				ErrShardConflict, s.Sequence, prev.Digest, s.Digest, prev.LineCount, s.LineCount,
			)
		}
		out = append(out, s)
	}

	return Manifest{SchemaVersion: global, Shards: out}, nil
}

// Start returns the first sequence number in the manifest, or zero for an
// empty manifest.
func (m Manifest) Start() int64 {
	if len(m.Shards) == 0 {
		return 0
	}
	return m.Shards[0].Sequence
}

// EndSequence returns the last sequence number in the manifest, or Start()-1
// for an empty manifest. The manifest must be normalized.
func (m Manifest) EndSequence() int64 {
	if len(m.Shards) == 0 {
		return m.Start() - 1
	}
	return m.Shards[len(m.Shards)-1].Sequence
}

// MissingSequences returns internal sequence gaps in a normalized manifest.
func (m Manifest) MissingSequences() []int64 {
	if len(m.Shards) < 2 {
		return nil
	}
	var missing []int64
	expected := m.Shards[0].Sequence + 1
	for _, s := range m.Shards[1:] {
		for expected < s.Sequence {
			missing = append(missing, expected)
			expected++
		}
		expected = s.Sequence + 1
	}
	return missing
}

// Shard returns the shard with the given sequence number.
func (m Manifest) Shard(sequence int64) (Shard, bool) {
	i := sort.Search(len(m.Shards), func(i int) bool {
		return m.Shards[i].Sequence >= sequence
	})
	if i < len(m.Shards) && m.Shards[i].Sequence == sequence {
		return m.Shards[i], true
	}
	return Shard{}, false
}
