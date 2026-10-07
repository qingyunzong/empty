package blockstore

import "fmt"

// Tx is a transaction that stages block writes and root additions.
// Any failed operation, or a failed Commit, rolls the transaction
// back completely: staged blocks are removed and every reference
// count is restored to its pre-transaction value.
type Tx struct {
	store      *Store
	created    []Hash        // blocks created by this transaction
	createdSet map[Hash]bool // dedup guard for created
	rawCreated map[Hash]bool // blocks staged with caller-supplied hashes
	rootIncs   map[Hash]int  // roots added: hash -> times added
	done       bool
}

// Begin starts a transaction on the store.
func (s *Store) Begin() *Tx {
	return &Tx{
		store:      s,
		createdSet: make(map[Hash]bool),
		rawCreated: make(map[Hash]bool),
		rootIncs:   make(map[Hash]int),
	}
}

func (t *Tx) fail(err error) error {
	t.Rollback()
	return err
}

// PutLeaf stages a leaf block, deduplicated by content.
func (t *Tx) PutLeaf(data []byte) Hash {
	h := hashLeaf(data)
	if !t.createdSet[h] {
		if _, ok := t.store.blocks[h]; !ok {
			t.store.blocks[h] = &block{data: data}
			t.created = append(t.created, h)
			t.createdSet[h] = true
		}
	}
	return h
}

// PutTree stages a tree node whose content hash is computed from its
// children. All children must already exist (in the store or staged
// earlier in this transaction). A missing child aborts and rolls back
// the whole transaction.
func (t *Tx) PutTree(children []Hash) (Hash, error) {
	if t.done {
		return Hash{}, ErrTxDone
	}
	for _, c := range children {
		if _, ok := t.store.blocks[c]; !ok {
			return Hash{}, t.fail(fmt.Errorf("%w: child %s", ErrNotFound, c))
		}
	}
	h := hashTree(children)
	if _, ok := t.store.blocks[h]; !ok {
		t.store.blocks[h] = &block{children: append([]Hash(nil), children...)}
		t.created = append(t.created, h)
		t.createdSet[h] = true
	}
	return h, nil
}

// PutTreeRaw stages a tree node under a caller-supplied hash, for
// importing externally addressed data. References are validated only
// at Commit time, so cyclic or dangling input is staged and then
// rejected (and fully rolled back) by Commit.
func (t *Tx) PutTreeRaw(h Hash, children []Hash) error {
	if t.done {
		return ErrTxDone
	}
	if _, ok := t.store.blocks[h]; ok {
		return t.fail(fmt.Errorf("blockstore: block %s already exists", h))
	}
	t.store.blocks[h] = &block{children: append([]Hash(nil), children...)}
	t.created = append(t.created, h)
	t.createdSet[h] = true
	t.rawCreated[h] = true
	return nil
}

// AddRoot stages h as a root. If h does not exist, the whole
// transaction is rolled back and an error is returned.
func (t *Tx) AddRoot(h Hash) error {
	if t.done {
		return ErrTxDone
	}
	if _, ok := t.store.blocks[h]; !ok {
		return t.fail(fmt.Errorf("%w: root %s", ErrNotFound, h))
	}
	t.store.roots[h]++
	t.rootIncs[h]++
	for r := range t.store.reachableFrom(h) {
		t.store.blocks[r].refs++
	}
	return nil
}

// Commit validates the staged changes: every reference must resolve
// and the resulting graph must be acyclic. On any validation failure
// the entire transaction is rolled back and the error returned.
func (t *Tx) Commit() error {
	if t.done {
		return ErrTxDone
	}
	if err := t.store.checkResolved(); err != nil {
		return t.fail(err)
	}
	if err := t.store.checkAcyclic(); err != nil {
		return t.fail(err)
	}
	t.done = true
	return nil
}

// Rollback undoes everything the transaction staged: root references
// are released, reference counts restored, and created blocks removed.
// It is safe to call Rollback after Commit (a no-op).
func (t *Tx) Rollback() {
	if t.done {
		return
	}
	t.done = true
	for h, n := range t.rootIncs {
		for i := 0; i < n; i++ {
			t.store.roots[h]--
			if t.store.roots[h] == 0 {
				delete(t.store.roots, h)
			}
			for r := range t.store.reachableFrom(h) {
				if b := t.store.blocks[r]; b != nil {
					b.refs--
				}
			}
		}
	}
	for _, h := range t.created {
		delete(t.store.blocks, h)
	}
}
