// Package dataeng extracts visible text from a stream of tokenized HTML
// events for page scraping. It never parses raw bytes itself: callers feed
// events, text inside script/style/textarea stays invisible with its source
// ranges preserved, comments are dropped, block-level ends contribute a
// single merged newline, and events cut off mid-tag report StatusPending.
package dataeng
