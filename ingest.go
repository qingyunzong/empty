package q218

import (
	"context"
	"errors"
	"io"
	"path"
	"strings"
)

// EntryType identifies the kind of an archive entry.
type EntryType int

const (
	// TypeFile is a regular file entry.
	TypeFile EntryType = iota + 1
	// TypeDir is a directory entry.
	TypeDir
)

// Entry is a single archive element handed to the ingestor.
//
// Name is an archive-relative, slash-separated path. Type selects between a
// regular file and a directory. DeclaredSize is the caller-advertised content
// length in bytes and is only used to reject entries before any bytes are
// read; the authoritative length is the number of bytes actually consumed
// from Content. Content must be non-nil for regular files and is ignored for
// directories.
type Entry struct {
	Name         string
	Type         EntryType
	DeclaredSize int64
	Content      io.Reader
}

// Iterator streams archive entries one at a time. Next returns io.EOF when no
// more entries are available.
type Iterator interface {
	Next() (*Entry, error)
}

// Limits constrains the number of content bytes the ingestor is willing to
// read. A zero or negative value means unlimited for that dimension.
//
// PerEntry caps the bytes consumed for any single regular file; Total caps the
// bytes consumed across the whole archive. Declared sizes above the applicable
// limit are rejected eagerly, before the entry's content is opened.
type Limits struct {
	PerEntry int64
	Total    int64
}

var (
	// ErrInvalidPath is returned when an entry name cannot be normalized to a
	// clean, in-root relative path (empty, absolute, containing ".." or
	// backslashes, etc.).
	ErrInvalidPath = errors.New("q218: invalid entry path")
	// ErrUnsupportedType is returned for entries that are neither regular
	// files nor directories.
	ErrUnsupportedType = errors.New("q218: unsupported entry type")
	// ErrDuplicateTarget is returned when two entries normalize to the same
	// target path.
	ErrDuplicateTarget = errors.New("q218: duplicate entry target")
	// ErrPathConflict is returned when a file would occupy a path that is an
	// existing directory, or vice versa, including ancestor relationships.
	ErrPathConflict = errors.New("q218: file/directory path conflict")
	// ErrDeclaredTooLarge is returned when a declared size exceeds the
	// per-entry or whole-archive byte budget before reading starts.
	ErrDeclaredTooLarge = errors.New("q218: declared size exceeds budget")
	// ErrMissingContent is returned when a regular file has no content stream.
	ErrMissingContent = errors.New("q218: file entry has no content stream")
	// ErrEntryBudget is returned when an entry's actual bytes exceed the
	// per-entry read budget.
	ErrEntryBudget = errors.New("q218: entry read budget exceeded")
	// ErrTotalBudget is returned when the whole archive's actual bytes exceed
	// the total read budget.
	ErrTotalBudget = errors.New("q218: total read budget exceeded")
	// ErrSizeMismatch is returned when the bytes actually read for a file do
	// not match its declared size.
	ErrSizeMismatch = errors.New("q218: actual content length differs from declared size")
	// ErrIterator is returned when the entry iterator fails.
	ErrIterator = errors.New("q218: iterator failed")
)

// StageTx is a transactional landing area for one archive.
//
// All paths passed to Mkdir and PutFile are normalized slash-separated
// relative paths. Implementations must keep every target inside the staging
// area and reject escapes. An uncommitted transaction is expected to be
// cleaned up by Abort; Commit makes the staged tree visible atomically.
type StageTx interface {
	Mkdir(rel string) error
	PutFile(rel string, content io.Reader) error
	Commit() error
	Abort() error
}

// Stager opens staging transactions.
type Stager interface {
	Begin(ctx context.Context) (StageTx, error)
}

// Ingest consumes every entry from it and lands the archive through stager as
// a single atomic unit. It is independent of any concrete archive format: it
// only relies on the Iterator/Entry contract.
//
// The archive is rejected (and the staging transaction aborted) when an entry
// is invalid, duplicate, conflicting, over budget, shorter or longer than its
// declared size, or cannot be read. Context cancellation likewise aborts the
// transaction. A nil error means the full archive was committed atomically.
func Ingest(ctx context.Context, stager Stager, it Iterator, limits Limits) (err error) {
	tx, err := stager.Begin(ctx)
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			if abortErr := tx.Abort(); abortErr != nil {
				err = errors.Join(err, abortErr)
			}
		}
	}()

	state := newIngestState()
	var totalRead int64

	for {
		if err = ctx.Err(); err != nil {
			return err
		}

		var entry *Entry
		entry, err = it.Next()
		if err == io.EOF {
			err = nil
			break
		}
		if err != nil {
			return errors.Join(ErrIterator, err)
		}
		if entry == nil {
			return errors.Join(ErrIterator, errors.New("nil entry"))
		}

		var rel string
		rel, err = normalizePath(entry.Name)
		if err != nil {
			return err
		}

		switch entry.Type {
		case TypeDir:
			if err = state.checkDir(rel); err != nil {
				return err
			}
			if err = tx.Mkdir(rel); err != nil {
				return err
			}
			state.markExplicitDir(rel)
		case TypeFile:
			if entry.Content == nil {
				return ErrMissingContent
			}
			if entry.DeclaredSize < 0 {
				return errors.Join(ErrDeclaredTooLarge, errors.New("negative declared size"))
			}
			if limits.PerEntry > 0 && entry.DeclaredSize > limits.PerEntry {
				return errors.Join(ErrDeclaredTooLarge, ErrEntryBudget)
			}
			if limits.Total > 0 && totalRead+entry.DeclaredSize > limits.Total {
				return errors.Join(ErrDeclaredTooLarge, ErrTotalBudget)
			}
			if err = state.checkFile(rel); err != nil {
				return err
			}

			if err = state.ensureParentDirs(tx, rel); err != nil {
				return err
			}

			reader := &budgetReader{
				ctx:      ctx,
				reader:   entry.Content,
				entryMax: limits.PerEntry,
				totalMax: limits.Total,
				total:    &totalRead,
			}
			if err = tx.PutFile(rel, reader); err != nil {
				return err
			}
			if reader.entryRead != entry.DeclaredSize {
				return errors.Join(ErrSizeMismatch, errors.New(rel))
			}
			state.markFile(rel)
			for ancestor := range ancestorPaths(rel) {
				state.dirs[ancestor] = true
			}
		default:
			return ErrUnsupportedType
		}
	}

	if err = tx.Commit(); err != nil {
		return err
	}
	committed = true
	return nil
}

// ingestState tracks every target path already seen so that duplicates and
// file/directory conflicts (including ancestor relationships) are rejected
// regardless of the order in which entries arrive.
type ingestState struct {
	// kind records the explicit entry kind at a path.
	kind map[string]EntryType
	// dirs records every directory path, including implicitly created parents.
	dirs map[string]bool
	// explicitDirs records paths introduced by actual directory entries.
	explicitDirs map[string]bool
}

func newIngestState() *ingestState {
	return &ingestState{
		kind:         make(map[string]EntryType),
		dirs:         make(map[string]bool),
		explicitDirs: make(map[string]bool),
	}
}

// checkFile validates a regular-file target against previously seen entries.
func (s *ingestState) checkFile(rel string) error {
	if existing, ok := s.kind[rel]; ok {
		if existing == TypeDir {
			return errors.Join(ErrPathConflict, errors.New(rel+" is a directory"))
		}
		return errors.Join(ErrDuplicateTarget, errors.New(rel))
	}
	// A file cannot live beneath an earlier file, e.g. "a" then "a/b".
	for ancestor := range ancestorPaths(rel) {
		if s.kind[ancestor] == TypeFile {
			return errors.Join(ErrPathConflict, errors.New(ancestor+" is a file"))
		}
	}
	// A file cannot replace an earlier (explicit or implicit) directory,
	// e.g. "a/b" then "a".
	if s.dirs[rel] {
		return errors.Join(ErrPathConflict, errors.New(rel+" is a directory"))
	}
	return nil
}

// checkDir validates a directory target against previously seen entries.
func (s *ingestState) checkDir(rel string) error {
	if existing, ok := s.kind[rel]; ok {
		// An explicit entry already occupies this exact path.
		if existing == TypeFile {
			return errors.Join(ErrPathConflict, errors.New(rel+" is a file"))
		}
		// kind only holds explicit entries, so a directory here means a
		// second directory entry targeting the same path.
		return errors.Join(ErrDuplicateTarget, errors.New(rel))
	}
	// A directory cannot contain an earlier file, e.g. "a/b" then "a".
	for ancestor := range ancestorPaths(rel) {
		if s.kind[ancestor] == TypeFile {
			return errors.Join(ErrPathConflict, errors.New(ancestor+" is a file"))
		}
	}
	// The path already exists as an implicit parent directory for an earlier
	// entry. If it actually contains entries (its implicit state proves it
	// does), re-declaring it as an explicit directory would change its kind
	// and is rejected as a conflict. An implicit leaf directory with no
	// descendants never appears in dirs, so this branch only fires when real
	// content lives below rel.
	if s.dirs[rel] {
		return errors.Join(ErrPathConflict, errors.New(rel+" is already a directory with content"))
	}
	// When no explicit entry exists at rel, any entries below it could only
	// have been created through implicit parent directories of other entries.
	// An implicit parent is a directory by construction, so explicitly
	// declaring it now is an idempotent re-declaration rather than a conflict.
	return nil
}

// ensureParentDirs materializes any ancestor directories that no entry
// introduced explicitly.
func (s *ingestState) ensureParentDirs(tx StageTx, rel string) error {
	for ancestor := range ancestorPaths(rel) {
		if s.dirs[ancestor] {
			continue
		}
		if err := tx.Mkdir(ancestor); err != nil {
			return err
		}
		s.markDir(ancestor)
	}
	return nil
}

func (s *ingestState) markDir(rel string) {
	s.dirs[rel] = true
}

func (s *ingestState) markExplicitDir(rel string) {
	s.dirs[rel] = true
	s.kind[rel] = TypeDir
	s.explicitDirs[rel] = true
}

func (s *ingestState) markFile(rel string) {
	s.kind[rel] = TypeFile
}

// ancestorPaths yields every slash-separated ancestor of rel, excluding rel
// itself and the root. rel is assumed to be a normalized relative path.
func ancestorPaths(rel string) map[string]bool {
	ancestors := make(map[string]bool)
	dir := path.Dir(rel)
	for dir != "." && dir != "/" {
		ancestors[dir] = true
		dir = path.Dir(dir)
	}
	return ancestors
}

// normalizePath resolves name to a clean, root-relative path and rejects
// anything that escapes the archive root or is otherwise unsuitable as a
// landing target.
func normalizePath(name string) (string, error) {
	if name == "" {
		return "", ErrInvalidPath
	}
	if strings.ContainsRune(name, 0) || strings.ContainsRune(name, '\\') {
		return "", ErrInvalidPath
	}
	if path.IsAbs(name) {
		return "", ErrInvalidPath
	}
	cleaned := path.Clean(name)
	if cleaned == "." || cleaned == "/" || cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return "", ErrInvalidPath
	}
	for _, segment := range strings.Split(cleaned, "/") {
		if segment == ".." {
			return "", ErrInvalidPath
		}
	}
	return cleaned, nil
}

// budgetReader enforces both the per-entry and whole-archive byte budgets and
// propagates context cancellation while content is being consumed.
//
// Hitting a budget exactly is allowed: the over-budget error is only raised on
// a subsequent read that would consume beyond it, so streams whose length
// equals the budget read cleanly to EOF.
type budgetReader struct {
	ctx       context.Context
	reader    io.Reader
	entryMax  int64
	totalMax  int64
	entryRead int64
	total     *int64
	// atLimit marks that the last read consumed exactly up to a budget
	// boundary. The following read probes with a single byte to distinguish a
	// stream that ends exactly at the boundary from one that overflows it.
	atLimit  bool
	limitHit EntryType // 0 = none, TypeFile = entry budget, TypeDir = total
}

func (r *budgetReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	if len(p) == 0 {
		return 0, nil
	}
	if r.atLimit {
		return r.probeBoundary()
	}

	limit := int64(len(p))
	var hit EntryType
	if r.entryMax > 0 {
		if remaining := r.entryMax - r.entryRead; remaining < limit {
			limit = remaining
			hit = TypeFile
		}
	}
	if r.totalMax > 0 {
		if remaining := r.totalMax - *r.total; remaining < limit {
			limit = remaining
			hit = TypeDir
		}
	}
	if limit < 0 {
		return 0, r.budgetError()
	}

	n, err := r.reader.Read(p[:int(limit)])
	r.entryRead += int64(n)
	*r.total += int64(n)
	if err != nil {
		return n, err
	}
	if hit != 0 && int64(n) == limit {
		r.atLimit = true
		r.limitHit = hit
	}
	return n, nil
}

// probeBoundary performs a one-byte look-ahead once the budget has been
// consumed exactly. No further byte means the stream legally ended at the
// boundary; any byte means the budget was genuinely exceeded.
func (r *budgetReader) probeBoundary() (int, error) {
	var one [1]byte
	n, err := r.reader.Read(one[:])
	if n > 0 {
		r.entryRead++
		*r.total++
		if r.limitHit == TypeFile {
			return 0, ErrEntryBudget
		}
		return 0, ErrTotalBudget
	}
	r.atLimit = false
	if err != nil {
		return 0, err
	}
	// A well-behaved reader returns (0, nil) only transiently; ask again.
	return r.Read(one[:])
}

func (r *budgetReader) budgetError() error {
	if r.entryMax > 0 && r.entryRead > r.entryMax {
		return ErrEntryBudget
	}
	return ErrTotalBudget
}
