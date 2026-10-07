package testiso

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Sentinel errors surfaced by Run.
var (
	// ErrPathEscapesRoot is returned when a manifest entry is absolute,
	// contains "..", or is a symlink chain resolving outside SrcRoot.
	ErrPathEscapesRoot = errors.New("testiso: path escapes source root")
	// ErrInvalidTask is returned for task names that are empty, contain
	// separators, or would collide with another task's directory.
	ErrInvalidTask = errors.New("testiso: invalid task name")
)

const maxGeneration = 999999

// Runner creates an isolated directory per run under RunRoot and stages
// the manifest-listed inputs from SrcRoot into it.
type Runner struct {
	// SrcRoot is the directory manifest paths are resolved against.
	SrcRoot string
	// RunRoot is the directory run directories are created under, laid
	// out as RunRoot/<task>/gen-NNNNNN.
	RunRoot string
	// FS performs all filesystem effects; nil means OSAdapter.
	FS FileAdapter
}

// Request describes a single run.
type Request struct {
	// Task names the run; parallel runs of the same Task are isolated
	// by generation.
	Task string
	// Manifest lists input files relative to SrcRoot. Only these files
	// are copied into the run directory.
	Manifest []string
}

// Result describes a finished (or failed) run.
type Result struct {
	// Dir is the isolated run directory.
	Dir string
	// Generation is the run's generation number within its task.
	Generation int
	// Evidence is the failure log kept under Dir/evidence; empty on
	// success.
	Evidence string
}

func (r *Runner) adapter() FileAdapter {
	if r.FS == nil {
		return OSAdapter{}
	}
	return r.FS
}

// Run executes one isolated run. On failure it keeps an evidence log in
// the run directory and removes non-evidence temporary items; the
// returned Result still describes the (failed) run directory.
func (r *Runner) Run(req Request) (*Result, error) {
	fs := r.adapter()
	if err := validateTask(req.Task); err != nil {
		return nil, err
	}
	dir, gen, err := allocGeneration(fs, r.RunRoot, req.Task)
	if err != nil {
		return nil, err
	}
	res := &Result{Dir: dir, Generation: gen}
	stageErr := r.stage(fs, dir, req.Manifest)
	evidence, finErr := finalize(fs, dir, stageErr)
	res.Evidence = evidence
	if stageErr != nil {
		return res, stageErr
	}
	if finErr != nil {
		return res, finErr
	}
	return res, nil
}

// validateTask confines a task name to a single safe path element.
func validateTask(task string) error {
	if task == "" || task == "." || task == ".." ||
		strings.ContainsRune(task, '/') || strings.ContainsRune(task, '\\') ||
		strings.ContainsRune(task, 0) || filepath.Clean(task) != task {
		return fmt.Errorf("%w: %q", ErrInvalidTask, task)
	}
	return nil
}

// allocGeneration claims the next free gen-NNNNNN directory for task.
// Mkdir is atomic, so concurrent runners of the same task each get a
// distinct generation.
func allocGeneration(fs FileAdapter, runRoot, task string) (string, int, error) {
	parent := filepath.Join(runRoot, task)
	if err := fs.MkdirAll(parent, 0o755); err != nil {
		return "", 0, err
	}
	for gen := 1; gen <= maxGeneration; gen++ {
		dir := filepath.Join(parent, fmt.Sprintf("gen-%06d", gen))
		err := fs.Mkdir(dir, 0o755)
		if err == nil {
			return dir, gen, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return "", 0, err
		}
	}
	return "", 0, fmt.Errorf("testiso: generation overflow for task %q", task)
}

// stage copies exactly the manifest files into dir/inputs, staging each
// through dir/tmp first so a failed copy never leaves a partial input.
func (r *Runner) stage(fs FileAdapter, dir string, manifest []string) error {
	inputs := filepath.Join(dir, "inputs")
	tmp := filepath.Join(dir, "tmp")
	for _, d := range []string{inputs, tmp} {
		if err := fs.MkdirAll(d, 0o755); err != nil {
			return err
		}
	}
	seen := make(map[string]bool, len(manifest))
	for _, entry := range manifest {
		src, rel, err := r.resolve(fs, entry)
		if err != nil {
			return err
		}
		if seen[rel] {
			continue
		}
		seen[rel] = true
		info, err := fs.Lstat(src)
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("testiso: manifest entry %q is not a regular file", entry)
		}
		staged := filepath.Join(tmp, rel)
		if err := fs.MkdirAll(filepath.Dir(staged), 0o755); err != nil {
			return err
		}
		if err := fs.CopyFile(src, staged, info.Mode().Perm()); err != nil {
			return fmt.Errorf("testiso: copy %q: %w", rel, err)
		}
		final := filepath.Join(inputs, rel)
		if err := fs.MkdirAll(filepath.Dir(final), 0o755); err != nil {
			return err
		}
		if err := fs.Rename(staged, final); err != nil {
			return err
		}
	}
	return nil
}

// resolve validates one manifest entry and returns its in-root absolute
// source path (symlinks fully resolved) plus its cleaned relative path.
func (r *Runner) resolve(fs FileAdapter, entry string) (src, rel string, err error) {
	rel = strings.TrimSpace(entry)
	if rel == "" {
		return "", "", errors.New("testiso: empty manifest entry")
	}
	if filepath.IsAbs(rel) {
		return "", "", fmt.Errorf("%w: absolute path %q", ErrPathEscapesRoot, entry)
	}
	rel = filepath.Clean(rel)
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", "", fmt.Errorf("%w: parent traversal %q", ErrPathEscapesRoot, entry)
	}
	candidate := filepath.Join(r.SrcRoot, rel)
	if _, err := fs.Lstat(candidate); err != nil {
		return "", "", err
	}
	resolved, err := fs.EvalSymlinks(candidate)
	if err != nil {
		return "", "", err
	}
	root, err := fs.EvalSymlinks(r.SrcRoot)
	if err != nil {
		return "", "", err
	}
	if resolved != root && !strings.HasPrefix(resolved, root+string(filepath.Separator)) {
		return "", "", fmt.Errorf("%w: %q resolves to %q", ErrPathEscapesRoot, entry, resolved)
	}
	return resolved, rel, nil
}

// finalize always removes the non-evidence tmp directory, and on
// failure records an evidence log that survives the run.
func finalize(fs FileAdapter, dir string, runErr error) (evidence string, err error) {
	if err := fs.RemoveAll(filepath.Join(dir, "tmp")); err != nil {
		return "", fmt.Errorf("testiso: cleanup tmp: %w", err)
	}
	if runErr == nil {
		return "", nil
	}
	evDir := filepath.Join(dir, "evidence")
	if err := fs.MkdirAll(evDir, 0o755); err != nil {
		return "", err
	}
	log := fmt.Sprintf("run failed at %s\nerror: %v\n",
		time.Now().UTC().Format(time.RFC3339Nano), runErr)
	evidence = filepath.Join(evDir, "failure.log")
	if err := fs.WriteFile(evidence, []byte(log), 0o644); err != nil {
		return "", fmt.Errorf("testiso: write evidence: %w", err)
	}
	return evidence, nil
}
