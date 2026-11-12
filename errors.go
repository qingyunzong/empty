package dataeng

import "errors"

var (
	// ErrInvalidKeyType is returned when an index is built with an unknown key
	// type.
	ErrInvalidKeyType = errors.New("dataeng: invalid key type")

	// ErrKeyTypeMismatch is returned when a delete key or data row key does not
	// match the index's configured key type. A nil key is a valid NULL value
	// and is not a mismatch.
	ErrKeyTypeMismatch = errors.New("dataeng: key type mismatch")

	// ErrInvalidDeleteKind is returned when a delete record has an unknown kind.
	ErrInvalidDeleteKind = errors.New("dataeng: invalid delete kind")

	// ErrInvalidRowNumber is returned for a negative position-delete or data
	// row number.
	ErrInvalidRowNumber = errors.New("dataeng: invalid row number")

	// ErrNilDeleteIndex is returned when a method is called on a nil
	// *DeleteIndex.
	ErrNilDeleteIndex = errors.New("dataeng: nil delete index")
)
