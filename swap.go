package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sync/atomic"
	"syscall"
	"time"
)

var (
	// ErrPendingTransaction is returned by Publish when an unfinished
	// transaction journal exists. Only Recover may finish it; a new
	// transaction is never started on top of a pending one.
	ErrPendingTransaction = errors.New("dirswap: pending transaction exists; run recover")
	// ErrCrossDevice is returned when source or target live on a
	// different filesystem than the target's parent directory, where
	// the atomic renames happen.
	ErrCrossDevice = errors.New("dirswap: cross-filesystem swap refused")
	// ErrSymlink is returned when the target is, or contains, a
	// symbolic link.
	ErrSymlink = errors.New("dirswap: symbolic link in target refused")
)

// crashHook, when non-nil, is invoked at each labelled point around the
// renames of a transaction. Tests use it to simulate a crash; returning
// an error aborts the transaction immediately, leaving on-disk state
// exactly as a real crash would.
var crashHook func(point string) error

func hook(point string) error {
	if crashHook == nil {
		return nil
	}
	return crashHook(point)
}

func lexists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

func deviceOf(path string) (uint64, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, errors.New("dirswap: cannot determine filesystem device")
	}
	return uint64(st.Dev), nil
}

// containsSymlink reports whether root is, or anywhere beneath it
// contains, a symbolic link. WalkDir uses Lstat and never follows
// links, so every entry is inspected directly.
func containsSymlink(root string) (bool, error) {
	found := false
	err := filepath.WalkDir(root, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.Type()&fs.ModeSymlink != 0 {
			found = true
			return filepath.SkipAll
		}
		return nil
	})
	return found, err
}

var idCounter atomic.Uint64

// newID returns a unique-enough transaction ID: nanosecond timestamp,
// PID and a process-local counter. It only needs to make the staging
// and retired directory names unique within the target's parent.
func newID() string {
	return fmt.Sprintf("%x-%x-%x", time.Now().UnixNano(), os.Getpid(), idCounter.Add(1))
}

// Publish atomically replaces the directory at target with the
// directory at source, journalling intent so a crash at any point can
// be completed by Recover. Source must be a sibling of target on the
// same filesystem. The old target is retired and deleted only after
// the new tree is in place.
func Publish(target, source string) error {
	absTarget, err := filepath.Abs(target)
	if err != nil {
		return err
	}
	absSource, err := filepath.Abs(source)
	if err != nil {
		return err
	}
	target = filepath.Clean(absTarget)
	source = filepath.Clean(absSource)
	parent := filepath.Dir(target)
	base := filepath.Base(target)

	if source == target {
		return errors.New("dirswap: source and target are the same path")
	}

	jp := journalPathFor(target)
	if lexists(jp) {
		return ErrPendingTransaction
	}

	srcFI, err := os.Stat(source)
	if err != nil {
		return fmt.Errorf("dirswap: source: %w", err)
	}
	if !srcFI.IsDir() {
		return fmt.Errorf("dirswap: source %q is not a directory", source)
	}

	parentDev, err := deviceOf(parent)
	if err != nil {
		return err
	}
	srcDev, err := deviceOf(source)
	if err != nil {
		return err
	}
	if srcDev != parentDev {
		return fmt.Errorf("%w: source %q is on a different filesystem", ErrCrossDevice, source)
	}

	if lexists(target) {
		tgtFI, err := os.Lstat(target)
		if err != nil {
			return err
		}
		if tgtFI.Mode()&fs.ModeSymlink != 0 {
			return fmt.Errorf("%w: target %q is itself a symlink", ErrSymlink, target)
		}
		if !tgtFI.IsDir() {
			return fmt.Errorf("dirswap: target %q is not a directory", target)
		}
		tgtDev, err := deviceOf(target)
		if err != nil {
			return err
		}
		if tgtDev != parentDev {
			return fmt.Errorf("%w: target %q is a mount point on another filesystem", ErrCrossDevice, target)
		}
		has, err := containsSymlink(target)
		if err != nil {
			return err
		}
		if has {
			return fmt.Errorf("%w: target %q contains a symbolic link", ErrSymlink, target)
		}
	}

	id := newID()
	j := &journal{
		ID:      id,
		Source:  source,
		Target:  target,
		Staging: filepath.Join(parent, stagingName(base, id)),
		Retired: filepath.Join(parent, retiredName(base, id)),
		Phase:   phaseInit,
	}
	if err := writeJournal(jp, j); err != nil {
		return err
	}
	return execute(jp, j)
}

// Recover finishes the pending transaction recorded in the journal
// next to target. It completes exactly the recorded transaction and
// refuses to touch anything the journal cannot prove is its own.
func Recover(target string) error {
	absTarget, err := filepath.Abs(target)
	if err != nil {
		return err
	}
	target = filepath.Clean(absTarget)
	jp := journalPathFor(target)
	j, err := loadJournal(jp)
	if errors.Is(err, fs.ErrNotExist) {
		return errors.New("dirswap: no pending transaction for target")
	}
	if err != nil {
		return err
	}
	return execute(jp, j)
}

// execute drives a transaction to completion. It trusts the filesystem
// over the recorded phase: a crash between a rename and the journal
// update leaves the disk one step ahead, and recovery simply continues
// from the observed state. Every step is idempotent.
func execute(jp string, j *journal) error {
	parent := filepath.Dir(j.Target)

	setPhase := func(phase string) error {
		j.Phase = phase
		return writeJournal(jp, j)
	}

	// Step 1: stage the new tree next to the target.
	if err := hook("pre-stage"); err != nil {
		return err
	}
	if !lexists(j.Staging) && lexists(j.Source) {
		if err := os.Rename(j.Source, j.Staging); err != nil {
			return err
		}
		if err := syncDir(parent); err != nil {
			return err
		}
	}
	if err := hook("post-stage"); err != nil {
		return err
	}
	if lexists(j.Staging) && j.Phase == phaseInit {
		if err := setPhase(phaseStaged); err != nil {
			return err
		}
	}

	// Step 2: retire the old target.
	if err := hook("pre-retire"); err != nil {
		return err
	}
	if lexists(j.Target) && !lexists(j.Retired) && lexists(j.Staging) {
		if err := os.Rename(j.Target, j.Retired); err != nil {
			return err
		}
		if err := syncDir(parent); err != nil {
			return err
		}
	}
	if err := hook("post-retire"); err != nil {
		return err
	}
	if (lexists(j.Retired) || !lexists(j.Target)) && phaseRank(j.Phase) < phaseRank(phaseRetired) {
		if err := setPhase(phaseRetired); err != nil {
			return err
		}
	}

	// Step 3: publish the staged tree onto the target path.
	if err := hook("pre-publish"); err != nil {
		return err
	}
	if !lexists(j.Target) && lexists(j.Staging) {
		if err := os.Rename(j.Staging, j.Target); err != nil {
			return err
		}
		if err := syncDir(parent); err != nil {
			return err
		}
	}
	if err := hook("post-publish"); err != nil {
		return err
	}
	if lexists(j.Target) && !lexists(j.Staging) && phaseRank(j.Phase) < phaseRank(phasePublished) {
		if err := setPhase(phasePublished); err != nil {
			return err
		}
	}

	// Step 4: delete the retired old tree, but only the exact path
	// this transaction derived from its own ID — never anything else.
	if lexists(j.Retired) && !lexists(j.Staging) {
		if err := removeRetired(j); err != nil {
			return err
		}
		if err := syncDir(parent); err != nil {
			return err
		}
	}

	// Final consistency check before closing the transaction.
	if !lexists(j.Target) || lexists(j.Staging) || lexists(j.Retired) {
		return fmt.Errorf("dirswap: inconsistent state for transaction %s; manual inspection required", j.ID)
	}
	if err := os.Remove(jp); err != nil {
		return err
	}
	return syncDir(parent)
}

// removeRetired deletes the retired old tree with defence in depth:
// the path must equal the one derived from the transaction ID, must
// sit directly in the target's parent, must be a real directory (not a
// symlink), and must contain no symlinks. os.RemoveAll never follows
// symlinks, but we verify anyway so a forged or corrupted journal can
// never cause an external path to be deleted.
func removeRetired(j *journal) error {
	parent := filepath.Dir(j.Target)
	base := filepath.Base(j.Target)
	want := filepath.Join(parent, retiredName(base, j.ID))
	if j.Retired != want {
		return fmt.Errorf("%w: refusing to delete %q", errCorruptJournal, j.Retired)
	}
	fi, err := os.Lstat(j.Retired)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !fi.IsDir() || fi.Mode()&fs.ModeSymlink != 0 {
		return fmt.Errorf("dirswap: refusing to delete %q: not a real directory", j.Retired)
	}
	has, err := containsSymlink(j.Retired)
	if err != nil {
		return err
	}
	if has {
		return fmt.Errorf("dirswap: refusing to delete %q: contains a symbolic link", j.Retired)
	}
	return os.RemoveAll(j.Retired)
}
