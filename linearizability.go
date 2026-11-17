package formal

import (
	"bytes"
	"errors"
	"fmt"
	"slices"
	"strings"
)

// This file implements a linearizability checker for Gateway operation
// histories. The sequential specification below (model) mirrors the
// documented Gateway semantics: part validation, idempotent re-upload,
// generation invalidation on overwrite, atomic commit, and reads that
// observe exactly one committed manifest's concatenation. CheckLinearizable
// searches for an interleaving of the recorded events that respects
// real-time order and whose responses the model reproduces exactly.

type modelPart struct {
	gen    uint64
	offset int64
	digest string
	data   []byte
}

type modelUpload struct {
	key      string
	parts    map[int]modelPart
	closed   bool
	manifest []PartRef
	version  uint64
}

type modelObject struct {
	version uint64
	data    []byte
}

type model struct {
	uploads map[string]*modelUpload
	objects map[string]*modelObject
	version uint64
}

func newModel() *model {
	return &model{
		uploads: make(map[string]*modelUpload),
		objects: make(map[string]*modelObject),
	}
}

func (m *model) clone() *model {
	nm := &model{
		uploads: make(map[string]*modelUpload, len(m.uploads)),
		objects: make(map[string]*modelObject, len(m.objects)),
		version: m.version,
	}
	for id, up := range m.uploads {
		nup := &modelUpload{
			key:      up.key,
			parts:    make(map[int]modelPart, len(up.parts)),
			closed:   up.closed,
			manifest: slices.Clone(up.manifest),
			version:  up.version,
		}
		for num, p := range up.parts {
			nup.parts[num] = modelPart{gen: p.gen, offset: p.offset, digest: p.digest, data: slices.Clone(p.data)}
		}
		nm.uploads[id] = nup
	}
	for key, obj := range m.objects {
		nm.objects[key] = &modelObject{version: obj.version, data: slices.Clone(obj.data)}
	}
	return nm
}

// hash renders the model state canonically for memoization. Object payloads
// are digested to keep the key small.
func (m *model) hash() string {
	var b strings.Builder
	fmt.Fprintf(&b, "v%d;", m.version)
	for _, id := range sortedKeys(m.uploads) {
		up := m.uploads[id]
		fmt.Fprintf(&b, "U%s:%s:%t:%d:", id, up.key, up.closed, up.version)
		for _, ref := range up.manifest {
			fmt.Fprintf(&b, "m%d:%d:%d:%d:%s;", ref.Number, ref.Gen, ref.Offset, ref.Size, ref.Digest)
		}
		for _, num := range sortedIntKeys(up.parts) {
			p := up.parts[num]
			fmt.Fprintf(&b, "p%d:%d:%d:%s;", num, p.gen, p.offset, p.digest)
		}
	}
	for _, key := range sortedKeys(m.objects) {
		obj := m.objects[key]
		fmt.Fprintf(&b, "O%s:%d:%s;", key, obj.version, DigestOf(obj.data))
	}
	return b.String()
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	return keys
}

func sortedIntKeys[V any](m map[int]V) []int {
	keys := make([]int, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	return keys
}

// stepModel applies e to a fresh clone of m and reports whether the model's
// response matches the recorded one.
func stepModel(m *model, e *Event) (*model, bool) {
	nm := m.clone()
	switch e.Kind {
	case OpBegin:
		nm.uploads[e.UploadID] = &modelUpload{key: e.Key, parts: make(map[int]modelPart)}
		return nm, e.Err == nil

	case OpPutPart:
		up, ok := nm.uploads[e.UploadID]
		if !ok {
			return nm, errors.Is(e.Err, ErrUnknownUpload)
		}
		if up.closed {
			return nm, errors.Is(e.Err, ErrUploadClosed)
		}
		if e.Spec.Number <= 0 || e.Spec.Offset < 0 {
			return nm, errors.Is(e.Err, ErrInvalidRange)
		}
		if DigestOf(e.Data) != e.Spec.Digest {
			return nm, errors.Is(e.Err, ErrDigestMismatch)
		}
		if p, ok := up.parts[e.Spec.Number]; ok {
			if p.digest == e.Spec.Digest && p.offset == e.Spec.Offset {
				return nm, e.Err == nil && e.Gen == p.gen
			}
			p.gen++
			p.offset = e.Spec.Offset
			p.digest = e.Spec.Digest
			p.data = slices.Clone(e.Data)
			up.parts[e.Spec.Number] = p
			return nm, e.Err == nil && e.Gen == p.gen
		}
		up.parts[e.Spec.Number] = modelPart{gen: 1, offset: e.Spec.Offset, digest: e.Spec.Digest, data: slices.Clone(e.Data)}
		return nm, e.Err == nil && e.Gen == 1

	case OpComplete:
		up, ok := nm.uploads[e.UploadID]
		if !ok {
			return nm, errors.Is(e.Err, ErrUnknownUpload)
		}
		if up.closed {
			if slices.Equal(up.manifest, e.Manifest) {
				return nm, e.Err == nil && e.Version == up.version
			}
			return nm, errors.Is(e.Err, ErrUploadClosed)
		}
		if err := validateManifest(e.Manifest); err != nil {
			return nm, errors.Is(e.Err, err)
		}
		for _, ref := range e.Manifest {
			p, ok := up.parts[ref.Number]
			if !ok {
				return nm, errors.Is(e.Err, ErrManifestMismatch)
			}
			if p.gen != ref.Gen {
				return nm, errors.Is(e.Err, ErrStaleGeneration)
			}
			if p.digest != ref.Digest || p.offset != ref.Offset || int64(len(p.data)) != ref.Size {
				return nm, errors.Is(e.Err, ErrManifestMismatch)
			}
		}
		var data []byte
		for _, ref := range e.Manifest {
			data = append(data, up.parts[ref.Number].data...)
		}
		nm.version++
		nm.objects[up.key] = &modelObject{version: nm.version, data: data}
		up.closed = true
		up.manifest = slices.Clone(e.Manifest)
		up.version = nm.version
		return nm, e.Err == nil && e.Version == nm.version

	case OpGet:
		obj, ok := nm.objects[e.Key]
		if !ok {
			return nm, !e.Found
		}
		return nm, e.Found && e.Version == obj.version && bytes.Equal(e.Object, obj.data)
	}
	return nm, false
}

// CheckLinearizable reports whether the recorded history admits a
// linearization consistent with the sequential Gateway specification: an
// ordering of the events that respects real-time order (an operation that
// returned before another was invoked must come first) and in which every
// recorded response is reproduced by the model. In particular this proves
// that every observed object was exactly the concatenation of the parts of
// one committed manifest.
func CheckLinearizable(events []*Event) bool {
	evs := slices.Clone(events)
	slices.SortStableFunc(evs, func(a, b *Event) int {
		switch {
		case a.Call < b.Call:
			return -1
		case a.Call > b.Call:
			return 1
		default:
			return 0
		}
	})
	n := len(evs)
	memo := make(map[string]bool)
	done := make([]bool, n)
	doneKey := make([]byte, n)

	var search func(m *model) bool
	search = func(m *model) bool {
		key := string(doneKey) + "|" + m.hash()
		if v, ok := memo[key]; ok {
			return v
		}
		result := false
		remaining := false
		for i := 0; i < n; i++ {
			if done[i] {
				continue
			}
			remaining = true
			// Real-time order: every operation that returned before
			// evs[i] was invoked must already be linearized.
			ready := true
			for j := 0; j < n; j++ {
				if !done[j] && evs[j].Ret < evs[i].Call {
					ready = false
					break
				}
			}
			if !ready {
				continue
			}
			nm, ok := stepModel(m, evs[i])
			if !ok {
				continue
			}
			done[i] = true
			doneKey[i] = 1
			if search(nm) {
				done[i] = false
				doneKey[i] = 0
				return true
			}
			done[i] = false
			doneKey[i] = 0
		}
		if !remaining {
			result = true
		}
		memo[key] = result
		return result
	}

	return search(newModel())
}
