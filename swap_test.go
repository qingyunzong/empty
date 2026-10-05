package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
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
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

// setup builds parent/{app,new} where app is the live target with old
// content and new is the replacement tree.
func setup(t *testing.T) (parent, target, source string) {
	t.Helper()
	parent = t.TempDir()
	target = filepath.Join(parent, "app")
	source = filepath.Join(parent, "new")
	writeFile(t, filepath.Join(target, "version.txt"), "old")
	writeFile(t, filepath.Join(target, "data", "keep.txt"), "old-data")
	writeFile(t, filepath.Join(source, "version.txt"), "new")
	return parent, target, source
}

func assertSwapped(t *testing.T, parent, target, source string) {
	t.Helper()
	if got := readFile(t, filepath.Join(target, "version.txt")); got != "new" {
		t.Fatalf("target version.txt = %q, want new", got)
	}
	if _, err := os.Lstat(filepath.Join(target, "data")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("old subtree still present at target: %v", err)
	}
	entries, err := os.ReadDir(parent)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if e.Name() != "app" {
			t.Fatalf("leftover entry in parent: %s", e.Name())
		}
	}
	if lexists(source) {
		t.Fatal("source still exists after swap")
	}
}

func TestPublishHappyPath(t *testing.T) {
	parent, target, source := setup(t)
	if err := Publish(target, source); err != nil {
		t.Fatal(err)
	}
	assertSwapped(t, parent, target, source)
}

func TestPublishFreshTarget(t *testing.T) {
	parent := t.TempDir()
	target := filepath.Join(parent, "app")
	source := filepath.Join(parent, "new")
	writeFile(t, filepath.Join(source, "version.txt"), "new")
	if err := Publish(target, source); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, filepath.Join(target, "version.txt")); got != "new" {
		t.Fatalf("got %q", got)
	}
}

func TestPublishRejectsSymlinkInsideTarget(t *testing.T) {
	_, target, source := setup(t)
	outside := filepath.Join(t.TempDir(), "secret.txt")
	writeFile(t, outside, "secret")
	if err := os.Symlink(outside, filepath.Join(target, "data", "link")); err != nil {
		t.Fatal(err)
	}
	if err := Publish(target, source); !errors.Is(err, ErrSymlink) {
		t.Fatalf("err = %v, want ErrSymlink", err)
	}
	if got := readFile(t, filepath.Join(target, "version.txt")); got != "old" {
		t.Fatal("target modified after refusal")
	}
}

func TestPublishRejectsSymlinkTarget(t *testing.T) {
	parent := t.TempDir()
	real := filepath.Join(parent, "real")
	writeFile(t, filepath.Join(real, "version.txt"), "old")
	target := filepath.Join(parent, "app")
	if err := os.Symlink(real, target); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(parent, "new")
	writeFile(t, filepath.Join(source, "version.txt"), "new")
	if err := Publish(target, source); !errors.Is(err, ErrSymlink) {
		t.Fatalf("err = %v, want ErrSymlink", err)
	}
}

func TestPublishRejectsCrossFilesystemSource(t *testing.T) {
	_, target, _ := setup(t)
	// /proc/<pid> is a directory on procfs, a different filesystem.
	source := fmt.Sprintf("/proc/%d", os.Getpid())
	srcDev, err := deviceOf(source)
	if err != nil {
		t.Skip("procfs unavailable:", err)
	}
	parentDev, err := deviceOf(filepath.Dir(target))
	if err != nil {
		t.Fatal(err)
	}
	if srcDev == parentDev {
		t.Skip("procfs on same device as temp dir")
	}
	if err := Publish(target, source); !errors.Is(err, ErrCrossDevice) {
		t.Fatalf("err = %v, want ErrCrossDevice", err)
	}
}

var crashPoints = []string{
	"pre-stage", "post-stage",
	"pre-retire", "post-retire",
	"pre-publish", "post-publish",
}

// TestCrashBeforeAndAfterEachRename simulates a crash at every point
// around the three renames, then lets Recover finish the transaction.
func TestCrashBeforeAndAfterEachRename(t *testing.T) {
	for _, point := range crashPoints {
		t.Run(point, func(t *testing.T) {
			parent, target, source := setup(t)
			crashHook = func(p string) error {
				if p == point {
					return errors.New("simulated crash at " + p)
				}
				return nil
			}
			defer func() { crashHook = nil }()

			if err := Publish(target, source); err == nil {
				t.Fatal("expected crash error from Publish")
			}
			crashHook = nil
			if err := Recover(target); err != nil {
				t.Fatalf("recover: %v", err)
			}
			assertSwapped(t, parent, target, source)
		})
	}
}

// TestRecoverIsIdempotent crashes recovery itself, then recovers again.
func TestRecoverIsIdempotent(t *testing.T) {
	parent, target, source := setup(t)
	crashHook = func(p string) error {
		if p == "post-retire" {
			return errors.New("simulated crash")
		}
		return nil
	}
	if err := Publish(target, source); err == nil {
		t.Fatal("expected crash error")
	}
	// First recovery attempt crashes too.
	if err := Recover(target); err == nil {
		t.Fatal("expected crash error from Recover")
	}
	crashHook = nil
	if err := Recover(target); err != nil {
		t.Fatalf("second recover: %v", err)
	}
	assertSwapped(t, parent, target, source)
}

// TestPublishRefusesWhilePending ensures a restart cannot begin a new
// transaction over an unfinished one.
func TestPublishRefusesWhilePending(t *testing.T) {
	_, target, source := setup(t)
	crashHook = func(p string) error {
		if p == "post-stage" {
			return errors.New("simulated crash")
		}
		return nil
	}
	if err := Publish(target, source); err == nil {
		t.Fatal("expected crash error")
	}
	crashHook = nil

	other := filepath.Join(filepath.Dir(target), "other")
	writeFile(t, filepath.Join(other, "version.txt"), "other")
	if err := Publish(target, other); !errors.Is(err, ErrPendingTransaction) {
		t.Fatalf("err = %v, want ErrPendingTransaction", err)
	}
	if err := Recover(target); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, filepath.Join(target, "version.txt")); got != "new" {
		t.Fatalf("recover completed the wrong transaction, got %q", got)
	}
}

// TestRecoverWithoutPending fails cleanly when there is no journal.
func TestRecoverWithoutPending(t *testing.T) {
	_, target, _ := setup(t)
	if err := Recover(target); err == nil {
		t.Fatal("expected error, got nil")
	}
}

// TestRecoverRefusesForgedJournalPointingOutside plants a journal whose
// retired path names an external directory and verifies recovery
// refuses and deletes nothing.
func TestRecoverRefusesForgedJournalPointingOutside(t *testing.T) {
	parent, target, _ := setup(t)
	external := t.TempDir()
	writeFile(t, filepath.Join(external, "important.txt"), "do-not-delete")

	j := &journal{
		ID:      "deadbeefcafe0001",
		Source:  filepath.Join(parent, "new"),
		Target:  target,
		Staging: filepath.Join(parent, stagingName("app", "deadbeefcafe0001")),
		Retired: external, // forged: outside the transaction
		Phase:   phaseRetired,
	}
	jp := journalPathFor(target)
	if err := writeJournal(jp, j); err != nil {
		t.Fatal(err)
	}
	if err := Recover(target); !errors.Is(err, errCorruptJournal) {
		t.Fatalf("err = %v, want errCorruptJournal", err)
	}
	if got := readFile(t, filepath.Join(external, "important.txt")); got != "do-not-delete" {
		t.Fatal("external path was modified")
	}
}

// TestRecoverRefusesSymlinkAtRetiredPath plants a symlink where the
// retired directory is expected; recovery must not follow or delete
// through it.
func TestRecoverRefusesSymlinkAtRetiredPath(t *testing.T) {
	parent, target, source := setup(t)
	external := t.TempDir()
	writeFile(t, filepath.Join(external, "important.txt"), "do-not-delete")

	crashHook = func(p string) error {
		if p == "post-stage" {
			return errors.New("simulated crash")
		}
		return nil
	}
	if err := Publish(target, source); err == nil {
		t.Fatal("expected crash error")
	}
	crashHook = nil

	// Move the real target away and plant a symlink at the retired path.
	jp := journalPathFor(target)
	j, err := loadJournal(jp)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(j.Target, filepath.Join(parent, "hidden-old")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(external, j.Retired); err != nil {
		t.Fatal(err)
	}
	if err := Recover(target); err == nil {
		t.Fatal("expected refusal, got nil")
	}
	if got := readFile(t, filepath.Join(external, "important.txt")); got != "do-not-delete" {
		t.Fatal("external path was modified through planted symlink")
	}
}

// TestJournalSurvivesRestart simulates a full process restart by
// reloading the journal from disk between crash and recovery.
func TestJournalSurvivesRestart(t *testing.T) {
	parent, target, source := setup(t)
	crashHook = func(p string) error {
		if p == "post-publish" {
			return errors.New("simulated crash")
		}
		return nil
	}
	if err := Publish(target, source); err == nil {
		t.Fatal("expected crash error")
	}
	crashHook = nil

	j, err := loadJournal(journalPathFor(target))
	if err != nil {
		t.Fatal(err)
	}
	// The crash hit after the publish rename but before the journal
	// update, so the journal legitimately lags one step behind the
	// filesystem; recovery must reconcile from the on-disk state.
	if j.Phase != phaseRetired {
		t.Fatalf("journal phase = %q, want %q", j.Phase, phaseRetired)
	}
	if err := Recover(target); err != nil {
		t.Fatal(err)
	}
	assertSwapped(t, parent, target, source)
}
