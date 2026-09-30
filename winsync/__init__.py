"""winsync: sliding-window pulls from read-only segment logs."""

from .core import WinsyncError, iter_records, pull, verify

__all__ = ["WinsyncError", "iter_records", "pull", "verify"]
__version__ = "0.1.0"
