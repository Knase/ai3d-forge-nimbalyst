"""Scan the AI3D Forge models folder and print one JSON document.
Run by the Nimbalyst panel:  python3 - <workspace> [models_root]  (source on stdin)."""
import json
import os
import re
import sys

ws = os.path.abspath(sys.argv[1])
override = sys.argv[2] if len(sys.argv) > 2 else ""
SUBS = ("inbox", "images", "renders", "refs", "mesh", "print", "prompts", "publish")
SKIP = {"node_modules", ".git", "dist", "__pycache__", ".venv", "venv"}


def models_root():
    if override:
        return override if os.path.isabs(override) else os.path.join(ws, override)
    cfg = os.path.join(ws, "_bmad", "ai3d", "config.yaml")
    values = {}
    if os.path.isfile(cfg):
        for line in open(cfg, encoding="utf-8", errors="replace"):
            m = re.match(r'\s*(models_folder|output_folder):\s*"?([^"\n#]+)"?', line)
            if m:
                values[m.group(1)] = m.group(2).strip().replace("{project-root}", ws)
    if "models_folder" in values:
        p = values["models_folder"]
    elif "output_folder" in values:
        p = os.path.join(values["output_folder"], "ai3d")
    else:
        # no setting: the content folder if it exists, else the pre-1.6 location
        p = os.path.join(ws, "models") if os.path.isdir(os.path.join(ws, "models")) else os.path.join(ws, "_bmad-output", "ai3d")
    return p if os.path.isabs(p) else os.path.join(ws, p)


def find_tool(rel):
    """Locate a module script wherever the module was installed in the workspace."""
    for base in (".claude/skills", "ai3d/skills", "skills", "_bmad/ai3d/skills", ".agents/skills"):
        p = os.path.join(ws, base, rel)
        if os.path.isfile(p):
            return p
    for cur, dirs, _ in os.walk(ws):
        depth = cur[len(ws):].count(os.sep)
        dirs[:] = [d for d in dirs if d not in SKIP and depth < 4]
        p = os.path.join(cur, rel)
        if os.path.isfile(p):
            return p
    return None


def view_info(d, files):
    v = os.path.join(d, "view", "index.html")
    if not os.path.isfile(v):
        return None
    vt = int(os.stat(v).st_mtime)
    newest = max([f["mtime"] for s in ("mesh", "print", "images", "renders", "prompts") for f in files[s]] + [0])
    return {"mtime": vt, "stale": newest > vt}


_flow_mod = None
_flow_tool = ""


def flow_graph(d):
    """Nodes of the model's flow graph. Uses flow_log.py when the module is installed (it also rebuilds nodes
    for older models from their files); otherwise only what flow.json holds."""
    global _flow_mod, _flow_tool
    if _flow_tool == "":
        _flow_tool = find_tool("ai3d-forge/scripts/flow_log.py")
    tool = _flow_tool
    if tool and _flow_mod is None:
        try:
            import importlib.util
            spec = importlib.util.spec_from_file_location("a3d_flow_log", tool)
            _flow_mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(_flow_mod)
        except Exception:
            _flow_mod = False
    if _flow_mod:
        try:
            g = _flow_mod.graph(d)
            return {"nodes": g["nodes"], "real": g["real"], "branches": g.get("branches"), "primary": g.get("primary"),
                    "migrated": g.get("migrated")}
        except Exception:
            pass
    doc = load_json(os.path.join(d, "flow.json")) or {}
    nodes = [n for n in doc.get("nodes", []) if isinstance(n, dict) and n.get("id") and n.get("step")]
    return {"nodes": nodes, "real": len(nodes)}


_trend_mod = None


def content_root(key, default_name, cfg):
    v = cfg.get(key, "").replace("{project-root}", ws)
    p = v or os.path.join(ws, default_name)
    return p if os.path.isabs(p) else os.path.join(ws, p)


def trends_and_ideas(trends_dir, insights_dir):
    """trend.json and insight.json documents plus the seasonal calendar, through trend_lib.py when installed."""
    global _trend_mod
    if _trend_mod is None:
        tool = find_tool("ai3d-scout/scripts/trend_lib.py")
        _trend_mod = False
        if tool:
            try:
                import importlib.util
                spec = importlib.util.spec_from_file_location("a3d_trend_lib", tool)
                mod = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(mod)
                _trend_mod = mod
            except Exception:
                _trend_mod = False
    if _trend_mod:
        try:
            return _trend_mod.list_all(trends_dir, insights_dir)
        except Exception:
            pass
    return {"trends": [], "insights": [], "calendar": []}


def listing(folder):
    out = []
    if os.path.isdir(folder):
        for name in sorted(os.listdir(folder)):
            p = os.path.join(folder, name)
            if os.path.isfile(p) and not name.startswith("."):
                st = os.stat(p)
                out.append({"name": name, "size": st.st_size, "mtime": int(st.st_mtime)})
    return out


def text(path, limit=6000):
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            return fh.read(limit)
    except OSError:
        return None


def load_json(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def read_config():
    """Every `key: value` line of _bmad/ai3d/config.yaml (raw strings, quotes stripped)."""
    cfg = os.path.join(ws, "_bmad", "ai3d", "config.yaml")
    out = {}
    if os.path.isfile(cfg):
        for line in open(cfg, encoding="utf-8", errors="replace"):
            m = re.match(r'^([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*(?:#.*)?$', line)
            if m and m.group(2) != "":
                out[m.group(1)] = m.group(2).strip().strip("\"'")
    return out


def views_prompt(d, prompts):
    """The latest prompts/views-vN.md (multi-view prompts for 3D), or None."""
    vs = sorted((int(m.group(1)), f["name"]) for f in prompts for m in [re.match(r"views-v(\d+)\.md$", f["name"])] if m)
    if not vs:
        return None
    return {"name": vs[-1][1], "text": text(os.path.join(d, "prompts", vs[-1][1]))}


def work(d):
    """What one work folder holds: a branch folder, or the model folder of a model without branches/."""
    files = {s: listing(os.path.join(d, s)) for s in SUBS}
    versions = []
    for f in files["prompts"]:
        m = re.match(r"image-v(\d+)\.md$", f["name"])
        if m:
            versions.append((int(m.group(1)), f["name"]))
    latest = max(versions)[1] if versions else None
    has3d = any(f["name"] == "3d-prompt.md" for f in files["prompts"])
    stamp = max([f["mtime"] for s in SUBS for f in files[s]] +
                [int(os.stat(os.path.join(d, n)).st_mtime) for n in ("metadata.json", "concept.md", "README.md")
                 if os.path.isfile(os.path.join(d, n))] + [0])
    return {
        "dir": d,
        "meta": load_json(os.path.join(d, "metadata.json")) or {},
        "concept": text(os.path.join(d, "concept.md"), 4000),
        "files": files,
        "attempts": listing(os.path.join(d, "mesh", "attempts")),
        "candidates": listing(os.path.join(d, "mesh", "candidates")),
        "imagePrompt": {"name": latest, "text": text(os.path.join(d, "prompts", latest))} if latest else None,
        "prompt3d": text(os.path.join(d, "prompts", "3d-prompt.md")) if has3d else None,
        "analysis": load_json(os.path.join(d, "print", "analysis.json")),
        "printLog": load_json(os.path.join(d, "print", "print-log.json")) or [],
        "printPhotos": listing(os.path.join(d, "print", "photos")),
        "hasReadme": os.path.isfile(os.path.join(d, "README.md")),
        "view": view_info(d, files),
        "source": text(os.path.join(d, "refs", "source.md"), 2000),
        "views": listing(os.path.join(d, "images", "views")),
        "viewsPrompt": views_prompt(d, files["prompts"]),
        "viewsInbox": listing(os.path.join(d, "inbox", "views")),
        "stamp": stamp,
    }


def model(root, slug):
    d = os.path.join(root, slug)
    flow = flow_graph(d)
    brs = flow.get("branches") or [{"id": "main", "name": "main", "dir": d, "exists": True, "primary": True, "status": "open"}]
    primary = flow.get("primary") or "main"
    views = []
    for b in brs:
        bd = b.get("dir") or d
        w = work(bd) if os.path.isdir(bd) else work(d)
        views.append({**{k: v for k, v in b.items() if k != "dir"}, "work": w})
    head = next((v["work"] for v in views if v["id"] == primary), views[0]["work"])
    root_meta = load_json(os.path.join(d, "metadata.json")) or {}
    out = dict(head)
    # the model card: the model folder's metadata, with the primary branch's progress on top
    out["meta"] = {**head["meta"], **{k: v for k, v in root_meta.items() if k in ("title", "slug", "origin", "summary", "tags", "created_at")}}
    out.update({
        "slug": slug,
        "rootDir": d,
        "branch": primary,
        "primary": primary,
        "migrated": bool(flow.get("migrated")),
        "branches": views,
        "flow": {"nodes": flow["nodes"], "real": flow["real"]},
        "stamp": max([v["work"]["stamp"] for v in views] + [int(os.stat(os.path.join(d, "flow.json")).st_mtime) if os.path.isfile(os.path.join(d, "flow.json")) else 0]),
    })
    return out


def vkey(v):
    return tuple(int(x) for x in re.findall(r"\d+", v or "")[:3]) or (0,)


def module_info():
    """Installed AI3D Forge version (from BMAD's manifest), where it was installed from, and a newer copy of the
    module lying next to that source, if there is one (so the panel can print the exact update command)."""
    info = {"version": None, "source": None, "newer": None}
    man = os.path.join(ws, "_bmad", "_config", "manifest.yaml")
    if os.path.isfile(man):
        block = None
        for line in open(man, encoding="utf-8", errors="replace"):
            m = re.match(r"\s*-\s*name:\s*(\S+)", line)
            if m:
                block = m.group(1)
                continue
            if block == "ai3d":
                m = re.match(r"\s*(version|localPath):\s*\"?([^\"\n]+)\"?", line)
                if m:
                    info["source" if m.group(1) == "localPath" else "version"] = m.group(2).strip()
    src = info["source"]
    folders = [os.path.dirname(src)] if src else []
    folders += [os.path.join(ws, "_modules"), ws]
    best = None
    for folder in folders:
        if not os.path.isdir(folder):
            continue
        for name in sorted(os.listdir(folder)):
            my = os.path.join(folder, name, "skills", "ai3d-setup", "assets", "module.yaml")
            if not os.path.isfile(my) or not os.path.isfile(os.path.join(folder, name, ".claude-plugin", "marketplace.json")):
                continue
            m = re.search(r"^version:\s*(\S+)", open(my, encoding="utf-8", errors="replace").read(), re.M)
            if m and (best is None or vkey(m.group(1)) > vkey(best["version"])):
                best = {"version": m.group(1), "path": os.path.join(folder, name)}
    if best and vkey(best["version"]) > vkey(info["version"]):
        info["newer"] = best
    return info


def has_text(path, needle):
    try:
        return needle in open(path, encoding="utf-8", errors="replace").read()
    except (OSError, TypeError):
        return False


root = models_root()
cfg_values = read_config()
trends_dir = content_root("trends_folder", "trends", cfg_values)
insights_dir = content_root("insights_folder", "insights", cfg_values)
ti = trends_and_ideas(trends_dir, insights_dir)
result = {
    "workspace": ws,
    "root": root,
    "rootExists": os.path.isdir(root),
    "installed": os.path.isfile(os.path.join(ws, "_bmad", "ai3d", "config.yaml")),
    "tools": {
        "stepTips": find_tool("ai3d-help/references/step-tips.md"),
        "helpStatus": find_tool("ai3d-help/scripts/status.py"),
        "buildReadme": find_tool("ai3d-herald/scripts/build-readme.py"),
        "kilnLib": find_tool("ai3d-kiln/scripts/kiln_lib.py"),
        "buildViewer": find_tool("ai3d-prism/scripts/build-viewer.py"),
        "buildInsights": find_tool("ai3d-prism/scripts/build-insights.py"),
        "flowLog": find_tool("ai3d-forge/scripts/flow_log.py"),
        "kilnRun": find_tool("ai3d-kiln/scripts/kiln_run.py"),
        "blenderGuide": find_tool("ai3d-kiln/references/blender-setup.md"),
        "trendLib": find_tool("ai3d-scout/scripts/trend_lib.py"),
        "printLog": find_tool("ai3d-anvil/scripts/print_log.py"),
    },
    "config": cfg_values,
    "python": "%d.%d.%d" % sys.version_info[:3],
    "module": module_info(),
    "trendsRoot": trends_dir,
    "ideasRoot": insights_dir,
    "trends": ti["trends"],
    "ideas": ti["insights"],
    "calendar": ti["calendar"],
    "configPath": os.path.join(ws, "_bmad", "ai3d", "config.yaml"),
    "dashboards": [f for f in listing(os.path.join(root, "_insights")) if f["name"].endswith((".html", ".scores.json"))],
    "shortlists": listing(os.path.join(root, "_shortlists")),
    "models": [],
}
if result["rootExists"]:
    for name in sorted(os.listdir(root)):
        if name.startswith(("_", ".")) or not os.path.isdir(os.path.join(root, name)):
            continue
        if any(os.path.exists(os.path.join(root, name, f)) for f in ("metadata.json", "concept.md", "branches")):
            result["models"].append(model(root, name))
t = result["tools"]
result["features"] = {
    "branches": has_text(t.get("flowLog"), "def branch_add"),
    "webRefs": has_text(t.get("trendLib"), "def add_ref"),
    "help": bool(t.get("helpStatus")),
    "views": bool(find_tool("ai3d-lumen/references/multiview.md")),
}
print(json.dumps(result))
