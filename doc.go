// Package dataeng decodes ORC string columns from stripe streams.
//
// A Decoder accepts direct and dictionary encoded chunks, optional PRESENT
// bitmaps, RLEv1/RLEv2 length and dictionary-index streams, and deterministic
// random access. Each independently encoded row group rebuilds its dictionary
// and stream state while row numbers continue across the stripe.
package dataeng
