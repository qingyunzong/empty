package formal

import (
	"fmt"
	"strings"
)

// Check verifies all maintained aggregates against a fresh walk of the
// namespace and validates the internal per-inode bookkeeping. It returns nil
// when the accounting is consistent.
func (fs *FS) Check() error {
	fs.mu.RLock()
	defer fs.mu.RUnlock()
	return fs.checkLocked()
}

func (fs *FS) checkLocked() error {
	if fs.root == nil || fs.root.inode == nil {
		return fmt.Errorf("%w: nil root", ErrInvariant)
	}
	if fs.root.parent != nil {
		return fmt.Errorf("%w: root has a parent", ErrInvariant)
	}

	dirSeen := make(map[*directory]bool)
	directParents := make(map[*inode]map[*directory]int64)
	entryCounts := make(map[*inode]int64)
	var totalLinks int64

	var walk func(*directory) error
	walk = func(dir *directory) error {
		if dir == nil || dir.inode == nil {
			return fmt.Errorf("%w: nil directory", ErrInvariant)
		}
		if dirSeen[dir] {
			return fmt.Errorf("%w: directory cycle at inode %d", ErrInvariant, dir.inode.id)
		}
		dirSeen[dir] = true

		if dir.inode.kind != kindDir || dir.inode.dir != dir {
			return fmt.Errorf("%w: malformed directory inode", ErrInvariant)
		}

		for name, in := range dir.entries {
			if in == nil {
				return fmt.Errorf("%w: nil inode at %q", ErrInvariant, name)
			}
			if name == "" || name == "." || name == ".." || strings.ContainsRune(name, '/') {
				return fmt.Errorf("%w: invalid entry name %q", ErrInvariant, name)
			}
		}

		for _, in := range dir.entries {
			entryCounts[in]++
			totalLinks++
			if directParents[in] == nil {
				directParents[in] = make(map[*directory]int64)
			}
			directParents[in][dir]++

			if in.kind == kindDir {
				if in.dir == nil {
					return fmt.Errorf("%w: directory inode %d has no directory", ErrInvariant, in.id)
				}
				if in.dir.parent != dir {
					return fmt.Errorf("%w: directory inode %d has wrong parent", ErrInvariant, in.id)
				}
				if err := walk(in.dir); err != nil {
					return err
				}
			}
		}

		want := naiveUsageLocked(dir)
		if dir.usage != want {
			return fmt.Errorf("%w: directory inode %d has %s, want %s", ErrInvariant, dir.inode.id, dir.usage, want)
		}
		return nil
	}

	if err := walk(fs.root); err != nil {
		return err
	}

	if int64(len(fs.byID)) != fs.inodeCount {
		return fmt.Errorf("%w: inode count is %d, map has %d", ErrInvariant, fs.inodeCount, len(fs.byID))
	}
	if totalLinks != fs.linkCount {
		return fmt.Errorf("%w: link count is %d, walk found %d", ErrInvariant, fs.linkCount, totalLinks)
	}

	var totalBytes int64
	for in, count := range entryCounts {
		if _, ok := fs.byID[in.id]; !ok || fs.byID[in.id] != in {
			return fmt.Errorf("%w: entry references unallocated inode %d", ErrInvariant, in.id)
		}
		if in.links != count {
			return fmt.Errorf("%w: inode %d has links=%d, walk found %d", ErrInvariant, in.id, in.links, count)
		}

		wantRefs := make(map[*directory]int64)
		for parent, n := range directParents[in] {
			for d := parent; d != nil; d = d.parent {
				wantRefs[d] += n
			}
		}
		if len(wantRefs) != len(in.refs) {
			return fmt.Errorf("%w: inode %d has %d reference buckets, want %d", ErrInvariant, in.id, len(in.refs), len(wantRefs))
		}
		for d, want := range wantRefs {
			if got := in.refs[d]; got != want {
				return fmt.Errorf("%w: inode %d reference count under %p is %d, want %d", ErrInvariant, in.id, d, got, want)
			}
		}
	}

	for id, in := range fs.byID {
		if in.id != id {
			return fmt.Errorf("%w: inode map key %d holds inode %d", ErrInvariant, id, in.id)
		}
		if in == fs.root.inode {
			if in.links != 0 || len(in.refs) != 0 {
				return fmt.Errorf("%w: root inode has links or reference buckets", ErrInvariant)
			}
		}
		if in.size < 0 {
			return fmt.Errorf("%w: inode %d has negative size", ErrInvariant, in.id)
		}
		totalBytes += in.size
		if in.kind == kindDir {
			if in.dir == nil {
				return fmt.Errorf("%w: directory inode %d has no directory", ErrInvariant, in.id)
			}
			if in.dir.inode != in {
				return fmt.Errorf("%w: directory inode %d is not owned by its directory", ErrInvariant, in.id)
			}
			if !dirSeen[in.dir] {
				return fmt.Errorf("%w: directory inode %d is unreachable", ErrInvariant, in.id)
			}
			if in.dir != fs.root && in.links != 1 {
				return fmt.Errorf("%w: directory inode %d has %d links", ErrInvariant, in.id, in.links)
			}
		} else if in.links == 0 && in != fs.root.inode {
			return fmt.Errorf("%w: file inode %d is unreachable", ErrInvariant, in.id)
		}
	}
	if totalBytes != fs.byteCount {
		return fmt.Errorf("%w: byte count is %d, inode sum is %d", ErrInvariant, fs.byteCount, totalBytes)
	}

	if fs.root.usage.Links != fs.linkCount {
		return fmt.Errorf("%w: root links=%d, global links=%d", ErrInvariant, fs.root.usage.Links, fs.linkCount)
	}
	if fs.root.usage.Inodes+1 != fs.inodeCount {
		return fmt.Errorf("%w: root inodes=%d, global inodes=%d", ErrInvariant, fs.root.usage.Inodes, fs.inodeCount)
	}
	if fs.root.usage.Bytes != fs.byteCount {
		return fmt.Errorf("%w: root bytes=%d, global bytes=%d", ErrInvariant, fs.root.usage.Bytes, fs.byteCount)
	}
	if len(dirSeen) == 0 {
		return fmt.Errorf("%w: no directories visited", ErrInvariant)
	}
	return nil
}
