package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCLIPackUnpack(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src")
	if err := os.MkdirAll(src, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "a.txt"), []byte("cli"), 0o644); err != nil {
		t.Fatal(err)
	}
	arc := filepath.Join(dir, "out.tar")
	dest := filepath.Join(dir, "restored")

	if err := run([]string{"pack", src, arc}); err != nil {
		t.Fatalf("pack: %v", err)
	}
	if err := run([]string{"unpack", arc, dest}); err != nil {
		t.Fatalf("unpack: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(dest, "a.txt"))
	if err != nil || string(got) != "cli" {
		t.Fatalf("restored = %q, %v", got, err)
	}
}

func TestCLIBadUsage(t *testing.T) {
	if err := run(nil); err == nil {
		t.Fatal("run(nil) succeeded, want usage error")
	}
	if err := run([]string{"bogus", "a", "b"}); err == nil {
		t.Fatal("run(bogus) succeeded, want error")
	}
}
