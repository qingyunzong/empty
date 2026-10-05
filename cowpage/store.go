// Package cowpage implements a memory page store with forkable snapshot
// branches and copy-on-write semantics.
//
// A Store owns a set of physical pages, each tracked by a reference count.
// A branch is a snapshot view: a fixed-size table mapping logical page
// indices to physical pages. Forking a branch shares every physical page
// and bumps reference counts; writing through a branch copies the page
// first when it is still shared, so concurrent branches never observe each
// other's modifications. Deleting a branch drops its references; a physical
// page is reclaimed only when its count reaches zero, so pages stay alive
// as long as any view still references them.
//
// Store is not safe for concurrent use.
package cowpage

import "fmt"

// PageID identifies a physical page inside a Store.
type PageID uint64

// BranchID identifies a snapshot branch inside a Store.
type BranchID uint64

type page struct {
	data []byte
	refs int
}

type branch struct {
	table []PageID
}

// Store manages physical pages and snapshot branches.
type Store struct {
	pageSize   int
	numPages   int
	pages      map[PageID]*page
	branches   map[BranchID]*branch
	nextPage   PageID
	nextBranch BranchID
	zeroPage   PageID // shared all-zero page, one reference held by the Store
	closed     bool
}

// New creates a Store whose branches each expose numPages logical pages of
// pageSize bytes. The store holds one all-zero physical page that every new
// branch shares until written.
func New(numPages, pageSize int) *Store {
	if numPages <= 0 || pageSize <= 0 {
		panic("cowpage: numPages and pageSize must be positive")
	}
	s := &Store{
		pageSize: pageSize,
		numPages: numPages,
		pages:    make(map[PageID]*page),
		branches: make(map[BranchID]*branch),
	}
	s.zeroPage = s.alloc(make([]byte, pageSize)) // refs == 1, owned by Store
	return s
}

func (s *Store) alloc(data []byte) PageID {
	id := s.nextPage
	s.nextPage++
	s.pages[id] = &page{data: data, refs: 1}
	return id
}

func (s *Store) ref(id PageID) {
	s.pages[id].refs++
}

// deref drops one reference and reclaims the page when none remain.
func (s *Store) deref(id PageID) {
	p := s.pages[id]
	p.refs--
	if p.refs == 0 {
		delete(s.pages, id)
	}
}

// Create returns a new branch whose pages all read as zero, sharing the
// store-wide zero page until written.
func (s *Store) Create() BranchID {
	id := s.nextBranch
	s.nextBranch++
	table := make([]PageID, s.numPages)
	for i := range table {
		table[i] = s.zeroPage
		s.ref(s.zeroPage)
	}
	s.branches[id] = &branch{table: table}
	return id
}

// Fork snapshots src into a new branch. The fork shares all of src's
// physical pages; later writes through either branch are invisible to the
// other.
func (s *Store) Fork(src BranchID) (BranchID, error) {
	b, ok := s.branches[src]
	if !ok {
		return 0, fmt.Errorf("cowpage: fork: unknown branch %d", src)
	}
	id := s.nextBranch
	s.nextBranch++
	table := make([]PageID, s.numPages)
	for i, pid := range b.table {
		table[i] = pid
		s.ref(pid)
	}
	s.branches[id] = &branch{table: table}
	return id, nil
}

// Delete removes a branch and drops its page references. Pages still
// referenced by surviving branches (or the store's zero page) are kept.
func (s *Store) Delete(id BranchID) error {
	b, ok := s.branches[id]
	if !ok {
		return fmt.Errorf("cowpage: delete: unknown branch %d", id)
	}
	delete(s.branches, id)
	for _, pid := range b.table {
		s.deref(pid)
	}
	return nil
}

// Read returns a copy of logical page index in branch b.
func (s *Store) Read(b BranchID, index int) ([]byte, error) {
	br, ok := s.branches[b]
	if !ok {
		return nil, fmt.Errorf("cowpage: read: unknown branch %d", b)
	}
	if index < 0 || index >= s.numPages {
		return nil, fmt.Errorf("cowpage: read: page index %d out of range", index)
	}
	src := s.pages[br.table[index]].data
	out := make([]byte, len(src))
	copy(out, src)
	return out, nil
}

// Write copies data into logical page index of branch b at offset. If the
// physical page is shared with other views, it is copied first and the
// branch is rebound to the private copy (copy-on-write).
func (s *Store) Write(b BranchID, index, offset int, data []byte) error {
	br, ok := s.branches[b]
	if !ok {
		return fmt.Errorf("cowpage: write: unknown branch %d", b)
	}
	if index < 0 || index >= s.numPages {
		return fmt.Errorf("cowpage: write: page index %d out of range", index)
	}
	if offset < 0 || offset+len(data) > s.pageSize {
		return fmt.Errorf("cowpage: write: offset %d + %d bytes exceeds page size %d", offset, len(data), s.pageSize)
	}
	pid := br.table[index]
	p := s.pages[pid]
	if p.refs > 1 {
		fresh := make([]byte, s.pageSize)
		copy(fresh, p.data)
		s.deref(pid)
		pid = s.alloc(fresh)
		br.table[index] = pid
		p = s.pages[pid]
	}
	copy(p.data[offset:], data)
	return nil
}

// LivePages reports how many physical pages currently exist, including the
// store-owned zero page.
func (s *Store) LivePages() int { return len(s.pages) }

// Branches reports how many branches currently exist.
func (s *Store) Branches() int { return len(s.branches) }

// RefCount reports the reference count of a physical page, for diagnostics.
// The second return value is false if the page no longer exists.
func (s *Store) RefCount(id PageID) (int, bool) {
	p, ok := s.pages[id]
	if !ok {
		return 0, false
	}
	return p.refs, true
}

// Validate checks that every physical page's reference count equals the
// number of incoming references from live branch tables (plus the store's
// own reference to the zero page), and that no branch points at a missing
// page. It returns nil when the store is internally consistent.
func (s *Store) Validate() error {
	want := map[PageID]int{s.zeroPage: 1}
	for id, b := range s.branches {
		if len(b.table) != s.numPages {
			return fmt.Errorf("cowpage: branch %d has table size %d, want %d", id, len(b.table), s.numPages)
		}
		for _, pid := range b.table {
			want[pid]++
		}
	}
	for pid, p := range s.pages {
		if p.refs <= 0 {
			return fmt.Errorf("cowpage: page %d has non-positive refs %d", pid, p.refs)
		}
		if want[pid] != p.refs {
			return fmt.Errorf("cowpage: page %d refs=%d, want %d", pid, p.refs, want[pid])
		}
		delete(want, pid)
	}
	for pid, n := range want {
		return fmt.Errorf("cowpage: %d dangling reference(s) to freed page %d", n, pid)
	}
	return nil
}

// Close deletes any remaining branches' references implicitly is NOT done;
// Close only releases the store-owned zero page reference. After Close,
// LivePages reports pages still pinned by live branches.
func (s *Store) Close() {
	if s.closed {
		return
	}
	s.closed = true
	s.deref(s.zeroPage)
}
