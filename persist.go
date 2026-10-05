package coverage

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// rootFile is the name of the published root pointer.
const rootFile = "root.json"

// FS abstracts the filesystem operations that publishing depends on, so
// tests can inject failures at every step of a publish.
type FS interface {
	ReadFile(name string) ([]byte, error)
	// WriteFile writes data and fsyncs it before returning.
	WriteFile(name string, data []byte) error
	Rename(old, new string) error
	Remove(name string) error
	SyncDir() error
	List() ([]string, error)
}

// DirFS is an FS rooted at a directory.
type DirFS struct {
	Dir string
}

func (d DirFS) path(name string) string { return filepath.Join(d.Dir, name) }

// ReadFile implements FS.
func (d DirFS) ReadFile(name string) ([]byte, error) {
	return os.ReadFile(d.path(name))
}

// WriteFile implements FS.
func (d DirFS) WriteFile(name string, data []byte) error {
	f, err := os.OpenFile(d.path(name), os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// Rename implements FS.
func (d DirFS) Rename(old, new string) error {
	return os.Rename(d.path(old), d.path(new))
}

// Remove implements FS. A missing file is not an error.
func (d DirFS) Remove(name string) error {
	if err := os.Remove(d.path(name)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// SyncDir implements FS.
func (d DirFS) SyncDir() error {
	dir, err := os.Open(d.Dir)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

// List implements FS.
func (d DirFS) List() ([]string, error) {
	entries, err := os.ReadDir(d.Dir)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names, nil
}

// rootMeta is the durable root pointer. It is replaced atomically by
// rename, so a crash can never leave a half-written root behind.
type rootMeta struct {
	Gen    uint64 `json:"gen"`
	Tree   string `json:"tree"`
	SHA256 string `json:"sha256"`
}

// treeData is one immutable published generation of the store.
type treeData struct {
	Gen     uint64                `json:"gen"`
	Sources map[string][]Interval `json:"sources"`
}

func treeName(gen uint64) string { return fmt.Sprintf("tree-%06d.json", gen) }

// readRoot loads the current root, or returns nil when none exists.
func readRoot(fsys FS) (*rootMeta, error) {
	data, err := fsys.ReadFile(rootFile)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var m rootMeta
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("coverage: corrupt root: %w", err)
	}
	return &m, nil
}

// Publish durably publishes s as the next generation and returns its
// generation number.
//
// The new tree file is written, synced and renamed into place first;
// only then is the root pointer swapped atomically and the directory
// synced. A crash at any point therefore leaves either the complete old
// generation or the complete new one visible to Recover, never a mix.
func Publish(fsys FS, s *Store) (uint64, error) {
	cur, err := readRoot(fsys)
	if err != nil {
		return 0, err
	}
	gen := uint64(1)
	if cur != nil {
		gen = cur.Gen + 1
	}
	data, err := json.Marshal(treeData{Gen: gen, Sources: s.srcs})
	if err != nil {
		return 0, err
	}
	sum := sha256.Sum256(data)
	name := treeName(gen)
	if err := fsys.WriteFile(name+".tmp", data); err != nil {
		return 0, err
	}
	if err := fsys.Rename(name+".tmp", name); err != nil {
		return 0, err
	}
	meta, err := json.Marshal(rootMeta{Gen: gen, Tree: name, SHA256: hex.EncodeToString(sum[:])})
	if err != nil {
		return 0, err
	}
	if err := fsys.WriteFile(rootFile+".tmp", meta); err != nil {
		return 0, err
	}
	if err := fsys.Rename(rootFile+".tmp", rootFile); err != nil {
		return 0, err
	}
	if err := fsys.SyncDir(); err != nil {
		return 0, err
	}
	gcTrees(fsys, name)
	return gen, nil
}

// Recover loads the last published store and its generation. A missing
// root yields an empty store at generation 0. Because the root is swapped
// atomically and the tree it names is written and synced beforehand, the
// recovered state is always one complete generation; a root pointing at
// a missing or corrupted tree is reported as an error rather than
// silently mixing old and new data.
func Recover(fsys FS) (*Store, uint64, error) {
	m, err := readRoot(fsys)
	if err != nil {
		return nil, 0, err
	}
	if m == nil {
		return NewStore(), 0, nil
	}
	data, err := fsys.ReadFile(m.Tree)
	if err != nil {
		return nil, 0, fmt.Errorf("coverage: tree %q unreadable: %w", m.Tree, err)
	}
	if got := sha256.Sum256(data); hex.EncodeToString(got[:]) != m.SHA256 {
		return nil, 0, fmt.Errorf("coverage: tree %q checksum mismatch", m.Tree)
	}
	var td treeData
	if err := json.Unmarshal(data, &td); err != nil {
		return nil, 0, fmt.Errorf("coverage: corrupt tree %q: %w", m.Tree, err)
	}
	if td.Gen != m.Gen {
		return nil, 0, fmt.Errorf("coverage: tree generation %d does not match root generation %d", td.Gen, m.Gen)
	}
	st := &Store{srcs: td.Sources}
	st.ensure()
	return st, m.Gen, nil
}

// gcTrees best-effort removes tree files superseded by keep and any
// temporary files left behind by interrupted publishes. It runs after
// the root swap, so its failure cannot affect durability.
func gcTrees(fsys FS, keep string) {
	names, err := fsys.List()
	if err != nil {
		return
	}
	for _, n := range names {
		if n == keep || n == rootFile {
			continue
		}
		if strings.HasPrefix(n, "tree-") || strings.HasSuffix(n, ".tmp") {
			_ = fsys.Remove(n)
		}
	}
}
