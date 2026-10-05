package buildcache

import (
	"crypto/sha256"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
)

// Open rebuilds a cache by scanning dir. Incomplete temp files left behind
// by interrupted writes (names containing the temp marker) are ignored.
// Paths sharing an inode are folded into a single entry so the recovered
// usage charges each inode once, matching what a fresh cache would report.
func Open(dir string, budget int64) (*Cache, error) {
	c := New(dir, budget)

	type discovered struct {
		path string
		fi   os.FileInfo
	}
	var found []discovered
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		if isTempName(d.Name()) {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return err
		}
		found = append(found, discovered{path: filepath.ToSlash(rel), fi: info})
		return nil
	})
	if err != nil {
		return nil, err
	}

	// Deterministic cold-to-warm access order from the scan.
	sort.Slice(found, func(i, j int) bool { return found[i].path < found[j].path })

	c.mu.Lock()
	defer c.mu.Unlock()
	for _, d := range found {
		hash, err := hashFile(filepath.Join(dir, d.path))
		if err != nil {
			return nil, err
		}
		if err := c.register(d.path, hash, d.fi); err != nil {
			return nil, err
		}
	}
	return c, nil
}

func hashFile(path string) ([sha256.Size]byte, error) {
	var sum [sha256.Size]byte
	f, err := os.Open(path)
	if err != nil {
		return sum, err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return sum, err
	}
	copy(sum[:], h.Sum(nil))
	return sum, nil
}
