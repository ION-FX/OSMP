"""`python -m osmp` — run the server without touching run.py's path.

Convenient for venv installs where `osmp` isn't on PATH but the package is:

    /opt/osmp/server/venv/bin/python -m osmp --host 0.0.0.0 --port 8543
"""
import runpy
import sys

if __name__ == "__main__":
    runpy.run_module("run", run_name="__main__", alter_sys=True)
