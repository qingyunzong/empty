package warc

import "errors"

// Sentinel errors returned by Graph.Add and Graph.Resolve. Use
// errors.Is to match them; the returned error always names the
// record IDs involved.
var (
	// ErrMissingRecordID: a record without a WARC-Record-ID was added.
	ErrMissingRecordID = errors.New("warc: record missing record id")

	// ErrDuplicateRecordID: two records share one WARC-Record-ID.
	ErrDuplicateRecordID = errors.New("warc: duplicate record id")

	// ErrMissingReference: a WARC-Refers-To (or WARC-Concurrent-To)
	// target is not present in the collection.
	ErrMissingReference = errors.New("warc: reference target not in collection")

	// ErrReferenceCycle: WARC-Refers-To links form a cycle.
	ErrReferenceCycle = errors.New("warc: refers-to cycle detected")

	// ErrMissingRefersTo: a revisit record has no WARC-Refers-To.
	ErrMissingRefersTo = errors.New("warc: revisit record missing refers-to")

	// ErrRevisitTargetNotOriginal: a revisit refers to a record that
	// is itself a revisit instead of a verified original.
	ErrRevisitTargetNotOriginal = errors.New("warc: revisit refers-to target is not an original record")

	// ErrUnverifiedOriginal: the revisit target carries no payload
	// digest or no payload to verify it against.
	ErrUnverifiedOriginal = errors.New("warc: revisit target payload digest cannot be verified")

	// ErrPayloadDigestMismatch: a payload digest does not match the
	// payload, or a revisit digest differs from its original's.
	ErrPayloadDigestMismatch = errors.New("warc: payload digest mismatch")

	// ErrInvalidDigest: a digest value cannot be parsed.
	ErrInvalidDigest = errors.New("warc: invalid payload digest")

	// ErrUnsupportedDigestScheme: the digest algorithm is unknown.
	ErrUnsupportedDigestScheme = errors.New("warc: unsupported digest scheme")

	// ErrMissingSegmentOrigin: a continuation's WARC-Segment-Origin-ID
	// does not name a segment-1 record in the collection.
	ErrMissingSegmentOrigin = errors.New("warc: segment origin not in collection")

	// ErrSegmentGap: segment numbers are not contiguous from 1.
	ErrSegmentGap = errors.New("warc: gap in segment sequence")

	// ErrSegmentTotalLength: WARC-Segment-Total-Length is missing on
	// the last segment or does not match the reassembled length.
	ErrSegmentTotalLength = errors.New("warc: segment total length mismatch")
)
