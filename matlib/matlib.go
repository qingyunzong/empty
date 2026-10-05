// Package matlib implements a run-material library.
//
// Every run attempt gets its own versioned directory; a failed rerun never
// mixes logs, summaries, or files from earlier attempts. An attempt becomes
// visible to readers only after every file of that attempt has been written
// and verified against its manifest, at which point the "current" pointer is
// switched atomically. Older attempts are retained on disk.
package matlib

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

const (
	attemptsDirName = "attempts"
	currentFileName = "current"
	manifestName    = "manifest.json"
)

// Hooks are fault-injection points around the publish pipeline. Any hook
// returning a non-nil error aborts (or, for AfterPointerSwitch, follows) the
// corresponding publish step. They are intended for tests.
type Hooks struct {
	BeforeManifestWrite func(version uint64) error
	BeforeVerify        func(version uint64) error
	BeforePointerSwitch func(version uint64) error
	AfterPointerSwitch  func(version uint64) error
}

// Store is a material library rooted at a directory.
type Store struct {
	root  string
	hooks *Hooks
}

// NewStore creates (or opens) a store rooted at root.
func NewStore(root string, hooks *Hooks) (*Store, error) {
	s := &Store{root: root, hooks: hooks}
	if err := os.MkdirAll(filepath.Join(root, attemptsDirName), 0o755); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) hook(fn func(*Hooks) func(uint64) error) func(uint64) error {
	if s.hooks == nil {
		return nil
	}
	return fn(s.hooks)
}

// ErrNoCurrent is returned when no attempt has been published yet.
var ErrNoCurrent = errors.New("matlib: no published attempt")

// Attempt is a single run's isolated workspace.
type Attempt struct {
	store     *Store
	version   uint64
	dir       string
	files     map[string]string // logical name -> sha256 hex
	published bool
}

// Begin allocates a fresh version and an isolated directory for a new
// attempt. Nothing from previous attempts is reused.
func (s *Store) Begin() (*Attempt, error) {
	attemptsDir := filepath.Join(s.root, attemptsDirName)
	for {
		next, err := nextVersion(attemptsDir)
		if err != nil {
			return nil, err
		}
		dir := attemptDir(attemptsDir, next)
		if err := os.Mkdir(dir, 0o755); err != nil {
			if errors.Is(err, fs.ErrExist) {
				continue // version raced; retry with the next one
			}
			return nil, err
		}
		return &Attempt{
			store:   s,
			version: next,
			dir:     dir,
			files:   map[string]string{},
		}, nil
	}
}

// Version returns the attempt's unique, monotonically increasing version.
func (a *Attempt) Version() uint64 { return a.version }

// Dir returns the attempt's private directory.
func (a *Attempt) Dir() string { return a.dir }

// WriteFile writes a material file into the attempt's private directory.
// Names may contain slashes to create subdirectories (e.g. "logs/run.log").
func (a *Attempt) WriteFile(name string, data []byte) error {
	if a.published {
		return fmt.Errorf("matlib: attempt %d already published", a.version)
	}
	if err := validName(name); err != nil {
		return err
	}
	path := filepath.Join(a.dir, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return err
	}
	sum := sha256.Sum256(data)
	a.files[name] = hex.EncodeToString(sum[:])
	return nil
}

// WriteLog appends a log file under logs/ inside the attempt directory.
func (a *Attempt) WriteLog(name string, data []byte) error {
	return a.WriteFile("logs/"+name, data)
}

// WriteSummary writes the attempt's run summary.
func (a *Attempt) WriteSummary(data []byte) error {
	return a.WriteFile("summary.json", data)
}

// manifest describes every file belonging to one attempt.
type manifest struct {
	Version uint64            `json:"version"`
	Files   map[string]string `json:"files"` // logical name -> sha256 hex
}

// Publish verifies every file of the attempt and then atomically switches
// the store's current pointer to this attempt. If any step fails, the
// pointer is left untouched and readers keep seeing the previous complete
// attempt; this attempt's directory is retained for inspection.
func (a *Attempt) Publish() error {
	if a.published {
		return fmt.Errorf("matlib: attempt %d already published", a.version)
	}
	m := manifest{Version: a.version, Files: a.files}

	if h := a.store.hook(func(h *Hooks) func(uint64) error { return h.BeforeManifestWrite }); h != nil {
		if err := h(a.version); err != nil {
			return fmt.Errorf("matlib: publish attempt %d: %w", a.version, err)
		}
	}
	raw, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(a.dir, manifestName), raw, 0o644); err != nil {
		return err
	}

	if h := a.store.hook(func(h *Hooks) func(uint64) error { return h.BeforeVerify }); h != nil {
		if err := h(a.version); err != nil {
			return fmt.Errorf("matlib: publish attempt %d: %w", a.version, err)
		}
	}
	if err := verifyAttempt(a.dir, &m); err != nil {
		return fmt.Errorf("matlib: publish attempt %d: %w", a.version, err)
	}

	if h := a.store.hook(func(h *Hooks) func(uint64) error { return h.BeforePointerSwitch }); h != nil {
		if err := h(a.version); err != nil {
			return fmt.Errorf("matlib: publish attempt %d: %w", a.version, err)
		}
	}
	if err := a.store.switchPointer(a.version); err != nil {
		return err
	}
	a.published = true

	if h := a.store.hook(func(h *Hooks) func(uint64) error { return h.AfterPointerSwitch }); h != nil {
		if err := h(a.version); err != nil {
			return fmt.Errorf("matlib: publish attempt %d: %w", a.version, err)
		}
	}
	return nil
}

// switchPointer atomically replaces the current pointer via write+rename.
func (s *Store) switchPointer(version uint64) error {
	tmp := filepath.Join(s.root, fmt.Sprintf(".%s.tmp.%d", currentFileName, version))
	if err := os.WriteFile(tmp, []byte(strconv.FormatUint(version, 10)), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(s.root, currentFileName))
}

// Material is a consistent, fully verified snapshot of one attempt.
type Material struct {
	Version uint64
	Files   map[string][]byte // logical name -> content
}

// Read returns the material of the current published attempt. The pointer is
// read once, so a concurrent publish cannot mix files from two attempts.
// Every file is re-verified against the attempt's manifest before anything
// is returned; any mismatch fails the whole read.
func (s *Store) Read() (*Material, error) {
	version, err := s.currentVersion()
	if err != nil {
		return nil, err
	}
	return s.ReadVersion(version)
}

// ReadVersion returns the verified material of a specific retained attempt.
func (s *Store) ReadVersion(version uint64) (*Material, error) {
	dir := attemptDir(filepath.Join(s.root, attemptsDirName), version)
	raw, err := os.ReadFile(filepath.Join(dir, manifestName))
	if err != nil {
		return nil, fmt.Errorf("matlib: read attempt %d: %w", version, err)
	}
	var m manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("matlib: read attempt %d: %w", version, err)
	}
	if m.Version != version {
		return nil, fmt.Errorf("matlib: attempt %d: manifest says version %d", version, m.Version)
	}
	if err := verifyAttempt(dir, &m); err != nil {
		return nil, fmt.Errorf("matlib: read attempt %d: %w", version, err)
	}
	mat := &Material{Version: version, Files: map[string][]byte{}}
	for name := range m.Files {
		data, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(name)))
		if err != nil {
			return nil, fmt.Errorf("matlib: read attempt %d: %w", version, err)
		}
		mat.Files[name] = data
	}
	return mat, nil
}

// CurrentVersion returns the version the current pointer refers to.
func (s *Store) CurrentVersion() (uint64, error) { return s.currentVersion() }

func (s *Store) currentVersion() (uint64, error) {
	raw, err := os.ReadFile(filepath.Join(s.root, currentFileName))
	if errors.Is(err, fs.ErrNotExist) {
		return 0, ErrNoCurrent
	}
	if err != nil {
		return 0, err
	}
	version, err := strconv.ParseUint(strings.TrimSpace(string(raw)), 10, 64)
	if err != nil {
		return 0, fmt.Errorf("matlib: corrupt current pointer: %w", err)
	}
	return version, nil
}

// verifyAttempt checks that the attempt directory contains exactly the files
// listed in the manifest, each with a matching SHA-256.
func verifyAttempt(dir string, m *manifest) error {
	if len(m.Files) == 0 {
		return errors.New("attempt has no files")
	}
	onDisk := map[string]bool{}
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil {
			return err
		}
		name := filepath.ToSlash(rel)
		if name == manifestName {
			return nil
		}
		onDisk[name] = true
		want, ok := m.Files[name]
		if !ok {
			return fmt.Errorf("unexpected file %q not in manifest", name)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(data)
		if got := hex.EncodeToString(sum[:]); got != want {
			return fmt.Errorf("file %q: sha256 mismatch", name)
		}
		return nil
	})
	if err != nil {
		return err
	}
	for name := range m.Files {
		if !onDisk[name] {
			return fmt.Errorf("manifest file %q missing on disk", name)
		}
	}
	return nil
}

// nextVersion returns one more than the highest attempt version present.
func nextVersion(attemptsDir string) (uint64, error) {
	entries, err := os.ReadDir(attemptsDir)
	if err != nil {
		return 0, err
	}
	var max uint64
	for _, e := range entries {
		if v, err := strconv.ParseUint(e.Name(), 10, 64); err == nil && v > max {
			max = v
		}
	}
	return max + 1, nil
}

func attemptDir(attemptsDir string, version uint64) string {
	return filepath.Join(attemptsDir, strconv.FormatUint(version, 10))
}

func validName(name string) error {
	if name == "" || name == manifestName {
		return fmt.Errorf("matlib: invalid file name %q", name)
	}
	clean := filepath.Clean(filepath.FromSlash(name))
	if filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return fmt.Errorf("matlib: file name %q escapes attempt directory", name)
	}
	return nil
}

// Versions lists all retained attempt versions, sorted ascending.
func (s *Store) Versions() ([]uint64, error) {
	entries, err := os.ReadDir(filepath.Join(s.root, attemptsDirName))
	if err != nil {
		return nil, err
	}
	var versions []uint64
	for _, e := range entries {
		if v, err := strconv.ParseUint(e.Name(), 10, 64); err == nil {
			versions = append(versions, v)
		}
	}
	sort.Slice(versions, func(i, j int) bool { return versions[i] < versions[j] })
	return versions, nil
}
