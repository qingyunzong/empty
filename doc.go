// Package dataeng decodes octet-counted syslog streams incrementally.
//
// A stream consists of frames of the form "N payload", where N is a
// non-zero-padded decimal length of 1 to 9 digits, followed by one space.
// NewDecoder enforces the host's maximum payload size before allocating space
// for a frame. Feed accepts chunks of any size and returns whole messages;
// Finish requires the input to end exactly on a frame boundary.
package dataeng
