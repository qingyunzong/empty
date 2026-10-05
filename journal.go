package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Transaction phases recorded in the persistent intent journal.
const (
	phaseInit      = "init"      // journal created, nothing renamed yet
	phaseStaged    = "staged"    // source renamed into the staging path
	phaseRetired   = "retired"   // old target renamed into the retired path
	phasePublished = "published" // staging renamed onto the target path
)

// journal is the persistent intent record for one directory-swap
// transaction. It is written (write-fsync-rename + directory fsync)
// before the first rename and updated after every completed step, so a
// crash at any point leaves enough state on disk to finish exactly this
// transaction — and no other.
type journal struct {
	ID      string `json:"id"`
	Source  string `json:"source"`
	Target  string `json:"target"`
	Staging string `json:"staging"`
	Retired string `json:"retired"`
	Phase   string `json:"phase"`
}

var errCorruptJournal = errors.New("dirswap: corrupt or foreign journal")

// phaseRank orders the transaction phases; the recorded phase is
// informational only (the filesystem is the source of truth), but
// ranking avoids re-writing older states over newer ones.
func phaseRank(phase string) int {
	switch phase {
	case phaseInit:
		return 0
	case phaseStaged:
		return 1
	case phaseRetired:
		return 2
	case phasePublished:
		return 3
	}
	return -1
}

func journalPathFor(target string) string {
	parent := filepath.Dir(target)
	base := filepath.Base(target)
	return filepath.Join(parent, "."+base+".dirswap.journal")
}

func stagingName(base, id string) string { return "." + base + ".staging-" + id }
func retiredName(base, id string) string { return "." + base + ".retired-" + id }

// validatePins every path in the journal to the target's parent
// directory and to the exact names derived from the transaction ID.
// Anything else means the journal is corrupt or forged; recovery must
// refuse to act on it so no external path can ever be renamed away or
// deleted.
func (j *journal) validate() error {
	if j.ID == "" || strings.ContainsAny(j.ID, `/\`) {
		return fmt.Errorf("%w: bad transaction id %q", errCorruptJournal, j.ID)
	}
	parent := filepath.Dir(j.Target)
	base := filepath.Base(j.Target)
	if base == "." || base == string(filepath.Separator) || base == "" {
		return fmt.Errorf("%w: bad target %q", errCorruptJournal, j.Target)
	}
	if !filepath.IsAbs(j.Source) || j.Source == j.Target {
		return fmt.Errorf("%w: bad source %q", errCorruptJournal, j.Source)
	}
	wantStaging := filepath.Join(parent, stagingName(base, j.ID))
	wantRetired := filepath.Join(parent, retiredName(base, j.ID))
	if j.Staging != wantStaging {
		return fmt.Errorf("%w: staging path %q, want %q", errCorruptJournal, j.Staging, wantStaging)
	}
	if j.Retired != wantRetired {
		return fmt.Errorf("%w: retired path %q, want %q", errCorruptJournal, j.Retired, wantRetired)
	}
	switch j.Phase {
	case phaseInit, phaseStaged, phaseRetired, phasePublished:
	default:
		return fmt.Errorf("%w: unknown phase %q", errCorruptJournal, j.Phase)
	}
	return nil
}

func writeJournal(path string, j *journal) error {
	data, err := json.MarshalIndent(j, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	return syncDir(filepath.Dir(path))
}

func loadJournal(path string) (*journal, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var j journal
	if err := json.Unmarshal(data, &j); err != nil {
		return nil, fmt.Errorf("%w: %v", errCorruptJournal, err)
	}
	if err := j.validate(); err != nil {
		return nil, err
	}
	return &j, nil
}

func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
