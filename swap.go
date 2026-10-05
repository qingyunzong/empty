package main

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
)

// deviceOf returns the device ID of the filesystem containing path.
// It is a variable so tests can simulate cross-filesystem scenarios.
var deviceOf = func(path string) (uint64, error) {
	info, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, fmt.Errorf("cannot determine device of %s", path)
	}
	return uint64(st.Dev), nil
}

// update replaces target with source using a crash-safe staged swap.
// If a journal already exists for target, a previous transaction is
// still pending and only that same transaction may be completed.
func update(target, source string) error {
	target, err := filepath.Abs(target)
	if err != nil {
		return err
	}
	source, err = filepath.Abs(source)
	if err != nil {
		return err
	}

	jPath := journalPath(target)
	if _, err := os.Lstat(jPath); err == nil {
		j, _ := readJournal(jPath)
		txid := "unknown"
		if j != nil {
			txid = j.TxID
		}
		return fmt.Errorf("transaction %s is already pending for %s; run 'dirswap recover --target %s' to finish exactly that transaction", txid, target, target)
	}

	srcInfo, err := os.Stat(source)
	if err != nil {
		return fmt.Errorf("source: %w", err)
	}
	if !srcInfo.IsDir() {
		return fmt.Errorf("source %s is not a directory", source)
	}

	parent := filepath.Dir(target)
	if _, err := os.Stat(parent); err != nil {
		return fmt.Errorf("target parent: %w", err)
	}

	// The target itself must never be a symlink: renaming or removing
	// through it could affect an external path.
	if info, err := os.Lstat(target); err == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("refusing: target %s is a symlink", target)
		}
		if !info.IsDir() {
			return fmt.Errorf("refusing: target %s exists and is not a directory", target)
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}

	nSymlinks, err := countSymlinks(target)
	if err != nil {
		return err
	}

	srcDev, err := deviceOf(source)
	if err != nil {
		return err
	}
	parentDev, err := deviceOf(parent)
	if err != nil {
		return err
	}
	crossFS := srcDev != parentDev

	// Refuse the dangerous combination: a target tree containing
	// symlinks whose replacement would cross filesystem boundaries.
	if nSymlinks > 0 && crossFS {
		return fmt.Errorf("refusing: target %s contains %d symlink(s) and the update crosses filesystems (source device %d, target device %d)", target, nSymlinks, srcDev, parentDev)
	}

	txid, err := newTxID()
	if err != nil {
		return err
	}
	j := &Journal{
		TxID:    txid,
		Target:  target,
		Staging: stagingPath(target, txid),
		Retired: retiredPath(target, txid),
		Phase:   PhaseStaged,
	}

	// Remove staging leftovers from transactions that died before
	// their first journal write. Only our own derived naming pattern
	// inside the target's parent is touched.
	if err := removeStaleStaging(target); err != nil {
		return err
	}

	if err := copyTree(source, j.Staging); err != nil {
		os.RemoveAll(j.Staging)
		return fmt.Errorf("staging: %w", err)
	}
	// First durable intent record: staging is complete.
	if err := writeJournal(j, jPath); err != nil {
		os.RemoveAll(j.Staging)
		return err
	}

	return resume(j, jPath)
}

// recover completes the pending transaction recorded for target.
// It can only resume the exact same transaction: the journal paths
// are validated to be derived from target and its recorded txid.
func recover(target string) error {
	target, err := filepath.Abs(target)
	if err != nil {
		return err
	}
	jPath := journalPath(target)
	j, err := readJournal(jPath)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("no pending transaction for %s", target)
		}
		return err
	}
	if err := validateJournal(j, target); err != nil {
		return fmt.Errorf("refusing to recover from untrusted journal: %w", err)
	}
	return resume(j, jPath)
}

// resume drives a transaction to completion from whatever phase its
// journal records. Every step is idempotent because renames are
// atomic and the phase is persisted before each rename.
func resume(j *Journal, jPath string) error {
	// Step 1: ensure the old target has been retired.
	if phaseRank[j.Phase] <= phaseRank[PhaseRetireIntent] {
		retiredExists := exists(j.Retired)
		targetExists := exists(j.Target)
		switch {
		case retiredExists && !targetExists:
			// Rename happened but the journal update did not.
		case targetExists:
			if err := setPhase(j, jPath, PhaseRetireIntent); err != nil {
				return err
			}
			if err := os.Rename(j.Target, j.Retired); err != nil {
				return fmt.Errorf("retire: %w", err)
			}
		case !targetExists && !retiredExists:
			// Fresh install: there was never anything to retire.
		}
		if err := setPhase(j, jPath, PhaseRetired); err != nil {
			return err
		}
	}

	// Step 2: ensure the staged directory has been published.
	if phaseRank[j.Phase] <= phaseRank[PhasePublishIntent] {
		stagingExists := exists(j.Staging)
		targetExists := exists(j.Target)
		switch {
		case targetExists && !stagingExists:
			// Publish rename happened but the journal update did not.
		case stagingExists:
			if exists(j.Target) {
				return fmt.Errorf("cannot publish: both staging %s and target %s exist", j.Staging, j.Target)
			}
			if err := setPhase(j, jPath, PhasePublishIntent); err != nil {
				return err
			}
			if err := os.Rename(j.Staging, j.Target); err != nil {
				return fmt.Errorf("publish: %w", err)
			}
		default:
			return fmt.Errorf("cannot publish: staging %s is missing", j.Staging)
		}
		if err := setPhase(j, jPath, PhasePublished); err != nil {
			return err
		}
	}

	// Step 3: retire the old tree and close the transaction.
	if err := safeRemoveAll(j.Retired); err != nil {
		return fmt.Errorf("cleanup: %w", err)
	}
	if err := os.Remove(jPath); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return fsyncDir(filepath.Dir(jPath))
}

// safeRemoveAll removes root without ever following symlinks and
// only after confirming root itself is a real directory (not a
// symlink to an external path).
func safeRemoveAll(root string) error {
	info, err := os.Lstat(root)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return fmt.Errorf("refusing to remove %s: not a real directory", root)
	}
	// os.RemoveAll never follows symlinks; entries inside the tree
	// that are symlinks are unlinked, not traversed.
	return os.RemoveAll(root)
}

// countSymlinks walks target without following symlinks and counts
// symlink entries. A missing target yields zero.
func countSymlinks(target string) (int, error) {
	count := 0
	err := filepath.WalkDir(target, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) && path == target {
				return nil
			}
			return err
		}
		if d.Type()&os.ModeSymlink != 0 {
			count++
		}
		return nil
	})
	return count, err
}

// copyTree recursively copies src to dst, preserving file modes and
// reproducing symlinks as symlinks (never following them).
func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		to := filepath.Join(dst, rel)
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		switch {
		case info.Mode()&os.ModeSymlink != 0:
			link, err := os.Readlink(path)
			if err != nil {
				return err
			}
			return os.Symlink(link, to)
		case info.IsDir():
			return os.MkdirAll(to, info.Mode().Perm())
		case info.Mode().IsRegular():
			return copyFile(path, to, info.Mode().Perm())
		default:
			return fmt.Errorf("unsupported file type in source: %s", path)
		}
	})
}

func copyFile(src, dst string, perm fs.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, perm)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Sync(); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// removeStaleStaging deletes staging directories left behind by
// transactions that crashed before writing their first journal
// record. Only directories matching our derived naming pattern in
// the target's parent are candidates, and symlinks are never
// followed or removed recursively through.
func removeStaleStaging(target string) error {
	parent := filepath.Dir(target)
	base := filepath.Base(target)
	entries, err := os.ReadDir(parent)
	if err != nil {
		return err
	}
	prefix := "." + base + ".dirswap-staging-"
	for _, e := range entries {
		name := e.Name()
		if len(name) <= len(prefix) || name[:len(prefix)] != prefix {
			continue
		}
		suffix := name[len(prefix):]
		if !txidPattern.MatchString(suffix) {
			continue
		}
		path := filepath.Join(parent, name)
		info, err := os.Lstat(path)
		if err != nil {
			continue
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			continue
		}
		if err := os.RemoveAll(path); err != nil {
			return err
		}
	}
	return nil
}

func exists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}
