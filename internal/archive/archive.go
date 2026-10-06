// Package archive packs a directory tree (directories, regular files,
// hard links and relative symbolic links) into a tar stream and restores
// it into a new root with strict path-traversal protection.
package archive

import (
	"archive/tar"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"syscall"
)

// Create walks src (never following symbolic links, so symlink cycles are
// harmless) and writes an archive of its entries to w. Any entry that is
// not a directory, regular file or relative symlink aborts the whole
// release with an error.
func Create(src string, w io.Writer) error {
	tw := tar.NewWriter(w)

	type inodeKey struct{ dev, ino uint64 }
	seen := map[inodeKey]string{}

	walkErr := filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		name := filepath.ToSlash(rel)
		info, err := os.Lstat(p)
		if err != nil {
			return err
		}

		switch {
		case info.IsDir():
			return tw.WriteHeader(&tar.Header{
				Typeflag: tar.TypeDir,
				Name:     name,
				Mode:     int64(info.Mode().Perm()),
				ModTime:  info.ModTime(),
			})

		case info.Mode()&os.ModeSymlink != 0:
			target, err := os.Readlink(p)
			if err != nil {
				return err
			}
			if path.IsAbs(target) || filepath.IsAbs(target) {
				return fmt.Errorf("archive: illegal absolute symlink %q -> %q", name, target)
			}
			return tw.WriteHeader(&tar.Header{
				Typeflag: tar.TypeSymlink,
				Name:     name,
				Linkname: target,
				Mode:     0o777,
				ModTime:  info.ModTime(),
			})

		case info.Mode().IsRegular():
			st, ok := info.Sys().(*syscall.Stat_t)
			if !ok {
				return fmt.Errorf("archive: cannot stat %q", name)
			}
			key := inodeKey{uint64(st.Dev), uint64(st.Ino)}
			if first, dup := seen[key]; dup {
				// Same inode as an earlier entry: emit a hard link.
				return tw.WriteHeader(&tar.Header{
					Typeflag: tar.TypeLink,
					Name:     name,
					Linkname: first,
					ModTime:  info.ModTime(),
				})
			}
			seen[key] = name
			if err := tw.WriteHeader(&tar.Header{
				Typeflag: tar.TypeReg,
				Name:     name,
				Size:     info.Size(),
				Mode:     int64(info.Mode().Perm()),
				ModTime:  info.ModTime(),
			}); err != nil {
				return err
			}
			f, err := os.Open(p)
			if err != nil {
				return err
			}
			defer f.Close()
			_, err = io.Copy(tw, f)
			return err

		default:
			return fmt.Errorf("archive: illegal entry type %q (%v)", name, info.Mode().Type())
		}
	})
	if walkErr != nil {
		tw.Close()
		return walkErr
	}
	return tw.Close()
}

// pendingLink is a hard link whose target may appear later in the stream.
type pendingLink struct{ linkRel, targetRel string }

// Extract restores an archive read from r into the new root dest.
// dest must not exist yet. Extraction happens in a temporary sibling
// directory and is renamed into place only when every entry — including
// deferred hard links — has been validated and written; any illegal entry
// fails the whole release and leaves no partial output behind.
func Extract(dest string, r io.Reader) error {
	if _, err := os.Lstat(dest); err == nil {
		return fmt.Errorf("archive: destination %q already exists", dest)
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}

	tmp, err := os.MkdirTemp(filepath.Dir(dest), ".extract-*")
	if err != nil {
		return err
	}
	ok := false
	defer func() {
		if !ok {
			os.RemoveAll(tmp)
		}
	}()

	var pending []pendingLink
	tr := tar.NewReader(r)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("archive: read: %w", err)
		}
		rel, err := safeRel(hdr.Name)
		if err != nil {
			return err
		}
		target := filepath.Join(tmp, rel)

		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, permOr(hdr.Mode, 0o755)); err != nil {
				return err
			}
		case tar.TypeReg:
			if hdr.Size < 0 {
				return fmt.Errorf("archive: illegal size for %q", rel)
			}
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			f, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, permOr(hdr.Mode, 0o644))
			if err != nil {
				return err
			}
			if _, err := io.Copy(f, tr); err != nil {
				f.Close()
				return err
			}
			if err := f.Close(); err != nil {
				return err
			}
		case tar.TypeSymlink:
			if err := safeSymlinkTarget(rel, hdr.Linkname); err != nil {
				return err
			}
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			if err := os.Symlink(hdr.Linkname, target); err != nil {
				return err
			}
		case tar.TypeLink:
			targetRel, err := safeRel(hdr.Linkname)
			if err != nil {
				return err
			}
			// The target may arrive later; defer linking until the end.
			pending = append(pending, pendingLink{linkRel: rel, targetRel: targetRel})
		default:
			return fmt.Errorf("archive: illegal entry type %d for %q", hdr.Typeflag, rel)
		}
	}

	for _, pl := range pending {
		srcPath := filepath.Join(tmp, pl.targetRel)
		if _, err := os.Lstat(srcPath); err != nil {
			return fmt.Errorf("archive: hard link %q target %q unavailable: %w", pl.linkRel, pl.targetRel, err)
		}
		linkPath := filepath.Join(tmp, pl.linkRel)
		if err := os.MkdirAll(filepath.Dir(linkPath), 0o755); err != nil {
			return err
		}
		if err := os.Link(srcPath, linkPath); err != nil {
			return fmt.Errorf("archive: hard link %q: %w", pl.linkRel, err)
		}
	}

	if err := os.Rename(tmp, dest); err != nil {
		return fmt.Errorf("archive: publish %q: %w", dest, err)
	}
	ok = true
	return nil
}

// permOr returns the permission bits of mode, falling back to fallback
// when the archive carries no permission information.
func permOr(mode int64, fallback os.FileMode) os.FileMode {
	perm := os.FileMode(mode) & 0o777
	if perm == 0 {
		return fallback
	}
	return perm
}

// safeRel validates an archive member name and returns its cleaned
// slash-separated relative form, rejecting anything that would escape
// the extraction root.
func safeRel(name string) (string, error) {
	if name == "" {
		return "", errors.New("archive: illegal empty entry name")
	}
	if path.IsAbs(name) || filepath.IsAbs(name) {
		return "", fmt.Errorf("archive: illegal absolute path %q", name)
	}
	clean := path.Clean(name)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") {
		return "", fmt.Errorf("archive: path traversal in entry %q", name)
	}
	return clean, nil
}

// safeSymlinkTarget rejects symlink targets that are absolute or that
// would resolve outside the extraction root.
func safeSymlinkTarget(linkRel, target string) error {
	if target == "" {
		return fmt.Errorf("archive: illegal empty symlink target for %q", linkRel)
	}
	if path.IsAbs(target) || filepath.IsAbs(target) {
		return fmt.Errorf("archive: illegal absolute symlink target %q for %q", target, linkRel)
	}
	resolved := path.Clean(path.Join(path.Dir(linkRel), target))
	if resolved == ".." || strings.HasPrefix(resolved, "../") {
		return fmt.Errorf("archive: symlink %q -> %q escapes extraction root", linkRel, target)
	}
	return nil
}
