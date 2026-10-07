package forward

import "testing"

func TestUnreleasedLeaseBlocksReuse(t *testing.T) {
	p := NewPool(8, 4)

	c := newChunk(p)
	c.Data = c.buf[:3]
	c.Retain() // second destination shares the same original chunk

	c.Release() // forwarder's own lease is gone, one remains
	if got := p.Idle(); got != 0 {
		t.Fatalf("buffer recycled with a lease outstanding: idle=%d", got)
	}

	fresh := p.get()
	if &fresh[0] == &c.buf[0] {
		t.Fatal("pool reused a buffer that still has an outstanding lease")
	}
	p.put(fresh)

	c.Release() // last lease dropped
	if got := p.Idle(); got != 2 {
		t.Fatalf("expected 2 idle buffers after full release, got %d", got)
	}
	back := p.get()
	if &back[0] != &c.buf[0] {
		t.Fatal("expected the fully released buffer to be recycled")
	}
}

func TestEmptyChunkLease(t *testing.T) {
	p := NewPool(8, 4)
	c := newChunk(p) // Data is empty until a read fills it
	if len(c.Data) != 0 {
		t.Fatalf("new chunk should be empty, got %d bytes", len(c.Data))
	}
	c.Retain()
	c.Release()
	if p.Idle() != 0 {
		t.Fatal("empty chunk recycled while leased")
	}
	c.Release()
	if p.Idle() != 1 {
		t.Fatal("empty chunk not recycled after last release")
	}
}
