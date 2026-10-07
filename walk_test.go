package dirwalk

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"
)

// TestFollowSymlinksCycleByIdentity builds a symlink loop a/b/loop -> /a
// and verifies the walk terminates, visiting each real directory once.
func TestFollowSymlinksCycleByIdentity(t *testing.T) {
	f := newFakeFS()
	f.mkdir("/a")
	f.mkdir("/a/b")
	f.mkfile("/a/b/file.txt")
	f.symlink("/a/b/loop", "/a") // cycle by identity, not by path

	res, err := Walk(context.Background(), f, "/a", Options{FollowSymlinks: true, MaxOpen: 4})
	if err != nil {
		t.Fatalf("Walk: %v", err)
	}
	if len(res.Errors) != 0 {
		t.Fatalf("unexpected errors: %v", res.Errors)
	}
	got := pathsOf(res)
	for _, p := range []string{"/a", "/a/b", "/a/b/file.txt", "/a/b/loop"} {
		if _, ok := got[p]; !ok {
			t.Errorf("missing entry %s in %v", p, got)
		}
	}
	if got["/a/b/loop"] != TypeSymlink {
		t.Errorf("loop should be recorded as symlink, got %v", got["/a/b/loop"])
	}
	// The cycle must not be unrolled: no paths below the loop symlink.
	if hasPathPrefix(res, "/a/b/loop/") {
		t.Errorf("cycle was traversed: %v", got)
	}
}

// TestSameIdentityDifferentPaths verifies dedup is by identity: two
// distinct symlink paths to the same directory are traversed once.
func TestSameIdentityDifferentPaths(t *testing.T) {
	f := newFakeFS()
	f.mkdir("/a")
	f.mkdir("/a/b")
	f.mkfile("/a/b/f")
	f.symlink("/alias1", "/a/b")
	f.symlink("/alias2", "/a/b")

	res, err := Walk(context.Background(), f, "/", Options{FollowSymlinks: true, MaxOpen: 4})
	if err != nil {
		t.Fatalf("Walk: %v", err)
	}
	// The directory's identity must be traversed exactly once, under
	// whichever path reaches it first.
	traversals := 0
	for _, prefix := range []string{"/a/b/", "/alias1/", "/alias2/"} {
		if hasPathPrefix(res, prefix) {
			traversals++
		}
	}
	if traversals != 1 {
		t.Errorf("same-identity directory traversed %d times, want 1: %v", traversals, res.Entries)
	}
}

// TestNoFollowSymlinks records symlinks without traversing them.
func TestNoFollowSymlinks(t *testing.T) {
	f := newFakeFS()
	f.mkdir("/a")
	f.mkdir("/real")
	f.mkfile("/real/secret")
	f.symlink("/a/link", "/real")

	res, err := Walk(context.Background(), f, "/a", Options{FollowSymlinks: false, MaxOpen: 2})
	if err != nil {
		t.Fatalf("Walk: %v", err)
	}
	got := pathsOf(res)
	if got["/a/link"] != TypeSymlink {
		t.Errorf("link not recorded as symlink: %v", got)
	}
	if hasPathPrefix(res, "/a/link/") {
		t.Errorf("symlink traversed with FollowSymlinks=false: %v", got)
	}
}

// TestBudgetConservation runs a wide tree with MaxOpen=3 and asserts the
// open-handle high-water mark never exceeds the budget and every opened
// handle is closed (opens == closes, none left open).
func TestBudgetConservation(t *testing.T) {
	f := newFakeFS()
	for i := 0; i < 5; i++ {
		d := fmt.Sprintf("/d%d", i)
		f.mkdir(d)
		for j := 0; j < 4; j++ {
			sub := fmt.Sprintf("%s/s%d", d, j)
			f.mkdir(sub)
			f.mkfile(sub + "/f")
		}
	}

	res, err := Walk(context.Background(), f, "/", Options{MaxOpen: 3})
	if err != nil {
		t.Fatalf("Walk: %v", err)
	}
	if len(res.Errors) != 0 {
		t.Fatalf("unexpected errors: %v", res.Errors)
	}
	open, maxOpen, opens, closes := f.stats()
	if maxOpen > 3 {
		t.Errorf("budget violated: max concurrent opens = %d, want <= 3", maxOpen)
	}
	if opens != closes {
		t.Errorf("budget not conserved: opens = %d, closes = %d", opens, closes)
	}
	if open != 0 {
		t.Errorf("handles leaked: %d still open", open)
	}
	if opens < 26 { // root + 5 dirs + 20 subdirs
		t.Errorf("expected at least 26 opens, got %d", opens)
	}
}

// TestCancellationClosesEverything cancels mid-walk and asserts all
// opened handles are closed and Walk reports the context error.
func TestCancellationClosesEverything(t *testing.T) {
	f := newFakeFS()
	f.blockRead = make(chan struct{}) // ReadDir blocks until ctx is done
	for i := 0; i < 8; i++ {
		f.mkdir(fmt.Sprintf("/d%d", i))
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	var err error
	go func() {
		defer close(done)
		_, err = Walk(ctx, f, "/", Options{MaxOpen: 3})
	}()

	// Wait until handles are actually open, then cancel.
	deadline := time.Now().Add(5 * time.Second)
	for {
		open, _, _, _ := f.stats()
		if open > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("no handle ever opened")
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	close(f.blockRead) // release any reader that outlived the cancel

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Walk did not return after cancellation")
	}
	if !errors.Is(err, context.Canceled) {
		t.Errorf("err = %v, want context.Canceled", err)
	}
	open, _, opens, closes := f.stats()
	if open != 0 || opens != closes {
		t.Errorf("cancellation leaked handles: open=%d opens=%d closes=%d", open, opens, closes)
	}
}

// TestErrorsCollectedPerPath injects a failure on one directory and
// verifies the error is filed under its path while siblings still walk.
func TestErrorsCollectedPerPath(t *testing.T) {
	f := newFakeFS()
	f.mkdir("/good")
	f.mkfile("/good/f")
	f.mkdir("/bad")
	f.openErr["/bad"] = errInjected

	res, err := Walk(context.Background(), f, "/", Options{MaxOpen: 2})
	if err != nil {
		t.Fatalf("Walk: %v", err)
	}
	if !errors.Is(res.Errors["/bad"], errInjected) {
		t.Errorf("Errors[/bad] = %v, want injected error", res.Errors["/bad"])
	}
	if _, ok := pathsOf(res)["/good/f"]; !ok {
		t.Errorf("sibling subtree not walked: %v", res.Entries)
	}
}
