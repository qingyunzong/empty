"""cfgdom: CFG construction and dominator analysis for linear bytecode."""

from .core import CFG, Block, CFGError, analyze, build_cfg

__version__ = "0.1.0"
__all__ = ["CFG", "Block", "CFGError", "analyze", "build_cfg", "__version__"]
