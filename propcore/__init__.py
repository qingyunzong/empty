"""propcore: a tiny deterministic property-based testing core."""

from .generators import GEN_VERSION
from .runner import run_spec

__version__ = "1.0.0"
__all__ = ["GEN_VERSION", "run_spec", "__version__"]
