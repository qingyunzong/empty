"""Exception types for the WAL paged key-value store."""


class CrashError(Exception):
    """Simulated process crash injected at a persistence boundary."""


class CorruptLogError(Exception):
    """Mid-log CRC/magic corruption: reported, log file left untouched."""


class ConflictError(Exception):
    """Two active transactions tried to write the same key."""
