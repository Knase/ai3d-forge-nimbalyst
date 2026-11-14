"""Blender readiness for the AI3D Forge panel. Run as:  python3 - <workspace> <blender_bin or auto>  (source on stdin).
Prints one JSON document: the executable and its version, whether Blender is running, and where a Blender MCP
server is registered (Claude Code reads .mcp.json and ~/.claude.json; the Claude desktop app has its own file)."""
import glob
import json
import os
import shutil
import subprocess
import sys

ws = os.path.abspath(sys.argv[1])
conf = (sys.argv[2] if len(sys.argv) > 2 else "").strip()
home = os.path.expanduser("~")


def candidates():
    if conf and conf != "auto":
        yield os.path.expanduser(conf)
        return
    yield "/Applications/Blender.app/Contents/MacOS/Blender"
    yield os.path.join(home, "Applications/Blender.app/Contents/MacOS/Blender")
    for p in sorted(glob.glob("/Applications/Blender*.app/Contents/MacOS/Blender"), reverse=True):
        yield p
    w = shutil.which("blender")
    if w:
        yield w
    yield "C:/Program Files/Blender Foundation/Blender/blender.exe"


def find_bin():
    for p in candidates():
        if p and os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return None


def version(b):
    try:
        out = subprocess.run([b, "--version"], capture_output=True, text=True, timeout=40)
        for line in out.stdout.splitlines():
            if line.strip().lower().startswith("blender"):
                return line.strip()
    except (OSError, subprocess.SubprocessError):
        pass
    return None


def running():
    for name in ("Blender", "blender"):
        try:
            if subprocess.run(["pgrep", "-x", name], capture_output=True, timeout=5).returncode == 0:
                return True
        except (OSError, subprocess.SubprocessError):
            return None
    return False


def servers(doc):
    return [k for k in (doc or {}).get("mcpServers", {}) if "blender" in k.lower()] if isinstance(doc, dict) else []


def load(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


mcp, all_servers = [], []


def note_all(doc, where, sessions):
    if isinstance(doc, dict):
        for k in (doc.get("mcpServers") or {}):
            all_servers.append({"where": where, "name": k, "forSessions": sessions})

proj_doc = load(os.path.join(ws, ".mcp.json"))
note_all(proj_doc, "project .mcp.json", True)
for name in servers(proj_doc):
    mcp.append({"where": "project .mcp.json", "name": name, "forSessions": True})
user = load(os.path.join(home, ".claude.json"))
note_all(user, "Claude Code user config", True)
for name in servers(user):
    mcp.append({"where": "Claude Code user config", "name": name, "forSessions": True})
if isinstance(user, dict):
    for path, proj in (user.get("projects") or {}).items():
        if os.path.abspath(path) == ws:
            note_all(proj, "Claude Code local config", True)
            for name in servers(proj):
                mcp.append({"where": "Claude Code local config", "name": name, "forSessions": True})
desk = os.path.join(home, "Library/Application Support/Claude/claude_desktop_config.json")
desk_doc = load(desk)
note_all(desk_doc, "Claude desktop app", False)
for name in servers(desk_doc):
    mcp.append({"where": "Claude desktop app", "name": name, "forSessions": False})

b = find_bin()
print(json.dumps({
    "bin": b,
    "configured": conf or "auto",
    "version": version(b) if b else None,
    "running": running(),
    "mcp": mcp,
    "servers": all_servers,
    "checkedAt": int(__import__("time").time()),
}))
