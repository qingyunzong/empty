package formal

import "testing"

func TestCheckDetectsCorruption(t *testing.T) {
	fs := New()
	must(t, fs.Mkdir("/a"))
	must(t, fs.CreateFile("/a/f", 17))
	must(t, fs.Link("/a/f", "/a/g"))

	if err := fs.Check(); err != nil {
		t.Fatalf("healthy Check: %v", err)
	}

	fs.mu.Lock()
	fs.root.usage.Bytes++
	fs.mu.Unlock()
	if err := fs.Check(); err == nil {
		t.Fatal("Check accepted corrupted bytes aggregate")
	}
	fs.mu.Lock()
	fs.root.usage.Bytes--
	fs.mu.Unlock()

	id, err := fs.Inode("/a/f")
	must(t, err)
	in := fs.byID[id]
	fs.mu.Lock()
	in.links++
	fs.mu.Unlock()
	if err := fs.Check(); err == nil {
		t.Fatal("Check accepted corrupted inode link count")
	}
	fs.mu.Lock()
	in.links--
	before := in.refs[fs.root]
	in.refs[fs.root] = before + 1
	fs.mu.Unlock()
	if err := fs.Check(); err == nil {
		t.Fatal("Check accepted corrupted inode reference count")
	}
	fs.mu.Lock()
	in.refs[fs.root] = before
	fs.mu.Unlock()

	if err := fs.Check(); err != nil {
		t.Fatalf("Check after restoring fields: %v", err)
	}
}
