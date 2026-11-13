// Package warc builds relationship graphs between WARC records.
//
// Records of type response, request, revisit, conversion and continuation
// are linked through their record IDs and WARC-Refers-To headers. A
// revisit record's payload digest may only reference a verified original
// record in the same collection; reference cycles and references to
// records missing from the collection are reported as explicit errors.
// Segmented records are reassembled seamlessly using the segment number
// and segment total length headers.
package warc

import "time"

// RecordType is the value of the WARC-Type header.
type RecordType string

const (
	TypeResponse     RecordType = "response"
	TypeRequest      RecordType = "request"
	TypeRevisit      RecordType = "revisit"
	TypeConversion   RecordType = "conversion"
	TypeContinuation RecordType = "continuation"
	TypeResource     RecordType = "resource"
	TypeMetadata     RecordType = "metadata"
	TypeWARCInfo     RecordType = "warcinfo"
)

// Record is a single WARC record. Content holds the record block; for a
// record carrying a payload digest, Content is the payload the digest is
// verified against. For segmented records, Content of the segment-1
// origin and of each continuation is concatenated during reassembly.
type Record struct {
	Type         RecordType
	ID           string // WARC-Record-ID
	RefersTo     string // WARC-Refers-To
	ConcurrentTo []string
	TargetURI    string
	Date         time.Time

	// PayloadDigest is the WARC-Payload-Digest value, e.g. "sha1:AB...".
	PayloadDigest string

	// Segmentation (WARC-Segment-Number, WARC-Segment-Origin-ID,
	// WARC-Segment-Total-Length). SegmentNumber is 0 for unsegmented
	// records, 1 for the origin segment and >= 2 for continuations.
	// SegmentTotalLength is 0 when the header is absent.
	SegmentNumber      int
	SegmentOriginID    string
	SegmentTotalLength int64

	Content []byte
}

// segmented reports whether the record takes part in segmentation.
func (r *Record) segmented() bool {
	return r.SegmentNumber > 0 || r.Type == TypeContinuation
}
