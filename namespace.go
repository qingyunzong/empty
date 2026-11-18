package formal

import (
	"errors"
	"fmt"
	"strings"
)

// Mkdir creates a new empty directory at p.
func (fs *FS) Mkdir(p string) error {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	parentPath, name, err := splitPath(p)
	if err != nil {
		return err
	}
	parent, err := fs.resolveDirLocked(parentPath)
	if err != nil {
		return err
	}
	if _, exists := parent.entries[name]; exists {
		return fmt.Errorf("%w: %s", ErrExist, p)
	}

	in := fs.allocInodeLocked(kindDir, 0)
	dir := &directory{
		inode:   in,
		parent:  parent,
		entries: make(map[string]*inode),
	}
	in.dir = dir
	if err := fs.attachLocked(parent, name, in); err != nil {
		fs.freeInodeLocked(in)
		return err
	}
	return nil
}

// MkdirAll creates p and any missing parent directories.
func (fs *FS) MkdirAll(p string) error {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	p, err := cleanPath(p)
	if err != nil {
		return err
	}
	if p == "/" {
		return nil
	}

	dir := fs.root
	for _, part := range strings.Split(strings.TrimPrefix(p, "/"), "/") {
		next, exists := dir.entries[part]
		if exists {
			if next.kind != kindDir {
				return fmt.Errorf("%w: %s", ErrNotDir, p)
			}
			dir = next.dir
			continue
		}

		in := fs.allocInodeLocked(kindDir, 0)
		child := &directory{
			inode:   in,
			parent:  dir,
			entries: make(map[string]*inode),
		}
		in.dir = child
		if err := fs.attachLocked(dir, part, in); err != nil {
			fs.freeInodeLocked(in)
			return err
		}
		dir = child
	}
	return nil
}

// CreateFile creates a regular file of the given size at p.
func (fs *FS) CreateFile(p string, size int64) error {
	if size < 0 {
		return ErrNegativeSize
	}

	fs.mu.Lock()
	defer fs.mu.Unlock()

	parentPath, name, err := splitPath(p)
	if err != nil {
		return err
	}
	parent, err := fs.resolveDirLocked(parentPath)
	if err != nil {
		return err
	}
	if _, exists := parent.entries[name]; exists {
		return fmt.Errorf("%w: %s", ErrExist, p)
	}

	in := fs.allocInodeLocked(kindFile, size)
	if err := fs.attachLocked(parent, name, in); err != nil {
		fs.freeInodeLocked(in)
		return err
	}
	return nil
}

// Create is an alias for CreateFile.
func (fs *FS) Create(p string, size int64) error { return fs.CreateFile(p, size) }

// Link creates a hard link at newPath referring to the file at existingPath.
func (fs *FS) Link(existingPath, newPath string) error {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	_, _, in, err := fs.resolveEntryLocked(existingPath)
	if err != nil {
		return err
	}
	if in.kind == kindDir {
		return fmt.Errorf("%w: %s", ErrIsDir, existingPath)
	}

	parentPath, name, err := splitPath(newPath)
	if err != nil {
		return err
	}
	parent, err := fs.resolveDirLocked(parentPath)
	if err != nil {
		return err
	}
	return fs.attachLocked(parent, name, in)
}

// HardLink is an alias for Link.
func (fs *FS) HardLink(existingPath, newPath string) error { return fs.Link(existingPath, newPath) }

// LinkInode creates a hard link to the inode id at newPath.
func (fs *FS) LinkInode(id InodeID, newPath string) error {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	in, ok := fs.byID[id]
	if !ok {
		return fmt.Errorf("%w: inode %d", ErrNotExist, id)
	}
	if in.kind == kindDir {
		return fmt.Errorf("%w: inode %d", ErrIsDir, id)
	}

	parentPath, name, err := splitPath(newPath)
	if err != nil {
		return err
	}
	parent, err := fs.resolveDirLocked(parentPath)
	if err != nil {
		return err
	}
	return fs.attachLocked(parent, name, in)
}

// Remove deletes one namespace entry. A directory must be empty to be removed.
// Removing the last link to an inode frees the inode.
func (fs *FS) Remove(p string) error {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	parent, name, in, err := fs.resolveEntryLocked(p)
	if err != nil {
		return err
	}
	if in.kind == kindDir && len(in.dir.entries) != 0 {
		return fmt.Errorf("%w: %s", ErrNotEmpty, p)
	}
	_, err = fs.detachLocked(parent, name)
	return err
}

// Unlink is an alias for Remove.
func (fs *FS) Unlink(p string) error { return fs.Remove(p) }

// Rmdir removes an empty directory.
func (fs *FS) Rmdir(p string) error {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	parent, name, in, err := fs.resolveEntryLocked(p)
	if err != nil {
		return err
	}
	if in.kind != kindDir {
		return fmt.Errorf("%w: %s", ErrNotDir, p)
	}
	if len(in.dir.entries) != 0 {
		return fmt.Errorf("%w: %s", ErrNotEmpty, p)
	}
	_, err = fs.detachLocked(parent, name)
	return err
}

// RemoveAll deletes p and every entry below it. Removing a missing path is not
// an error. The root itself cannot be removed.
func (fs *FS) RemoveAll(p string) error {
	clean, err := cleanPath(p)
	if err != nil {
		return err
	}
	if clean == "/" {
		return ErrRoot
	}

	fs.mu.Lock()
	defer fs.mu.Unlock()

	parentPath, name, err := splitPath(clean)
	if err != nil {
		return err
	}
	parent, err := fs.resolveDirLocked(parentPath)
	if err != nil {
		if errors.Is(err, ErrNotExist) {
			return nil
		}
		return err
	}
	if _, exists := parent.entries[name]; !exists {
		return nil
	}
	return fs.removeAllLocked(parent, name)
}

func (fs *FS) removeAllLocked(parent *directory, name string) error {
	in := parent.entries[name]
	if in.kind == kindDir {
		for len(in.dir.entries) != 0 {
			for child := range in.dir.entries {
				if err := fs.removeAllLocked(in.dir, child); err != nil {
					return err
				}
				break
			}
		}
		in.dir.parent = nil
	}
	_, err := fs.detachLocked(parent, name)
	return err
}

// Rename atomically moves oldPath to newPath. Existing destinations are
// replaced with normal rename semantics: a file may replace a file, and a
// directory may replace an empty directory.
//
// Only the aggregates on the source and destination branches are changed.
// Aggregates of their common ancestors are untouched because every moved
// namespace entry remains inside those subtrees.
func (fs *FS) Rename(oldPath, newPath string) error {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	oldParentPath, oldName, err := splitPath(oldPath)
	if err != nil {
		return err
	}
	newParentPath, newName, err := splitPath(newPath)
	if err != nil {
		return err
	}

	srcParent, err := fs.resolveDirLocked(oldParentPath)
	if err != nil {
		return err
	}
	dstParent, err := fs.resolveDirLocked(newParentPath)
	if err != nil {
		return err
	}

	src, exists := srcParent.entries[oldName]
	if !exists {
		return fmt.Errorf("%w: %s", ErrNotExist, oldPath)
	}
	if oldParentPath == newParentPath && oldName == newName {
		return nil
	}

	if src.kind == kindDir && isAncestor(src.dir, dstParent) {
		return fmt.Errorf("%w: cannot move %s into its own subtree", ErrInvalidRename, oldPath)
	}

	var dst *inode
	if existing, ok := dstParent.entries[newName]; ok {
		dst = existing
		if src.kind == kindDir {
			if dst.kind != kindDir {
				return fmt.Errorf("%w: %s", ErrNotDir, newPath)
			}
			if len(dst.dir.entries) != 0 {
				return fmt.Errorf("%w: %s", ErrNotEmpty, newPath)
			}
		} else if dst.kind == kindDir {
			return fmt.Errorf("%w: %s", ErrIsDir, newPath)
		}
	}

	c := collectClosure(src)
	if err := fs.validateMoveDeltaLocked(srcParent, dstParent, c); err != nil {
		return err
	}

	// Replacement is part of the same atomic operation. It happens after all
	// validation, so a failed rename leaves the namespace unchanged.
	if dst != nil {
		if _, err := fs.detachLocked(dstParent, newName); err != nil {
			return err
		}
	}

	if err := fs.applyMoveDeltaLocked(srcParent, dstParent, c); err != nil {
		return err
	}

	delete(srcParent.entries, oldName)
	dstParent.entries[newName] = src
	if src.kind == kindDir {
		src.dir.parent = dstParent
	}
	return nil
}

// Stats returns the maintained subtree usage for the directory at p.
func (fs *FS) Stats(p string) (Usage, error) {
	fs.mu.RLock()
	defer fs.mu.RUnlock()

	dir, err := fs.resolveDirLocked(p)
	if err != nil {
		return Usage{}, err
	}
	return dir.usage, nil
}

// Stat is an alias for Stats.
func (fs *FS) Stat(p string) (Usage, error) { return fs.Stats(p) }

// NaiveStats computes the usage of p from scratch by walking every descendant
// entry. It is intended for auditing and tests; production callers should use
// Stats.
func (fs *FS) NaiveStats(p string) (Usage, error) {
	fs.mu.RLock()
	defer fs.mu.RUnlock()

	dir, err := fs.resolveDirLocked(p)
	if err != nil {
		return Usage{}, err
	}
	return naiveUsageLocked(dir), nil
}

func naiveUsageLocked(dir *directory) Usage {
	var usage Usage
	seen := make(map[*inode]struct{})
	var walk func(*directory)
	walk = func(d *directory) {
		for _, in := range d.entries {
			usage.Links++
			if _, ok := seen[in]; !ok {
				seen[in] = struct{}{}
				usage.Inodes++
				usage.Bytes += in.size
			}
			if in.kind == kindDir {
				walk(in.dir)
			}
		}
	}
	walk(dir)
	return usage
}

// Inode returns the inode id referenced by p.
func (fs *FS) Inode(p string) (InodeID, error) {
	fs.mu.RLock()
	defer fs.mu.RUnlock()

	_, _, in, err := fs.resolveEntryLocked(p)
	if err != nil {
		return 0, err
	}
	return in.id, nil
}

// InodeLinks returns the global hard-link count of id.
func (fs *FS) InodeLinks(id InodeID) (int64, error) {
	fs.mu.RLock()
	defer fs.mu.RUnlock()

	in, ok := fs.byID[id]
	if !ok {
		return 0, fmt.Errorf("%w: inode %d", ErrNotExist, id)
	}
	return in.links, nil
}
