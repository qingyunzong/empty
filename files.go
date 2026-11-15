package dataeng

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

func sanitizeSuggestedName(raw string) (string, error) {
	if strings.TrimSpace(raw) == "" {
		return "", fmt.Errorf("%w: empty name", ErrInvalidFilename)
	}
	if strings.ContainsRune(raw, '\x00') {
		return "", fmt.Errorf("%w: contains NUL", ErrInvalidFilename)
	}

	// Browser suggestions sometimes contain Windows separators even on other
	// platforms. Normalize both separators before taking the final element.
	normalized := strings.ReplaceAll(raw, "\\", "/")
	name := strings.TrimSpace(path.Base(normalized))
	if name == "" || name == "." || name == ".." || name == "/" {
		return "", fmt.Errorf("%w: %q", ErrInvalidFilename, raw)
	}
	return name, nil
}

func normalizeSHA256(raw string) (string, error) {
	value := strings.TrimSpace(strings.ToLower(raw))
	value = strings.TrimPrefix(value, "sha256:")
	value = strings.TrimPrefix(value, "sha256=")
	if value == "" {
		return "", nil
	}
	decoded, err := hex.DecodeString(value)
	if err != nil || len(decoded) != sha256.Size {
		return "", fmt.Errorf("%w: %q", ErrInvalidDigest, raw)
	}
	return hex.EncodeToString(decoded), nil
}

func (c *Coordinator) settle(ctx context.Context, filename string, expectedSize int64, cancel <-chan struct{}) (os.FileInfo, error) {
	ticker := time.NewTicker(c.pollInterval)
	defer ticker.Stop()

	var (
		lastSize    int64
		stableSince time.Time
		seen        bool
	)

	for {
		if err := contextError(ctx); err != nil {
			return nil, err
		}
		select {
		case <-cancel:
			return nil, ErrCanceled
		default:
		}

		info, err := os.Stat(filename)
		now := time.Now()
		switch {
		case err == nil:
			if !info.Mode().IsRegular() {
				return nil, fmt.Errorf("%w: %s", ErrNotRegularFile, filename)
			}
			if expectedSize > 0 && info.Size() > expectedSize {
				return nil, fmt.Errorf("%w: expected %d bytes, file already has %d", ErrSizeMismatch, expectedSize, info.Size())
			}
			if !seen || info.Size() != lastSize {
				seen = true
				lastSize = info.Size()
				stableSince = now
			} else if now.Sub(stableSince) >= c.stableWindow {
				return info, nil
			}
		case errors.Is(err, os.ErrNotExist):
			seen = false
			lastSize = 0
			stableSince = time.Time{}
		default:
			return nil, fmt.Errorf("dataeng: stat temporary file: %w", err)
		}

		if c.stableWindow == 0 && seen {
			return info, nil
		}

		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-cancel:
			return nil, ErrCanceled
		case <-ticker.C:
		}
	}
}

func digestFile(ctx context.Context, filename string, cancel <-chan struct{}) (string, int64, time.Time, error) {
	file, err := os.Open(filename)
	if err != nil {
		return "", 0, time.Time{}, fmt.Errorf("dataeng: open temporary file: %w", err)
	}
	defer file.Close()

	before, err := file.Stat()
	if err != nil {
		return "", 0, time.Time{}, fmt.Errorf("dataeng: stat temporary file: %w", err)
	}
	if !before.Mode().IsRegular() {
		return "", 0, time.Time{}, fmt.Errorf("%w: %s", ErrNotRegularFile, filename)
	}

	hash := sha256.New()
	buffer := make([]byte, 128*1024)
	var size int64
	for {
		select {
		case <-ctx.Done():
			return "", 0, time.Time{}, ctx.Err()
		case <-cancel:
			return "", 0, time.Time{}, ErrCanceled
		default:
		}

		n, readErr := file.Read(buffer)
		if n > 0 {
			_, _ = hash.Write(buffer[:n])
			size += int64(n)
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return "", 0, time.Time{}, fmt.Errorf("dataeng: read temporary file: %w", readErr)
		}
	}

	after, err := file.Stat()
	if err != nil {
		return "", 0, time.Time{}, fmt.Errorf("dataeng: stat temporary file: %w", err)
	}
	if before.Size() != after.Size() || size != after.Size() || !before.ModTime().Equal(after.ModTime()) {
		return "", 0, time.Time{}, errFileChanged
	}

	return hex.EncodeToString(hash.Sum(nil)), size, after.ModTime(), nil
}

func (c *Coordinator) pickTargetLocked(name string, overwrite bool) (string, error) {
	if overwrite {
		target := filepath.Join(c.dir, name)
		info, err := os.Lstat(target)
		if err == nil && info.IsDir() {
			return "", fmt.Errorf("%w: %s", ErrTargetIsDirectory, target)
		}
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return "", fmt.Errorf("dataeng: inspect target: %w", err)
		}
		return target, nil
	}

	for attempt := 0; attempt < maxNameAttempts; attempt++ {
		candidateName := name
		if attempt > 0 {
			candidateName = numberedName(name, attempt)
		}
		target := filepath.Join(c.dir, candidateName)
		_, err := os.Lstat(target)
		if errors.Is(err, os.ErrNotExist) {
			return target, nil
		}
		if err != nil {
			return "", fmt.Errorf("dataeng: inspect target: %w", err)
		}
		// Existing files and directories are skipped. This keeps concurrent
		// downloads with the same suggested name isolated from each other.
	}
	return "", fmt.Errorf("%w: %q", ErrNameExhausted, name)
}

func numberedName(name string, n int) string {
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	if stem == "" {
		// Preserve dotfiles such as ".profile" instead of producing " (1)".
		stem = name
		ext = ""
	}
	return fmt.Sprintf("%s (%d)%s", stem, n, ext)
}

func moveIntoPlace(ctx context.Context, source, target, expectedDigest string) error {
	err := os.Rename(source, target)
	if err == nil {
		syncDirectory(filepath.Dir(target))
		return nil
	}
	if !errors.Is(err, syscall.EXDEV) {
		return fmt.Errorf("dataeng: move download into place: %w", err)
	}

	// The browser temp directory and the destination may be on different
	// filesystems. Stage a complete copy beside the target and rename that
	// copy, so the final publication remains a single atomic rename.
	stage, err := os.CreateTemp(filepath.Dir(target), ".dataeng-stage-*")
	if err != nil {
		return fmt.Errorf("dataeng: create staging file: %w", err)
	}
	stageName := stage.Name()
	cleanup := func() {
		_ = stage.Close()
		_ = os.Remove(stageName)
	}

	sourceFile, err := os.Open(source)
	if err != nil {
		cleanup()
		return fmt.Errorf("dataeng: open temporary file: %w", err)
	}
	defer sourceFile.Close()

	sourceInfo, err := sourceFile.Stat()
	if err != nil {
		cleanup()
		return fmt.Errorf("dataeng: stat temporary file: %w", err)
	}

	hash := sha256.New()
	buffer := make([]byte, 128*1024)
	for {
		select {
		case <-ctx.Done():
			cleanup()
			return ctx.Err()
		default:
		}
		n, readErr := sourceFile.Read(buffer)
		if n > 0 {
			if _, err := stage.Write(buffer[:n]); err != nil {
				cleanup()
				return fmt.Errorf("dataeng: write staging file: %w", err)
			}
			_, _ = hash.Write(buffer[:n])
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			cleanup()
			return fmt.Errorf("dataeng: read temporary file: %w", readErr)
		}
	}

	if err := stage.Sync(); err != nil {
		cleanup()
		return fmt.Errorf("dataeng: sync staging file: %w", err)
	}
	if err := stage.Close(); err != nil {
		_ = os.Remove(stageName)
		return fmt.Errorf("dataeng: close staging file: %w", err)
	}

	actualDigest := hex.EncodeToString(hash.Sum(nil))
	if actualDigest != expectedDigest {
		_ = os.Remove(stageName)
		return errFileChanged
	}
	if err := os.Chmod(stageName, sourceInfo.Mode().Perm()); err != nil {
		_ = os.Remove(stageName)
		return fmt.Errorf("dataeng: set staging permissions: %w", err)
	}
	if err := os.Rename(stageName, target); err != nil {
		_ = os.Remove(stageName)
		return fmt.Errorf("dataeng: publish staging file: %w", err)
	}
	syncDirectory(filepath.Dir(target))

	// Publication is complete; failure to remove the source would only leave a
	// stale temporary file, not expose a partially written artifact.
	_ = os.Remove(source)
	return nil
}

func syncDirectory(dir string) {
	file, err := os.Open(dir)
	if err != nil {
		return
	}
	_ = file.Sync()
	_ = file.Close()
}
