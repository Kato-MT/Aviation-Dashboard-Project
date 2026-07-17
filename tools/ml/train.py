#!/usr/bin/env python3
"""Compatibility entry point for the root `pnpm ml:train` command."""

from train_model import main


if __name__ == "__main__":
    raise SystemExit(main())

