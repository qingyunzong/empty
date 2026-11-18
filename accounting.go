package formal

import "fmt"

func (fs *FS) allocInodeLocked(kind inodeKind, size int64) *inode {
	in := &inode{
		id:   InodeID(fs.nextID),
		kind: kind,
		size: size,
		refs: make(map[*directory]int64),
	}
	fs.nextID++
	fs.byID[in.id] = in
	fs.inodeCount++
	fs.byteCount += size
	return in
}

func (fs *FS) freeInodeLocked(in *inode) {
	delete(fs.byID, in.id)
	fs.inodeCount--
	fs.byteCount -= in.size
	in.links = 0
}

// attachLocked records one new direct link to in at parent/name and applies
// the delta to every ancestor aggregate.
func (fs *FS) attachLocked(parent *directory, name string, in *inode) error {
	if _, exists := parent.entries[name]; exists {
		return fmt.Errorf("%w: %s", ErrExist, name)
	}
	parent.entries[name] = in
	in.links++
	fs.linkCount++

	for d := parent; d != nil; d = d.parent {
		d.usage.Links++
		count := in.refs[d]
		if count == 0 {
			d.usage.Inodes++
			d.usage.Bytes += in.size
		}
		in.refs[d] = count + 1
	}
	return nil
}

// detachLocked removes the direct link at parent/name and applies the delta to
// every ancestor aggregate. The inode is freed when its last link disappears.
func (fs *FS) detachLocked(parent *directory, name string) (*inode, error) {
	in, exists := parent.entries[name]
	if !exists {
		return nil, fmt.Errorf("%w: %s", ErrNotExist, name)
	}

	// Validate before changing anything so a broken invariant cannot leave a
	// half-updated aggregate behind.
	for d := parent; d != nil; d = d.parent {
		if d.usage.Links < 1 || in.refs[d] < 1 {
			return nil, fmt.Errorf("%w: link underflow for inode %d", ErrInvariant, in.id)
		}
	}

	delete(parent.entries, name)
	in.links--
	fs.linkCount--

	for d := parent; d != nil; d = d.parent {
		d.usage.Links--
		count := in.refs[d] - 1
		if count == 0 {
			delete(in.refs, d)
			d.usage.Inodes--
			d.usage.Bytes -= in.size
		} else {
			in.refs[d] = count
		}
	}

	if in.links == 0 {
		fs.freeInodeLocked(in)
	}
	return in, nil
}

type closure struct {
	entries int64
	counts  map[*inode]int64
}

// collectClosure returns the entries in the namespace closure rooted at in,
// including the link to in itself and every link below it.
func collectClosure(in *inode) closure {
	c := closure{counts: make(map[*inode]int64)}
	var walk func(*inode)
	walk = func(cur *inode) {
		c.entries++
		c.counts[cur]++
		if cur.kind == kindDir {
			for _, child := range cur.dir.entries {
				walk(child)
			}
		}
	}
	walk(in)
	return c
}

func directoryDepth(d *directory) int {
	n := 0
	for ; d != nil; d = d.parent {
		n++
	}
	return n
}

func commonAncestor(a, b *directory) *directory {
	da, db := directoryDepth(a), directoryDepth(b)
	for da > db {
		a = a.parent
		da--
	}
	for db > da {
		b = b.parent
		db--
	}
	for a != b {
		a = a.parent
		b = b.parent
	}
	return a
}

func isAncestor(ancestor, d *directory) bool {
	for ; d != nil; d = d.parent {
		if d == ancestor {
			return true
		}
	}
	return false
}

func (fs *FS) validateMoveDeltaLocked(srcParent, dstParent *directory, c closure) error {
	common := commonAncestor(srcParent, dstParent)
	for d := srcParent; d != common; d = d.parent {
		if d.usage.Links < c.entries {
			return fmt.Errorf("%w: link underflow under %p", ErrInvariant, d)
		}
		for in, n := range c.counts {
			if in.refs[d] < n {
				return fmt.Errorf("%w: inode %d underflow under %p", ErrInvariant, in.id, d)
			}
		}
	}
	return nil
}

// applyMoveDeltaLocked moves the aggregate contribution of a namespace
// closure from the source branch to the destination branch. Ancestors shared
// by both parents are untouched: every link in the closure remains inside
// their subtrees.
func (fs *FS) applyMoveDeltaLocked(srcParent, dstParent *directory, c closure) error {
	common := commonAncestor(srcParent, dstParent)

	for d := srcParent; d != common; d = d.parent {
		if d.usage.Links < c.entries {
			return fmt.Errorf("%w: link underflow under %p", ErrInvariant, d)
		}
		d.usage.Links -= c.entries
		for in, n := range c.counts {
			count := in.refs[d]
			if count < n {
				return fmt.Errorf("%w: inode %d underflow under %p", ErrInvariant, in.id, d)
			}
			count -= n
			if count == 0 {
				delete(in.refs, d)
				d.usage.Inodes--
				d.usage.Bytes -= in.size
			} else {
				in.refs[d] = count
			}
		}
	}

	for d := dstParent; d != common; d = d.parent {
		d.usage.Links += c.entries
		for in, n := range c.counts {
			count := in.refs[d]
			if count == 0 {
				d.usage.Inodes++
				d.usage.Bytes += in.size
			}
			in.refs[d] = count + n
		}
	}

	return nil
}
