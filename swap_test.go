package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// setupTargetSource builds parent/target (old content) and source
// (new content) under a temp dir and returns the paths.
func setupTargetSource(t *testing.T) (target, source string) {
	t.Helper()
	root := t.TempDir()
	target = filepath.Join(root, "app")
	source = filepath.Join(root, "newapp")
	writeFile(t, filepath.Join(target, "bin", "tool"), "old-binary")
	writeFile(t, filepath.Join(target, "VERSION"), "1")
	writeFile(t, filepath.Join(source, "bin", "tool"), "new-binary")
	writeFile(t, filepath.Join(source, "VERSION"), "2")
	return target, source
}

// assertSwapped verifies the transaction completed fully: new content
// published, no journal/staging/retired leftovers.
func assertSwapped(t *testing.T, target string) {
	t.Helper()
	if got := readFile(t, filepath.Join(target, "VERSION")); got != "2" {
		t.Fatalf("target VERSION = %q, want new content", got)
	}
	if got := readFile(t, filepath.Join(target, "bin", "tool")); got != "new-binary" {
		t.Fatalf("target tool = %q, want new content", got)
	}
	parent := filepath.Dir(target)
	entries, err := os.ReadDir(parent)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.Contains(e.Name(), "dirswap") {
			t.Fatalf("leftover transaction artifact: %s", e.Name())
		}
	}
}

func TestUpdateHappyPath(t *testing.T) {
	target, source := setupTargetSource(t)
	if err := update(target, source); err != nil {
		t.Fatal(err)
	}
	assertSwapped(t, target)
}

func TestUpdateFreshInstall(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "app")
	source := filepath.Join(root, "newapp")
	writeFile(t, filepath.Join(source, "VERSION"), "2")
	writeFile(t, filepath.Join(source, "bin", "tool"), "new-binary")
	if err := update(target, source); err != nil {
		t.Fatal(err)
	}
	assertSwapped(t, target)
}

func TestRefuseSymlinkCrossFilesystem(t *testing.T) {
	target, source := setupTargetSource(t)
	if err := os.Symlink("/etc/hostname", filepath.Join(target, "link")); err != nil {
		t.Fatal(err)
	}
	// Simulate source living on a different filesystem.
	orig := deviceOf
	deviceOf = func(path string) (uint64, error) {
		if path == source {
			return 111, nil
		}
		return 222, nil
	}
	defer func() { deviceOf = orig }()

	err := update(target, source)
	if err == nil || !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("expected symlink+cross-fs refusal, got %v", err)
	}
	// Target must be untouched.
	if got := readFile(t, filepath.Join(target, "VERSION")); got != "1" {
		t.Fatal("target modified despite refusal")
	}
}

func TestAllowSymlinkSameFilesystem(t *testing.T) {
	target, source := setupTargetSource(t)
	if err := os.Symlink("VERSION", filepath.Join(target, "link")); err != nil {
		t.Fatal(err)
	}
	if err := update(target, source); err != nil {
		t.Fatal(err)
	}
	assertSwapped(t, target)
}

func TestRefuseTargetIsSymlink(t *testing.T) {
	root := t.TempDir()
	real := filepath.Join(root, "real")
	writeFile(t, filepath.Join(real, "VERSION"), "1")
	target := filepath.Join(root, "app")
	if err := os.Symlink(real, target); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(root, "newapp")
	writeFile(t, filepath.Join(source, "VERSION"), "2")
	if err := update(target, source); err == nil {
		t.Fatal("expected refusal for symlink target")
	}
}

func TestPendingTransactionBlocksNewUpdate(t *testing.T) {
	target, source := setupTargetSource(t)
	j := &Journal{
		TxID:    "0123456789abcdef",
		Target:  target,
		Staging: stagingPath(target, "0123456789abcdef"),
		Retired: retiredPath(target, "0123456789abcdef"),
		Phase:   PhaseStaged,
	}
	if err := writeJournal(j, journalPath(target)); err != nil {
		t.Fatal(err)
	}
	err := update(target, source)
	if err == nil || !strings.Contains(err.Error(), "pending") {
		t.Fatalf("expected pending-transaction refusal, got %v", err)
	}
}

// TestRecoverFromEveryCrashPoint simulates a crash before and after
// every rename in the transaction and verifies recovery completes
// exactly the same transaction.
func TestRecoverFromEveryCrashPoint(t *testing.T) {
	const txid = "aaaabbbbccccdddd"
	cases := []struct {
		name  string
		phase string
		// setup arranges the filesystem as it would look after the crash.
		setup func(t *testing.T, target, staging, retired string)
	}{
		{"AfterStaging", PhaseStaged, func(t *testing.T, target, staging, retired string) {
			// staging exists, old target still in place
		}},
		{"BeforeRetireRename", PhaseRetireIntent, func(t *testing.T, target, staging, retired string) {
			// rename not yet done: target still present
		}},
		{"AfterRetireRename", PhaseRetireIntent, func(t *testing.T, target, staging, retired string) {
			// rename done, journal update lost
			if err := os.Rename(target, retired); err != nil {
				t.Fatal(err)
			}
		}},
		{"AfterRetireRecorded", PhaseRetired, func(t *testing.T, target, staging, retired string) {
			if err := os.Rename(target, retired); err != nil {
				t.Fatal(err)
			}
		}},
		{"BeforePublishRename", PhasePublishIntent, func(t *testing.T, target, staging, retired string) {
			if err := os.Rename(target, retired); err != nil {
				t.Fatal(err)
			}
		}},
		{"AfterPublishRename", PhasePublishIntent, func(t *testing.T, target, staging, retired string) {
			if err := os.Rename(target, retired); err != nil {
				t.Fatal(err)
			}
			if err := os.Rename(staging, target); err != nil {
				t.Fatal(err)
			}
		}},
		{"AfterPublishRecorded", PhasePublished, func(t *testing.T, target, staging, retired string) {
			if err := os.Rename(target, retired); err != nil {
				t.Fatal(err)
			}
			if err := os.Rename(staging, target); err != nil {
				t.Fatal(err)
			}
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			target, source := setupTargetSource(t)
			staging := stagingPath(target, txid)
			retired := retiredPath(target, txid)
			// Stage the new tree as the crashed transaction had.
			if err := copyTree(source, staging); err != nil {
				t.Fatal(err)
			}
			tc.setup(t, target, staging, retired)
			j := &Journal{
				TxID:    txid,
				Target:  target,
				Staging: staging,
				Retired: retired,
				Phase:   tc.phase,
			}
			if err := writeJournal(j, journalPath(target)); err != nil {
				t.Fatal(err)
			}
			if err := recover(target); err != nil {
				t.Fatal(err)
			}
			assertSwapped(t, target)
		})
	}
}

func TestRecoverRefusesExternalPaths(t *testing.T) {
	target, _ := setupTargetSource(t)
	external := t.TempDir()
	writeFile(t, filepath.Join(external, "keep.txt"), "precious")

	j := &Journal{
		TxID:    "0123456789abcdef",
		Target:  target,
		Staging: stagingPath(target, "0123456789abcdef"),
		Retired: external, // tampered: points outside the target's parent
		Phase:   PhasePublished,
	}
	if err := writeJournal(j, journalPath(target)); err != nil {
		t.Fatal(err)
	}
	err := recover(target)
	if err == nil || !strings.Contains(err.Error(), "untrusted") {
		t.Fatalf("expected untrusted-journal refusal, got %v", err)
	}
	if got := readFile(t, filepath.Join(external, "keep.txt")); got != "precious" {
		t.Fatal("external path was modified")
	}
}

func TestRecoverRefusesInvalidTxID(t *testing.T) {
	target, _ := setupTargetSource(t)
	j := &Journal{
		TxID:    "../..",
		Target:  target,
		Staging: filepath.Join(filepath.Dir(target), "staging"),
		Retired: filepath.Join(filepath.Dir(target), "retired"),
		Phase:   PhasePublished,
	}
	if err := writeJournal(j, journalPath(target)); err != nil {
		t.Fatal(err)
	}
	if err := recover(target); err == nil {
		t.Fatal("expected refusal for invalid txid")
	}
}

func TestCleanupDoesNotFollowSymlinks(t *testing.T) {
	target, source := setupTargetSource(t)
	txid := "ffffeeeeddddcccc"
	staging := stagingPath(target, txid)
	retired := retiredPath(target, txid)
	if err := copyTree(source, staging); err != nil {
		t.Fatal(err)
	}
	external := t.TempDir()
	writeFile(t, filepath.Join(external, "keep.txt"), "precious")
	// Retired tree contains a symlink pointing outside.
	if err := os.Rename(target, retired); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(external, filepath.Join(retired, "escape")); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(staging, target); err != nil {
		t.Fatal(err)
	}
	j := &Journal{TxID: txid, Target: target, Staging: staging, Retired: retired, Phase: PhasePublished}
	if err := writeJournal(j, journalPath(target)); err != nil {
		t.Fatal(err)
	}
	if err := recover(target); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, filepath.Join(external, "keep.txt")); got != "precious" {
		t.Fatal("cleanup followed a symlink and deleted external content")
	}
	assertSwapped(t, target)
}

func TestStaleStagingCleanedOnNewUpdate(t *testing.T) {
	target, source := setupTargetSource(t)
	// Leftover from a transaction that died before its first journal write.
	stale := stagingPath(target, "1111222233334444")
	writeFile(t, filepath.Join(stale, "partial"), "junk")
	if err := update(target, source); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(stale); !os.IsNotExist(err) {
		t.Fatal("stale staging directory was not cleaned")
	}
	assertSwapped(t, target)
}

func TestRecoverWithoutPendingTransaction(t *testing.T) {
	root := t.TempDir()
	if err := recover(filepath.Join(root, "app")); err == nil {
		t.Fatal("expected error when no transaction is pending")
	}
}
