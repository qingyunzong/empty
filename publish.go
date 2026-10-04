// Package artifactpub publishes immutable test-artifact bundles.
//
// A bundle packages the test log, the summary and the exit code of one
// test run. Files are staged, fsynced and verified before the manifest is
// committed with an atomic directory rename, so readers only ever observe
// a fully verified bundle or no bundle at all. Bundles are immutable:
// retrying a run ID with identical content is a no-op, while retrying it
// with different content is rejected.
package artifactpub

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
)

// Well-known file names inside a bundle.
const (
	LogFileName      = "test.log"
	SummaryFileName  = "summary.json"
	ExitCodeFileName = "exit_code"

	manifestFileName = "manifest.json"
	stagingDirName   = "staging"
	bundlesDirName   = "bundles"
)

var (
	// ErrNotPublished is returned by Load when no complete, verified
	// bundle exists for the run ID.
	ErrNotPublished = errors.New("artifactpub: bundle not published")
	// ErrDigestMismatch is returned by Publish when the run ID was
	// already published with different content.
	ErrDigestMismatch = errors.New("artifactpub: run ID already published with a different digest")
	// ErrCorrupt is returned when an on-disk bundle fails verification.
	ErrCorrupt = errors.New("artifactpub: bundle failed verification")
)

// Manifest describes a published bundle. Digest uniquely identifies the
// run ID plus the exact content of every file.
type Manifest struct {
	RunID  string            `json:"run_id"`
	Files  map[string]string `json:"files"` // file name -> hex sha256
	Digest string            `json:"digest"`
}

// NewBundle assembles the file set for one test run.
func NewBundle(log, summary []byte, exitCode int) map[string][]byte {
	return map[string][]byte{
		LogFileName:      log,
		SummaryFileName:  summary,
		ExitCodeFileName: []byte(strconv.Itoa(exitCode) + "\n"),
	}
}

// ReadExitCode extracts the exit code from a loaded bundle's files.
func ReadExitCode(files map[string][]byte) (int, error) {
	raw, ok := files[ExitCodeFileName]
	if !ok {
		return 0, fmt.Errorf("artifactpub: bundle has no %s", ExitCodeFileName)
	}
	return strconv.Atoi(strings.TrimSpace(string(raw)))
}

// DigestOf computes the bundle digest for the given content.
func DigestOf(runID string, files map[string][]byte) string {
	h := sha256.New()
	io.WriteString(h, runID+"\n")
	for _, name := range sortedKeys(files) {
		sum := sha256.Sum256(files[name])
		fmt.Fprintf(h, "%s:%s\n", name, hex.EncodeToString(sum[:]))
	}
	return hex.EncodeToString(h.Sum(nil))
}

// Publisher stages and commits bundles under a root directory.
//
// Layout:
//
//	<root>/staging/<runID>/   scratch space, cleaned on Open
//	<root>/bundles/<runID>/   committed, immutable bundles
type Publisher struct {
	root string
	mu   sync.Mutex
	hook func(step string) error // fault-injection hook, nil in production
}

// Open creates or opens the store rooted at root and recovers from any
// previous crash by discarding incomplete staging directories.
func Open(root string) (*Publisher, error) {
	p := &Publisher{root: root}
	for _, dir := range []string{p.stagingDir(), p.bundlesDir()} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, err
		}
	}
	if err := p.recover(); err != nil {
		return nil, err
	}
	return p, nil
}

func (p *Publisher) stagingDir() string { return filepath.Join(p.root, stagingDirName) }
func (p *Publisher) bundlesDir() string { return filepath.Join(p.root, bundlesDirName) }

// recover removes leftover staging directories. A crash can never leave a
// partially committed bundle behind because the commit is a single rename,
// so anything still in staging is incomplete and safe to discard.
func (p *Publisher) recover() error {
	entries, err := os.ReadDir(p.stagingDir())
	if err != nil {
		return err
	}
	for _, e := range entries {
		if err := os.RemoveAll(filepath.Join(p.stagingDir(), e.Name())); err != nil {
			return err
		}
	}
	return syncDir(p.stagingDir())
}

// Publish stages, verifies and commits the bundle for runID.
//
// If the run ID is already published, identical content is acknowledged
// as a no-op and different content is rejected with ErrDigestMismatch.
// On success it returns the bundle digest.
func (p *Publisher) Publish(runID string, files map[string][]byte) (string, error) {
	if err := validateRunID(runID); err != nil {
		return "", err
	}
	if len(files) == 0 {
		return "", errors.New("artifactpub: bundle must contain at least one file")
	}
	for name := range files {
		if err := validateFileName(name); err != nil {
			return "", err
		}
	}
	digest := DigestOf(runID, files)

	p.mu.Lock()
	defer p.mu.Unlock()

	finalDir := filepath.Join(p.bundlesDir(), runID)
	if _, err := os.Stat(filepath.Join(finalDir, manifestFileName)); err == nil {
		return digest, p.checkExisting(finalDir, digest)
	}

	if err := p.failpoint("stage.mkdir"); err != nil {
		return "", err
	}
	staging := filepath.Join(p.stagingDir(), runID)
	if err := os.RemoveAll(staging); err != nil {
		return "", err
	}
	if err := os.MkdirAll(staging, 0o755); err != nil {
		return "", err
	}

	manifest := &Manifest{RunID: runID, Files: map[string]string{}, Digest: digest}
	for _, name := range sortedKeys(files) {
		if err := p.failpoint("stage.write"); err != nil {
			return "", err
		}
		if err := writeFileSync(filepath.Join(staging, name), files[name], 0o444); err != nil {
			return "", err
		}
		sum := sha256.Sum256(files[name])
		manifest.Files[name] = hex.EncodeToString(sum[:])
	}

	if err := p.failpoint("stage.manifest"); err != nil {
		return "", err
	}
	raw, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return "", err
	}
	if err := writeFileSync(filepath.Join(staging, manifestFileName), raw, 0o444); err != nil {
		return "", err
	}
	if err := syncDir(staging); err != nil {
		return "", err
	}

	// Verify the staged bytes before they become visible to readers.
	if err := p.failpoint("stage.verify"); err != nil {
		return "", err
	}
	if err := verifyDir(staging, manifest); err != nil {
		return "", err
	}

	// Atomic commit: readers see the whole bundle or nothing.
	if err := p.failpoint("commit.rename"); err != nil {
		return "", err
	}
	if err := os.Rename(staging, finalDir); err != nil {
		if isExistErr(err) {
			// Concurrent publisher won the race.
			return digest, p.checkExisting(finalDir, digest)
		}
		return "", err
	}

	// Failure past this point leaves a fully published bundle; a retry
	// with the same content is acknowledged idempotently.
	if err := p.failpoint("commit.sync"); err != nil {
		return "", err
	}
	if err := syncDir(p.bundlesDir()); err != nil {
		return "", err
	}
	return digest, nil
}

// checkExisting verifies an already-published bundle and acknowledges the
// retry only if the digest matches.
func (p *Publisher) checkExisting(finalDir, digest string) error {
	m, err := loadManifest(finalDir)
	if err != nil {
		return err
	}
	if err := verifyDir(finalDir, m); err != nil {
		return err
	}
	if m.Digest != digest {
		return ErrDigestMismatch
	}
	return nil
}

// Load returns the manifest and files of a published bundle. It returns
// ErrNotPublished if no manifest exists and ErrCorrupt if any file does
// not match the manifest, so callers never observe a partial or tampered
// bundle as valid.
func (p *Publisher) Load(runID string) (*Manifest, map[string][]byte, error) {
	if err := validateRunID(runID); err != nil {
		return nil, nil, err
	}
	dir := filepath.Join(p.bundlesDir(), runID)
	m, err := loadManifest(dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil, ErrNotPublished
		}
		return nil, nil, err
	}
	if err := verifyDir(dir, m); err != nil {
		return nil, nil, err
	}
	files := make(map[string][]byte, len(m.Files))
	for name := range m.Files {
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return nil, nil, err
		}
		files[name] = data
	}
	return m, files, nil
}

// Published reports whether a complete, verified bundle exists for runID.
func (p *Publisher) Published(runID string) bool {
	_, _, err := p.Load(runID)
	return err == nil
}

func (p *Publisher) failpoint(step string) error {
	if p.hook != nil {
		return p.hook(step)
	}
	return nil
}

func loadManifest(dir string) (*Manifest, error) {
	raw, err := os.ReadFile(filepath.Join(dir, manifestFileName))
	if err != nil {
		return nil, err
	}
	var m Manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("%w: bad manifest: %v", ErrCorrupt, err)
	}
	if m.Digest == "" || len(m.Files) == 0 {
		return nil, fmt.Errorf("%w: incomplete manifest", ErrCorrupt)
	}
	return &m, nil
}

// verifyDir re-reads every file listed in the manifest and checks its
// hash, and also rejects unexpected extra files.
func verifyDir(dir string, m *Manifest) error {
	for name, want := range m.Files {
		if err := validateFileName(name); err != nil {
			return fmt.Errorf("%w: %v", ErrCorrupt, err)
		}
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return fmt.Errorf("%w: %v", ErrCorrupt, err)
		}
		sum := sha256.Sum256(data)
		if got := hex.EncodeToString(sum[:]); got != want {
			return fmt.Errorf("%w: %s hash mismatch", ErrCorrupt, name)
		}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		name := e.Name()
		if name == manifestFileName {
			continue
		}
		if _, ok := m.Files[name]; !ok {
			return fmt.Errorf("%w: unexpected file %s", ErrCorrupt, name)
		}
	}
	return nil
}

func writeFileSync(path string, data []byte, perm os.FileMode) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, perm)
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
	return f.Close()
}

func syncDir(path string) error {
	d, err := os.Open(path)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

func isExistErr(err error) bool {
	return errors.Is(err, syscall.EEXIST) || errors.Is(err, syscall.ENOTEMPTY)
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func validateRunID(runID string) error {
	if runID == "" || runID == "." || runID == ".." ||
		strings.ContainsAny(runID, "/\\") || strings.ContainsRune(runID, 0) {
		return fmt.Errorf("artifactpub: invalid run ID %q", runID)
	}
	return nil
}

func validateFileName(name string) error {
	if name == "" || name == "." || name == ".." || name == manifestFileName ||
		strings.ContainsAny(name, "/\\") || strings.ContainsRune(name, 0) {
		return fmt.Errorf("artifactpub: invalid file name %q", name)
	}
	return nil
}
