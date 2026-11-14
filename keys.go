package dataeng

import (
	"path"
	"strings"
)

const (
	// DataObjectPrefix is the key prefix, relative to a table prefix, for
	// immutable content-addressed data objects.
	DataObjectPrefix = "data/sha256/"

	// ManifestObjectPrefix is the key prefix, relative to a table prefix,
	// for immutable manifests.
	ManifestObjectPrefix = "metadata/manifests/"

	// HeadObjectName is the single mutable pointer object, relative to a
	// table prefix.
	HeadObjectName = "metadata/HEAD"
)

// DataObjectKey returns the relative object key for a sha256 digest.
func DataObjectKey(digest string) (string, error) {
	hex, err := digestHex(digest)
	if err != nil {
		return "", err
	}
	return DataObjectPrefix + hex, nil
}

// ManifestObjectKey returns the relative object key for a manifest digest.
func ManifestObjectKey(id string) (string, error) {
	hex, err := digestHex(id)
	if err != nil {
		return "", err
	}
	return ManifestObjectPrefix + hex + ".json", nil
}

func cleanPrefix(prefix string) string {
	prefix = strings.TrimSpace(prefix)
	prefix = strings.Trim(prefix, "/")
	if prefix == "" {
		return ""
	}
	clean := path.Clean(prefix)
	if clean == "." {
		return ""
	}
	return clean
}

func withPrefix(prefix, relative string) string {
	prefix = cleanPrefix(prefix)
	if prefix == "" {
		return relative
	}
	return prefix + "/" + relative
}

func dataKey(prefix, digest string) (string, error) {
	relative, err := DataObjectKey(digest)
	if err != nil {
		return "", err
	}
	return withPrefix(prefix, relative), nil
}

func manifestKey(prefix, id string) (string, error) {
	relative, err := ManifestObjectKey(id)
	if err != nil {
		return "", err
	}
	return withPrefix(prefix, relative), nil
}

func headKey(prefix string) string {
	return withPrefix(prefix, HeadObjectName)
}

func validLogicalPath(name string) bool {
	if name == "" || strings.HasPrefix(name, "/") || strings.ContainsRune(name, 0) {
		return false
	}
	if path.Clean(name) != name {
		return false
	}
	return name != "." && name != ".."
}

func validObjectKey(key string) bool {
	if key == "" || strings.HasPrefix(key, "/") || strings.ContainsRune(key, 0) {
		return false
	}
	if path.Clean(key) != key {
		return false
	}
	return key != "." && key != ".."
}
