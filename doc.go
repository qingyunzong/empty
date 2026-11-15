// Package dataeng parses HL7 v2 batch files.
//
// The parser reads a complete payload before it exposes a batch. A batch whose
// envelope is incomplete, or whose BTS/FTS counts do not agree with the
// payload, is not returned as a publishable *Batch. The returned error carries
// envelope evidence and the original raw segments so a caller can diagnose or
// replay the rejected input.
//
// Delimiters are taken from each MSH-1/MSH-2 pair. FHS and BHS use the same
// header layout for their own delimiters. Fields, repetitions, components and
// subcomponents retain both raw text and decoded text.
package dataeng
