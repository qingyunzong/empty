"""CLI: python -m taskq run script.json --db queue.json --out done.json
       python -m taskq recover --db queue.json
"""
import sys

from .core import main

if __name__ == "__main__":
    sys.exit(main())
