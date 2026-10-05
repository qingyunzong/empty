package store

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
)

// manifest is the commit record of one generation. The atomic rename of the
// manifest file is the single commit point: before it the old generation is
// fully intact, after it the new generation (segment + index, both already
// fsynced) is fully intact.
type manifest struct {
	Generation uint64   `json:"generation"`
	Segments   []uint64 `json:"segments"`
}

func manifestPath(dir string) string {
	return filepath.Join(dir, "manifest.json")
}

func readManifest(dir string) (manifest, error) {
	buf, err := os.ReadFile(manifestPath(dir))
	if errors.Is(err, fs.ErrNotExist) {
		return manifest{}, nil
	}
	if err != nil {
		return manifest{}, err
	}
	var m manifest
	if err := json.Unmarshal(buf, &m); err != nil {
		return manifest{}, err
	}
	return m, nil
}

// writeManifest publishes m atomically: tmp file -> fsync -> rename ->
// dir fsync.
func writeManifest(dir string, m manifest) error {
	buf, err := json.Marshal(m)
	if err != nil {
		return err
	}
	tmp := manifestPath(dir) + ".tmp"
	if err := os.WriteFile(tmp, buf, 0o644); err != nil {
		return err
	}
	if err := syncFile(tmp); err != nil {
		return err
	}
	if err := os.Rename(tmp, manifestPath(dir)); err != nil {
		return err
	}
	return syncDir(dir)
}

func syncFile(path string) error {
	f, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}

func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
