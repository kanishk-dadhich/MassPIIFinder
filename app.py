#!/usr/bin/env python3
"""Convenience shim so `python app.py` still works from the repo root.

The application now lives in the installable `mass_pii_finder` package. After
`pip install .` you can also just run the `mass-pii-finder` command.
"""

from mass_pii_finder.app import main

if __name__ == "__main__":
    main()
