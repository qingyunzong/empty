package runtool

import (
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"strings"
)

const maxSymlinkDepth = 40

// resolveInRoot resolves p lexically and through any symlinks, guaranteeing
// the final path stays inside root. Components that do not exist yet are
// kept as-is (their lexical containment is still enforced). Any symlink
// whose target lands outside root is rejected.
func resolveInRoot(fsys FS, root, p string, depth int) (string, error) {
	if depth > maxSymlinkDepth {
		return "", fmt.Errorf("too many symlinks resolving %q", p)
	}
	rel, err := filepath.Rel(root, p)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("path %q escapes root %q", p, root)
	}
	if rel == "." {
		return root, nil
	}
	parent, err := resolveInRoot(fsys, root, filepath.Dir(p), depth)
	if err != nil {
		return "", err
	}
	candidate := filepath.Join(parent, filepath.Base(p))
	info, err := fsys.Lstat(candidate)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return candidate, nil
	case err != nil:
		return "", err
	case info.Mode()&fs.ModeSymlink == 0:
		return candidate, nil
	}
	target, err := fsys.Readlink(candidate)
	if err != nil {
		return "", err
	}
	if !filepath.IsAbs(target) {
		target = filepath.Join(parent, target)
	}
	return resolveInRoot(fsys, root, target, depth+1)
}

// validateManifestEntry rejects manifest entries that are absolute or that
// would lexically escape the source root.
func validateManifestEntry(entry string) error {
	if entry == "" {
		return errors.New("empty manifest entry")
	}
	if filepath.IsAbs(entry) {
		return fmt.Errorf("absolute path %q is not allowed in the manifest", entry)
	}
	clean := filepath.Clean(entry)
	if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return fmt.Errorf("manifest entry %q escapes the source root", entry)
	}
	return nil
}
