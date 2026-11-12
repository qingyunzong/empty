package dataeng

import (
	"fmt"
	"sort"
)

type normalizedKey struct {
	nilKey bool
	intKey int64
	strKey string
}

type positionKey struct {
	fileID    string
	rowNumber int64
}

type candidate struct {
	evidence DeleteEvidence
	order    int
}

// DeleteIndex is an immutable index over delete records. Building the index
// validates every delete before any data row can be scanned. The index copies
// all values it retains and never mutates the delete slice supplied by the
// caller. It is safe for concurrent scans once built.
type DeleteIndex struct {
	keyType KeyType

	positions    map[positionKey][]candidate
	equalityInt  map[int64][]candidate
	equalityStr  map[string][]candidate
	equalityNull []candidate
}

// BuildDeleteIndex validates all deletes and constructs an immutable index.
//
// Validation covers the configured key type, every delete kind, every
// equality-delete key, and position-delete row numbers. If any delete is
// invalid, no index is returned and scanning cannot begin.
func BuildDeleteIndex(keyType KeyType, deletes []Delete) (*DeleteIndex, error) {
	if !keyType.Valid() {
		return nil, fmt.Errorf("%w: %v", ErrInvalidKeyType, keyType)
	}

	index := &DeleteIndex{
		keyType:   keyType,
		positions: make(map[positionKey][]candidate),
	}
	switch keyType {
	case KeyTypeInt64:
		index.equalityInt = make(map[int64][]candidate)
	case KeyTypeString:
		index.equalityStr = make(map[string][]candidate)
	}

	for i := range deletes {
		if err := index.addDelete(i, deletes[i]); err != nil {
			return nil, fmt.Errorf("delete[%d]: %w", i, err)
		}
	}

	index.sortCandidates()
	return index, nil
}

// NewDeleteIndex is an alias for BuildDeleteIndex.
func NewDeleteIndex(keyType KeyType, deletes []Delete) (*DeleteIndex, error) {
	return BuildDeleteIndex(keyType, deletes)
}

// KeyType returns the configured key column type.
func (index *DeleteIndex) KeyType() KeyType {
	if index == nil {
		return KeyTypeInvalid
	}
	return index.keyType
}

func (index *DeleteIndex) addDelete(order int, delete Delete) error {
	switch delete.Kind {
	case PositionDeleteKind:
		if delete.RowNumber < 0 {
			return fmt.Errorf("%w: position row number %d", ErrInvalidRowNumber, delete.RowNumber)
		}
		key := positionKey{fileID: delete.DataFileID, rowNumber: delete.RowNumber}
		index.positions[key] = append(index.positions[key], candidate{
			evidence: DeleteEvidence{
				Kind:           delete.Kind,
				DeleteFileID:   delete.DeleteFileID,
				SequenceNumber: delete.SequenceNumber,
				DataFileID:     delete.DataFileID,
				RowNumber:      delete.RowNumber,
			},
			order: order,
		})

	case EqualityDeleteKind:
		key, err := index.normalizeKey(delete.Key)
		if err != nil {
			return err
		}
		entry := candidate{
			evidence: DeleteEvidence{
				Kind:           delete.Kind,
				DeleteFileID:   delete.DeleteFileID,
				SequenceNumber: delete.SequenceNumber,
				Key:            delete.Key,
			},
			order: order,
		}
		if key.nilKey {
			index.equalityNull = append(index.equalityNull, entry)
		} else {
			index.addEqualityKey(key, entry)
		}

	default:
		return fmt.Errorf("%w: %d", ErrInvalidDeleteKind, delete.Kind)
	}
	return nil
}

func (index *DeleteIndex) addEqualityKey(key normalizedKey, entry candidate) {
	switch index.keyType {
	case KeyTypeInt64:
		index.equalityInt[key.intKey] = append(index.equalityInt[key.intKey], entry)
	case KeyTypeString:
		index.equalityStr[key.strKey] = append(index.equalityStr[key.strKey], entry)
	}
}

func (index *DeleteIndex) sortCandidates() {
	for key, entries := range index.positions {
		sortCandidates(entries)
		index.positions[key] = entries
	}
	for key, entries := range index.equalityInt {
		sortCandidates(entries)
		index.equalityInt[key] = entries
	}
	for key, entries := range index.equalityStr {
		sortCandidates(entries)
		index.equalityStr[key] = entries
	}
	sortCandidates(index.equalityNull)
}

func sortCandidates(entries []candidate) {
	sort.Slice(entries, func(i, j int) bool {
		return candidateLess(entries[i], entries[j])
	})
}

func candidateLess(a, b candidate) bool {
	if a.evidence.SequenceNumber != b.evidence.SequenceNumber {
		return a.evidence.SequenceNumber < b.evidence.SequenceNumber
	}
	if a.evidence.DeleteFileID != b.evidence.DeleteFileID {
		return a.evidence.DeleteFileID < b.evidence.DeleteFileID
	}
	return a.order < b.order
}

func (index *DeleteIndex) normalizeKey(key any) (normalizedKey, error) {
	switch key.(type) {
	case nil:
		return normalizedKey{nilKey: true}, nil

	case int64:
		if index.keyType != KeyTypeInt64 {
			return normalizedKey{}, fmt.Errorf("%w: got int64, want %s", ErrKeyTypeMismatch, index.keyType)
		}
		return normalizedKey{intKey: key.(int64)}, nil

	case string:
		if index.keyType != KeyTypeString {
			return normalizedKey{}, fmt.Errorf("%w: got string, want %s", ErrKeyTypeMismatch, index.keyType)
		}
		return normalizedKey{strKey: key.(string)}, nil

	default:
		return normalizedKey{}, fmt.Errorf("%w: got %T, want %s", ErrKeyTypeMismatch, key, index.keyType)
	}
}

// Scan returns one visibility result per input row, preserving row order. All
// data row keys are validated before any result is computed, so an error
// produces no partial result. The rows slice is not modified.
func (index *DeleteIndex) Scan(rows []DataRow) ([]RowVisibility, error) {
	if index == nil {
		return nil, ErrNilDeleteIndex
	}

	keys := make([]normalizedKey, len(rows))
	for i := range rows {
		if rows[i].RowNumber < 0 {
			return nil, fmt.Errorf("data row[%d]: %w: row number %d", i, ErrInvalidRowNumber, rows[i].RowNumber)
		}
		key, err := index.normalizeKey(rows[i].Key)
		if err != nil {
			return nil, fmt.Errorf("data row[%d]: %w", i, err)
		}
		keys[i] = key
	}

	results := make([]RowVisibility, len(rows))
	for i := range rows {
		if best, ok := index.firstApplicable(rows[i], keys[i]); ok {
			evidence := best.evidence
			results[i] = RowVisibility{Deleted: true, Evidence: &evidence}
		}
	}
	return results, nil
}

// ScanBatch is an alias for Scan and is useful when file readers deliver
// interleaved batches of rows.
func (index *DeleteIndex) ScanBatch(rows []DataRow) ([]RowVisibility, error) {
	return index.Scan(rows)
}

// FirstDelete returns the first delete that applies to row, or nil when the
// row is visible. The returned evidence is a copy and may be modified by the
// caller.
func (index *DeleteIndex) FirstDelete(row DataRow) (*DeleteEvidence, error) {
	if index == nil {
		return nil, ErrNilDeleteIndex
	}
	if row.RowNumber < 0 {
		return nil, fmt.Errorf("%w: row number %d", ErrInvalidRowNumber, row.RowNumber)
	}
	key, err := index.normalizeKey(row.Key)
	if err != nil {
		return nil, err
	}
	best, ok := index.firstApplicable(row, key)
	if !ok {
		return nil, nil
	}
	evidence := best.evidence
	return &evidence, nil
}

func (index *DeleteIndex) firstApplicable(row DataRow, key normalizedKey) (candidate, bool) {
	var best candidate
	haveBest := false

	if entries := index.positions[positionKey{fileID: row.FileID, rowNumber: row.RowNumber}]; len(entries) > 0 {
		best = entries[0]
		haveBest = true
	}

	entries := index.equalityCandidates(key)
	for i := range entries {
		// Candidates are ordered by delete sequence number, so the first one
		// strictly above the data sequence number is the best equality delete.
		if entries[i].evidence.SequenceNumber > row.DataSequenceNumber {
			if !haveBest || candidateLess(entries[i], best) {
				best = entries[i]
				haveBest = true
			}
			break
		}
	}
	return best, haveBest
}

func (index *DeleteIndex) equalityCandidates(key normalizedKey) []candidate {
	if key.nilKey {
		return index.equalityNull
	}
	switch index.keyType {
	case KeyTypeInt64:
		return index.equalityInt[key.intKey]
	case KeyTypeString:
		return index.equalityStr[key.strKey]
	default:
		return nil
	}
}
