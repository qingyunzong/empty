package materialpub

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
)

// ErrNotPublished is returned by Read when no manifest exists for a run ID.
var ErrNotPublished = errors.New("materialpub: run ID not published")

// ErrCorrupt is returned by Read when a published package fails integrity
// verification against its manifest.
var ErrCorrupt = errors.New("materialpub: package failed integrity verification")

// Package is a fully verified material package.
type Package struct {
	Manifest Manifest
	TestLog  []byte
	Summary  []byte
	ExitCode int
}

// Read loads and verifies the package for runID under root. It returns
// ErrNotPublished when no manifest has been committed, and ErrCorrupt when
// the manifest or any file fails digest verification. Readers never observe
// partially written packages: the manifest rename is the commit point and
// every listed file is re-hashed before the package is returned.
func Read(root, runID string) (*Package, error) {
	if err := validateRunID(runID); err != nil {
		return nil, err
	}
	runDir := filepath.Join(root, "runs", runID)

	data, err := os.ReadFile(filepath.Join(runDir, manifestFile))
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotPublished
	}
	if err != nil {
		return nil, err
	}
	var m Manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("%w: unparsable manifest: %v", ErrCorrupt, err)
	}
	if m.RunID != runID || m.Digest != digestFiles(m.Files) {
		return nil, fmt.Errorf("%w: manifest digest mismatch", ErrCorrupt)
	}

	seen := map[string]bool{}
	contents := map[string][]byte{}
	for _, e := range m.Files {
		if seen[e.Name] {
			return nil, fmt.Errorf("%w: duplicate file entry %q", ErrCorrupt, e.Name)
		}
		seen[e.Name] = true
		if err := verifyFile(runDir, e); err != nil {
			return nil, fmt.Errorf("%w: %v", ErrCorrupt, err)
		}
		contents[e.Name], _ = os.ReadFile(filepath.Join(runDir, e.Name))
	}
	for _, name := range []string{TestLogFile, SummaryFile, ExitCodeFile} {
		if !seen[name] {
			return nil, fmt.Errorf("%w: manifest missing %s", ErrCorrupt, name)
		}
	}

	codeBytes := bytes.TrimSpace(contents[ExitCodeFile])
	code, err := strconv.Atoi(string(codeBytes))
	if err != nil {
		return nil, fmt.Errorf("%w: bad exit code: %v", ErrCorrupt, err)
	}
	return &Package{
		Manifest: m,
		TestLog:  contents[TestLogFile],
		Summary:  contents[SummaryFile],
		ExitCode: code,
	}, nil
}
