package snapshot

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	manifestDir = "checkpoints/"
	manifestSfx = ".manifest"
	tmpSfx      = ".tmp"
	headKey     = "HEAD"
)

func manifestKey(id string) string { return manifestDir + id + manifestSfx }
func stagingKey(id string) string  { return manifestKey(id) + tmpSfx }

// checkpoint is the in-memory generation state for one manifest.
type checkpoint struct {
	manifest Manifest
	// refs counts holders of this generation: the checkpoint itself while
	// active, plus every child checkpoint that has not been reclaimed.
	// A dropped checkpoint is reclaimed when refs reaches zero, meaning
	// no active descendant can reference its files.
	refs int
}

// Manager owns the checkpoint graph persisted in a Store. The zero value
// is not usable; construct one with Open.
type Manager struct {
	store Store

	mu  sync.Mutex
	cps map[string]*checkpoint
	// fileRefs counts, per file key, how many unreclaimed manifests
	// reference the file. A file is deleted only when this reaches zero.
	fileRefs map[string]int
	head     string
}

// Open loads every manifest in the store and rebuilds the reference
// counts. Parent links come exclusively from manifest fields; object
// listings are never used to guess the chain. Leftover staging files from
// interrupted commits are ignored. Any corrupt manifest, dangling parent,
// or dangling HEAD is a hard stop and returns an error wrapping
// ErrCorruptManifest.
func Open(ctx context.Context, store Store) (*Manager, error) {
	keys, err := store.List(ctx, manifestDir)
	if err != nil {
		return nil, fmt.Errorf("list manifests: %w", err)
	}
	m := &Manager{
		store:    store,
		cps:      make(map[string]*checkpoint),
		fileRefs: make(map[string]int),
	}
	for _, key := range keys {
		if !strings.HasSuffix(key, manifestSfx) {
			// Staging files from interrupted commits are not
			// published generations; skip them.
			continue
		}
		data, err := store.Get(ctx, key)
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", key, err)
		}
		manifest, err := decodeManifest(data)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", key, err)
		}
		if got := manifestKey(manifest.ID); got != key {
			return nil, fmt.Errorf("%s: %w: id %q does not match key", key, ErrCorruptManifest, manifest.ID)
		}
		if _, dup := m.cps[manifest.ID]; dup {
			return nil, fmt.Errorf("%s: %w: duplicate checkpoint id", key, ErrCorruptManifest)
		}
		m.cps[manifest.ID] = &checkpoint{manifest: *manifest}
	}
	for id, cp := range m.cps {
		parent := cp.manifest.Parent
		if parent == "" {
			continue
		}
		p, ok := m.cps[parent]
		if !ok {
			return nil, fmt.Errorf("checkpoint %s: %w: missing parent %s", id, ErrCorruptManifest, parent)
		}
		p.refs++
	}
	for _, cp := range m.cps {
		if !cp.manifest.Dropped {
			cp.refs++
		}
		for _, f := range cp.manifest.SSTs {
			m.fileRefs[f]++
		}
		for _, f := range cp.manifest.Private {
			m.fileRefs[f]++
		}
	}
	head, err := store.Get(ctx, headKey)
	if err == nil {
		id := string(head)
		if _, ok := m.cps[id]; !ok {
			return nil, fmt.Errorf("HEAD: %w: unknown checkpoint %s", ErrCorruptManifest, id)
		}
		m.head = id
	} else if err != ErrNotFound {
		return nil, fmt.Errorf("read HEAD: %w", err)
	}
	return m, nil
}

// Commit atomically publishes a new checkpoint generation. The manifest is
// staged and then renamed into place, and HEAD is advanced. The parent, if
// any, must exist and still be active; its reference count is incremented
// so its files survive until the new checkpoint is reclaimed.
func (m *Manager) Commit(ctx context.Context, manifest Manifest) error {
	if manifest.ID == "" || strings.ContainsAny(manifest.ID, "/.") {
		return ErrInvalidID
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.cps[manifest.ID]; ok {
		return fmt.Errorf("%w: %s", ErrCheckpointExists, manifest.ID)
	}
	var parent *checkpoint
	if manifest.Parent != "" {
		p, ok := m.cps[manifest.Parent]
		if !ok {
			return fmt.Errorf("%w: parent %s", ErrNotFound, manifest.Parent)
		}
		if p.manifest.Dropped {
			return fmt.Errorf("%w: parent %s", ErrCheckpointDropped, manifest.Parent)
		}
		parent = p
	}
	manifest.Dropped = false
	if manifest.Created.IsZero() {
		manifest.Created = time.Now().UTC()
	}
	data, err := encodeManifest(&manifest)
	if err != nil {
		return err
	}
	// Publish: stage, atomically rename, then advance HEAD.
	if err := m.store.Put(ctx, stagingKey(manifest.ID), data); err != nil {
		return fmt.Errorf("stage manifest: %w", err)
	}
	if err := m.store.Rename(ctx, stagingKey(manifest.ID), manifestKey(manifest.ID)); err != nil {
		return fmt.Errorf("publish manifest: %w", err)
	}
	if err := m.store.Put(ctx, headKey, []byte(manifest.ID)); err != nil {
		return fmt.Errorf("advance HEAD: %w", err)
	}
	m.cps[manifest.ID] = &checkpoint{manifest: manifest, refs: 1}
	if parent != nil {
		parent.refs++
	}
	for _, f := range manifest.SSTs {
		m.fileRefs[f]++
	}
	for _, f := range manifest.Private {
		m.fileRefs[f]++
	}
	m.head = manifest.ID
	return nil
}

// Cancel marks a checkpoint as cancelled and reclaims whatever generations
// and files are no longer held by active descendants.
func (m *Manager) Cancel(ctx context.Context, id string) error {
	return m.drop(ctx, id)
}

// Expire marks a checkpoint as expired. It is semantically identical to
// Cancel: only files with no active descendant references are reclaimed.
func (m *Manager) Expire(ctx context.Context, id string) error {
	return m.drop(ctx, id)
}

func (m *Manager) drop(ctx context.Context, id string) error {
	m.mu.Lock()
	cp, ok := m.cps[id]
	if !ok {
		m.mu.Unlock()
		return fmt.Errorf("%w: %s", ErrNotFound, id)
	}
	if cp.manifest.Dropped {
		m.mu.Unlock()
		return nil
	}
	cp.manifest.Dropped = true
	cp.refs--
	data, err := encodeManifest(&cp.manifest)
	if err != nil {
		m.mu.Unlock()
		return err
	}
	m.mu.Unlock()
	// Persist the dropped flag before reclaiming so a crash never
	// resurrects the checkpoint as active.
	if err := m.store.Put(ctx, stagingKey(id), data); err != nil {
		return fmt.Errorf("stage manifest: %w", err)
	}
	if err := m.store.Rename(ctx, stagingKey(id), manifestKey(id)); err != nil {
		return fmt.Errorf("publish manifest: %w", err)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.reclaim(ctx, id)
}

// reclaim collects every dropped generation whose reference count has
// reached zero, starting at id and cascading up the parent chain. Files
// are deleted only when no unreclaimed manifest references them.
func (m *Manager) reclaim(ctx context.Context, id string) error {
	for {
		cp, ok := m.cps[id]
		if !ok || !cp.manifest.Dropped || cp.refs > 0 {
			return nil
		}
		delete(m.cps, id)
		for _, f := range cp.manifest.SSTs {
			m.unrefFile(ctx, f)
		}
		for _, f := range cp.manifest.Private {
			m.unrefFile(ctx, f)
		}
		if err := m.store.Delete(ctx, manifestKey(id)); err != nil {
			return fmt.Errorf("delete manifest %s: %w", id, err)
		}
		if m.head == id {
			m.head = cp.manifest.Parent
			if err := m.store.Put(ctx, headKey, []byte(m.head)); err != nil {
				return fmt.Errorf("rewind HEAD: %w", err)
			}
		}
		parent := cp.manifest.Parent
		if parent == "" {
			return nil
		}
		p, ok := m.cps[parent]
		if !ok {
			return nil
		}
		p.refs--
		id = parent
	}
}

func (m *Manager) unrefFile(ctx context.Context, key string) {
	m.fileRefs[key]--
	if m.fileRefs[key] > 0 {
		return
	}
	delete(m.fileRefs, key)
	// A missing file is tolerable: reclamation is idempotent.
	_ = m.store.Delete(ctx, key)
}

// Head returns the manifest of the most recently committed checkpoint.
func (m *Manager) Head() (Manifest, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.get(m.head)
}

// Get returns the manifest of the named checkpoint.
func (m *Manager) Get(id string) (Manifest, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.get(id)
}

func (m *Manager) get(id string) (Manifest, bool) {
	cp, ok := m.cps[id]
	if !ok {
		return Manifest{}, false
	}
	return cp.manifest, true
}

// ActiveFiles returns the sorted set of file keys still referenced by at
// least one unreclaimed checkpoint.
func (m *Manager) ActiveFiles() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	files := make([]string, 0, len(m.fileRefs))
	for f := range m.fileRefs {
		files = append(files, f)
	}
	sort.Strings(files)
	return files
}
