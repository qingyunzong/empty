package runtool

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"path/filepath"
	"strings"
	"time"
)

// Runner allocates an isolated directory per run under a common root.
type Runner struct {
	root string
	fs   FS
}

// NewRunner creates a Runner storing run directories under root. A nil fsys
// uses the host filesystem; tests pass a wrapping FS to inject failures.
func NewRunner(root string, fsys FS) (*Runner, error) {
	if fsys == nil {
		fsys = OSFS{}
	}
	if err := fsys.MkdirAll(root, 0o755); err != nil {
		return nil, fmt.Errorf("create runs root: %w", err)
	}
	return &Runner{root: root, fs: fsys}, nil
}

// Start allocates a fresh run directory for task. Concurrent runs of the
// same task name are isolated by generation: the first free
// <root>/<task>/gen-NNNNNN directory is claimed atomically with Mkdir.
func (r *Runner) Start(task string) (*Run, error) {
	if err := validateTaskName(task); err != nil {
		return nil, err
	}
	base := filepath.Join(r.root, task)
	if err := r.fs.MkdirAll(base, 0o755); err != nil {
		return nil, fmt.Errorf("create task dir: %w", err)
	}
	for gen := 0; ; gen++ {
		dir := filepath.Join(base, fmt.Sprintf("gen-%06d", gen))
		err := r.fs.Mkdir(dir, 0o755)
		switch {
		case err == nil:
			return &Run{Task: task, Generation: gen, Dir: dir, fs: r.fs}, nil
		case errors.Is(err, fs.ErrExist):
			continue
		default:
			return nil, fmt.Errorf("allocate run dir: %w", err)
		}
	}
}

func validateTaskName(task string) error {
	if task == "" || task == "." || task == ".." {
		return fmt.Errorf("invalid task name %q", task)
	}
	if filepath.IsAbs(task) || strings.ContainsAny(task, `/\`) {
		return fmt.Errorf("task name %q must be a single path element", task)
	}
	return nil
}

// Run is one isolated execution directory.
type Run struct {
	Task       string
	Generation int
	Dir        string
	fs         FS
}

// InputsDir holds the staged manifest inputs.
func (r *Run) InputsDir() string { return filepath.Join(r.Dir, "inputs") }

// WorkDir is scratch space; it is wiped when the run finishes.
func (r *Run) WorkDir() string { return filepath.Join(r.Dir, "work") }

// EvidenceDir is preserved when the run fails.
func (r *Run) EvidenceDir() string { return filepath.Join(r.Dir, "evidence") }

// StageInputs copies exactly the entries listed in manifest from srcRoot
// into InputsDir. Entries must be relative paths inside srcRoot; absolute
// paths, ".." escapes, and symlinks resolving outside srcRoot are rejected.
func (r *Run) StageInputs(srcRoot string, manifest []string) error {
	absRoot, err := filepath.Abs(srcRoot)
	if err != nil {
		return err
	}
	resolvedRoot, err := resolveInRoot(r.fs, string(filepath.Separator), absRoot, 0)
	if err != nil {
		return fmt.Errorf("resolve source root: %w", err)
	}
	seen := make(map[string]bool, len(manifest))
	for _, entry := range manifest {
		if err := validateManifestEntry(entry); err != nil {
			return err
		}
		clean := filepath.Clean(entry)
		if seen[clean] {
			continue
		}
		seen[clean] = true
		src := filepath.Join(resolvedRoot, clean)
		resolved, err := resolveInRoot(r.fs, resolvedRoot, src, 0)
		if err != nil {
			return fmt.Errorf("manifest entry %q: %w", entry, err)
		}
		info, err := r.fs.Lstat(resolved)
		if err != nil {
			return fmt.Errorf("manifest entry %q: %w", entry, err)
		}
		dst := filepath.Join(r.InputsDir(), clean)
		if err := copyEntry(r.fs, resolvedRoot, resolved, dst, info); err != nil {
			return fmt.Errorf("stage %q: %w", entry, err)
		}
	}
	return nil
}

// Finish finalizes the run. On success the whole run directory is removed.
// On failure the evidence directory is preserved (with a FAILURE.txt marker
// recording the cause) and non-evidence temporaries are removed.
func (r *Run) Finish(runErr error) error {
	if runErr == nil {
		return r.fs.RemoveAll(r.Dir)
	}
	if err := r.fs.MkdirAll(r.EvidenceDir(), 0o755); err != nil {
		return fmt.Errorf("preserve evidence: %w", err)
	}
	marker := fmt.Sprintf("task: %s\ngeneration: %d\ntime: %s\nerror: %v\n",
		r.Task, r.Generation, time.Now().UTC().Format(time.RFC3339), runErr)
	if err := writeFile(r.fs, filepath.Join(r.EvidenceDir(), "FAILURE.txt"), []byte(marker)); err != nil {
		return fmt.Errorf("record failure evidence: %w", err)
	}
	if err := r.fs.RemoveAll(r.WorkDir()); err != nil {
		return fmt.Errorf("clean non-evidence temporaries: %w", err)
	}
	return nil
}

// copyEntry copies src to dst. Directories are copied recursively; symlinks
// encountered along the way must resolve inside root or are rejected.
func copyEntry(fsys FS, root, src, dst string, info fs.FileInfo) error {
	switch {
	case info.Mode()&fs.ModeSymlink != 0:
		resolved, err := resolveInRoot(fsys, root, src, 0)
		if err != nil {
			return err
		}
		rinfo, err := fsys.Lstat(resolved)
		if err != nil {
			return err
		}
		return copyEntry(fsys, root, resolved, dst, rinfo)
	case info.IsDir():
		if err := fsys.MkdirAll(dst, 0o755); err != nil {
			return err
		}
		entries, err := fsys.ReadDir(src)
		if err != nil {
			return err
		}
		for _, e := range entries {
			childSrc := filepath.Join(src, e.Name())
			childInfo, err := fsys.Lstat(childSrc)
			if err != nil {
				return err
			}
			if err := copyEntry(fsys, root, childSrc, filepath.Join(dst, e.Name()), childInfo); err != nil {
				return err
			}
		}
		return nil
	case info.Mode().IsRegular():
		if err := fsys.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		return copyFile(fsys, src, dst)
	default:
		return fmt.Errorf("unsupported file type %q for %s", info.Mode().Type(), src)
	}
}

func copyFile(fsys FS, src, dst string) error {
	in, err := fsys.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := fsys.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

func writeFile(fsys FS, path string, data []byte) error {
	f, err := fsys.Create(path)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}
