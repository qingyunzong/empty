// Package dataeng reads single-primary-HDU FITS integer images.
//
// The reader accepts only the deliberately narrow subset described by
// Open: an 8/16/32/64-bit integer image, a single primary HDU, fixed-size
// ASCII header cards, and exact decimal scaling. It does not support tables,
// extensions, strings, or floating-point samples.
package dataeng
