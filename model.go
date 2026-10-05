package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
)

// Object is one versioned backup object: an ordered list of block IDs.
type Object struct {
	Version int      `json:"version"`
	Blocks  []string `json:"blocks"`
}

// Manifest is the full backup manifest (全量清单).
type Manifest struct {
	Blocks  map[string]string `json:"blocks"`  // block ID -> data
	Objects map[string]Object `json:"objects"` // object name -> current version
}

// Op is a single mutation inside an incremental package.
type Op struct {
	Op      string   `json:"op"` // "put" or "delete"
	Object  string   `json:"object"`
	Version int      `json:"version,omitempty"`
	Blocks  []string `json:"blocks,omitempty"`
}

// Package is an incremental package (增量包) chained by parent digest.
type Package struct {
	Parent string            `json:"parent"` // digest of the state this package applies to
	Blocks map[string]string `json:"blocks,omitempty"`
	Ops    []Op              `json:"ops"`
}

// State is the mutable restore working state.
type State struct {
	Blocks  map[string]string
	Objects map[string]Object
}

func stateFromManifest(m *Manifest) *State {
	s := &State{Blocks: map[string]string{}, Objects: map[string]Object{}}
	for k, v := range m.Blocks {
		s.Blocks[k] = v
	}
	for k, v := range m.Objects {
		s.Objects[k] = Object{Version: v.Version, Blocks: append([]string(nil), v.Blocks...)}
	}
	return s
}

// Digest is the canonical state digest: SHA-256 over a sorted, unambiguous
// serialization of the object table.
func Digest(s *State) string {
	names := make([]string, 0, len(s.Objects))
	for n := range s.Objects {
		names = append(names, n)
	}
	sort.Strings(names)
	var b strings.Builder
	for _, n := range names {
		o := s.Objects[n]
		fmt.Fprintf(&b, "%s\x00%d\x00%s\n", n, o.Version, strings.Join(o.Blocks, "\x01"))
	}
	sum := sha256.Sum256([]byte(b.String()))
	return hex.EncodeToString(sum[:])
}

func equalBlocks(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
