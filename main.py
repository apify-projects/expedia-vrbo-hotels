#!/usr/bin/env python3
"""Entry point for Apify CLI."""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "src"))
from main import main
import asyncio

if __name__ == "__main__":
    asyncio.run(main())
