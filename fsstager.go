package q218

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const (
	defaultDirPerm  = 0o755
	defaultFilePerm = 0o644
)

// FSStager lands archives on the local filesystem.

// Each transaction stages its tree in a hidden, uniquely named directory
// created in the same parent directory as the destination, so Commit is a
// single same-filesystem atomic rename. The destination must not already
// exist; Begin rejects it to guarantee that an archive never overwrites
// unrelated data.
type FSStager struct {
	// Root is the final destination directory for committed archives.
	Root string
}

// NewFSStager returns a filesystem stager landing at root.
func NewFSStager(root string) *FSStager {
	return &FSStager{Root: root}
}

// Begin creates a fresh staging directory and opens a transaction.
func (s *FSStager) Begin(ctx context.Context) (StageTx, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	root := filepath.Clean(s.Root)
	if root == "." || root == string(filepath.Separator) {
		return nil, errors.New("q218: staging root must be a specific directory")
	}

	parent := filepath.Dir(root)
	if err := os.MkdirAll(parent, defaultDirPerm); err != nil {
		return nil, err
	}
	// Reject an existing destination up front: Commit's rename must publish a
	// brand-new tree rather than clobbering one.
	if _, err := os.Stat(root); !errors.Is(err, os.ErrNotExist) {
		if err == nil {
			return nil, errors.New("q218: destination already exists: " + root)
		}
		return nil, err
	}

	staging, err := os.MkdirTemp(parent, "."+filepath.Base(root)+".staging-*")
	if err != nil {
		return nil, err
	}
	return &fsStageTx{root: root, staging: staging}, nil
}

type fsStageTx struct {
	root    string
	staging string
	done    bool
}

// resolve maps a slash-separated relative path to an absolute path inside the
// staging area and rejects any escape attempt.
func (tx *fsStageTx) resolve(rel string) (string, error) {
	if rel == "" || filepath.IsAbs(rel) {
		return "", ErrInvalidPath
	}
	cleaned := filepath.Clean(filepath.FromSlash(rel))
	if cleaned == ".." || filepath.IsAbs(cleaned) {
		return "", ErrInvalidPath
	}
	target := filepath.Join(tx.staging, cleaned)
	relToStaging, err := filepath.Rel(tx.staging, target)
	if err != nil || relToStaging == ".." || filepath.IsAbs(relToStaging) ||
		strings.HasPrefix(relToStaging, ".."+string(filepath.Separator)) {
		return "", ErrInvalidPath
	}
	return target, nil
}

// Mkdir creates a directory (and any missing ancestors) inside staging.
func (tx *fsStageTx) Mkdir(rel string) error {
	target, err := tx.resolve(rel)
	if err != nil {
		return err
	}
	return os.MkdirAll(target, defaultDirPerm)
}

// PutFile streams content into a freshly created file inside staging.
func (tx *fsStageTx) PutFile(rel string, content io.Reader) error {
	target, err := tx.resolve(rel)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(target), defaultDirPerm); err != nil {
		return err
	}

	file, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, defaultFilePerm)
	if err != nil {
		return err
	}
	copyErr := copyAndSync(file, content)
	closeErr := file.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}

// Commit makes the staged tree visible at the destination atomically. The
// staging directory is removed when the rename cannot happen.
func (tx *fsStageTx) Commit() error {
	if tx.done {
		return errors.New("q218: transaction already finished")
	}
	tx.done = true

	if err := syncDir(tx.staging); err != nil {
		_ = os.RemoveAll(tx.staging)
		return err
	}
	if err := os.Rename(tx.staging, tx.root); err != nil {
		_ = os.RemoveAll(tx.staging)
		return err
	}
	syncDir(filepath.Dir(tx.root))
	return nil
}

// Abort discards the whole staging tree. It is safe to call after Commit.
func (tx *fsStageTx) Abort() error {
	if tx.done {
		return nil
	}
	tx.done = true
	return os.RemoveAll(tx.staging)
}

func copyAndSync(file *os.File, content io.Reader) error {
	if _, err := io.Copy(file, content); err != nil {
		_ = file.Sync()
		return err
	}
	return file.Sync()
}

// syncDir flushes a directory's metadata so that renames and file creations
// survive a crash. It is best-effort on platforms that cannot open
// directories for reading.
func syncDir(dir string) error {
	handle, err := os.Open(dir)
	if err != nil {
		return err
	}
	err = handle.Sync()
	_ = handle.Close()
	return err
}
