package dirwalk

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// TestRealDirectory exercises OSFS against a real temp tree containing a
// symlink cycle, with follow on and off.
func TestRealDirectory(t *testing.T) {
	root := t.TempDir()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.MkdirAll(filepath.Join(root, "sub", "deep"), 0o755))
	must(os.WriteFile(filepath.Join(root, "sub", "deep", "f.txt"), []byte("x"), 0o644))
	must(os.Symlink(root, filepath.Join(root, "sub", "loop"))) // cycle

	res, err := Walk(context.Background(), OSFS{}, root, Options{FollowSymlinks: true, MaxOpen: 2})
	if err != nil {
		t.Fatalf("Walk follow: %v", err)
	}
	if len(res.Errors) != 0 {
		t.Fatalf("unexpected errors: %v", res.Errors)
	}
	got := pathsOf(res)
	if _, ok := got[filepath.Join(root, "sub", "deep", "f.txt")]; !ok {
		t.Errorf("real file missing: %v", got)
	}
	if hasPathPrefix(res, filepath.Join(root, "sub", "loop")+string(os.PathSeparator)) {
		t.Errorf("real symlink cycle was unrolled: %v", got)
	}

	res, err = Walk(context.Background(), OSFS{}, root, Options{FollowSymlinks: false, MaxOpen: 2})
	if err != nil {
		t.Fatalf("Walk nofollow: %v", err)
	}
	got = pathsOf(res)
	if got[filepath.Join(root, "sub", "loop")] != TypeSymlink {
		t.Errorf("loop not recorded as symlink: %v", got)
	}
}

// countingFS wraps an Adapter and tracks handle-budget usage.
type countingFS struct {
	inner Adapter

	mu                       sync.Mutex
	open, max, opens, closes int
}

func (c *countingFS) OpenDir(ctx context.Context, p string) (Handle, error) {
	h, err := c.inner.OpenDir(ctx, p)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	c.open++
	c.opens++
	if c.open > c.max {
		c.max = c.open
	}
	c.mu.Unlock()
	return h, nil
}

func (c *countingFS) ReadDir(ctx context.Context, h Handle) ([]Entry, error) {
	return c.inner.ReadDir(ctx, h)
}

func (c *countingFS) Stat(ctx context.Context, p string) (Entry, error) {
	return c.inner.Stat(ctx, p)
}

func (c *countingFS) Close(h Handle) error {
	err := c.inner.Close(h)
	c.mu.Lock()
	c.open--
	c.closes++
	c.mu.Unlock()
	return err
}

// TestRealDirectoryBudget verifies the handle budget holds against the
// real filesystem, observed through an injected counting adapter.
func TestRealDirectoryBudget(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 6; i++ {
		if err := os.MkdirAll(filepath.Join(root, fmt.Sprintf("a%d/b%d", i, i)), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	c := &countingFS{inner: OSFS{}}
	res, err := Walk(context.Background(), c, root, Options{MaxOpen: 2})
	if err != nil {
		t.Fatalf("Walk: %v", err)
	}
	if len(res.Errors) != 0 {
		t.Fatalf("unexpected errors: %v", res.Errors)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.max > 2 {
		t.Errorf("budget violated on real fs: max open = %d, want <= 2", c.max)
	}
	if c.opens != c.closes || c.open != 0 {
		t.Errorf("not conserved: opens=%d closes=%d open=%d", c.opens, c.closes, c.open)
	}
}
