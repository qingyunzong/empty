package main

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
)

// Transaction phases recorded in the persistent intent journal.
// A phase is always persisted BEFORE the filesystem mutation it
// authorizes, so a crash at any point leaves enough information to
// resume exactly the same transaction.
const (
	PhaseStaged        = "staged"         // staging copy complete, nothing renamed yet
	PhaseRetireIntent  = "retire-intent"  // about to rename target -> retired
	PhaseRetired       = "retired"        // target -> retired rename done
	PhasePublishIntent = "publish-intent" // about to rename staging -> target
	PhasePublished     = "published"      // staging -> target rename done
)

var phaseRank = map[string]int{
	PhaseStaged:        1,
	PhaseRetireIntent:  2,
	PhaseRetired:       3,
	PhasePublishIntent: 4,
	PhasePublished:     5,
}

// Journal is the persistent intent record for one swap transaction.
type Journal struct {
	TxID    string `json:"txid"`
	Target  string `json:"target"`
	Staging string `json:"staging"`
	Retired string `json:"retired"`
	Phase   string `json:"phase"`
}

var txidPattern = regexp.MustCompile(`^[0-9a-f]{16}$`)

func newTxID() (string, error) {
	// crypto/rand is unavailable in this toolchain's stdlib, so read
	// the kernel CSPRNG directly.
	f, err := os.Open("/dev/urandom")
	if err != nil {
		return "", err
	}
	defer f.Close()
	var b [8]byte
	if _, err := io.ReadFull(f, b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

// journalPath derives the journal location from the target directory.
func journalPath(target string) string {
	parent := filepath.Dir(target)
	base := filepath.Base(target)
	return filepath.Join(parent, "."+base+".dirswap-journal.json")
}

// stagingPath and retiredPath derive transaction paths from target+txid.
// Deriving (never inventing) paths is what keeps recovery from ever
// touching anything outside the target's parent directory.
func stagingPath(target, txid string) string {
	parent := filepath.Dir(target)
	base := filepath.Base(target)
	return filepath.Join(parent, "."+base+".dirswap-staging-"+txid)
}

func retiredPath(target, txid string) string {
	parent := filepath.Dir(target)
	base := filepath.Base(target)
	return filepath.Join(parent, "."+base+".dirswap-retired-"+txid)
}

// validateJournal ensures a loaded journal can only refer to paths
// derived from the given target directory. This is the guard that
// prevents recovery from deleting or renaming external paths.
func validateJournal(j *Journal, target string) error {
	if !txidPattern.MatchString(j.TxID) {
		return fmt.Errorf("journal has invalid txid %q", j.TxID)
	}
	if _, ok := phaseRank[j.Phase]; !ok {
		return fmt.Errorf("journal has unknown phase %q", j.Phase)
	}
	if filepath.Clean(j.Target) != filepath.Clean(target) {
		return fmt.Errorf("journal target %q does not match %q", j.Target, target)
	}
	if filepath.Clean(j.Staging) != stagingPath(target, j.TxID) {
		return fmt.Errorf("journal staging path %q is not derived from target", j.Staging)
	}
	if filepath.Clean(j.Retired) != retiredPath(target, j.TxID) {
		return fmt.Errorf("journal retired path %q is not derived from target", j.Retired)
	}
	return nil
}

// writeJournal atomically persists the journal (temp file + rename +
// fsync of file and directory).
func writeJournal(j *Journal, path string) error {
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
	return fsyncDir(filepath.Dir(path))
}

func readJournal(path string) (*Journal, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var j Journal
	if err := json.Unmarshal(data, &j); err != nil {
		return nil, fmt.Errorf("corrupt journal %s: %w", path, err)
	}
	return &j, nil
}

// setPhase persists a phase transition of the same transaction.
func setPhase(j *Journal, path, phase string) error {
	j.Phase = phase
	return writeJournal(j, path)
}

func fsyncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
