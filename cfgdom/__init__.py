"""cfgdom: build a CFG from linear bytecode and compute dominators."""

from .core import (
    Block,
    CFGError,
    Instruction,
    analyze_program,
    build_cfg,
    compute_dominators,
    parse_program,
)

__all__ = [
    "Block",
    "CFGError",
    "Instruction",
    "analyze_program",
    "build_cfg",
    "compute_dominators",
    "parse_program",
]

__version__ = "0.1.0"
