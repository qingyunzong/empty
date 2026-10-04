// Package manifest builds a deterministic inventory of a directory tree and
// commits it to a Merkle root. Symlinks are recorded but never followed,
// hard links are recorded as the same object, and paths are valid UTF-8
// sorted in byte (code-point) order. Only the Go standard library is used.
package manifest

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"syscall"
	"unicode/utf8"
)

// EntryType classifies a manifest entry.
type EntryType uint8

const (
	TypeFile EntryType = iota + 1
	TypeDir
	TypeSymlink
	TypeOther // fifo, socket, device: metadata only, no content
)

func (t EntryType) String() string {
	switch t {
	case TypeFile:
		return "file"
	case TypeDir:
		return "dir"
	case TypeSymlink:
		return "symlink"
	default:
		return "other"
	}
}

// Entry is one node of the virtual directory tree. Path is relative to the
// scanned root, uses '/' separators, and must be valid UTF-8.
type Entry struct {
	Path   string
	Type   EntryType
	Mode   uint32
	Size   int64
	Digest [32]byte // file: SHA-256 of content; symlink: SHA-256 of target text
	Object string   // content-addressed object id; shared by hard-linked files
}

// Manifest is a sorted list of entries plus their cached leaf hashes.
type Manifest struct {
	entries []Entry
	leaves  [][32]byte
}

// Entries returns the manifest entries in canonical (UTF-8 byte) order.
func (m *Manifest) Entries() []Entry { return m.entries }

// ErrInvalidUTF8 is returned when a path component is not valid UTF-8.
var ErrInvalidUTF8 = errors.New("manifest: path is not valid UTF-8")

// Build walks root and constructs the manifest. The walk uses Lstat
// semantics throughout: symlinks are never followed. Hard-linked files
// (same device+inode) are hashed once and recorded as the same object.
func Build(root string) (*Manifest, error) {
	type fileID struct{ dev, ino uint64 }
	seen := make(map[fileID][32]byte)
	m := &Manifest{}
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if path == root {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if !utf8.ValidString(rel) {
			return fmt.Errorf("%w: %q", ErrInvalidUTF8, rel)
		}
		info, err := d.Info() // WalkDir never follows symlinks; this is Lstat data.
		if err != nil {
			return err
		}
		e := Entry{Path: rel, Mode: uint32(info.Mode().Perm()), Size: info.Size()}
		switch {
		case d.Type().IsRegular():
			e.Type = TypeFile
			st, ok := info.Sys().(*syscall.Stat_t)
			if ok {
				id := fileID{uint64(st.Dev), uint64(st.Ino)}
				if digest, dup := seen[id]; dup {
					e.Digest = digest
					e.Object = hex.EncodeToString(digest[:])
					m.entries = append(m.entries, e)
					return nil
				}
				digest, err := hashFile(path)
				if err != nil {
					return err
				}
				seen[id] = digest
				e.Digest = digest
			} else {
				digest, err := hashFile(path)
				if err != nil {
					return err
				}
				e.Digest = digest
			}
			e.Object = hex.EncodeToString(e.Digest[:])
		case d.IsDir():
			e.Type = TypeDir
			e.Size = 0
		case d.Type()&fs.ModeSymlink != 0:
			e.Type = TypeSymlink
			target, err := os.Readlink(path)
			if err != nil {
				return err
			}
			e.Digest = sha256.Sum256([]byte(target))
			e.Size = int64(len(target))
		default:
			e.Type = TypeOther
			e.Size = 0
		}
		m.entries = append(m.entries, e)
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(m.entries, func(i, j int) bool {
		return m.entries[i].Path < m.entries[j].Path // byte order == UTF-8 code-point order
	})
	m.leaves = make([][32]byte, len(m.entries))
	for i, e := range m.entries {
		m.leaves[i] = LeafHash(e)
	}
	return m, nil
}

func hashFile(path string) ([32]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return [32]byte{}, err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return [32]byte{}, err
	}
	var digest [32]byte
	copy(digest[:], h.Sum(nil))
	return digest, nil
}

// LeafHash computes the canonical, domain-separated hash of an entry.
func LeafHash(e Entry) [32]byte {
	h := sha256.New()
	h.Write([]byte{0x00}) // leaf domain separator
	h.Write([]byte{byte(e.Type)})
	writeString(h, e.Path)
	var buf [16]byte
	binary.BigEndian.PutUint32(buf[0:4], e.Mode)
	binary.BigEndian.PutUint64(buf[4:12], uint64(e.Size))
	h.Write(buf[:12])
	h.Write(e.Digest[:])
	writeString(h, e.Object)
	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out
}

func writeString(w io.Writer, s string) {
	var buf [4]byte
	binary.BigEndian.PutUint32(buf[:], uint32(len(s)))
	w.Write(buf[:])
	io.WriteString(w, s)
}

// Root returns the Merkle root committing to all entries.
func (m *Manifest) Root() [32]byte { return RootOf(m.leaves) }

// Prove returns an inclusion proof for the entry at path.
func (m *Manifest) Prove(path string) (Proof, Entry, error) {
	i := sort.Search(len(m.entries), func(i int) bool { return m.entries[i].Path >= path })
	if i >= len(m.entries) || m.entries[i].Path != path {
		return Proof{}, Entry{}, fmt.Errorf("manifest: no entry for %q", path)
	}
	return NewProof(m.leaves, i), m.entries[i], nil
}

// Change describes one incremental mutation of the virtual directory.
type Change struct {
	Remove  bool
	Path    string
	Type    EntryType // ignored when Remove is true
	Mode    uint32
	Content []byte // file content (TypeFile only)
	Target  string // link target (TypeSymlink only)
}

// Apply applies changes incrementally: it touches only the affected sorted
// positions and recomputes leaf hashes for changed entries, without
// re-walking the filesystem or re-hashing unchanged content.
func (m *Manifest) Apply(changes ...Change) error {
	for _, c := range changes {
		if !utf8.ValidString(c.Path) {
			return fmt.Errorf("%w: %q", ErrInvalidUTF8, c.Path)
		}
		i := sort.Search(len(m.entries), func(i int) bool { return m.entries[i].Path >= c.Path })
		found := i < len(m.entries) && m.entries[i].Path == c.Path
		if c.Remove {
			if !found {
				return fmt.Errorf("manifest: cannot remove missing %q", c.Path)
			}
			m.entries = append(m.entries[:i], m.entries[i+1:]...)
			m.leaves = append(m.leaves[:i], m.leaves[i+1:]...)
			continue
		}
		e := Entry{Path: c.Path, Type: c.Type, Mode: c.Mode}
		switch c.Type {
		case TypeFile:
			e.Digest = sha256.Sum256(c.Content)
			e.Size = int64(len(c.Content))
			e.Object = hex.EncodeToString(e.Digest[:])
		case TypeSymlink:
			e.Digest = sha256.Sum256([]byte(c.Target))
			e.Size = int64(len(c.Target))
		}
		leaf := LeafHash(e)
		if found {
			m.entries[i] = e
			m.leaves[i] = leaf
		} else {
			m.entries = append(m.entries, Entry{})
			copy(m.entries[i+1:], m.entries[i:])
			m.entries[i] = e
			m.leaves = append(m.leaves, [32]byte{})
			copy(m.leaves[i+1:], m.leaves[i:])
			m.leaves[i] = leaf
		}
	}
	return nil
}

// equalEntries reports whether two manifests hold identical entry lists.
func equalEntries(a, b []Entry) bool {
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

// Equal reports whether two manifests are identical (entries and root).
func (m *Manifest) Equal(other *Manifest) bool {
	return m.Root() == other.Root() && equalEntries(m.entries, other.entries)
}
