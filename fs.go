package dirdiff

import (
	"fmt"
	"os"
	"path/filepath"
)

// Materialize writes a manifest into root as real files whose content encodes
// the entry ID and version, so moves can be verified end to end.
func Materialize(root string, m Manifest) error {
	if err := m.Validate(); err != nil {
		return err
	}
	for _, e := range m.Entries {
		if err := writeEntry(root, e); err != nil {
			return err
		}
	}
	return nil
}

func writeEntry(root string, e Entry) error {
	p := filepath.Join(root, filepath.FromSlash(e.Path))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	return os.WriteFile(p, encodeContent(e), 0o644)
}

// Snapshot reads root back into a manifest. Paths are slash-separated and
// relative to root; file contents must have the "id@vN" form written by
// Materialize. Scratch files created mid-plan are skipped if absent.
func Snapshot(root string) (Manifest, error) {
	var m Manifest
	err := filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		id, version, err := decodeContent(data)
		if err != nil {
			return fmt.Errorf("dirdiff: snapshot %q: %w", rel, err)
		}
		m.Entries = append(m.Entries, Entry{ID: id, Path: filepath.ToSlash(rel), Version: version})
		return nil
	})
	return m, err
}

// ApplyFS executes a plan against a real directory tree rooted at root,
// verifying expected versions (from file contents) before each mutation.
func ApplyFS(root string, ops []Op) error {
	for i, op := range ops {
		if err := applyFSOne(root, op); err != nil {
			return fmt.Errorf("dirdiff: op %d (%s): %w", i, op, err)
		}
	}
	return nil
}

func checkVersion(root, path, id string, want int) error {
	p := filepath.Join(root, filepath.FromSlash(path))
	data, err := os.ReadFile(p)
	if err != nil {
		return err
	}
	gotID, gotVersion, err := decodeContent(data)
	if err != nil {
		return fmt.Errorf("bad content at %q: %w", path, err)
	}
	if gotID != id {
		return fmt.Errorf("at %q: have ID %q, want %q", path, gotID, id)
	}
	if gotVersion != want {
		return fmt.Errorf("at %q: version mismatch: have v%d, want v%d", path, gotVersion, want)
	}
	return nil
}

func applyFSOne(root string, op Op) error {
	from := filepath.Join(root, filepath.FromSlash(op.From))
	to := filepath.Join(root, filepath.FromSlash(op.To))
	switch op.Kind {
	case OpCreate:
		if _, err := os.Lstat(to); err == nil {
			return fmt.Errorf("create target %q occupied", op.To)
		}
		return writeEntry(root, Entry{ID: op.ID, Path: op.To, Version: op.NewVersion})
	case OpDelete:
		if err := checkVersion(root, op.From, op.ID, op.Version); err != nil {
			return err
		}
		return os.Remove(from)
	case OpMove:
		if err := checkVersion(root, op.From, op.ID, op.Version); err != nil {
			return err
		}
		if _, err := os.Lstat(to); err == nil {
			return fmt.Errorf("move target %q occupied", op.To)
		}
		if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
			return err
		}
		if err := os.Rename(from, to); err != nil {
			return err
		}
		if op.NewVersion != op.Version {
			return writeEntry(root, Entry{ID: op.ID, Path: op.To, Version: op.NewVersion})
		}
		return nil
	}
	return fmt.Errorf("unknown op kind %d", op.Kind)
}
