package materialpub

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
)

// ErrDigestConflict is returned when a run ID is retried with content whose
// package digest differs from the digest durably claimed for that run ID.
var ErrDigestConflict = errors.New("materialpub: run ID already claimed with a different digest")

// Input is the material that makes up one immutable package.
type Input struct {
	RunID    string
	TestLog  []byte
	Summary  []byte
	ExitCode int
}

// Options tunes a Publisher. All fields are optional.
type Options struct {
	// AfterOp, when set, is invoked after each durable publish step with the
	// step name ("claim", "files", "verify", "manifest-staged", "manifest").
	// A non-nil return aborts the publish, simulating a crash at that point.
	AfterOp func(op string) error
}

// Publisher assembles and publishes material packages under a root directory.
// A Publisher is not safe for concurrent use; distinct Publisher instances
// over the same root coordinate through on-disk claims.
type Publisher struct {
	root    string
	afterOp func(op string) error
}

// NewPublisher returns a Publisher storing packages under root.
func NewPublisher(root string, opts *Options) *Publisher {
	p := &Publisher{root: root}
	if opts != nil {
		p.afterOp = opts.AfterOp
	}
	return p
}

// claimRecord is the durable binding between a run ID and a package digest.
type claimRecord struct {
	RunID  string `json:"run_id"`
	Digest string `json:"digest"`
}

// buildManifest derives the manifest for in without touching disk.
func buildManifest(in Input) Manifest {
	files := []FileEntry{
		{Name: TestLogFile, Size: int64(len(in.TestLog)), SHA256: sha256Bytes(in.TestLog)},
		{Name: SummaryFile, Size: int64(len(in.Summary)), SHA256: sha256Bytes(in.Summary)},
		{Name: ExitCodeFile, Size: int64(len(exitCodeBytes(in.ExitCode))), SHA256: sha256Bytes(exitCodeBytes(in.ExitCode))},
	}
	return Manifest{RunID: in.RunID, Files: files, Digest: digestFiles(files)}
}

func exitCodeBytes(code int) []byte {
	return []byte(strconv.Itoa(code) + "\n")
}

// Publish durably assembles the package for in and atomically publishes its
// manifest. It is idempotent: republishing identical content for an already
// published run ID succeeds and returns the existing manifest. Republishing
// the same run ID with different content fails with ErrDigestConflict.
//
// The commit order is: claim digest -> write+fsync data files -> re-verify
// files from disk -> atomically rename manifest into place. A crash at any
// point leaves readers seeing either the previous complete state or nothing.
func (p *Publisher) Publish(in Input) (*Manifest, error) {
	if err := validateRunID(in.RunID); err != nil {
		return nil, err
	}
	m := buildManifest(in)

	runDir := filepath.Join(p.root, "runs", in.RunID)
	if err := os.MkdirAll(runDir, 0o755); err != nil {
		return nil, err
	}
	if err := syncDir(filepath.Dir(runDir)); err != nil {
		return nil, err
	}
	if err := removeStaleTemp(runDir); err != nil {
		return nil, err
	}

	if err := p.claim(runDir, in.RunID, m.Digest); err != nil {
		return nil, err
	}
	if err := p.step("claim"); err != nil {
		return nil, err
	}

	// Fast path: an identical, fully published package needs no rewrite.
	if existing, err := Read(p.root, in.RunID); err == nil && existing.Manifest.Digest == m.Digest {
		return &existing.Manifest, nil
	}

	contents := map[string][]byte{
		TestLogFile:  in.TestLog,
		SummaryFile:  in.Summary,
		ExitCodeFile: exitCodeBytes(in.ExitCode),
	}
	for _, e := range m.Files {
		if err := writeFileAtomic(runDir, e.Name, contents[e.Name]); err != nil {
			return nil, err
		}
	}
	if err := p.step("files"); err != nil {
		return nil, err
	}

	// Verify every file from disk before the manifest may appear.
	for _, e := range m.Files {
		if err := verifyFile(runDir, e); err != nil {
			return nil, err
		}
	}
	if err := p.step("verify"); err != nil {
		return nil, err
	}

	body, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return nil, err
	}
	// Stage the manifest, then make the rename the single commit point.
	tmp := filepath.Join(runDir, manifestFile+tmpSuffix)
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, err
	}
	if _, err := f.Write(body); err != nil {
		f.Close()
		return nil, err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return nil, err
	}
	if err := f.Close(); err != nil {
		return nil, err
	}
	if err := p.step("manifest-staged"); err != nil {
		return nil, err
	}
	if err := os.Rename(tmp, filepath.Join(runDir, manifestFile)); err != nil {
		return nil, err
	}
	if err := syncDir(runDir); err != nil {
		return nil, err
	}
	if err := p.step("manifest"); err != nil {
		return nil, err
	}
	return &m, nil
}

// claim durably binds runID to digest, or validates an existing binding.
func (p *Publisher) claim(runDir, runID, digest string) error {
	claimPath := filepath.Join(runDir, claimFile)
	if _, err := os.Stat(claimPath); errors.Is(err, fs.ErrNotExist) {
		body, err := json.Marshal(claimRecord{RunID: runID, Digest: digest})
		if err != nil {
			return err
		}
		if err := writeFileAtomic(runDir, claimFile, body); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	data, err := os.ReadFile(claimPath)
	if err != nil {
		return err
	}
	var rec claimRecord
	if err := json.Unmarshal(data, &rec); err != nil {
		return fmt.Errorf("materialpub: corrupt claim for run %q: %w", runID, err)
	}
	if rec.Digest != digest {
		return ErrDigestConflict
	}
	return nil
}

func (p *Publisher) step(op string) error {
	if p.afterOp != nil {
		return p.afterOp(op)
	}
	return nil
}
