// Package dataeng reads implicit value representation (implicit VR) DICOM
// data sets. It builds an element/sequence tree and does not render images.
//
// Undefined-length sequences are delimited by item and sequence delimiter
// tags. The delimiters are structural markers and never appear in the
// returned data. A defined-length item is consumed by its declared byte
// count, so delimiter-looking bytes inside its values are ordinary payload.
// Nested sequence delimiters close only the innermost sequence, private data
// must follow the matching private creator in the same layer, and the
// complete input is bounded by a host-configurable byte limit.
package dataeng
