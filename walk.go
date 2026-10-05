package merklefs

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"hash"
	"io"
	"io/fs"
	"sort"
	"syscall"
)

// EntryType classifies manifest entries.
type EntryType byte

const (
	TypeFile    EntryType = 'F'
	TypeDir     EntryType = 'D'
	TypeSymlink EntryType = 'L'
)

// Entry is a single canonical record in a Manifest.
type Entry struct {
	Path string    // canonical relative path, UTF-8, slash-separated
	Type EntryType // file, directory or symlink

	// Files only.
	Size int64
	Hash [32]byte // SHA-256 of file content

	// ObjID identifies the underlying storage object. Hard-linked files
	// (same device and inode) share one ObjID and are hashed only once.
	ObjID [16]byte

	// Symlinks only: the link target, recorded verbatim. Links are never
	// followed during the walk.
	Target string
}

// Manifest is a deterministic inventory of a directory tree. Entries are
// sorted by canonical path in UTF-8 byte order.
type Manifest struct {
	Entries []Entry
	root    [32]byte
}

// Root returns the Merkle root of the manifest.
func (m *Manifest) Root() [32]byte { return m.root }

// Len returns the number of entries.
func (m *Manifest) Len() int { return len(m.Entries) }

// Find returns the entry for a canonical path.
func (m *Manifest) Find(path string) (Entry, bool) {
	i, ok := entryIndex(m.Entries, path)
	if !ok {
		return Entry{}, false
	}
	return m.Entries[i], true
}

// sortSlice orders entries by canonical path.
func sortSlice(entries []Entry, less func(i, j int) bool) {
	sort.Slice(entries, less)
}

// objectKey identifies a storage object by device and inode.
type objectKey struct {
	dev uint64
	ino uint64
}

// objectID derives a deterministic object identifier from the key, so
// incremental updates and full rebuilds agree on ObjIDs.
func objectID(k objectKey) [16]byte {
	var buf [16]byte
	binary.LittleEndian.PutUint64(buf[0:8], k.dev)
	binary.LittleEndian.PutUint64(buf[8:16], k.ino)
	sum := sha256.Sum256(buf[:])
	var id [16]byte
	copy(id[:], sum[:16])
	return id
}

// statObject extracts the (device, inode) pair from FileInfo, if the
// underlying system exposes it.
func statObject(info fs.FileInfo) (objectKey, bool) {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return objectKey{}, false
	}
	return objectKey{dev: uint64(st.Dev), ino: uint64(st.Ino)}, true
}

// Walk traverses the tree rooted at root inside fsys and builds a Manifest.
//
// Symbolic links are recorded but never followed. Hard-linked files are
// detected via device/inode and recorded as the same object: their content
// is hashed once and they share an ObjID. If fsys does not expose inode
// information, every file is treated as a distinct object.
func Walk(fsys fs.FS, root string) (*Manifest, error) {
	if root == "" {
		root = "."
	}
	objects := make(map[objectKey][16]byte) // object key -> ObjID
	var entries []Entry

	err := fs.WalkDir(fsys, root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if path == root {
			return nil // the root itself is not an entry
		}
		rel := path
		if root != "." {
			var ok bool
			rel, ok = trimRoot(path, root)
			if !ok {
				return fmt.Errorf("merklefs: path %q escapes root %q", path, root)
			}
		}
		if _, err := Canonicalize(rel); err != nil {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		mode := info.Mode()
		switch {
		case mode.IsDir():
			entries = append(entries, Entry{Path: rel, Type: TypeDir})
		case mode.IsRegular():
			e := Entry{Path: rel, Type: TypeFile, Size: info.Size()}
			if key, ok := statObject(info); ok {
				id, seen := objects[key]
				if !seen {
					id = objectID(key)
					objects[key] = id
				}
				e.ObjID = id
				if seen {
					// Same object: reuse the already computed hash.
					e.Hash = hashOfObject(entries, id)
				} else {
					h, err := hashFile(fsys, path)
					if err != nil {
						return err
					}
					e.Hash = h
				}
			} else {
				// No inode information: object identity is the path.
				e.ObjID = objectIDPath(rel)
				h, err := hashFile(fsys, path)
				if err != nil {
					return err
				}
				e.Hash = h
			}
			entries = append(entries, e)
		case mode&fs.ModeSymlink != 0:
			// Record the target; never follow the link.
			target, err := readLink(fsys, path)
			if err != nil {
				return err
			}
			entries = append(entries, Entry{Path: rel, Type: TypeSymlink, Target: target})
		default:
			return fmt.Errorf("merklefs: unsupported file type %v at %q", mode.Type(), rel)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	sortEntries(entries)
	return &Manifest{Entries: entries, root: computeRoot(entries)}, nil
}

// Build assembles a Manifest directly from entries, canonicalizing and
// sorting them. It is used by incremental updates and tests.
func Build(entries []Entry) (*Manifest, error) {
	out := make([]Entry, len(entries))
	copy(out, entries)
	for i := range out {
		if _, err := Canonicalize(out[i].Path); err != nil {
			return nil, err
		}
		switch out[i].Type {
		case TypeFile, TypeDir, TypeSymlink:
		default:
			return nil, fmt.Errorf("merklefs: unknown entry type %q at %q", out[i].Type, out[i].Path)
		}
	}
	sortEntries(out)
	for i := 1; i < len(out); i++ {
		if equalPaths(out[i-1].Path, out[i].Path) {
			return nil, fmt.Errorf("merklefs: duplicate path %q", out[i].Path)
		}
	}
	return &Manifest{Entries: out, root: computeRoot(out)}, nil
}

func trimRoot(path, root string) (string, bool) {
	if len(path) <= len(root) || path[:len(root)] != root || path[len(root)] != '/' {
		return "", false
	}
	return path[len(root)+1:], true
}

func hashOfObject(entries []Entry, id [16]byte) [32]byte {
	for i := len(entries) - 1; i >= 0; i-- {
		if entries[i].Type == TypeFile && entries[i].ObjID == id {
			return entries[i].Hash
		}
	}
	return [32]byte{}
}

func objectIDPath(path string) [16]byte {
	sum := sha256.Sum256(append([]byte("path:"), path...))
	var id [16]byte
	copy(id[:], sum[:16])
	return id
}

func hashFile(fsys fs.FS, path string) ([32]byte, error) {
	f, err := fsys.Open(path)
	if err != nil {
		return [32]byte{}, err
	}
	defer f.Close()
	var zero [32]byte
	h := hash.Hash(sha256.New())
	if _, err := io.Copy(h, f); err != nil {
		return zero, err
	}
	var sum [32]byte
	copy(sum[:], h.Sum(nil))
	return sum, nil
}

// readLink returns the target of a symbolic link without following it. It
// prefers fs.ReadLinkFS (Go 1.25+) and falls back to fs.ReadFile, whose
// result for a symlink is the target in fs implementations such as
// fstest.MapFS.
func readLink(fsys fs.FS, path string) (string, error) {
	if rfs, ok := fsys.(fs.ReadLinkFS); ok {
		return rfs.ReadLink(path)
	}
	b, err := fs.ReadFile(fsys, path)
	if err != nil {
		return "", err
	}
	if len(b) == 0 {
		return "", errors.New("merklefs: empty symlink target at " + path)
	}
	return string(b), nil
}
