package formal

import (
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	// ErrClosed is returned by operations on a closed Writer.
	ErrClosed = errors.New("formal: writer is closed")

	// ErrDiskFull is returned when accepting a write would make the total
	// managed size exceed Config.MaxTotalBytes. Existing log data is never
	// truncated or overwritten; if rotation was required first, the old
	// segment remains as a backup and the new active file stays empty.
	ErrDiskFull = errors.New("formal: disk budget exceeded")

	// ErrInvalidConfig is wrapped by configuration validation errors.
	ErrInvalidConfig = errors.New("formal: invalid configuration")

	// errSkipCompression is internal: the gzip representation would not fit
	// in the byte budget, so the raw file is deliberately retained.
	errSkipCompression = errors.New("formal: compression would exceed disk budget")
)

const (
	backupSeqWidth = 20
)

// Config controls a Writer.
//
// Rotation boundaries are closed on the triggering side:
//
//   - MaxSize is the maximum number of bytes a rotated file may contain. A
//     non-empty write which would make the active file larger than MaxSize
//     rotates first. A write which exactly reaches MaxSize does not rotate;
//     the following non-empty write does. A single write larger than MaxSize
//     is allowed when the active file is empty and becomes the whole active
//     file.
//   - MaxAge is the maximum age of the active segment. At exactly MaxAge the
//     segment is eligible for rotation; writes strictly before that boundary
//     use the current segment.
//
// MaxBackups counts rotated files only. The active file is always kept.
// MaxTotalBytes is a hard budget for the active file plus every rotated file.
// The Writer never truncates, reuses, or overwrites an existing log to make a
// write fit. If a write cannot fit, it fails with ErrDiskFull. Retention and
// successful compression are the only operations which free budget.
//
// Zero disables size, age, and byte-budget limits. MaxBackups is always a
// count, so zero means "keep no rotated files".
type Config struct {
	// Dir is the directory holding the active file and its backups.
	Dir string

	// BaseName is the file name of the active log, for example "app.log".
	// It must not contain a path separator.
	BaseName string

	// MaxSize is the maximum size of a rotated file in bytes. Zero disables
	// size-based rotation.
	MaxSize int64

	// MaxAge is the maximum age of the active segment. Zero disables
	// time-based rotation.
	MaxAge time.Duration

	// MaxBackups is the number of newest rotated files to retain. All but the
	// newest MaxBackups rotated files are deleted. Zero keeps no rotated
	// files.
	MaxBackups int

	// Compress gzips rotated files. The raw file is removed only after the
	// complete gzip file has been written, closed, and renamed into place.
	Compress bool

	// MaxTotalBytes is the hard upper bound on the total size of the active
	// file and all retained rotated files. Zero disables the budget.
	MaxTotalBytes int64

	// Now supplies the clock. It defaults to time.Now.
	Now func() time.Time
}

// FileInfo describes a managed file at the time of a Stats call.
type FileInfo struct {
	Name       string
	Size       int64
	Compressed bool
}

// Stats is a snapshot of a Writer.
type Stats struct {
	ActiveSize        int64
	Backups           int
	CompressedBackups int
	Usage             int64
	Files             []FileInfo

	// MaintenanceError is the most recent non-fatal compression or
	// retention error. Such an error never causes log data to be dropped.
	MaintenanceError error
}

type backup struct {
	path       string
	size       int64
	seq        uint64
	compressed bool
}

// Writer is an io.WriteCloser which rotates, compresses, and prunes log files.
// It is safe for concurrent use by multiple goroutines. A directory should be
// owned by one Writer at a time.
type Writer struct {
	mu  sync.Mutex
	cfg Config

	activePath string
	file       *os.File
	activeSize int64
	openedAt   time.Time

	backups []backup
	seq     uint64
	usage   int64

	lastErr error
	closed  bool
}

// NewWriter opens (or creates) the active file and validates all managed
// files. Existing rotated files are counted, retained according to
// MaxBackups, and compressed when Compress is enabled.
func NewWriter(cfg Config) (*Writer, error) {
	if err := validateConfig(&cfg); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(cfg.Dir, 0o755); err != nil {
		return nil, err
	}

	w := &Writer{
		cfg:        cfg,
		activePath: filepath.Join(cfg.Dir, cfg.BaseName),
	}
	if err := w.loadBackups(); err != nil {
		return nil, err
	}
	w.removeTemps()

	f, err := os.OpenFile(w.activePath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, err
	}
	info, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, err
	}
	w.file = f
	w.activeSize = info.Size()
	w.openedAt = w.now()
	w.usage = w.activeSize
	for _, b := range w.backups {
		w.usage += b.size
	}

	// Bring a directory left by an earlier process back to the configured
	// invariants. Compression errors are reported by Stats but do not prevent
	// opening the log.
	w.maintainLocked()
	return w, nil
}

func validateConfig(cfg *Config) error {
	if cfg.Dir == "" {
		return fmt.Errorf("%w: Dir is empty", ErrInvalidConfig)
	}
	if cfg.BaseName == "" {
		return fmt.Errorf("%w: BaseName is empty", ErrInvalidConfig)
	}
	if filepath.Base(cfg.BaseName) != cfg.BaseName ||
		cfg.BaseName == "." || cfg.BaseName == ".." {
		return fmt.Errorf("%w: BaseName must be a plain file name", ErrInvalidConfig)
	}
	if cfg.MaxSize < 0 {
		return fmt.Errorf("%w: MaxSize is negative", ErrInvalidConfig)
	}
	if cfg.MaxAge < 0 {
		return fmt.Errorf("%w: MaxAge is negative", ErrInvalidConfig)
	}
	if cfg.MaxBackups < 0 {
		return fmt.Errorf("%w: MaxBackups is negative", ErrInvalidConfig)
	}
	if cfg.MaxTotalBytes < 0 {
		return fmt.Errorf("%w: MaxTotalBytes is negative", ErrInvalidConfig)
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	return nil
}

func (w *Writer) now() time.Time {
	return w.cfg.Now()
}

// Write appends p to the active file, rotating first when a configured
// boundary is reached. A failed write never modifies an existing file.
func (w *Writer) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	if w.closed {
		return 0, ErrClosed
	}
	if len(p) == 0 {
		return 0, nil
	}
	if w.file == nil {
		if err := w.reopenActive(); err != nil {
			return 0, err
		}
	}

	now := w.now()
	if w.mustRotate(len(p), now) {
		if err := w.rotateLocked(now); err != nil {
			return 0, err
		}
	} else if w.activeSize == 0 && w.cfg.MaxAge > 0 &&
		now.Sub(w.openedAt) >= w.cfg.MaxAge {
		// An old but empty segment is simply restarted. Rotating it would
		// create an empty backup.
		w.openedAt = now
	}

	if !w.fits(len(p)) {
		return 0, ErrDiskFull
	}

	n, err := w.file.Write(p)
	if n > 0 {
		w.activeSize += int64(n)
		w.usage += int64(n)
	}
	if err == nil && n != len(p) {
		err = io.ErrShortWrite
	}
	return n, err
}

func (w *Writer) mustRotate(n int, now time.Time) bool {
	if w.activeSize == 0 {
		return false
	}
	if w.cfg.MaxSize > 0 && int64(n) > w.cfg.MaxSize-w.activeSize {
		return true
	}
	if w.cfg.MaxAge > 0 && now.Sub(w.openedAt) >= w.cfg.MaxAge {
		return true
	}
	return false
}

func (w *Writer) fits(n int) bool {
	if w.cfg.MaxTotalBytes == 0 {
		return true
	}
	return int64(n) <= w.cfg.MaxTotalBytes-w.usage
}

// Rotate starts a new active file when the current one contains data. It
// applies compression and retention exactly like an automatic rotation.
func (w *Writer) Rotate() error {
	w.mu.Lock()
	defer w.mu.Unlock()

	if w.closed {
		return ErrClosed
	}
	return w.rotateLocked(w.now())
}

func (w *Writer) rotateLocked(now time.Time) error {
	if w.activeSize == 0 {
		return nil
	}
	if w.file == nil {
		if err := w.reopenActive(); err != nil {
			return err
		}
	}

	if err := w.file.Close(); err != nil {
		w.file = nil
		_ = w.reopenActive()
		return err
	}
	w.file = nil

	w.seq++
	b := backup{
		path: w.backupPath(w.seq, now, false),
		size: w.activeSize,
		seq:  w.seq,
	}
	if err := os.Rename(w.activePath, b.path); err != nil {
		_ = w.reopenActive()
		return err
	}
	oldSize := w.activeSize
	w.activeSize = 0
	w.backups = append(w.backups, b)

	f, err := os.OpenFile(w.activePath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		// Put the old segment back so a failed rotation cannot lose data.
		w.backups = w.backups[:len(w.backups)-1]
		w.activeSize = oldSize
		if renameErr := os.Rename(b.path, w.activePath); renameErr != nil {
			// The renamed backup is still the only copy of the old data.
			// Track it rather than losing its bytes from accounting.
			w.backups = append(w.backups, b)
			w.activeSize = 0
			w.lastErr = errors.Join(w.lastErr, renameErr)
		} else {
			_ = w.reopenActive()
		}
		return err
	}
	w.file = f
	w.openedAt = now

	if w.cfg.Compress {
		if err := w.compressBackupLocked(&w.backups[len(w.backups)-1]); err != nil &&
			!errors.Is(err, errSkipCompression) {
			w.lastErr = errors.Join(w.lastErr, err)
		}
	}
	if err := w.applyRetentionLocked(); err != nil {
		w.lastErr = errors.Join(w.lastErr, err)
	}
	return nil
}

func (w *Writer) reopenActive() error {
	f, err := os.OpenFile(w.activePath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	info, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return err
	}
	w.file = f
	w.activeSize = info.Size()
	return nil
}

func (w *Writer) backupPath(seq uint64, t time.Time, compressed bool) string {
	suffix := ".log"
	if compressed {
		suffix = ".log.gz"
	}
	return filepath.Join(w.cfg.Dir, fmt.Sprintf("%s.%0*d.%d%s",
		w.cfg.BaseName, backupSeqWidth, seq, t.UTC().UnixNano(), suffix))
}

// compressBackupLocked replaces b with a gzip file. The raw file is not
// removed until the gzip file has been completely written, closed, and renamed
// into place. If compression would exceed the byte budget, the raw file is
// kept and no bytes are lost.
func (w *Writer) compressBackupLocked(b *backup) error {
	if b.compressed {
		return nil
	}

	src, err := os.Open(b.path)
	if err != nil {
		return err
	}
	defer src.Close()

	tmp, err := os.CreateTemp(w.cfg.Dir,
		"."+filepath.Base(w.cfg.BaseName)+".tmp-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	committed := false
	defer func() {
		if !committed {
			_ = tmp.Close()
			_ = os.Remove(tmpPath)
		}
	}()

	gz := gzip.NewWriter(tmp)
	if _, err := io.Copy(gz, src); err != nil {
		return err
	}
	if err := gz.Close(); err != nil {
		return err
	}
	info, err := tmp.Stat()
	if err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	gzSize := info.Size()

	newUsage := w.usage - b.size + gzSize
	if w.cfg.MaxTotalBytes > 0 && newUsage > w.cfg.MaxTotalBytes {
		return errSkipCompression
	}

	finalPath := b.path + ".gz"
	if err := os.Rename(tmpPath, finalPath); err != nil {
		return err
	}
	// The gzip file is now durable under its final name. Only now is it safe
	// to remove the raw source.
	if err := os.Remove(b.path); err != nil {
		// Roll the duplicate gzip file back if possible, leaving the raw log
		// as the authoritative copy.
		_ = os.Remove(finalPath)
		return err
	}
	committed = true

	w.usage = newUsage
	b.path = finalPath
	b.size = gzSize
	b.compressed = true
	return nil
}

func (w *Writer) applyRetentionLocked() error {
	if len(w.backups) <= w.cfg.MaxBackups {
		return nil
	}
	sort.Slice(w.backups, func(i, j int) bool {
		return w.backups[i].seq < w.backups[j].seq
	})
	for len(w.backups) > w.cfg.MaxBackups {
		b := w.backups[0]
		if err := os.Remove(b.path); err != nil && !os.IsNotExist(err) {
			return err
		}
		w.usage -= b.size
		w.backups = w.backups[1:]
	}
	return nil
}

// Maintain compresses any uncompressed retained backup and reapplies the
// retention count. It is useful after a process restart or an earlier
// compression failure. Data is never removed before a complete replacement
// exists.
func (w *Writer) Maintain() error {
	w.mu.Lock()
	defer w.mu.Unlock()

	if w.closed {
		return ErrClosed
	}
	return w.maintainLocked()
}

func (w *Writer) maintainLocked() error {
	var errs []error
	if w.cfg.Compress {
		for i := range w.backups {
			if err := w.compressBackupLocked(&w.backups[i]); err != nil &&
				!errors.Is(err, errSkipCompression) {
				errs = append(errs, err)
			}
		}
	}
	if err := w.applyRetentionLocked(); err != nil {
		errs = append(errs, err)
	}
	if len(errs) > 0 {
		err := errors.Join(errs...)
		w.lastErr = errors.Join(w.lastErr, err)
		return err
	}
	return nil
}

// Sync flushes the active file to stable storage.
func (w *Writer) Sync() error {
	w.mu.Lock()
	defer w.mu.Unlock()

	if w.closed {
		return ErrClosed
	}
	if w.file == nil {
		if err := w.reopenActive(); err != nil {
			return err
		}
	}
	return w.file.Sync()
}

// Close flushes and closes the active file. It is idempotent.
func (w *Writer) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()

	if w.closed {
		return nil
	}
	w.closed = true
	if w.file == nil {
		return nil
	}
	err := w.file.Sync()
	if closeErr := w.file.Close(); err == nil {
		err = closeErr
	}
	w.file = nil
	return err
}

// Stats returns an immutable snapshot of the writer.
func (w *Writer) Stats() Stats {
	w.mu.Lock()
	defer w.mu.Unlock()

	files := make([]FileInfo, 0, len(w.backups)+1)
	if w.activePath != "" {
		files = append(files, FileInfo{
			Name: w.cfg.BaseName,
			Size: w.activeSize,
		})
	}
	compressed := 0
	for _, b := range w.backups {
		if b.compressed {
			compressed++
		}
		files = append(files, FileInfo{
			Name:       filepath.Base(b.path),
			Size:       b.size,
			Compressed: b.compressed,
		})
	}
	return Stats{
		ActiveSize:        w.activeSize,
		Backups:           len(w.backups),
		CompressedBackups: compressed,
		Usage:             w.usage,
		Files:             files,
		MaintenanceError:  w.lastErr,
	}
}

func (w *Writer) loadBackups() error {
	entries, err := os.ReadDir(w.cfg.Dir)
	if err != nil {
		return err
	}
	prefix := w.cfg.BaseName + "."
	for _, ent := range entries {
		if ent.IsDir() {
			continue
		}
		name := ent.Name()
		if name == w.cfg.BaseName || !strings.HasPrefix(name, prefix) {
			continue
		}
		rest := strings.TrimPrefix(name, prefix)
		compressed := false
		switch {
		case strings.HasSuffix(rest, ".log.gz"):
			rest = strings.TrimSuffix(rest, ".log.gz")
			compressed = true
		case strings.HasSuffix(rest, ".log"):
			rest = strings.TrimSuffix(rest, ".log")
		default:
			continue
		}
		parts := strings.Split(rest, ".")
		if len(parts) != 2 {
			continue
		}
		seq, err := strconv.ParseUint(parts[0], 10, 64)
		if err != nil {
			continue
		}
		if _, err := strconv.ParseInt(parts[1], 10, 64); err != nil {
			continue
		}
		info, err := ent.Info()
		if err != nil {
			return err
		}
		if seq > w.seq {
			w.seq = seq
		}
		w.backups = append(w.backups, backup{
			path:       filepath.Join(w.cfg.Dir, name),
			size:       info.Size(),
			seq:        seq,
			compressed: compressed,
		})
	}
	sort.Slice(w.backups, func(i, j int) bool {
		return w.backups[i].seq < w.backups[j].seq
	})
	w.backups = w.dedupeBackups(w.backups)
	return nil
}

// dedupeBackups handles the narrow crash window in which a completed .gz file
// and its raw source both exist. The gzip file is authoritative; the raw file
// is removed only after the duplicate is observed to be complete.
func (w *Writer) dedupeBackups(in []backup) []backup {
	out := make([]backup, 0, len(in))
	for _, b := range in {
		if len(out) == 0 || out[len(out)-1].seq != b.seq {
			out = append(out, b)
			continue
		}
		prev := &out[len(out)-1]
		switch {
		case b.compressed && !prev.compressed:
			if err := os.Remove(prev.path); err == nil {
				*prev = b
			} else {
				out = append(out, b)
			}
		case prev.compressed && !b.compressed:
			if err := os.Remove(b.path); err != nil {
				out = append(out, b)
			}
		default:
			out = append(out, b)
		}
	}
	return out
}

func (w *Writer) removeTemps() {
	entries, err := os.ReadDir(w.cfg.Dir)
	if err != nil {
		return
	}
	prefix := "." + filepath.Base(w.cfg.BaseName) + ".tmp-"
	for _, ent := range entries {
		if !ent.IsDir() && strings.HasPrefix(ent.Name(), prefix) {
			_ = os.Remove(filepath.Join(w.cfg.Dir, ent.Name()))
		}
	}
}
