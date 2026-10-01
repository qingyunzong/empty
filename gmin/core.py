"""Core minimization engine for gmin.

Reduces UTF-8 text while preserving a defect predicate checked by an
external oracle process (exit code 42 means the defect is triggered).

Transformation priority (highest first):
  1. delete contiguous blocks of lines
  2. delete a single line
  3. delete contiguous blocks of characters within a line
  4. replace a character with an entry from the replacement table

All transformations operate on ``str`` (decoded UTF-8), so the candidate
is always valid UTF-8 and multi-byte characters are never split.
"""

from __future__ import annotations

import os
import subprocess
import sys
from dataclasses import dataclass

STATUS_MINIMAL = "MINIMAL"
STATUS_BUDGET_EXCEEDED = "BUDGET_EXCEEDED"
STATUS_NOT_TRIGGERED = "NOT_TRIGGERED"

DEFAULT_REPLACEMENT_TABLE = (" ", "a", "0", "\n")

DEFAULT_TIMEOUT = 1.0


class OracleError(Exception):
    """Raised when the oracle program cannot be used."""


class _BudgetExhausted(Exception):
    pass


@dataclass
class ReductionResult:
    status: str
    text: str
    checks: int

    @property
    def bytes(self) -> int:
        return len(self.text.encode("utf-8"))


class SubprocessOracle:
    """Runs ``python oracle.py``, feeding the candidate on stdin.

    Returns True only when the process exits with code 42 within the
    timeout.  Timeouts and any other exit code count as not triggered.
    """

    def __init__(self, path, timeout=DEFAULT_TIMEOUT, python=None):
        if not os.path.isfile(path):
            raise OracleError("oracle not found: %s" % path)
        self.path = path
        self.timeout = timeout
        self.python = python or sys.executable

    def __call__(self, text: str) -> bool:
        data = text.encode("utf-8")
        try:
            proc = subprocess.run(
                [self.python, self.path],
                input=data,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=self.timeout,
            )
        except subprocess.TimeoutExpired:
            return False
        return proc.returncode == 42


def _split_lines(text: str):
    return text.splitlines(keepends=True)


def reduce_text(text, oracle, budget, replacement_table=DEFAULT_REPLACEMENT_TABLE):
    """Greedily reduce ``text`` while ``oracle`` keeps reporting the defect.

    ``oracle`` is a callable taking ``str`` and returning bool.  ``budget``
    bounds the total number of oracle invocations, including the final
    minimality verification.  Returns a :class:`ReductionResult`.
    """
    checks = 0
    candidate = text

    def triggers(s: str) -> bool:
        nonlocal checks
        if checks >= budget:
            raise _BudgetExhausted
        checks += 1
        return bool(oracle(s))

    def try_line_block_deletion() -> bool:
        nonlocal candidate
        lines = _split_lines(candidate)
        n = len(lines)
        for size in range(n, 1, -1):
            for start in range(0, n - size + 1):
                trial = "".join(lines[:start] + lines[start + size:])
                if triggers(trial):
                    candidate = trial
                    return True
        return False

    def try_single_line_deletion() -> bool:
        nonlocal candidate
        lines = _split_lines(candidate)
        for i in range(len(lines)):
            trial = "".join(lines[:i] + lines[i + 1:])
            if triggers(trial):
                candidate = trial
                return True
        return False

    def try_char_block_deletion() -> bool:
        nonlocal candidate
        lines = _split_lines(candidate)
        for li, line in enumerate(lines):
            m = len(line)
            for size in range(m, 0, -1):
                for start in range(0, m - size + 1):
                    trial_line = line[:start] + line[start + size:]
                    trial = "".join(lines[:li] + [trial_line] + lines[li + 1:])
                    if triggers(trial):
                        candidate = trial
                        return True
        return False

    def try_char_replacement() -> bool:
        nonlocal candidate
        lines = _split_lines(candidate)
        for li, line in enumerate(lines):
            for ci, ch in enumerate(line):
                for rep in replacement_table:
                    if rep == ch:
                        continue
                    trial_line = line[:ci] + rep + line[ci + 1:]
                    trial = "".join(lines[:li] + [trial_line] + lines[li + 1:])
                    if triggers(trial):
                        candidate = trial
                        return True
        return False

    def verify_minimality() -> bool:
        """Check every single-line and single-character deletion.

        Returns True (applying the reduction) if one still triggers the
        defect, meaning the candidate is not yet 1-minimal.
        """
        nonlocal candidate
        lines = _split_lines(candidate)
        for i in range(len(lines)):
            trial = "".join(lines[:i] + lines[i + 1:])
            if triggers(trial):
                candidate = trial
                return True
        for li, line in enumerate(lines):
            for ci in range(len(line)):
                trial_line = line[:ci] + line[ci + 1:]
                trial = "".join(lines[:li] + [trial_line] + lines[li + 1:])
                if triggers(trial):
                    candidate = trial
                    return True
        return False

    try:
        if not triggers(candidate):
            return ReductionResult(STATUS_NOT_TRIGGERED, candidate, checks)
        while True:
            if try_line_block_deletion():
                continue
            if try_single_line_deletion():
                continue
            if try_char_block_deletion():
                continue
            if try_char_replacement():
                continue
            if verify_minimality():
                continue
            break
    except _BudgetExhausted:
        return ReductionResult(STATUS_BUDGET_EXCEEDED, candidate, checks)
    return ReductionResult(STATUS_MINIMAL, candidate, checks)
