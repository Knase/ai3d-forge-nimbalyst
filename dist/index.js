import { jsxs as a, jsx as e, Fragment as te } from "react/jsx-runtime";
import { useState as A, useMemo as je, useRef as qe, useEffect as ke, useCallback as H, useSyncExternalStore as Aa } from "react";
const Ra = `"""Scan the AI3D Forge models folder and print one JSON document.
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
            m = re.match(r'\\s*(models_folder|output_folder):\\s*"?([^"\\n#]+)"?', line)
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
    """Every \`key: value\` line of _bmad/ai3d/config.yaml (raw strings, quotes stripped)."""
    cfg = os.path.join(ws, "_bmad", "ai3d", "config.yaml")
    out = {}
    if os.path.isfile(cfg):
        for line in open(cfg, encoding="utf-8", errors="replace"):
            m = re.match(r'^([A-Za-z_][\\w-]*)\\s*:\\s*(.*?)\\s*(?:#.*)?$', line)
            if m and m.group(2) != "":
                out[m.group(1)] = m.group(2).strip().strip("\\"'")
    return out


def views_prompt(d, prompts):
    """The latest prompts/views-vN.md (multi-view prompts for 3D), or None."""
    vs = sorted((int(m.group(1)), f["name"]) for f in prompts for m in [re.match(r"views-v(\\d+)\\.md$", f["name"])] if m)
    if not vs:
        return None
    return {"name": vs[-1][1], "text": text(os.path.join(d, "prompts", vs[-1][1]))}


def work(d):
    """What one work folder holds: a branch folder, or the model folder of a model without branches/."""
    files = {s: listing(os.path.join(d, s)) for s in SUBS}
    versions = []
    for f in files["prompts"]:
        m = re.match(r"image-v(\\d+)\\.md$", f["name"])
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
    return tuple(int(x) for x in re.findall(r"\\d+", v or "")[:3]) or (0,)


def module_info():
    """Installed AI3D Forge version (from BMAD's manifest), where it was installed from, and a newer copy of the
    module lying next to that source, if there is one (so the panel can print the exact update command)."""
    info = {"version": None, "source": None, "newer": None}
    man = os.path.join(ws, "_bmad", "_config", "manifest.yaml")
    if os.path.isfile(man):
        block = None
        for line in open(man, encoding="utf-8", errors="replace"):
            m = re.match(r"\\s*-\\s*name:\\s*(\\S+)", line)
            if m:
                block = m.group(1)
                continue
            if block == "ai3d":
                m = re.match(r"\\s*(version|localPath):\\s*\\"?([^\\"\\n]+)\\"?", line)
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
            m = re.search(r"^version:\\s*(\\S+)", open(my, encoding="utf-8", errors="replace").read(), re.M)
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
`, Pa = /\.(png|jpe?g|webp|gif)$/i, Ba = (t) => Pa.test(t.name), ue = (t) => t.filter(Ba), Ta = (t, i) => t.some((l) => i.test(l.name)), Z = (t, i, l, s) => ({
  kind: "agent",
  label: t,
  skill: i,
  trigger: l,
  extra: s
});
function xn(t) {
  return t >= 1e6 ? `${(t / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(t / 1e3))} KB`;
}
function Si(t) {
  return xn(t);
}
function ri(t, i) {
  const l = t.meta.stages ?? {}, s = t.files, o = ue(s.inbox), g = ue(s.images), w = ue(s.renders), m = s.mesh.find((q) => /^raw\./i.test(q.name)), C = (t.candidates ?? []).filter((q) => /\.(stl|glb|gltf|obj|fbx)$/i.test(q.name)), k = s.mesh.find((q) => q.name === "print.stl") ?? s.mesh.find((q) => q.name === "clean.stl"), S = t.meta.model_type === "flexi", f = t.analysis?.after ?? t.analysis?.analysis ?? null, x = t.meta.status ?? "concept", L = !!l.concept?.done || /\*\*Subject:\*\*\s*\S/.test(t.concept ?? ""), M = !!l.image?.done || g.length > 0, B = !!l.mesh?.done || !!m && !!k, I = !!k, F = Ta(s.print, /^slicing-notes\.md$/), p = t.hasReadme && (x === "ready" || x === "published"), O = t.printLog.filter((q) => !q.skipped), T = O[O.length - 1] ?? null, _ = !T && t.printLog.some((q) => q.skipped), v = !!l.print_test?.done || t.printLog.length > 0, E = [L, M, B, I, F, v, p];
  !m && (ue(t.viewsInbox ?? []).length || t.viewsPrompt && !ue(t.views ?? []).length) && (E[1] = !1);
  const b = t.branch && t.branch !== "main" ? t.branches?.find((q) => q.id === t.branch) : null, j = b ? Math.max(0, ["concept", "image", "mesh", "blender", "validate", "print", "publish"].indexOf(b.from_step)) : 0;
  for (let q = 0; q < j; q++) E[q] = !0;
  const h = E.indexOf(!1), d = [];
  d.push({
    id: "concept",
    title: "Concept",
    agent: "Muse",
    result: L ? `${t.meta.model_type ?? "type not set"} · ${t.meta.scale_mm ? t.meta.scale_mm + " mm" : "scale not set"}` : "No concept yet",
    hint: L ? "Concept is written. Re-run to change type or scale." : "Muse writes the concept and picks static / flexi / functional.",
    thumb: null,
    primary: L ? null : Z("Write concept", "ai3d-muse", "*concept"),
    more: [Z("Re-check model type", "ai3d-muse", "*type")]
  });
  let c, V;
  const Y = ue(t.views ?? []), Q = ue(t.viewsInbox ?? []), ae = !!t.viewsPrompt && !Y.length && !Q.length && !m;
  M && ae ? (c = {
    kind: "human",
    label: "Generate the views in Gemini, save them into inbox/views/",
    copy: t.viewsPrompt?.text ?? "",
    copyLabel: `Copy ${t.viewsPrompt?.name}`,
    folder: "inbox/views"
  }, V = `Your turn: run each view prompt of ${t.viewsPrompt?.name} in Gemini with the accepted image attached; save front.png, left.png, back.png, right.png into inbox/views/.`) : M && Q.length > 0 ? (c = Z(`Review ${Q.length} view${Q.length === 1 ? "" : "s"}`, "ai3d-lumen", "*review-views"), V = "Lumen checks the views against the accepted image (same proportions, colours, pose) and files them as front / left / back / right.") : M ? (c = null, V = `${g.length} image${g.length === 1 ? "" : "s"} accepted.${Y.length ? ` ${Y.length} views for multi-view 3D.` : " Optional: prepare front / left / back / right views for multi-view 3D (Other actions → Prepare views)."}`) : o.length > 0 ? (c = Z(`Review ${o.length} image${o.length === 1 ? "" : "s"} in inbox`, "ai3d-lumen", "*review"), V = "Lumen reads the inbox images and either accepts one or writes the next prompt.") : t.imagePrompt ? (c = {
    kind: "human",
    label: "Generate in Gemini, save into inbox/",
    copy: t.imagePrompt.text ?? "",
    copyLabel: `Copy ${t.imagePrompt.name}`,
    folder: "inbox"
  }, V = `Your turn: paste ${t.imagePrompt.name} into Gemini and save the image into inbox/.`) : (c = Z("Write image prompt", "ai3d-lumen", "*prompt"), V = "Lumen writes the first Gemini prompt."), d.push({
    id: "image",
    title: "Image",
    agent: "Lumen",
    result: M ? `${g.length} accepted${Y.length ? ` · ${Y.length} views` : ""}` : o.length ? `${o.length} in inbox` : t.imagePrompt ? `${t.imagePrompt.name} ready` : "No prompt yet",
    hint: V,
    thumb: g[0] ? `images/${g[0].name}` : o[0] ? `inbox/${o[0].name}` : null,
    primary: c,
    more: [
      Z("Write next prompt", "ai3d-lumen", "*prompt"),
      Z("Review inbox", "ai3d-lumen", "*review"),
      Z("Accept image", "ai3d-lumen", "*accept"),
      Z("Prepare views for 3D (front, left, back, right)", "ai3d-lumen", "*views"),
      Z("Review the views", "ai3d-lumen", "*review-views")
    ]
  });
  let X, me;
  B ? (X = null, me = "Mesh accepted.") : m ? (X = Z("Review the mesh", "ai3d-chisel", "*review-mesh"), me = "Chisel checks the mesh against the concept and accepts it or changes the settings.") : C.length ? (X = Z("Compare the variants", "ai3d-chisel", "*review-mesh"), me = `${C.length} variants are waiting in mesh/candidates/. Use one as the raw mesh (Files → 3D files → “Use as raw mesh”), or let Chisel compare them and recommend one.`) : t.prompt3d ? (X = {
    kind: "human",
    label: "Run the 3D service, then Add 3D model…",
    copy: t.prompt3d,
    copyLabel: "Copy 3D spec",
    folder: "mesh"
  }, me = "Your turn: upload the accepted image to the 3D service and add the export with “Add 3D model…” (GLB or STL; if the service gives several variants, add them all and choose one).") : (X = Z("Write 3D spec", "ai3d-chisel", "*3d-prompt"), me = "Chisel writes the service settings for the accepted image."), d.push({
    id: "mesh",
    title: "3D mesh",
    agent: "Chisel",
    result: m ? `${m.name} · ${xn(m.size)}` : C.length ? `${C.length} variants to choose from` : t.prompt3d ? "3D spec ready" : "No mesh yet",
    hint: me,
    thumb: null,
    primary: X,
    more: [
      Z("Write 3D spec", "ai3d-chisel", "*3d-prompt"),
      Z("Review mesh", "ai3d-chisel", "*review-mesh"),
      Z("Accept mesh", "ai3d-chisel", "*accept-mesh")
    ]
  });
  const Oe = [
    Z("Inspect only", "ai3d-kiln", "*inspect"),
    Z("Optimize again", "ai3d-kiln", "*optimize"),
    Z("Build flexi joints", "ai3d-kiln", "*flexi"),
    Z("Render previews", "ai3d-kiln", "*render"),
    { kind: "script", label: "Build interactive 3D view", script: "view" },
    Z("Export clearance coupon", "ai3d-kiln", "*coupon"),
    Z("Blender command (free text)", "ai3d-kiln", "*run")
  ];
  d.push({
    id: "blender",
    title: "Blender",
    agent: "Kiln",
    result: k ? [f?.overhang_pct != null ? `overhang ${f.overhang_pct} %` : null, t.analysis?.side_on_bed ? `${t.analysis.side_on_bed} on bed` : null, xn(k.size)].filter(Boolean).join(" · ") : "Not optimised yet",
    hint: k ? S ? "Print file exists. Build or rebuild flexi joints if needed." : "Print file exists." : "Kiln works in Blender: solid mesh, bed side, flat cut, overhang check. It asks you for two verdicts.",
    thumb: w[0] ? `renders/${w[0].name}` : null,
    primary: k ? null : Z("Optimize in Blender", "ai3d-kiln", "*optimize"),
    more: Oe
  }), d.push({
    id: "validate",
    title: "Validate",
    agent: "Anvil",
    result: F ? "Slicing notes written" : "Not validated yet",
    hint: F ? "Checklist and slicing notes are in print/." : "Anvil runs the print-ready checklist and writes the slicing notes.",
    thumb: null,
    primary: F ? null : Z("Validate and write slicing notes", "ai3d-anvil", "*validate", "When the checklist passes, continue with *slice."),
    more: [Z("Validate", "ai3d-anvil", "*validate"), Z("Slicing notes", "ai3d-anvil", "*slice")]
  });
  const Ne = ue(t.printPhotos);
  d.push({
    id: "print",
    title: "Test print",
    agent: "Anvil",
    result: T ? `${T.result}${T.printer ? ` · ${T.printer}` : ""}${O.length > 1 ? ` · ${O.length} prints` : ""}` : _ ? "Skipped" : "Not printed yet",
    hint: T ? T.change ? `Change next time: ${T.change}` : "Logged. Print again after changes, or move on." : _ ? "Skipped for this model." : "Print mesh/print.stl, then log the result with a photo. Or skip it for a shape you have already proven.",
    thumb: Ne.length ? `print/photos/${Ne[Ne.length - 1].name}` : null,
    primary: v ? null : { kind: "human", label: "Print mesh/print.stl, then log the result", folder: "print" },
    more: [
      { kind: "form", label: "Log a test print…", form: "print-log" },
      { kind: "form", label: "Skip the test print", form: "print-skip" },
      Z("Log with Anvil (reads the photos)", "ai3d-anvil", "*print-log")
    ]
  });
  let R;
  t.hasReadme ? x !== "ready" && x !== "published" ? R = Z("Mark ready", "ai3d-herald", "*ready") : R = null : R = t.meta.summary && i.tools.buildReadme ? { kind: "script", label: "Build README", script: "readme" } : Z("Write README", "ai3d-herald", "*readme");
  const G = [
    Z("Write README text", "ai3d-herald", "*readme"),
    Z("Mark ready", "ai3d-herald", "*ready"),
    Z("Write listing", "ai3d-herald", "*listing"),
    Z("Mark published", "ai3d-herald", "*publish")
  ];
  return i.tools.buildReadme && G.unshift({ kind: "script", label: "Rebuild README (no agent)", script: "readme" }), d.push({
    id: "publish",
    title: "Publish",
    agent: "Herald",
    result: t.hasReadme ? `README · ${x}` : "No README yet",
    hint: p ? "Model is ready." : t.hasReadme ? "README exists. Mark the model ready when you are happy with it." : "Herald builds the README with images, description and the STL link.",
    thumb: null,
    primary: R,
    more: G
  }), d.map((q, fe) => {
    let ce;
    return E[fe] ? ce = "done" : h === fe ? ce = q.primary?.kind === "human" ? "waiting" : "active" : ce = "locked", { ...q, n: fe + 1, state: ce };
  });
}
const De = ["concept", "image", "mesh", "blender", "validate", "print", "publish"], Ve = (t, i, l) => ({ kind: "agent", label: t, skill: i, trigger: l }), Ma = /* @__PURE__ */ new Set([
  "ai3d-muse *concept",
  "ai3d-lumen *prompt",
  "ai3d-lumen *views",
  "ai3d-chisel *3d-prompt",
  "ai3d-kiln *optimize",
  "ai3d-kiln *flexi",
  "ai3d-anvil *validate",
  "ai3d-herald *readme"
]), _n = (t) => t.kind === "agent" && Ma.has(`${t.skill} ${t.trigger}`), gt = {
  concept: [Ve("Write concept", "ai3d-muse", "*concept")],
  image: [Ve("Write image prompt", "ai3d-lumen", "*prompt"), Ve("Prepare views for 3D", "ai3d-lumen", "*views")],
  mesh: [Ve("Write 3D spec", "ai3d-chisel", "*3d-prompt")],
  blender: [Ve("Optimize in Blender", "ai3d-kiln", "*optimize"), Ve("Build flexi joints", "ai3d-kiln", "*flexi")],
  validate: [Ve("Validate and write slicing notes", "ai3d-anvil", "*validate")],
  publish: [Ve("Write README", "ai3d-herald", "*readme")]
};
function Tn(t, i, l, s, o, g) {
  const w = l.root.startsWith(l.workspace) ? l.root.slice(l.workspace.length + 1) || "." : l.root, m = [`Use the \`${t.skill}\` skill from the AI3D Forge BMAD module and run its \`${t.trigger}\` action.`], C = (k) => k.startsWith(l.workspace) ? k.slice(l.workspace.length + 1) || "." : k;
  if (i) {
    if (m.push(`Model: \`${i.slug}\` — model folder \`${C(i.rootDir ?? `${l.root}/${i.slug}`)}/\`. Work only on this model.`), i.migrated || i.branches?.length > 1) {
      const k = i.branches.find((S) => S.id === i.branch);
      m.push(`Branch: \`${i.branch}\`${k && k.name !== i.branch ? ` (${k.name})` : ""}. Work folder: \`${C(i.dir)}/\` — read and write every step file (concept.md, metadata.json, prompts/, inbox/, images/, mesh/, print/, renders/, publish/, README.md) in this folder, not in the model folder. flow.json stays in the model folder; flow_log.py accepts the work folder and records the branch.`), k?.source && m.push(`This branch started from a ${k.source.kind}: ${k.source.kind === "text" ? "see refs/source.md" : k.source.ref}${k.source.kind === "link" ? " (also in refs/source.md)" : ""}.`), k?.description && m.push(`Why this branch: ${k.description}`);
    }
  } else m.push(`Models folder: \`${w}/\`.`);
  if (s && m.push(`Input from the user: ${s}`), o && i) {
    const k = o.node;
    m.push(`Flow node: \`${k.id}\` (step ${k.step}), created by the panel with status running. Do not add a new node: update this one when you finish` + (o.flowLog ? ` with \`python3 ${o.flowLog} update ${i.dir} ${k.id} ...\`` : "") + " (rules: ai3d-forge/references/flow-graph.md)."), k.parent && m.push(`This attempt grows from node \`${k.parent}\`.`);
    const S = Object.entries(k.settings);
    S.length && m.push(`Settings for this attempt, use exactly these and do not fall back to defaults: ${S.map(([f, x]) => `${f}=${x}`).join(", ")}.`), k.description && m.push(`What is different this time: ${k.description}`);
  }
  return t.extra && m.push(t.extra), m.push("Follow the skill's HALT rules: stop and ask me whenever a verdict or an off-tool step is needed."), g === "medium" && m.push("Think about the options before you act."), g === "high" && m.push("Think hard: weigh the options and check the numbers before you act."), g === "max" && m.push("Ultrathink: this step needs your deepest reasoning before you act."), m.join(`
`);
}
const Ze = (t) => De.indexOf(t), ji = (t, i) => t.created_at < i.created_at ? -1 : t.created_at > i.created_at ? 1 : 0;
function lt(t, i) {
  return t.filter((l) => l.step === i).sort(ji);
}
function La(t) {
  const i = t.filter((l) => l.verdict !== "rejected" && l.status !== "error");
  return i.length ? i.sort((l, s) => Ze(s.step) - Ze(l.step) || +(s.verdict === "accepted") - +(l.verdict === "accepted") || ji(s, l))[0] : null;
}
function Ea(t, i) {
  const l = new Map(t.map((g) => [g.id, g])), s = /* @__PURE__ */ new Set();
  let o = i ? l.get(i) : void 0;
  for (; o && !s.has(o.id); )
    s.add(o.id), o = o.parent ? l.get(o.parent) : void 0;
  return s;
}
function Fa(t, i) {
  if (i === "image") {
    const l = lt(t, "image").filter((s) => s.verdict !== "accepted");
    if (l.length) return l[l.length - 1].id;
  }
  for (let l = Ze(i) - 1; l >= 0; l--) {
    const s = lt(t, De[l]).filter((g) => g.verdict !== "rejected" && g.status !== "error");
    if (!s.length) continue;
    const o = s.filter((g) => g.verdict === "accepted");
    return (o.length ? o : s).slice(-1)[0].id;
  }
  return null;
}
function Oa(t) {
  return t.step === "image" ? t.id : t.parent;
}
function Ia(t) {
  const i = De.map(() => 0), l = [];
  for (let s = 0; s < De.length; s++)
    lt(t, De[s]).forEach((o, g) => {
      l.push({ node: o, row: s, slot: g }), i[s] = g + 1;
    });
  return { placed: l, slots: i };
}
function Wa(t, i = 2) {
  const l = Object.entries(t.settings);
  return l.length ? l.slice(0, i).map(([s, o]) => `${s}=${o}`).join(" ") + (l.length > i ? ` +${l.length - i}` : "") : "";
}
const Pe = (t) => t.branch ?? "main";
function za(t, i) {
  const l = t.branches.find((s) => s.id === i);
  return !l || l.id === t.branch ? t : { ...t, ...l.work, meta: { ...l.work.meta, title: t.meta.title ?? l.work.meta.title }, branch: l.id };
}
function Ht(t) {
  return t.branches.find((i) => i.id === t.branch) ?? null;
}
function st(t, i = t.flow.nodes) {
  return i.filter((l) => Pe(l) === t.branch);
}
function It(t, i, l) {
  return Fa(st(t, i), l) ?? Ht(t)?.from_node ?? null;
}
function Ka(t) {
  const i = [t.primary ? "primary" : null, t.status !== "open" ? t.status : null].filter(Boolean);
  return `${t.name}${i.length ? ` (${i.join(", ")})` : ""}`;
}
const Cn = (t, i) => Math.max(0, t.branches.findIndex((l) => l.id === i));
function Sn(t, i) {
  return t.branches.find((l) => l.id === Pe(i))?.work.dir ?? t.dir;
}
const Di = [
  { value: "", label: "Default (Nimbalyst setting)" },
  { value: "claude-code:opus", label: "Opus — deepest, slowest, most expensive" },
  { value: "claude-code:sonnet", label: "Sonnet — balanced" },
  { value: "claude-code:haiku", label: "Haiku — fastest, cheapest" }
], tn = [
  { value: "low", label: "Low — no extra thinking", keyword: "" },
  { value: "medium", label: "Medium — think", keyword: "think" },
  { value: "high", label: "High — think hard", keyword: "think hard" },
  { value: "max", label: "Max — ultrathink", keyword: "ultrathink" }
], Ai = [
  { id: "concept", label: "1 Concept (Muse)" },
  { id: "image", label: "2 Image (Lumen)" },
  { id: "mesh", label: "3 3D mesh (Chisel)" },
  { id: "blender", label: "4 Blender (Kiln)" },
  { id: "validate", label: "5 Validate (Anvil)" },
  { id: "print", label: "6 Test print (Anvil)" },
  { id: "publish", label: "7 Publish (Herald)" },
  { id: "scout", label: "Trends (Scout)" },
  { id: "ideas", label: "Insights (Muse, Prism)" },
  { id: "help", label: "Help (Compass)" }
], Ri = "concept=opus,image=sonnet,mesh=sonnet,blender=sonnet,validate=sonnet,print=haiku,publish=haiku,scout=opus,ideas=opus,help=haiku", Pi = "concept=high,image=medium,mesh=medium,blender=high,validate=medium,print=low,publish=low,scout=high,ideas=high,help=low";
function qt(t, i) {
  const l = {};
  for (const s of `${i},${t ?? ""}`.split(/[,\s]+/)) {
    const [o, g] = s.split("=");
    o && g !== void 0 && (l[o.trim()] = g.trim());
  }
  return l;
}
const oi = (t) => Ai.map((i) => `${i.id}=${t[i.id] ?? ""}`).join(","), Ga = {
  "ai3d-scout": "scout",
  "ai3d-prism": "ideas",
  "ai3d-help": "help",
  "ai3d-muse": "concept",
  "ai3d-lumen": "image",
  "ai3d-iterate": "image",
  "ai3d-chisel": "mesh",
  "ai3d-kiln": "blender",
  "ai3d-anvil": "validate",
  "ai3d-herald": "publish",
  "ai3d-forge": "concept"
};
function bt(t, i, l, s) {
  let o = i ?? Ga[l] ?? "concept";
  !i && l === "ai3d-muse" && (s === "*prepare" || s === "*idea") && (o = "ideas");
  const g = qt(t.step_models, Ri), w = qt(t.step_effort, Pi), m = g[o] ?? "", C = !m || m === "default" ? "" : m.includes(":") ? m : `claude-code:${m}`, k = w[o];
  return { model: C, effort: tn.some((S) => S.value === k) ? k : "medium" };
}
const mn = (t) => t ? t.replace(/^claude-code:/, "").replace(/^./, (i) => i.toUpperCase()) : "default model", di = (t) => tn.find((i) => i.value === t)?.keyword ?? "";
function Mn({ value: t, onChange: i }) {
  return /* @__PURE__ */ a("span", { className: "a3d-row a3d-runpick", children: [
    /* @__PURE__ */ a("label", { children: [
      "Model",
      /* @__PURE__ */ e("select", { value: t.model, onChange: (l) => i({ ...t, model: l.target.value }), children: Di.map((l) => /* @__PURE__ */ e("option", { value: l.value, children: l.label }, l.value)) })
    ] }),
    /* @__PURE__ */ a("label", { children: [
      "Reasoning",
      /* @__PURE__ */ e("select", { value: t.effort, onChange: (l) => i({ ...t, effort: l.target.value }), children: tn.map((l) => /* @__PURE__ */ e("option", { value: l.value, children: l.label }, l.value)) })
    ] })
  ] });
}
const ge = (...t) => t.map((i) => typeof i == "string" ? { value: i, label: i } : { value: i[0], label: i[1] }), Ua = {
  concept: [
    { key: "model_type", label: "Model type", help: "Static figure, print-in-place flexi, or a functional part.", kind: "choice", choices: ge("static", "flexi", "functional") },
    { key: "scale_mm", label: "Size", help: "Longest side of the printed model.", kind: "number", unit: "mm", min: 10, max: 400, step: 5, placeholder: "120" },
    { key: "style", label: "Style", help: "How it should look.", kind: "text", placeholder: "chibi, low-poly, realistic…" },
    { key: "print_target", label: "Printer type", help: "Drives wall thickness and the smallest detail.", kind: "choice", choices: ge("FDM", "resin") }
  ],
  image: [
    { key: "mode", label: "How", help: "A new picture from scratch, or an edit of the previous one (keeps the pose, changes a detail).", kind: "choice", choices: ge(["new", "New picture"], ["edit", "Edit the previous picture"]) },
    { key: "view", label: "Camera", help: "Three-quarter front suits single-image 3D best.", kind: "choice", choices: ge(["three-quarter", "Three-quarter front"], ["front", "Front"], ["side", "Side"]) },
    { key: "style", label: "Style", help: "Overrides the style of the concept for this picture.", kind: "text", placeholder: "chibi, clay toy, low-poly…" },
    { key: "aspect", label: "Aspect ratio", help: "", kind: "choice", choices: ge("1:1", "4:3", "3:4") },
    { key: "backend", label: "Image model", help: "Which Gemini model the prompt is written for.", kind: "choice", choices: ge(["nano-banana-pro", "Nano Banana Pro (quality)"], ["nano-banana-2", "Nano Banana 2 (speed)"]) }
  ],
  mesh: [
    { key: "service", label: "3D service", help: "The spec is written for this service.", kind: "choice", choices: ge(["tripo3d", "Tripo3D"], ["meshy", "Meshy"], ["rodin", "Rodin / Hyper3D"], ["hitem3d", "Hitem3D"]) },
    { key: "mode", label: "Input", help: "Multi-view needs accepted views (Image step → Prepare views).", kind: "choice", choices: ge(["single", "One image"], ["multiview", "Multi-view (front, left, back, right)"]) },
    { key: "texture", label: "Texture", help: "Off is enough for printing and costs fewer credits.", kind: "choice", choices: ge("off", "on") },
    { key: "topology", label: "Topology", help: "Quad is cleaner to edit in Blender.", kind: "choice", choices: ge("quad", "triangle") },
    { key: "face_limit", label: "Face limit", help: "50 000–200 000 is plenty for a print.", kind: "number", min: 5e3, max: 2e6, step: 5e3, placeholder: "100000" },
    { key: "segmentation", label: "Split into parts", help: "On for flexi models and models you will print in parts.", kind: "choice", choices: ge("on", "off") },
    { key: "symmetry", label: "Symmetry", help: "On for symmetric animals and characters.", kind: "choice", choices: ge("on", "off", "auto") }
  ],
  blender: [
    { key: "side_on_bed", label: "Side on the bed", help: "Which side lies on the print bed. Analyze lists the best ones.", kind: "choice", choices: ge("bottom", "back", "front", "left", "right", "top") },
    { key: "cut_mm", label: "Flat cut", help: "How much is cut off for a flat base (0.5–1.5 is usual).", kind: "number", unit: "mm", min: 0, max: 20, step: 0.1, placeholder: "1" },
    { key: "overhang_deg", label: "Overhang angle", help: "Faces steeper than this count as needing support.", kind: "number", unit: "°", min: 20, max: 75, step: 1, placeholder: "45" },
    { key: "scale_mm", label: "Size", help: "Longest side after scaling.", kind: "number", unit: "mm", min: 10, max: 400, step: 5, placeholder: "120" },
    { key: "flexi", label: "Flexi joints", help: "Build print-in-place joints.", kind: "choice", choices: ge("yes", "no") },
    { key: "segments", label: "Segments", help: "Number of body segments for flexi.", kind: "number", min: 2, max: 30, step: 1, placeholder: "9" },
    { key: "clearance_mm", label: "Joint clearance", help: "Gap in the joints; take it from your coupon print.", kind: "number", unit: "mm", min: 0.1, max: 1, step: 0.05, placeholder: "0.35" }
  ],
  validate: [
    { key: "slicer", label: "Slicer", help: "The slicing notes use its setting names.", kind: "choice", choices: ge("Bambu Studio", "OrcaSlicer", "PrusaSlicer", "Cura") },
    { key: "nozzle_mm", label: "Nozzle", help: "", kind: "choice", choices: ge("0.2", "0.4", "0.6", "0.8") },
    { key: "layer_mm", label: "Layer height", help: "", kind: "number", unit: "mm", min: 0.04, max: 0.6, step: 0.02, placeholder: "0.16" },
    { key: "material", label: "Material", help: "", kind: "choice", choices: ge("PLA", "PETG", "TPU", "ABS / ASA") }
  ],
  publish: [
    { key: "target", label: "Marketplace", help: "The listing is written for it.", kind: "choice", choices: ge(["makerworld", "MakerWorld"], ["printables", "Printables"], ["thingiverse", "Thingiverse"], ["cults3d", "Cults3D"]) },
    { key: "tone", label: "Tone of the text", help: "", kind: "text", placeholder: "playful, short, for parents…" }
  ]
}, Va = {
  concept: ["Make it flexi instead of static", "Bigger, so details survive", "Simplify: fewer small parts"],
  image: ["Legs apart, nothing touching", "Thicker limbs, no thin parts", "Plain background, no shadow", "Same pose, fix only the face"],
  mesh: ["Texture off, geometry only", "The last mesh fused parts: split them", "Fewer faces, cleaner surface"],
  blender: ["Try another side on the bed", "Thicker base", "Less overhang, even if a detail is lost", "Bigger joint clearance"],
  validate: ["Check thin walls again", "Profile for a 0.4 nozzle, 0.16 layers"],
  publish: ["Shorter description", "Add the print settings table"]
}, Ha = /* @__PURE__ */ new Set(["run_model", "run_effort"]);
function Ja({ model: t, scan: i, stepTitle: l, initial: s, busy: o, onCancel: g, onRun: w, onBranch: m, defaultRun: C }) {
  const k = Ua[s.step] ?? [], S = new Set(k.map((R) => R.key)), f = Object.entries(s.settings).filter(([R]) => !Ha.has(R)), [x, L] = A(Object.fromEntries(f.filter(([R]) => S.has(R)))), [M, B] = A(f.filter(([R]) => !S.has(R))), [I, F] = A(s.description), [p, O] = A(s.parent ?? ""), T = s.settings.run_model !== void 0 ? { model: s.settings.run_model === "default" ? "" : `claude-code:${s.settings.run_model}`, effort: s.settings.run_effort || C.effort } : null, [_, v] = A(s.run ?? T ?? C), E = gt[s.step] ?? [], [b, j] = A(0), h = Ze(s.step), d = t.flow.nodes.filter((R) => Ze(R.step) <= h && !R.archived), c = t.flow.nodes.find((R) => R.id === p) ?? null, V = Va[s.step] ?? [], Y = je(() => {
    const R = {};
    for (const G of k) (x[G.key] ?? "").trim() && (R[G.key] = x[G.key].trim());
    for (const [G, q] of M) G.trim() && q.trim() && (R[G.trim()] = q.trim());
    return R;
  }, [k, x, M]), Q = Object.entries(Y), ae = (R, G) => L((q) => ({ ...q, [R]: G })), X = (R, G, q) => B((fe) => fe.map((ce, Be) => Be === R ? G === 0 ? [q, ce[1]] : [ce[0], q] : ce)), me = je(() => {
    const R = E[b];
    if (!R) return "";
    const G = {
      id: "<new node id>",
      step: s.step,
      agent: "",
      label: "",
      parent: p || null,
      status: "running",
      verdict: null,
      created_at: "",
      finished_at: null,
      settings: Y,
      description: I.trim(),
      outcome: "",
      files: [],
      branch: t.branch
    };
    return Tn(R, t, i, void 0, { node: G, flowLog: i.tools.flowLog }, _.effort);
  }, [E, b, s.step, p, Y, I, t, i, _.effort]), Oe = () => w(E[b], { step: s.step, parent: p || null, settings: Y, description: I.trim(), run: _ }), Ne = !I.trim() && Q.length === 0;
  return /* @__PURE__ */ e("div", { className: "a3d-overlay", onClick: g, children: /* @__PURE__ */ a("form", { className: "a3d-dialog a3d-dialog-wide a3d-attempt", onClick: (R) => R.stopPropagation(), onSubmit: (R) => {
    R.preventDefault(), Oe();
  }, children: [
    /* @__PURE__ */ a("header", { children: [
      /* @__PURE__ */ a("h3", { children: [
        "Try the ",
        l(s.step),
        " step again"
      ] }),
      /* @__PURE__ */ a("p", { className: "a3d-muted", children: [
        "A new try next to the earlier ones",
        t.branches.length > 1 ? ` in branch ${t.branch}` : "",
        "; nothing is overwritten.",
        c ? /* @__PURE__ */ a(te, { children: [
          " Continues from ",
          /* @__PURE__ */ e("strong", { children: c.label }),
          "."
        ] }) : null
      ] })
    ] }),
    E.length > 1 && /* @__PURE__ */ a("label", { children: [
      "What to run",
      /* @__PURE__ */ e("select", { value: b, onChange: (R) => j(Number(R.target.value)), children: E.map((R, G) => /* @__PURE__ */ e("option", { value: G, children: R.label }, R.trigger)) })
    ] }),
    /* @__PURE__ */ a("section", { className: "a3d-attempt-sec", children: [
      /* @__PURE__ */ e("label", { htmlFor: "a3d-attempt-what", children: /* @__PURE__ */ e("strong", { children: "1 · What should be different this time?" }) }),
      /* @__PURE__ */ e(
        "textarea",
        {
          id: "a3d-attempt-what",
          rows: 3,
          autoFocus: !0,
          value: I,
          onChange: (R) => F(R.target.value),
          placeholder: "In your own words. The agent reads it first, and it stays on the attempt as its description."
        }
      ),
      V.length > 0 && /* @__PURE__ */ e("span", { className: "a3d-row", children: V.map((R) => /* @__PURE__ */ a("button", { type: "button", className: "a3d-chipbtn", onClick: () => F((G) => G.trim() ? `${G.trim().replace(/[.;]$/, "")}; ${R.charAt(0).toLowerCase()}${R.slice(1)}` : R), children: [
        "+ ",
        R
      ] }, R)) })
    ] }),
    k.length > 0 && /* @__PURE__ */ a("section", { className: "a3d-attempt-sec", children: [
      /* @__PURE__ */ e("strong", { children: "2 · Options to change" }),
      /* @__PURE__ */ e("p", { className: "a3d-muted a3d-small", children: "Leave an option on “agent decides” to keep what the agent would pick. A chosen option is passed as “use exactly this” and saved on the attempt." }),
      /* @__PURE__ */ e("div", { className: "a3d-optgrid", children: k.map((R) => /* @__PURE__ */ a("label", { className: x[R.key] ? "a3d-opt a3d-opt-set" : "a3d-opt", title: R.help, children: [
        /* @__PURE__ */ a("span", { children: [
          R.label,
          R.unit ? /* @__PURE__ */ a("span", { className: "a3d-muted", children: [
            " (",
            R.unit,
            ")"
          ] }) : null
        ] }),
        R.kind === "choice" ? /* @__PURE__ */ a("select", { value: x[R.key] ?? "", onChange: (G) => ae(R.key, G.target.value), children: [
          /* @__PURE__ */ e("option", { value: "", children: "agent decides" }),
          (R.choices.some((G) => G.value === x[R.key]) || !x[R.key] ? R.choices : [...R.choices, { value: x[R.key], label: x[R.key] }]).map((G) => /* @__PURE__ */ e("option", { value: G.value, children: G.label }, G.value))
        ] }) : /* @__PURE__ */ e(
          "input",
          {
            type: R.kind === "number" ? "number" : "text",
            min: R.min,
            max: R.max,
            step: R.step,
            value: x[R.key] ?? "",
            onChange: (G) => ae(R.key, G.target.value),
            placeholder: R.kind === "number" ? `agent decides (e.g. ${R.placeholder})` : R.placeholder
          }
        ),
        R.help && /* @__PURE__ */ e("span", { className: "a3d-muted a3d-small", children: R.help })
      ] }, R.key)) })
    ] }),
    (s.step === "image" || s.step === "mesh") && /* @__PURE__ */ a("p", { className: "a3d-muted a3d-small", children: [
      "Another picture, a link or a ready 3D file instead of other options?",
      " ",
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: m, children: "Start a branch with it" }),
      " — it gets its own files to the end."
    ] }),
    /* @__PURE__ */ a("details", { className: "a3d-attempt-more", children: [
      /* @__PURE__ */ e("summary", { children: "More: continues from, model and reasoning, own option, the prompt" }),
      /* @__PURE__ */ a("label", { children: [
        "Continues from",
        /* @__PURE__ */ a("select", { value: p, onChange: (R) => O(R.target.value), children: [
          /* @__PURE__ */ e("option", { value: "", children: "Nothing (start of this line)" }),
          d.map((R) => /* @__PURE__ */ a("option", { value: R.id, children: [
            t.branches.length > 1 ? `[${Pe(R)}] ` : "",
            l(R.step),
            " · ",
            R.label,
            R.verdict ? ` (${R.verdict})` : ""
          ] }, R.id))
        ] }),
        /* @__PURE__ */ e("span", { className: "a3d-muted a3d-small", children: "The earlier try this one builds on. It only draws the arrow in the graph and tells the agent what to start from." })
      ] }),
      /* @__PURE__ */ e(Mn, { value: _, onChange: v }),
      /* @__PURE__ */ a("fieldset", { className: "a3d-fields", children: [
        /* @__PURE__ */ e("legend", { children: "Own option" }),
        /* @__PURE__ */ a("p", { className: "a3d-muted a3d-small", children: [
          "For something the list does not have: a name and a value, passed to the agent as it is (for example ",
          /* @__PURE__ */ e("code", { children: "pose = sitting" }),
          ")."
        ] }),
        M.map(([R, G], q) => /* @__PURE__ */ a("div", { className: "a3d-kvrow", children: [
          /* @__PURE__ */ e("input", { "aria-label": "Option name", placeholder: "name", value: R, onChange: (fe) => X(q, 0, fe.target.value) }),
          /* @__PURE__ */ e("input", { "aria-label": "Option value", placeholder: "value", value: G, onChange: (fe) => X(q, 1, fe.target.value) }),
          /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", "aria-label": "Remove option", onClick: () => B((fe) => fe.filter((ce, Be) => Be !== q)), children: "×" })
        ] }, q)),
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => B((R) => [...R, ["", ""]]), children: "+ Add own option" })
      ] }),
      /* @__PURE__ */ a("details", { children: [
        /* @__PURE__ */ e("summary", { children: "Prompt sent to the agent session" }),
        /* @__PURE__ */ e("pre", { className: "a3d-cmd", children: me })
      ] })
    ] }),
    /* @__PURE__ */ a("footer", { className: "a3d-attempt-foot", children: [
      /* @__PURE__ */ e("span", { className: "a3d-muted a3d-small", children: Q.length ? /* @__PURE__ */ a(te, { children: [
        "Changed: ",
        Q.map(([R, G]) => /* @__PURE__ */ a("span", { className: "a3d-pill", children: [
          R,
          " = ",
          G
        ] }, R))
      ] }) : Ne ? "Nothing changed yet: the agent would repeat the step with its defaults." : "No options changed; the agent follows your text." }),
      /* @__PURE__ */ a("span", { className: "a3d-row a3d-row-end", children: [
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: g, children: "Cancel" }),
        /* @__PURE__ */ a("button", { type: "submit", className: "a3d-btn a3d-btn-primary", disabled: o || !E.length, children: [
          "Run: ",
          E[b]?.label
        ] })
      ] })
    ] })
  ] }) });
}
const ye = 172, He = 58, at = 22, Je = 80, fn = 132, ut = 10, Wt = 34, zt = (t, i) => t.length > i ? `${t.slice(0, i - 1)}…` : t, ci = { done: "done", active: "next", waiting: "your turn", locked: "locked" }, Jt = { running: "running", open: "waiting", done: "done", error: "failed" }, hi = { running: "", open: "", done: "✓", error: "!" };
function qa({ model: t, steps: i, selectedNode: l, selectedStep: s, compare: o, showArchived: g, onSelectNode: w, onSelectStep: m, onNew: C, onSelectBranch: k }) {
  const S = Bi(t.flow.nodes, g), f = t.branches.filter((b) => g || b.status !== "archived" || b.id === t.branch), x = new Set(f.map((b) => b.id)), L = S.filter((b) => x.has(Pe(b))), M = f.length > 1, B = La(L.filter((b) => Pe(b) === t.branch)), I = Ea(L, B?.id ?? null), F = ut + (M ? Wt : 0), p = /* @__PURE__ */ new Map(), O = [];
  let T = fn;
  for (const b of f) {
    const j = L.filter((Y) => Pe(Y) === b.id), { placed: h, slots: d } = Ia(j), c = Math.max(1, ...d) + (b.id === t.branch ? 1 : 0);
    for (const Y of h)
      p.set(Y.node.id, { x: T + Y.slot * (ye + at), y: F + Y.row * Je + (Je - He) / 2, row: Y.row, lane: b.id });
    const V = c * (ye + at) - at + (M ? 16 : 0);
    O.push({ id: b.id, x: T - (M ? 8 : 0), w: V, slots: d, color: Cn(t, b.id) }), T += V + (M ? at + 8 : at);
  }
  const _ = Math.max(T, fn + 2 * (ye + at)), v = F + De.length * Je, E = L.filter((b) => b.parent && p.has(b.parent) && p.has(b.id)).map((b) => {
    const j = p.get(b.parent), h = p.get(b.id);
    let d;
    if (j.row === h.row) {
      const c = j.y + He / 2;
      d = j.x < h.x ? `M${j.x + ye},${c} L${h.x},${c}` : `M${j.x},${c} L${h.x + ye},${c}`;
    } else {
      const c = j.x + ye / 2, V = j.y + He, Y = h.x + ye / 2, Q = h.y, ae = (V + Q) / 2;
      d = `M${c},${V} C${c},${ae} ${Y},${ae} ${Y},${Q}`;
    }
    return { id: `${b.parent}>${b.id}`, d, on: I.has(b.id) && I.has(b.parent), cross: j.lane !== h.lane };
  });
  return /* @__PURE__ */ a("section", { className: "a3d-graph", "aria-label": "Flow graph", children: [
    /* @__PURE__ */ e("div", { className: "a3d-graph-scroll", children: /* @__PURE__ */ a("svg", { width: _, height: v, viewBox: `0 0 ${_} ${v}`, role: "group", "aria-label": `Flow of ${t.meta.title || t.slug}`, children: [
      /* @__PURE__ */ e("defs", { children: /* @__PURE__ */ e("marker", { id: "a3d-arrow", viewBox: "0 0 8 8", refX: "7", refY: "4", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse", children: /* @__PURE__ */ e("path", { d: "M0,0 L8,4 L0,8 z", className: "a3d-g-arrow" }) }) }),
      De.map((b, j) => {
        const h = i.find((V) => V.id === b), d = F + j * Je, c = h?.state === "active" || h?.state === "waiting";
        return /* @__PURE__ */ a("g", { className: `a3d-g-row a3d-g-${h?.state ?? "locked"}${s === b ? " a3d-g-rowsel" : ""}`, children: [
          /* @__PURE__ */ e("rect", { x: 0, y: d, width: _, height: Je, className: j % 2 ? "a3d-g-band a3d-g-band2" : "a3d-g-band" }),
          /* @__PURE__ */ a(
            "g",
            {
              tabIndex: 0,
              role: "button",
              "aria-label": `Step ${j + 1} ${h?.title ?? b}, ${ci[h?.state ?? "locked"]}`,
              onClick: () => m(b),
              onKeyDown: (V) => {
                (V.key === "Enter" || V.key === " ") && (V.preventDefault(), m(b));
              },
              className: "a3d-g-label",
              children: [
                /* @__PURE__ */ e("rect", { x: 4, y: d + 6, width: fn - 12, height: Je - 12, rx: 6, className: "a3d-g-labelbg" }),
                /* @__PURE__ */ a("text", { x: 14, y: d + 28, className: "a3d-g-steptitle", children: [
                  c ? "▶ " : "",
                  j + 1,
                  " · ",
                  h?.title ?? b
                ] }),
                /* @__PURE__ */ a("text", { x: 14, y: d + 45, className: "a3d-g-stepsub", children: [
                  h?.agent,
                  " · ",
                  ci[h?.state ?? "locked"]
                ] })
              ]
            }
          )
        ] }, b);
      }),
      M && O.map((b) => {
        const j = t.branches.find((d) => d.id === b.id), h = b.id === t.branch;
        return /* @__PURE__ */ a("g", { className: `a3d-g-lane a3d-lane-c${b.color % 8}${h ? " a3d-g-lanesel" : ""}`, children: [
          /* @__PURE__ */ e("rect", { x: b.x, y: ut, width: b.w, height: v - ut, rx: 8, className: "a3d-g-lanebg" }),
          /* @__PURE__ */ a(
            "g",
            {
              tabIndex: 0,
              role: "button",
              "aria-pressed": h,
              "aria-label": `Branch ${j.name}${j.primary ? ", primary" : ""}${j.status !== "open" ? `, ${j.status}` : ""}`,
              onClick: () => k(b.id),
              onKeyDown: (d) => {
                (d.key === "Enter" || d.key === " ") && (d.preventDefault(), k(b.id));
              },
              children: [
                /* @__PURE__ */ e("title", { children: [`Branch ${j.name}`, j.source ? `from ${j.source.kind}: ${j.source.ref}` : null, j.from_step !== "concept" ? `starts at ${j.from_step}` : null, j.description].filter(Boolean).join(`
`) }),
                /* @__PURE__ */ e("rect", { x: b.x, y: ut, width: b.w, height: Wt - 6, rx: 8, className: "a3d-g-lanehead" }),
                /* @__PURE__ */ e("circle", { cx: b.x + 14, cy: ut + (Wt - 6) / 2, r: 5, className: "a3d-g-lanedot" }),
                /* @__PURE__ */ a("text", { x: b.x + 26, y: ut + (Wt - 6) / 2 + 4, className: "a3d-g-lanename", children: [
                  zt(j.name, Math.max(8, Math.floor(b.w / 8) - 12)),
                  j.primary ? " ★" : "",
                  j.status !== "open" ? ` · ${j.status}` : ""
                ] })
              ]
            }
          )
        ] }, `lane-${b.id}`);
      }),
      E.map((b) => /* @__PURE__ */ e("path", { d: b.d, className: ["a3d-g-edge", b.on ? "a3d-g-edge-on" : "", b.cross ? "a3d-g-edge-cross" : ""].filter(Boolean).join(" "), markerEnd: "url(#a3d-arrow)" }, b.id)),
      L.filter((b) => p.has(b.id)).map((b) => {
        const { x: j, y: h, lane: d } = p.get(b.id), c = l === b.id, V = I.has(b.id), Y = Wa(b), Q = b.outcome || b.description, ae = ["a3d-g-node", d !== t.branch ? "a3d-g-otherlane" : "", o.includes(b.id) ? "a3d-g-cmp" : "", b.archived ? "a3d-g-archived" : "", `a3d-gs-${b.status}`, b.verdict ? `a3d-gv-${b.verdict}` : "", b.inferred ? "a3d-g-inferred" : "", V ? "a3d-g-on" : "", c ? "a3d-g-sel" : ""].filter(Boolean).join(" ");
        return /* @__PURE__ */ a(
          "g",
          {
            className: ae,
            transform: `translate(${j},${h})`,
            tabIndex: 0,
            role: "button",
            "aria-label": `${b.label}, ${Jt[b.status]}${b.verdict ? ", " + b.verdict : ""}${M ? `, branch ${d}` : ""}${B?.id === b.id ? ", current" : ""}`,
            onClick: () => w(b.id),
            onKeyDown: (X) => {
              (X.key === "Enter" || X.key === " ") && (X.preventDefault(), w(b.id));
            },
            children: [
              /* @__PURE__ */ e("title", { children: [b.label, `${Jt[b.status]}${b.verdict ? ` · ${b.verdict}` : ""}${b.inferred ? " · rebuilt from files" : ""}`, M ? `branch: ${d}` : "", Y, b.description, b.outcome].filter(Boolean).join(`
`) }),
              /* @__PURE__ */ e("rect", { width: ye, height: He, rx: 8, className: "a3d-g-box" }),
              /* @__PURE__ */ e("circle", { cx: 14, cy: 16, r: 7, className: "a3d-g-dot" }),
              hi[b.status] && /* @__PURE__ */ e("text", { x: 14, y: 19.5, className: "a3d-g-dotglyph", textAnchor: "middle", children: hi[b.status] }),
              /* @__PURE__ */ e("text", { x: 28, y: 20, className: "a3d-g-label1", children: zt(b.label, b.verdict ? 17 : 19) }),
              b.verdict && /* @__PURE__ */ e("text", { x: ye - 10, y: 20, textAnchor: "end", className: "a3d-g-verdict", children: b.verdict === "accepted" ? "✓" : "✗" }),
              /* @__PURE__ */ e("text", { x: 10, y: 36, className: "a3d-g-line2", children: zt(Y || Jt[b.status], 26) }),
              /* @__PURE__ */ e("text", { x: 10, y: 50, className: "a3d-g-line3", children: zt(Q, 26) }),
              o.includes(b.id) && /* @__PURE__ */ e("text", { x: ye - 10, y: He - 6, textAnchor: "end", className: "a3d-g-cmpmark", children: o.indexOf(b.id) === 0 ? "A" : "B" }),
              (b.notes?.length ?? 0) > 0 && /* @__PURE__ */ e("text", { x: ye - 28, y: 20, textAnchor: "end", className: "a3d-g-notemark", children: "✎" }),
              B?.id === b.id && /* @__PURE__ */ e("text", { x: ye - 8, y: -4, textAnchor: "end", className: "a3d-g-here", children: "you are here" })
            ]
          },
          b.id
        );
      }),
      (() => {
        const b = O.find((h) => h.id === t.branch);
        if (!b) return null;
        const j = b.x + (M ? 8 : 0);
        return De.map((h, d) => {
          const c = i.find((ae) => ae.id === h);
          if (!c || c.state === "locked" && !b.slots[d]) return null;
          const V = t.branches.find((ae) => ae.id === t.branch);
          if (V && V.id !== "main" && d < Math.max(0, De.indexOf(V.from_step))) return null;
          const Y = j + b.slots[d] * (ye + at), Q = F + d * Je + (Je - He) / 2;
          return /* @__PURE__ */ a(
            "g",
            {
              className: "a3d-g-new",
              transform: `translate(${Y},${Q})`,
              tabIndex: 0,
              role: "button",
              "aria-label": `New attempt on ${c.title}`,
              onClick: () => C(h),
              onKeyDown: (ae) => {
                (ae.key === "Enter" || ae.key === " ") && (ae.preventDefault(), C(h));
              },
              children: [
                /* @__PURE__ */ a("title", { children: [
                  "New attempt on ",
                  c.title,
                  " in this branch, with its own settings and description"
                ] }),
                /* @__PURE__ */ e("rect", { width: ye - 40, height: He, rx: 8, className: "a3d-g-newbox" }),
                /* @__PURE__ */ e("text", { x: (ye - 40) / 2, y: He / 2 + 5, textAnchor: "middle", className: "a3d-g-newtext", children: "+ New attempt" })
              ]
            },
            `new-${h}`
          );
        });
      })()
    ] }) }),
    /* @__PURE__ */ a("p", { className: "a3d-graph-legend a3d-muted", children: [
      "Rows are the steps, each box is one attempt.",
      M ? " Each column is a branch with its own files; click its header to work in it (★ primary)." : "",
      " Blue line: the path of the selected branch. ✓ accepted, ✗ rejected, dashed box: an attempt you left. Grey box: rebuilt from files. Ring: waiting for you. Pulsing: running. ✎ has notes. A / B: picked for comparison."
    ] })
  ] });
}
function Bi(t, i) {
  if (i) return t;
  const l = new Set(t.filter((o) => o.archived).map((o) => o.id));
  let s = !0;
  for (; s; ) {
    s = !1;
    for (const o of t) !l.has(o.id) && o.parent && l.has(o.parent) && (l.add(o.id), s = !0);
  }
  return t.filter((o) => !l.has(o.id));
}
const gn = (t) => {
  const i = new Date(t);
  return Number.isNaN(i.getTime()) ? t : i.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};
function Ya({ model: t, node: i, busy: l, canEdit: s, inCompare: o, onSelectNode: g, onRerun: w, onNext: m, onBranch: C, onVerdict: k, onOpen: S, onFiles: f, onCompare: x, onArchive: L, onNote: M, onCost: B }) {
  const [I, F] = A(""), [p, O] = A(i.cost?.service ?? ""), [T, _] = A(i.cost ? String(i.cost.credits) : ""), v = i.parent ? t.flow.nodes.find((h) => h.id === i.parent) : null, E = t.flow.nodes.filter((h) => h.parent === i.id), b = De[Ze(i.step) + 1], j = Object.entries(i.settings);
  return /* @__PURE__ */ a("section", { className: "a3d-node-detail", children: [
    /* @__PURE__ */ a("header", { children: [
      /* @__PURE__ */ a("div", { children: [
        /* @__PURE__ */ a("h3", { children: [
          i.label,
          " ",
          /* @__PURE__ */ e("span", { className: `a3d-pill a3d-pill-${i.status}`, children: Jt[i.status] }),
          i.verdict && /* @__PURE__ */ e("span", { className: `a3d-pill a3d-pill-${i.verdict}`, children: i.verdict }),
          i.inferred && /* @__PURE__ */ e("span", { className: "a3d-pill", children: "rebuilt from files" })
        ] }),
        /* @__PURE__ */ a("p", { className: "a3d-muted", children: [
          i.step,
          " · ",
          i.agent,
          t.branches.length > 1 ? ` · branch ${i.branch ?? "main"}` : "",
          " · ",
          gn(i.created_at),
          i.finished_at ? ` → ${gn(i.finished_at)}` : ""
        ] })
      ] }),
      /* @__PURE__ */ a("span", { className: "a3d-row", children: [
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", "aria-pressed": o, onClick: () => x(i), title: "Pick two attempts of the same step and compare them", children: o ? "In comparison" : "Compare" }),
        i.files.length > 0 && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => f(i), title: "Open the Files tab with only this attempt's files", children: "Show files" }),
        /* @__PURE__ */ e(
          "button",
          {
            type: "button",
            className: "a3d-btn",
            disabled: l,
            onClick: () => w(i),
            title: "Same step again, with the settings of this attempt as a starting point",
            children: "Run again with changes…"
          }
        ),
        b && /* @__PURE__ */ e(
          "button",
          {
            type: "button",
            className: "a3d-btn",
            disabled: l,
            onClick: () => m(i),
            title: "Run the next step on this attempt, in the same branch",
            children: "Continue from here…"
          }
        ),
        s && /* @__PURE__ */ e(
          "button",
          {
            type: "button",
            className: "a3d-btn",
            disabled: l,
            onClick: () => C(i),
            title: "A separate line with its own files from here to the end: another image, link, mesh, or other settings",
            children: "New branch from here…"
          }
        )
      ] })
    ] }),
    /* @__PURE__ */ a("dl", { className: "a3d-node-grid", children: [
      /* @__PURE__ */ e("dt", { children: "Settings" }),
      /* @__PURE__ */ e("dd", { children: j.length ? /* @__PURE__ */ e("ul", { className: "a3d-kv", children: j.map(([h, d]) => /* @__PURE__ */ a("li", { children: [
        /* @__PURE__ */ e("code", { children: h }),
        " ",
        d
      ] }, h)) }) : /* @__PURE__ */ e("span", { className: "a3d-muted", children: "none recorded" }) }),
      /* @__PURE__ */ e("dt", { children: "Description" }),
      /* @__PURE__ */ e("dd", { children: i.description || /* @__PURE__ */ e("span", { className: "a3d-muted", children: "none" }) }),
      /* @__PURE__ */ e("dt", { children: "Outcome" }),
      /* @__PURE__ */ e("dd", { children: i.outcome || /* @__PURE__ */ e("span", { className: "a3d-muted", children: "not recorded yet" }) }),
      i.files.length > 0 && /* @__PURE__ */ a(te, { children: [
        /* @__PURE__ */ e("dt", { children: "Files" }),
        /* @__PURE__ */ e("dd", { children: /* @__PURE__ */ e("ul", { className: "a3d-kv", children: i.files.map((h) => /* @__PURE__ */ e("li", { children: /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: () => S(h), children: h }) }, h)) }) })
      ] }),
      /* @__PURE__ */ e("dt", { children: "Cost" }),
      /* @__PURE__ */ e("dd", { children: s && !i.inferred ? /* @__PURE__ */ a("span", { className: "a3d-row", children: [
        /* @__PURE__ */ e("input", { className: "a3d-in-small", "aria-label": "Service", list: "a3d-services", placeholder: "service", value: p, onChange: (h) => O(h.target.value) }),
        /* @__PURE__ */ e("input", { className: "a3d-in-small", "aria-label": "Credits", type: "number", min: "0", step: "any", placeholder: "credits", value: T, onChange: (h) => _(h.target.value) }),
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", disabled: !p.trim() || T === "" || i.cost?.service === p && String(i.cost?.credits) === T, onClick: () => B(i, p.trim(), T), children: "Save" }),
        /* @__PURE__ */ a("datalist", { id: "a3d-services", children: [
          /* @__PURE__ */ e("option", { value: "tripo3d" }),
          /* @__PURE__ */ e("option", { value: "gemini" }),
          /* @__PURE__ */ e("option", { value: "meshy" }),
          /* @__PURE__ */ e("option", { value: "rodin" }),
          /* @__PURE__ */ e("option", { value: "apify" }),
          /* @__PURE__ */ e("option", { value: "usd" })
        ] })
      ] }) : i.cost ? `${i.cost.credits} ${i.cost.service}` : /* @__PURE__ */ e("span", { className: "a3d-muted", children: "not recorded" }) }),
      /* @__PURE__ */ e("dt", { children: "Notes" }),
      /* @__PURE__ */ a("dd", { children: [
        (i.notes ?? []).length > 0 && /* @__PURE__ */ e("ul", { className: "a3d-notes", children: i.notes.map((h, d) => /* @__PURE__ */ a("li", { children: [
          /* @__PURE__ */ e("span", { className: "a3d-muted", children: gn(h.at) }),
          " ",
          h.text
        ] }, d)) }),
        s && /* @__PURE__ */ a("form", { className: "a3d-row", onSubmit: (h) => {
          h.preventDefault(), I.trim() && (M(i, I.trim()), F(""));
        }, children: [
          /* @__PURE__ */ e("input", { className: "a3d-in-grow", "aria-label": "New note", placeholder: "Add a note: what you saw, what to try", value: I, onChange: (h) => F(h.target.value) }),
          /* @__PURE__ */ e("button", { type: "submit", className: "a3d-btn a3d-btn-small", disabled: !I.trim(), children: "Add" })
        ] })
      ] }),
      /* @__PURE__ */ e("dt", { children: "Position" }),
      /* @__PURE__ */ a("dd", { children: [
        v ? /* @__PURE__ */ a(te, { children: [
          "grows from ",
          /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: () => g(v.id), children: v.label })
        ] }) : "first attempt",
        E.length > 0 && /* @__PURE__ */ a(te, { children: [
          " · leads to ",
          E.map((h, d) => /* @__PURE__ */ a("span", { children: [
            d ? ", " : "",
            /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: () => g(h.id), children: h.label })
          ] }, h.id))
        ] })
      ] })
    ] }),
    s && !i.inferred && /* @__PURE__ */ a("p", { className: "a3d-row", children: [
      /* @__PURE__ */ e("span", { className: "a3d-muted", children: "Verdict" }),
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", "aria-pressed": i.verdict === "accepted", onClick: () => k(i, "accepted"), children: "Accepted" }),
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", "aria-pressed": i.verdict === "rejected", onClick: () => k(i, "rejected"), children: "Rejected" }),
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", disabled: !i.verdict, onClick: () => k(i, "none"), children: "Clear" }),
      /* @__PURE__ */ e("span", { className: "a3d-tabs-spacer" }),
      /* @__PURE__ */ e(
        "button",
        {
          type: "button",
          className: "a3d-btn a3d-btn-small",
          onClick: () => L(i, !i.archived),
          title: i.archived ? "Show this attempt again" : "Hide this attempt and everything that grew from it; nothing is deleted",
          children: i.archived ? "Unarchive attempt" : "Archive attempt"
        }
      )
    ] })
  ] });
}
const $ = (t) => `'${t.replace(/'/g, "'\\''")}'`, pi = () => /Win/i.test(navigator.platform) ? 'start ""' : /Mac/i.test(navigator.platform) ? "open" : "xdg-open", ui = (t, i) => `file://${encodeURI(t).replace(/#/g, "%23").replace(/\?/g, "%3F")}?v=${i}`, Za = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" }, Ln = () => /Mac/i.test(navigator.platform), Xa = () => /Win/i.test(navigator.platform);
function bn(t) {
  return Ln() ? `open -R ${$(t)}` : Xa() ? `explorer /select,"${t.replace(/\//g, "\\")}"` : `xdg-open ${$(t.replace(/\/[^/]*$/, ""))}`;
}
function Fe({ host: t, path: i, mtime: l, alt: s, onClick: o }) {
  const [g, w] = A(() => ui(i, l)), m = qe(!1);
  return ke(() => {
    m.current = !1, w(ui(i, l));
  }, [i, l]), /* @__PURE__ */ e("img", { src: g, alt: s, onError: async () => {
    if (m.current) return;
    m.current = !0;
    const k = await t.exec(`base64 < ${$(i)}`, { timeout: 2e4 }), S = i.split(".").pop()?.toLowerCase() ?? "png";
    k.success && w(`data:${Za[S] ?? "image/png"};base64,${k.stdout.replace(/\s+/g, "")}`);
  }, onClick: o, loading: "lazy" });
}
const mi = /\.(png|jpe?g|webp|gif)$/i;
function Qa({ host: t, model: i, a: l, b: s, onClose: o, onSwap: g, onView3d: w, onOpen: m }) {
  const C = Array.from(/* @__PURE__ */ new Set([...Object.keys(l.settings), ...Object.keys(s.settings)])).sort(), k = (f, x, L) => /* @__PURE__ */ a("tr", { className: x !== L ? "a3d-diff" : void 0, children: [
    /* @__PURE__ */ e("th", { children: f }),
    /* @__PURE__ */ e("td", { children: x || /* @__PURE__ */ e("span", { className: "a3d-muted", children: "–" }) }),
    /* @__PURE__ */ e("td", { children: L || /* @__PURE__ */ e("span", { className: "a3d-muted", children: "–" }) })
  ] }, f), S = (f) => {
    const x = f.files.filter((M) => mi.test(M)), L = f.files.filter((M) => /\.stl$/i.test(M));
    return /* @__PURE__ */ a("div", { className: "a3d-cmp-side", children: [
      x.length > 0 && /* @__PURE__ */ e("div", { className: "a3d-gallery", children: x.map((M) => /* @__PURE__ */ a("figure", { children: [
        /* @__PURE__ */ e(Fe, { host: t, path: `${Sn(i, f)}/${M}`, mtime: i.stamp, alt: M }),
        /* @__PURE__ */ e("figcaption", { children: M })
      ] }, M)) }),
      /* @__PURE__ */ a("p", { className: "a3d-row", children: [
        L.map((M) => /* @__PURE__ */ a("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => w(f, M), children: [
          "3D: ",
          M.split("/").pop()
        ] }, M)),
        f.files.filter((M) => !mi.test(M) && !/\.stl$/i.test(M)).map((M) => /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: () => m(M, f), children: M }, M))
      ] })
    ] });
  };
  return /* @__PURE__ */ a("section", { className: "a3d-node-detail a3d-compare", children: [
    /* @__PURE__ */ a("header", { children: [
      /* @__PURE__ */ a("h3", { children: [
        "Compare attempts",
        l.step !== s.step ? /* @__PURE__ */ e("span", { className: "a3d-pill", children: "different steps" }) : null
      ] }),
      /* @__PURE__ */ a("span", { className: "a3d-row", children: [
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: g, children: "Swap" }),
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: o, children: "Close" })
      ] })
    ] }),
    /* @__PURE__ */ a("table", { className: "a3d-filetable a3d-cmp-table", children: [
      /* @__PURE__ */ e("thead", { children: /* @__PURE__ */ a("tr", { children: [
        /* @__PURE__ */ e("th", {}),
        /* @__PURE__ */ a("th", { children: [
          "A · ",
          l.label
        ] }),
        /* @__PURE__ */ a("th", { children: [
          "B · ",
          s.label
        ] })
      ] }) }),
      /* @__PURE__ */ a("tbody", { children: [
        i.branches.length > 1 && k("Branch", Pe(l), Pe(s)),
        k("Status", `${l.status}${l.verdict ? ` · ${l.verdict}` : ""}`, `${s.status}${s.verdict ? ` · ${s.verdict}` : ""}`),
        C.map((f) => k(f, l.settings[f] ?? "", s.settings[f] ?? "")),
        k("Description", l.description, s.description),
        k("Outcome", l.outcome, s.outcome),
        k("Cost", l.cost ? `${l.cost.credits} ${l.cost.service}` : "", s.cost ? `${s.cost.credits} ${s.cost.service}` : ""),
        k("Notes", (l.notes ?? []).map((f) => f.text).join(" · "), (s.notes ?? []).map((f) => f.text).join(" · "))
      ] })
    ] }),
    /* @__PURE__ */ a("div", { className: "a3d-two", children: [
      S(l),
      S(s)
    ] }),
    /* @__PURE__ */ e("p", { className: "a3d-muted a3d-small", children: "Rows that differ are highlighted. A file an attempt replaced later lives in mesh/attempts/; older attempts that did not record their files show none." })
  ] });
}
function es({ model: t, last: i, onPickPhotos: l, onCancel: s, onSave: o }) {
  const [g, w] = A({
    result: "ok",
    printer: i?.printer ?? "",
    filament: i?.filament ?? "",
    settings: i?.settings ?? "",
    change: "",
    notes: "",
    photoPaths: [],
    photoFiles: []
  }), m = qe(null), C = (f, x) => w((L) => ({ ...L, [f]: x })), k = async () => {
    const f = await l();
    f === null ? m.current?.click() : f.length && w((x) => ({ ...x, photoPaths: [...x.photoPaths, ...f] }));
  }, S = g.photoPaths.length + g.photoFiles.length;
  return /* @__PURE__ */ e("div", { className: "a3d-overlay", onClick: s, children: /* @__PURE__ */ a("form", { className: "a3d-dialog a3d-dialog-wide", onClick: (f) => f.stopPropagation(), onSubmit: (f) => {
    f.preventDefault(), o(g);
  }, children: [
    /* @__PURE__ */ a("h3", { children: [
      "Test print · ",
      t.meta.title || t.slug
    ] }),
    /* @__PURE__ */ a("fieldset", { className: "a3d-fields a3d-result", children: [
      /* @__PURE__ */ e("legend", { children: "Result" }),
      [["ok", "OK, prints as intended"], ["issues", "Prints, with issues"], ["fail", "Failed"]].map(([f, x]) => /* @__PURE__ */ a("label", { className: "a3d-radio", children: [
        /* @__PURE__ */ e("input", { type: "radio", name: "a3d-result", checked: g.result === f, onChange: () => C("result", f) }),
        " ",
        x
      ] }, f))
    ] }),
    /* @__PURE__ */ a("div", { className: "a3d-form-grid", children: [
      /* @__PURE__ */ a("label", { children: [
        "Printer",
        /* @__PURE__ */ e("input", { value: g.printer, onChange: (f) => C("printer", f.target.value), placeholder: "Bambu A1" })
      ] }),
      /* @__PURE__ */ a("label", { children: [
        "Filament",
        /* @__PURE__ */ e("input", { value: g.filament, onChange: (f) => C("filament", f.target.value), placeholder: "PLA Basic, green" })
      ] })
    ] }),
    /* @__PURE__ */ a("label", { children: [
      "Settings",
      /* @__PURE__ */ e("input", { value: g.settings, onChange: (f) => C("settings", f.target.value), placeholder: "0.2 mm layers, 3 walls, 15 % infill, no supports" })
    ] }),
    /* @__PURE__ */ a("label", { children: [
      "What to change next time",
      /* @__PURE__ */ e("input", { value: g.change, onChange: (f) => C("change", f.target.value), placeholder: "clearance 0.45 instead of 0.4; tail joint stuck" })
    ] }),
    /* @__PURE__ */ a("label", { children: [
      "Notes",
      /* @__PURE__ */ e("textarea", { rows: 2, value: g.notes, onChange: (f) => C("notes", f.target.value) })
    ] }),
    /* @__PURE__ */ a("p", { className: "a3d-row", children: [
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => {
        k();
      }, children: "Add photos…" }),
      /* @__PURE__ */ e("span", { className: "a3d-muted", children: S ? `${S} photo${S === 1 ? "" : "s"}` : "Photos are copied into print/photos/." }),
      /* @__PURE__ */ e("input", { ref: m, type: "file", accept: "image/*", multiple: !0, hidden: !0, onChange: (f) => {
        const x = Array.from(f.target.files ?? []);
        f.target.value = "", w((L) => ({ ...L, photoFiles: [...L.photoFiles, ...x] }));
      } })
    ] }),
    /* @__PURE__ */ a("span", { className: "a3d-row a3d-row-end", children: [
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: s, children: "Cancel" }),
      /* @__PURE__ */ e("button", { type: "submit", className: "a3d-btn a3d-btn-primary", children: "Save" })
    ] })
  ] }) });
}
const Ti = { modelsRoot: "" }, ts = `"""Blender readiness for the AI3D Forge panel. Run as:  python3 - <workspace> <blender_bin or auto>  (source on stdin).
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
`;
async function ns(t, i) {
  const l = await t.exec(`python3 - ${$(t.workspacePath)} ${$(i || "auto")} <<'A3D_BL'
${ts}
A3D_BL`, { timeout: 6e4 });
  if (!l.success) throw new Error(l.stderr.trim().split(`
`).pop() || "Blender check failed");
  return JSON.parse(l.stdout.trim().split(`
`).pop() ?? "{}");
}
function is(t, i, l, s, o = {}) {
  const g = Object.entries(o).filter(([, w]) => w !== "").map(([w, m]) => $(`${w}=${m}`)).join(" ");
  return `${$(t)} -b --factory-startup -P ${$(i)} -- ${l} ${$(s)}${g ? ` ${g}` : ""}`;
}
async function as(t, i, l, s, o, g) {
  const w = await t.exec(is(i, l, s, o, g), { timeout: 9e5, maxBuffer: 2e7 }), m = (w.stdout ?? "").split(`
`).reverse().find((k) => k.startsWith("A3D_RESULT "));
  if (m) return JSON.parse(m.slice(11));
  const C = `${w.stderr ?? ""}
${w.stdout ?? ""}`.trim().split(`
`).filter(Boolean).slice(-3).join(" · ");
  return { ok: !1, command: s, problems: [`Blender did not finish: ${C || "no output"}`], crashed: !0 };
}
async function ss(t, i, l) {
  const s = Ln() && (!i || i.includes(".app/"));
  if (!l) return t.exec(s ? "open -a Blender" : `nohup ${$(i ?? "blender")} >/dev/null 2>&1 &`, { timeout: 15e3 });
  const o = l.split(".").pop()?.toLowerCase() ?? "";
  if (o === "blend") {
    const C = s ? `open -a Blender ${$(l)}` : `nohup ${$(i ?? "blender")} ${$(l)} >/dev/null 2>&1 &`;
    return t.exec(C, { timeout: 15e3 });
  }
  const g = JSON.stringify(l), m = `import bpy; bpy.ops.wm.read_homefile(use_empty=True); ${o === "stl" ? `bpy.ops.wm.stl_import(filepath=${g})` : o === "obj" ? `bpy.ops.wm.obj_import(filepath=${g})` : o === "fbx" ? `bpy.ops.import_scene.fbx(filepath=${g})` : `bpy.ops.import_scene.gltf(filepath=${g})`}`;
  return t.exec(`nohup ${$(i ?? "blender")} --python-expr ${$(m)} >/dev/null 2>&1 &`, { timeout: 15e3 });
}
function jn(t) {
  if (!t.ok && t.problems?.length) return t.problems.join(" ");
  const i = t.after ?? t.analysis, l = t.before, s = [];
  return t.command === "flexi" && t.flexi && s.push(`${t.flexi.joints ?? "?"} joints`), i?.overhang_pct != null && s.push(`overhang ${i.overhang_pct} %${l?.overhang_pct != null ? ` (was ${l.overhang_pct} %)` : ""}`), t.side_on_bed && s.push(`${t.side_on_bed} on bed`), i?.size_mm && s.push(`${i.size_mm.map((o) => Math.round(o)).join("×")} mm`), i?.watertight === !1 && s.push("not watertight"), s.join(", ") || (t.files?.length ? `wrote ${t.files.join(", ")}` : "done");
}
function ls(t) {
  return t ? t.bin ? t.mcp.some((i) => i.forSessions) ? "ready" : "partial" : "missing" : "unknown";
}
const fi = (t) => t?.match(/\d+\.\d+(\.\d+)?/)?.[0] ?? "";
function rs({ status: t, checking: i, onClick: l }) {
  const s = ls(t), o = i ? "checking…" : s === "ready" ? `${fi(t.version)} · MCP` : s === "partial" ? `${fi(t.version)} · no MCP` : s === "missing" ? "not found" : "";
  return /* @__PURE__ */ a("button", { type: "button", className: `a3d-chip a3d-chip-${s}`, onClick: l, title: "Blender and the Blender MCP: status, setup guide", children: [
    /* @__PURE__ */ e("i", { "aria-hidden": "true" }),
    "Blender ",
    /* @__PURE__ */ e("span", { className: "a3d-muted", children: o })
  ] });
}
function Kt({ ok: t, label: i, value: l, hint: s }) {
  return /* @__PURE__ */ a("div", { className: "a3d-status-row", children: [
    /* @__PURE__ */ e("span", { className: t === null ? "a3d-st a3d-st-unknown" : t ? "a3d-st a3d-st-ok" : "a3d-st a3d-st-bad", "aria-hidden": "true", children: t === null ? "?" : t ? "✓" : "✕" }),
    /* @__PURE__ */ e("span", { className: "a3d-status-label", children: i }),
    /* @__PURE__ */ a("span", { className: "a3d-status-value", children: [
      l,
      s && /* @__PURE__ */ a("span", { className: "a3d-muted", children: [
        " — ",
        s
      ] })
    ] })
  ] });
}
function os({ status: t, checking: i, kilnInstalled: l, guide: s, onCheck: o, onGuide: g, onLaunch: w, onClose: m }) {
  const C = t?.mcp.filter((S) => S.forSessions) ?? [], k = t?.mcp.filter((S) => !S.forSessions) ?? [];
  return /* @__PURE__ */ e("div", { className: "a3d-overlay", onClick: m, children: /* @__PURE__ */ a("div", { className: "a3d-dialog a3d-dialog-wide", role: "dialog", "aria-label": "Blender", onClick: (S) => S.stopPropagation(), children: [
    /* @__PURE__ */ e("h3", { children: "Blender" }),
    /* @__PURE__ */ e("p", { className: "a3d-muted", children: "The Kiln agent drives your open Blender through the Blender MCP. The quick tools in the Blender step run a background Blender and need only the app." }),
    /* @__PURE__ */ a("div", { className: "a3d-status", children: [
      /* @__PURE__ */ e(
        Kt,
        {
          ok: t ? !!t.bin : null,
          label: "Blender app",
          value: t?.bin ? `${t.version ?? "version unknown"}` : "not found",
          hint: t?.bin ? t.bin : "install it into /Applications, or set “Blender executable” in Settings"
        }
      ),
      /* @__PURE__ */ e(
        Kt,
        {
          ok: t?.running ?? null,
          label: "Running",
          value: t?.running ? "yes" : t?.running === !1 ? "no" : "unknown",
          hint: t?.running ? void 0 : "the agent needs Blender open with the MCP add-on server started"
        }
      ),
      /* @__PURE__ */ e(
        Kt,
        {
          ok: t ? C.length > 0 : null,
          label: "MCP for agent sessions",
          value: C.length ? C.map((S) => `${S.name} (${S.where})`).join(", ") : "not registered for Claude Code",
          hint: C.length ? void 0 : k.length ? "found only in the Claude desktop app, which Nimbalyst sessions do not read" : "see the setup guide, step 3"
        }
      ),
      /* @__PURE__ */ e(Kt, { ok: l, label: "Kiln scripts", value: l ? "installed" : "not found", hint: l ? void 0 : "update the AI3D Forge module" })
    ] }),
    /* @__PURE__ */ a("p", { className: "a3d-muted a3d-small", children: [
      "⚠ The panel cannot see inside an agent session: “registered” means the config has it, not that this session connected. In a session, ",
      /* @__PURE__ */ e("code", { children: "/mcp" }),
      " shows the live state."
    ] }),
    /* @__PURE__ */ a("span", { className: "a3d-row a3d-row-end", children: [
      s && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: g, children: "Setup guide" }),
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", disabled: !t?.bin, onClick: w, children: "Open Blender" }),
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", disabled: i, onClick: o, children: i ? "Checking…" : "Check again" }),
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-primary", onClick: m, children: "Close" })
    ] })
  ] }) });
}
const ds = ["auto", "bottom", "back", "front", "left", "right", "top"];
function cs({ cmd: t, model: i, initial: l, onCancel: s, onRun: o }) {
  const g = String(i.meta.scale_mm ?? ""), [w, m] = A(() => ({
    ...t === "prep" ? { height: g || "100", orient: "auto", cut: "1.0", voxel: "" } : { segments: "6", clearance: "0.4", gap: "1.5", pin_d: "3.0" },
    ...l ?? {}
  })), [C, k] = A(""), S = (x, L) => m((M) => ({ ...M, [x]: L })), f = (x, L, M, B = "0.1") => /* @__PURE__ */ a("label", { children: [
    L,
    /* @__PURE__ */ e("input", { type: "number", step: B, min: "0", value: w[x] ?? "", onChange: (I) => S(x, I.target.value) }),
    /* @__PURE__ */ e("span", { className: "a3d-muted a3d-small", children: M })
  ] }, x);
  return /* @__PURE__ */ e("div", { className: "a3d-overlay", onClick: s, children: /* @__PURE__ */ a("form", { className: "a3d-dialog a3d-dialog-wide", onClick: (x) => x.stopPropagation(), onSubmit: (x) => {
    x.preventDefault(), o({ cmd: t, opts: w, description: C.trim() });
  }, children: [
    /* @__PURE__ */ e("h3", { children: t === "prep" ? "Quick prep in Blender" : "Flexi joints in Blender" }),
    /* @__PURE__ */ e("p", { className: "a3d-muted", children: "Runs in a background Blender, no agent, no tokens. It becomes a new attempt in the graph; the current print.stl is kept in mesh/attempts/." }),
    /* @__PURE__ */ e("div", { className: "a3d-form-grid", children: t === "prep" ? /* @__PURE__ */ a(te, { children: [
      f("height", "Size (mm)", "tallest dimension after scaling", "1"),
      /* @__PURE__ */ a("label", { children: [
        "Side on the bed",
        /* @__PURE__ */ e("select", { value: w.orient, onChange: (x) => S("orient", x.target.value), children: ds.map((x) => /* @__PURE__ */ e("option", { value: x, children: x }, x)) }),
        /* @__PURE__ */ e("span", { className: "a3d-muted a3d-small", children: "auto picks the lowest overhang among stable sides" })
      ] }),
      f("cut", "Flat cut (mm)", "sliced off the bed side for a flat base"),
      f("voxel", "Voxel size (mm)", "empty = automatic; smaller keeps detail, slower")
    ] }) : /* @__PURE__ */ a(te, { children: [
      f("segments", "Segments", "number of body parts", "1"),
      f("clearance", "Clearance (mm)", "gap in the joint; use your coupon result", "0.05"),
      f("gap", "Gap between segments (mm)", "cut width"),
      f("pin_d", "Pin diameter (mm)", "smaller for narrow bodies")
    ] }) }),
    /* @__PURE__ */ a("label", { children: [
      "Description: what is different this time",
      /* @__PURE__ */ e("textarea", { rows: 2, value: C, onChange: (x) => k(x.target.value), placeholder: t === "prep" ? "Back on the bed instead of bottom: the belly has the detail." : "Six segments, clearance from the coupon." })
    ] }),
    /* @__PURE__ */ a("span", { className: "a3d-row a3d-row-end", children: [
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: s, children: "Cancel" }),
      /* @__PURE__ */ e("button", { type: "submit", className: "a3d-btn a3d-btn-primary", children: "Run in Blender" })
    ] })
  ] }) });
}
function hs({ model: t, status: i, kilnRun: l, busy: s, last: o, onRun: g, onPrep: w, onFlexi: m, onOpen: C, onCommand: k, onSetup: S }) {
  const f = !!i?.bin && !!l && !s, x = t.files.mesh.find((p) => /^raw\./i.test(p.name)), L = t.files.mesh.find((p) => p.name === "print.stl") ?? t.files.mesh.find((p) => p.name === "clean.stl"), M = t.files.mesh.find((p) => p.name === "work.blend"), B = i ? i.bin ? l ? null : "Kiln scripts not found: update the module." : "Blender not found." : "Checking Blender…", I = o?.command === "analyze" ? o.orientations ?? [] : [], F = o?.analysis ?? o?.after;
  return /* @__PURE__ */ a("section", { className: "a3d-block", children: [
    /* @__PURE__ */ a("h4", { children: [
      "Blender quick tools ",
      /* @__PURE__ */ e("span", { className: "a3d-muted", children: "no agent, no tokens" })
    ] }),
    B && /* @__PURE__ */ a("p", { className: "a3d-muted", children: [
      B,
      " ",
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: S, children: "Blender setup" })
    ] }),
    /* @__PURE__ */ a("p", { className: "a3d-row", children: [
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", disabled: !f || !x && !L, onClick: () => g("analyze"), children: s === "analyze" ? "Analyzing…" : "Analyze" }),
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", disabled: !f || !x, onClick: w, title: x ? "" : "needs mesh/raw.*", children: s === "prep" ? "Preparing…" : "Quick prep…" }),
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", disabled: !f || !L, onClick: m, title: L ? "" : "needs mesh/print.stl", children: s === "flexi" ? "Building joints…" : "Flexi…" }),
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", disabled: !f || !x && !L, onClick: () => g("render"), children: s === "render" ? "Rendering…" : "Render previews" }),
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", disabled: !f, onClick: () => g("coupon"), children: s === "coupon" ? "Exporting…" : "Clearance coupon" })
    ] }),
    /* @__PURE__ */ a("p", { className: "a3d-row", children: [
      /* @__PURE__ */ e("span", { className: "a3d-muted", children: "Open in Blender:" }),
      M && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", disabled: !i?.bin, onClick: () => C("mesh/work.blend"), children: "work.blend" }),
      L && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", disabled: !i?.bin, onClick: () => C(`mesh/${L.name}`), children: L.name }),
      x && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", disabled: !i?.bin, onClick: () => C(`mesh/${x.name}`), children: x.name }),
      /* @__PURE__ */ e("span", { className: "a3d-tabs-spacer" }),
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: k, title: "Kiln agent runs one instruction in your open Blender", children: "Blender command…" })
    ] }),
    s && /* @__PURE__ */ e("p", { className: "a3d-muted", children: "Running in a background Blender. Voxel remesh on a large mesh can take a minute or two." }),
    o && !s && /* @__PURE__ */ a("div", { className: o.ok ? "a3d-kiln-result" : "a3d-kiln-result a3d-kiln-bad", children: [
      /* @__PURE__ */ a("p", { children: [
        /* @__PURE__ */ a("strong", { children: [
          o.command === "analyze" ? "Analysis" : o.command === "prep" ? "Quick prep" : o.command === "flexi" ? "Flexi" : o.command === "render" ? "Render" : "Coupon",
          o.ok ? "" : " — problem",
          ":"
        ] }),
        " ",
        jn(o)
      ] }),
      F && o.command === "analyze" && /* @__PURE__ */ a("dl", { className: "a3d-metrics", children: [
        F.size_mm && /* @__PURE__ */ a("div", { className: "a3d-metric", children: [
          /* @__PURE__ */ e("dt", { children: "Size" }),
          /* @__PURE__ */ a("dd", { children: [
            F.size_mm.join(" × "),
            " mm"
          ] })
        ] }),
        F.watertight != null && /* @__PURE__ */ a("div", { className: F.watertight ? "a3d-metric a3d-good" : "a3d-metric a3d-bad", children: [
          /* @__PURE__ */ e("dt", { children: "Watertight" }),
          /* @__PURE__ */ e("dd", { children: F.watertight ? "yes" : "no" })
        ] }),
        F.shells != null && /* @__PURE__ */ a("div", { className: "a3d-metric", children: [
          /* @__PURE__ */ e("dt", { children: "Shells" }),
          /* @__PURE__ */ e("dd", { children: F.shells })
        ] }),
        F.overhang_pct != null && /* @__PURE__ */ a("div", { className: "a3d-metric", children: [
          /* @__PURE__ */ e("dt", { children: "Overhang" }),
          /* @__PURE__ */ a("dd", { children: [
            F.overhang_pct,
            " %"
          ] })
        ] }),
        F.triangles != null && /* @__PURE__ */ a("div", { className: "a3d-metric", children: [
          /* @__PURE__ */ e("dt", { children: "Triangles" }),
          /* @__PURE__ */ e("dd", { children: Number(F.triangles).toLocaleString() })
        ] })
      ] }),
      I.length > 0 && /* @__PURE__ */ a("table", { className: "a3d-filetable a3d-orient", children: [
        /* @__PURE__ */ e("thead", { children: /* @__PURE__ */ a("tr", { children: [
          /* @__PURE__ */ e("th", { children: "Side on bed" }),
          /* @__PURE__ */ e("th", { children: "Overhang" }),
          /* @__PURE__ */ e("th", { children: "Height" }),
          /* @__PURE__ */ e("th", { children: "Stable" })
        ] }) }),
        /* @__PURE__ */ e("tbody", { children: I.map((p) => /* @__PURE__ */ a("tr", { children: [
          /* @__PURE__ */ e("td", { children: p.side }),
          /* @__PURE__ */ a("td", { className: "a3d-num", children: [
            p.overhang_pct,
            " %"
          ] }),
          /* @__PURE__ */ e("td", { className: "a3d-num", children: p.height_mm != null ? `${p.height_mm} mm` : "" }),
          /* @__PURE__ */ e("td", { children: p.stable == null ? "" : p.stable ? "yes" : "no" })
        ] }, p.side)) })
      ] }),
      o.command === "analyze" && /* @__PURE__ */ a("p", { className: "a3d-muted a3d-small", children: [
        "Measured on ",
        String(o.source ?? ""),
        "."
      ] })
    ] })
  ] });
}
const ps = `"""Place files the user picked into the right folder of a model. Run by the Nimbalyst panel:
    python3 - <model dir> <image|mesh> <move|copy> <source path>...   (source on stdin)
Images go to inbox/ (kind view: inbox/views/). Meshes: one .glb/.gltf/.obj/.fbx/.stl becomes mesh/raw.<ext> (the previous raw.* is
archived to mesh/attempts/); several at once (the variants of one generation) go to mesh/candidates/ and wait for a choice;
print.stl / clean.stl keep their name in mesh/; .3mf goes to print/. kind promote: copy mesh/candidates/<file> to mesh/raw.<ext>.
A file that is already there (same bytes) is skipped. Nothing is overwritten. Prints one JSON document."""
import hashlib
import json
import os
import shutil
import sys
import time

model, kind, mode = sys.argv[1], sys.argv[2], sys.argv[3]
sources = sys.argv[4:]
IMG = (".png", ".jpg", ".jpeg", ".webp", ".gif")
RAW = (".glb", ".gltf", ".obj", ".fbx", ".stl")   # what a 3D service hands out
OWN = ("print.stl", "clean.stl")                    # Blender's outputs keep their names
placed, skipped, candidates = [], [], []


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def same_as_existing(src, folders):
    """Relative path of a file in one of the folders with the same bytes as src, or None."""
    size = os.path.getsize(src)
    digest = None
    for folder in folders:
        d = os.path.join(model, folder)
        if not os.path.isdir(d):
            continue
        for old in sorted(os.listdir(d)):
            p = os.path.join(d, old)
            if os.path.isfile(p) and os.path.getsize(p) == size:
                digest = digest or sha(src)
                if sha(p) == digest:
                    return "%s/%s" % (folder, old)
    return None


def archive_raw():
    """Move every mesh/raw.* to mesh/attempts/; return the last archived path."""
    mesh_dir = os.path.join(model, "mesh")
    last = None
    if os.path.isdir(mesh_dir):
        for old in sorted(os.listdir(mesh_dir)):
            if old.lower().startswith("raw.") and os.path.isfile(os.path.join(mesh_dir, old)):
                last = archive(os.path.join(mesh_dir, old))
    return last


def free_name(folder, name):
    stem, ext = os.path.splitext(name)
    out, n = name, 2
    while os.path.exists(os.path.join(folder, out)):
        out = "%s-%d%s" % (stem, n, ext)
        n += 1
    return out


def archive(path):
    att = os.path.join(model, "mesh", "attempts")
    os.makedirs(att, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime(os.path.getmtime(path)))
    name = free_name(att, "%s-%s" % (stamp, os.path.basename(path)))
    shutil.move(path, os.path.join(att, name))
    return "mesh/attempts/" + name


if kind == "promote":
    # sources are paths relative to the model folder, e.g. mesh/candidates/medieval.stl
    for rel in sources:
        src = os.path.join(model, rel)
        ext = os.path.splitext(src)[1].lower()
        if not os.path.isfile(src) or ext not in RAW:
            skipped.append({"file": rel, "why": "not a 3D file"})
            continue
        dup = same_as_existing(src, ["mesh"])
        if dup and os.path.basename(dup).lower().startswith("raw."):
            skipped.append({"file": rel, "why": "already the raw mesh (%s)" % dup})
            continue
        archived = archive_raw()
        shutil.copy2(src, os.path.join(model, "mesh", "raw" + ext))
        placed.append({"file": "mesh/raw" + ext, "archived": archived})
    print(json.dumps({"placed": placed, "skipped": skipped, "candidates": candidates}))
    sys.exit(0)

# several service files at once are the variants of one generation: keep them all, choose later
service = [s for s in sources if os.path.splitext(s)[1].lower() in RAW and os.path.basename(s).lower() not in OWN]
many = kind == "mesh" and len(service) > 1

for src in sources:
    if not os.path.isfile(src):
        skipped.append({"file": src, "why": "not a file"})
        continue
    base = os.path.basename(src)
    ext = os.path.splitext(base)[1].lower()
    archived = None
    pending_archive = False
    if kind in ("image", "view"):
        if ext not in IMG:
            skipped.append({"file": base, "why": "not an image (png, jpg, webp, gif)"})
            continue
        # views for multi-view 3D wait in inbox/views/ for Lumen *review-views
        folder, name = ("inbox/views" if kind == "view" else "inbox"), None
        look = [folder]
    elif base.lower() in OWN:
        folder, name = "mesh", None
        existing = os.path.join(model, "mesh", base)
        look = ["mesh"]
        if os.path.isfile(existing):
            archived = archive(existing)
    elif ext in RAW and many:
        folder, name = "mesh/candidates", None
        look = ["mesh/candidates", "mesh"]
    elif ext in RAW:
        folder, name = "mesh", "raw" + ext
        look = ["mesh"]
        pending_archive = True
    elif ext == ".3mf":
        folder, name = "print", None
        look = ["print"]
    else:
        skipped.append({"file": base, "why": "not a 3D file (glb, gltf, obj, fbx, stl, 3mf)"})
        continue
    dup = same_as_existing(src, look)
    if dup:
        skipped.append({"file": base, "why": "already there (%s)" % dup})
        if mode == "move":
            os.remove(src)
        continue
    dest_dir = os.path.join(model, folder)
    if pending_archive:
        archived = archive_raw()
    os.makedirs(dest_dir, exist_ok=True)
    name = name if name and not os.path.exists(os.path.join(dest_dir, name)) else free_name(dest_dir, name or base)
    dest = os.path.join(dest_dir, name)
    if os.path.abspath(src) == os.path.abspath(dest):
        skipped.append({"file": base, "why": "already there"})
        continue
    (shutil.move if mode == "move" else shutil.copy2)(src, dest)
    placed.append({"file": "%s/%s" % (folder, name), "archived": archived})
    if folder == "mesh/candidates":
        candidates.append("%s/%s" % (folder, name))
print(json.dumps({"placed": placed, "skipped": skipped, "candidates": candidates}))
`, En = ["png", "jpg", "jpeg", "webp", "gif"], Fn = ["glb", "gltf", "obj", "fbx", "stl", "3mf"], us = (t) => {
  const i = t.split(".").pop()?.toLowerCase() ?? "";
  return En.includes(i) ? "image" : Fn.includes(i) ? "mesh" : null;
};
async function mt(t, i) {
  if (!Ln()) return null;
  const l = (i !== "mesh" ? En : Fn).map((w) => `"${w}"`).join(", "), o = [
    'tell application "Finder" to activate',
    `tell application "Finder" to set fs to choose file with prompt "${i === "image" ? "Choose the generated image(s)" : i === "view" ? "Choose the view images (front, left, back, right)" : "Choose the 3D file (GLB, STL, 3MF…)"}" of type {${l}} with multiple selections allowed`,
    'set out to ""',
    "repeat with f in fs",
    "set out to out & POSIX path of f & linefeed",
    "end repeat",
    "return out"
  ].map((w) => `-e ${$(w)}`).join(" "), g = await t.exec(`osascript ${o}`, { timeout: 6e5 });
  return g.success ? g.stdout.split(`
`).map((w) => w.trim()).filter(Boolean) : /-128|cancel/i.test(g.stderr) ? [] : null;
}
function ms(t) {
  let i = "";
  for (let l = 0; l < t.length; l += 32768) i += String.fromCharCode(...t.subarray(l, l + 32768));
  return btoa(i);
}
async function Mi(t, i, l) {
  const s = `${i}/.import-tmp`, o = `${s}/${l.name.replace(/[^\w.\- ]+/g, "_")}`, g = await t.exec(`mkdir -p ${$(s)} && : > ${$(o)}`, { timeout: 15e3 });
  if (!g.success) throw new Error(g.stderr.trim() || "could not create the temporary file");
  const w = 6e4;
  if (l.size > 12e7) throw new Error(`${l.name} is too large to add this way; copy it into the model folder instead`);
  for (let m = 0; m < l.size; m += w) {
    const C = new Uint8Array(await l.slice(m, m + w).arrayBuffer()), k = await t.exec(
      `python3 -c "import sys,base64;open(sys.argv[1],'ab').write(base64.b64decode(sys.stdin.read()))" ${$(o)} <<'A3D_B64'
${ms(C)}
A3D_B64`,
      { timeout: 6e4 }
    );
    if (!k.success) throw new Error(k.stderr.trim() || `upload of ${l.name} failed`);
  }
  return o;
}
async function Yt(t, i, l, s, o) {
  const g = await t.exec(
    `python3 - ${$(i)} ${l} ${s} ${o.map($).join(" ")} <<'A3D_IMPORT'
${ps}
A3D_IMPORT`,
    { timeout: 12e4 }
  );
  if (!g.success) throw new Error(g.stderr.trim().split(`
`).pop() || "import failed");
  return JSON.parse(g.stdout.trim().split(`
`).pop() ?? "{}");
}
function fs(t, i, l) {
  return Yt(t, i, "promote", "copy", [l]);
}
function gs(t, i, l, s) {
  return Yt(t, i, l, "copy", s);
}
async function bs(t, i, l, s) {
  const o = s.map((m) => m.path).filter((m) => !!m);
  if (o.length === s.length) return Yt(t, i, l, "copy", o);
  const g = [];
  for (const m of s) g.push(await Mi(t, i, m));
  const w = await Yt(t, i, l, "move", g);
  return t.exec(`rmdir ${$(`${i}/.import-tmp`)} 2>/dev/null; true`, { timeout: 1e4 }), w;
}
function ws(t) {
  const i = [];
  t.candidates?.length ? i.push(`${t.candidates.length} 3D files saved in mesh/candidates/. Pick one with “Use as raw mesh” (Files → 3D files), or let Chisel compare them.`) : t.placed.length && i.push(`Added ${t.placed.map((s) => s.file).join(", ")}.`);
  const l = t.placed.filter((s) => s.archived).map((s) => s.archived);
  return l.length && i.push(`The previous file was kept as ${l.join(", ")}.`), t.skipped.length && i.push(`Skipped: ${t.skipped.map((s) => `${s.file} (${s.why})`).join("; ")}.`), i.join(" ") || "Nothing was added.";
}
const Gt = /\.(png|jpe?g|webp|gif)$/i, wn = /\.(stl|3mf|glb|gltf|obj|fbx|blend)$/i, vn = /\.(md|json|txt|ya?ml)$/i;
function yn(t, i) {
  const l = (o, g, w) => g.filter((m) => w.test(m.name)).map((m) => ({ rel: `${o}/${m.name}`, f: m }));
  if (i === "images") return [...l("inbox", t.files.inbox, Gt), ...l("images", t.files.images, Gt), ...l("renders", t.files.renders, Gt), ...l("refs", t.files.refs, Gt)];
  if (i === "meshes") return [...l("mesh", t.files.mesh, wn), ...l("mesh/candidates", t.candidates ?? [], wn), ...l("print", t.files.print, /\.3mf$/i), ...l("mesh/attempts", t.attempts, wn)];
  const s = [];
  return t.concept && s.push({ rel: "concept.md", f: { name: "concept.md", size: t.concept.length, mtime: t.stamp } }), t.hasReadme && s.push({ rel: "README.md", f: { name: "README.md", size: 0, mtime: t.stamp } }), [...s, ...l("prompts", t.files.prompts, vn), ...l("print", t.files.print, vn), ...l("publish", t.files.publish, vn)];
}
const gi = (t) => new Date(t * 1e3).toLocaleDateString([], { month: "short", day: "numeric" });
function bi({ host: t, model: i, type: l, rows: s, onZoom: o, onOpen: g, onReveal: w, onView: m, onConcept: C, onPromote: k }) {
  const S = /* @__PURE__ */ new Map();
  for (const f of i.flow.nodes) for (const x of f.files) S.set(x, f.label);
  return s.length ? l === "images" ? /* @__PURE__ */ e("div", { className: "a3d-gallery a3d-gallery-files", children: s.map(({ rel: f, f: x }) => {
    const L = `${i.dir}/${f}`;
    return /* @__PURE__ */ a("figure", { children: [
      /* @__PURE__ */ e(Fe, { host: t, path: L, mtime: x.mtime, alt: x.name, onClick: () => o({ path: L, mtime: x.mtime, name: f }) }),
      /* @__PURE__ */ a("figcaption", { title: f, children: [
        /* @__PURE__ */ e("span", { className: "a3d-file-folder", children: f.split("/")[0] }),
        " ",
        x.name
      ] }),
      /* @__PURE__ */ a("span", { className: "a3d-fig-actions", children: [
        /* @__PURE__ */ e("span", { className: "a3d-muted", children: S.get(f) ?? gi(x.mtime) }),
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: () => w(i, f), children: "Show in Finder" }),
        C && /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", title: "Muse writes a concept from this picture: a new model, or a new branch of this one", onClick: () => C(L), children: "Concept from this…" })
      ] })
    ] }, f);
  }) }) : /* @__PURE__ */ a("table", { className: "a3d-filetable", children: [
    /* @__PURE__ */ e("thead", { children: /* @__PURE__ */ a("tr", { children: [
      /* @__PURE__ */ e("th", { children: "File" }),
      /* @__PURE__ */ e("th", { children: "Size" }),
      /* @__PURE__ */ e("th", { children: "Date" }),
      /* @__PURE__ */ e("th", { children: "From attempt" }),
      /* @__PURE__ */ e("th", { children: /* @__PURE__ */ e("span", { className: "a3d-sr", children: "Actions" }) })
    ] }) }),
    /* @__PURE__ */ e("tbody", { children: s.map(({ rel: f, f: x }) => /* @__PURE__ */ a("tr", { children: [
      /* @__PURE__ */ a("td", { children: [
        /* @__PURE__ */ e("span", { className: "a3d-file-folder", children: f.slice(0, f.lastIndexOf("/") + 1) }),
        /* @__PURE__ */ e("strong", { children: x.name }),
        /^mesh\/print\.stl$/.test(f) && /* @__PURE__ */ e("span", { className: "a3d-pill a3d-pill-done", children: "to print" }),
        /^mesh\/raw\./.test(f) && /* @__PURE__ */ e("span", { className: "a3d-pill", children: "as generated" }),
        f.startsWith("mesh/candidates/") && /* @__PURE__ */ e("span", { className: "a3d-pill", children: "variant" })
      ] }),
      /* @__PURE__ */ e("td", { className: "a3d-num", children: x.size ? Si(x.size) : "" }),
      /* @__PURE__ */ e("td", { className: "a3d-num", children: gi(x.mtime) }),
      /* @__PURE__ */ e("td", { className: "a3d-muted", children: S.get(f) ?? "" }),
      /* @__PURE__ */ e("td", { children: /* @__PURE__ */ a("span", { className: "a3d-row a3d-row-end", children: [
        k && f.startsWith("mesh/candidates/") && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small a3d-btn-primary", title: "Copies it to mesh/raw.* (the previous raw mesh is kept in mesh/attempts/)", onClick: () => k(f), children: "Use as raw mesh" }),
        m && /\.stl$/i.test(x.name) && f.startsWith("mesh/") && !f.includes("attempts") && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => m(i), children: "3D view" }),
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => g(i, f), children: l === "docs" ? "Open" : /\.(stl|3mf)$/i.test(x.name) ? "Open in slicer" : "Open in app" }),
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => w(i, f), children: "Show in Finder" })
      ] }) })
    ] }, f)) })
  ] }) : /* @__PURE__ */ e("p", { className: "a3d-muted a3d-files-empty", children: l === "images" ? "No images." : l === "meshes" ? "No 3D files." : "No documents." });
}
function vs({ host: t, scan: i, model: l, nodeFilter: s, importing: o, onClearFilter: g, onSelectModel: w, onZoom: m, onOpen: C, onReveal: k, onView: S, onPick: f, onFiles: x, onConcept: L, onPromote: M }) {
  const [B, I] = A("images"), [F, p] = A(!1), O = qe(null), [T, _] = A("image"), v = l && s ? l.flow.nodes.find((d) => d.id === s) ?? null : null, E = i.models.filter((d) => d.slug !== l?.slug), b = (d, c) => yn(d, c).length, j = async (d) => {
    await f(d) || (_(d), setTimeout(() => O.current?.click(), 0));
  }, h = l ? yn(l, B).filter((d) => !v || v.files.includes(d.rel)) : [];
  return /* @__PURE__ */ a("section", { className: "a3d-files-tab", children: [
    /* @__PURE__ */ a("header", { className: "a3d-head", children: [
      /* @__PURE__ */ a("div", { children: [
        /* @__PURE__ */ e("h1", { children: "Files" }),
        /* @__PURE__ */ e("p", { className: "a3d-muted", children: l ? /* @__PURE__ */ e(te, { children: "The selected model first, every other model below." }) : "Pick a model in Models to see its files first." })
      ] }),
      /* @__PURE__ */ e("span", { className: "a3d-seg", role: "group", "aria-label": "File type", children: [["images", "Images"], ["meshes", "3D files"], ["docs", "Documents"]].map(([d, c]) => /* @__PURE__ */ a("button", { type: "button", "aria-pressed": B === d, onClick: () => I(d), children: [
        c,
        l ? ` ${b(l, d)}` : ""
      ] }, d)) })
    ] }),
    l && /* @__PURE__ */ a(
      "section",
      {
        className: F ? "a3d-files-current a3d-drop-over" : "a3d-files-current",
        onDragOver: (d) => {
          d.preventDefault(), p(!0);
        },
        onDragLeave: () => p(!1),
        onDrop: (d) => {
          d.preventDefault(), p(!1);
          const c = Array.from(d.dataTransfer.files);
          c.length && x(c);
        },
        children: [
          /* @__PURE__ */ a("div", { className: "a3d-files-bar", children: [
            /* @__PURE__ */ a("h3", { children: [
              l.meta.title || l.slug,
              l.branches?.length > 1 && /* @__PURE__ */ a("span", { className: "a3d-muted", style: { fontWeight: 400 }, children: [
                " · branch ",
                l.branches.find((d) => d.id === l.branch)?.name ?? l.branch
              ] })
            ] }),
            /* @__PURE__ */ a("span", { className: "a3d-row", children: [
              /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-primary", disabled: o, onClick: () => {
                j("image");
              }, children: "Add image…" }),
              /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-primary", disabled: o, onClick: () => {
                j("mesh");
              }, children: "Add 3D model…" }),
              /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => k(l, ""), children: "Show folder in Finder" })
            ] })
          ] }),
          /* @__PURE__ */ e("p", { className: "a3d-muted a3d-files-hint", children: o ? "Adding files…" : "Or drop files here. Images go to inbox/. One 3D file (GLB, STL, OBJ…) becomes mesh/raw.<ext>, the previous one is kept in mesh/attempts/. Several at once (the variants of one generation) go to mesh/candidates/ for you to choose. print.stl keeps its name, 3MF goes to print/. Files already added are skipped." }),
          v && /* @__PURE__ */ a("p", { className: "a3d-banner", children: [
            "Only the files of the attempt “",
            v.label,
            "”.",
            /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: g, children: "Show all files" })
          ] }),
          /* @__PURE__ */ e(bi, { host: t, model: l, type: B, rows: h, onZoom: m, onOpen: C, onReveal: k, onView: S, onConcept: L, onPromote: M }),
          /* @__PURE__ */ e(
            "input",
            {
              ref: O,
              type: "file",
              multiple: !0,
              hidden: !0,
              accept: (T === "image" ? En : Fn).map((d) => `.${d}`).join(","),
              onChange: (d) => {
                const c = Array.from(d.target.files ?? []);
                d.target.value = "", c.length && x(c);
              }
            }
          )
        ]
      }
    ),
    E.length > 0 && /* @__PURE__ */ a("section", { className: "a3d-files-others", children: [
      /* @__PURE__ */ e("h3", { className: "a3d-files-others-title", children: "Other models" }),
      E.map((d) => /* @__PURE__ */ a("details", { children: [
        /* @__PURE__ */ a("summary", { children: [
          /* @__PURE__ */ e("span", { className: "a3d-files-name", children: d.meta.title || d.slug }),
          /* @__PURE__ */ a("span", { className: "a3d-muted", children: [
            b(d, B),
            " ",
            B === "images" ? "images" : B === "meshes" ? "3D files" : "documents"
          ] }),
          /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: (c) => {
            c.preventDefault(), w(d.slug);
          }, children: "Select" })
        ] }),
        /* @__PURE__ */ e(bi, { host: t, model: d, type: B, rows: yn(d, B), onZoom: m, onOpen: C, onReveal: k, onConcept: L })
      ] }, d.slug))
    ] })
  ] });
}
const yt = [
  { id: "demand", label: "Demand" },
  { id: "print_fit", label: "Print fit" },
  { id: "differentiation", label: "Stand-out" },
  { id: "ip_safety", label: "IP safety" },
  { id: "ease", label: "Ease" }
], ys = [
  { label: "Bambu A1 mini", value: "180x180x180" },
  { label: "Bambu A1 / P1 / X1", value: "256x256x256" },
  { label: "Prusa MK4", value: "250x210x220" }
], Li = [
  {
    title: "Pipeline",
    fields: [
      {
        key: "image_backend",
        label: "Image model",
        help: "Gemini model the image prompts are written for.",
        kind: "select",
        def: "nano-banana-pro",
        options: [{ value: "nano-banana-pro", label: "Nano Banana Pro (quality)" }, { value: "nano-banana-2", label: "Nano Banana 2 (speed)" }]
      },
      {
        key: "model3d_service",
        label: "3D service",
        help: "Cloud image-to-3D service the 3D specs are written for.",
        kind: "select",
        def: "tripo3d",
        options: [{ value: "tripo3d", label: "Tripo3D" }, { value: "meshy", label: "Meshy" }, { value: "rodin", label: "Rodin / Hyper3D" }, { value: "hitem3d", label: "Hitem3D" }]
      },
      { key: "blender_mcp", label: "Blender MCP connected", help: "Kiln drives Blender live. Off: Anvil writes a headless fallback.", kind: "toggle", def: "true" },
      { key: "blender_bin", label: "Blender executable", help: "For the quick tools (background Blender). auto = /Applications/Blender.app or blender on PATH.", kind: "text", def: "auto" },
      { key: "printbox_watch", label: "PrintBox handoff", help: "Keep metadata.json valid for the PrintBox watch folder.", kind: "toggle", def: "true" },
      {
        key: "publish_target",
        label: "Publish target",
        help: "Default marketplace for listings.",
        kind: "select",
        def: "makerworld",
        options: [{ value: "makerworld", label: "MakerWorld" }, { value: "printables", label: "Printables" }, { value: "thingiverse", label: "Thingiverse" }, { value: "cults3d", label: "Cults3D" }]
      },
      { key: "models_folder", label: "Models folder", help: "Where the per-model directories live. Scans and agents read this.", kind: "text", def: "{project-root}/models" },
      { key: "trends_folder", label: "Trends folder", help: "Trend research: one folder per trend.", kind: "text", def: "{project-root}/trends" },
      { key: "insights_folder", label: "Insights folder", help: "Idea preparation: one folder per idea.", kind: "text", def: "{project-root}/insights" }
    ]
  },
  {
    title: "Printer",
    fields: [
      { key: "bed_mm", label: "Bed size (mm)", help: "X × Y × Z. The 3D view checks every model against it.", kind: "bed", def: "256x256x256" },
      { key: "overhang_deg", label: "Overhang angle", help: "Faces steeper than this from vertical need support. Used by the 3D view; Kiln has its own parameter.", kind: "angle", def: "45" }
    ]
  },
  {
    title: "Agent runs",
    fields: [
      {
        key: "step_models",
        label: "Model and reasoning per step",
        help: "Which Claude model runs each step and how much it thinks first. Run command… and New attempt… can change it for one run. Effort is passed as a thinking keyword in the prompt (think / think hard / ultrathink).",
        kind: "runs",
        def: "concept=opus,image=sonnet,mesh=sonnet,blender=sonnet,validate=sonnet,print=haiku,publish=haiku,scout=opus,ideas=opus,help=haiku"
      },
      {
        key: "step_effort",
        label: "Reasoning per step",
        help: "",
        kind: "hidden",
        def: "concept=high,image=medium,mesh=medium,blender=high,validate=medium,print=low,publish=low,scout=high,ideas=high,help=low"
      }
    ]
  },
  {
    title: "Idea scoring",
    fields: [
      { key: "score_weights", label: "Weights", help: "How much each dimension counts in the Prism ranking (0 = ignore, 5 = most important).", kind: "weights", def: "demand=3,print_fit=3,differentiation=2,ip_safety=2,ease=1" }
    ]
  }
], ks = Li.flatMap((t) => t.fields), Ns = Object.fromEntries(ks.map((t) => [t.key, t.def]));
function wi(t) {
  const i = (t.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  return i.length === 1 ? [i[0], i[0], i[0]] : i.length >= 3 ? [i[0], i[1], i[2]] : [256, 256, 256];
}
const $s = (t) => t.join("x");
function Ei(t) {
  const i = Object.fromEntries(yt.map((l) => [l.id, 1]));
  for (const l of t.split(/[,\s]+/)) {
    const [s, o] = l.split("=");
    s in i && o !== void 0 && !Number.isNaN(Number(o)) && (i[s] = Number(o));
  }
  return i;
}
const xs = (t) => yt.map((i) => `${i.id}=${t[i.id]}`).join(",");
function _s(t) {
  const i = {};
  for (const l of t.split(/\r?\n/)) {
    const s = l.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*(?:#.*)?$/);
    s && s[2] !== "" && (i[s[1]] = s[2].trim().replace(/^["']|["']$/g, ""));
  }
  return i;
}
const vi = (t) => `"${t.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
function Cs(t, i) {
  let l = t;
  const s = [];
  for (const [o, g] of Object.entries(i)) {
    const w = new RegExp(`^${o}\\s*:.*$`, "m");
    w.test(l) ? l = l.replace(w, () => `${o}: ${vi(g)}`) : s.push(`${o}: ${vi(g)}`);
  }
  if (s.length) {
    const o = (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d+Z$/, "Z");
    l = `${l.replace(/\n*$/, `
`)}
# AI3D Forge values (set from the Nimbalyst panel, ${o})
${s.join(`
`)}
`;
  }
  return l;
}
Object.fromEntries(yt.map((t) => [t.id, t.label]));
function vt(t, i) {
  const l = Ei(i ?? ""), s = t.scores ?? {};
  let o = 0, g = 0;
  for (const w of yt) {
    const m = s[w.id];
    if (typeof m != "number") return null;
    o += l[w.id] * (m - 1) / 4, g += l[w.id];
  }
  return g ? Math.round(100 * o / g) : null;
}
function Dn({ value: t }) {
  return t == null ? /* @__PURE__ */ e("span", { className: "a3d-muted", children: "not scored" }) : /* @__PURE__ */ a("span", { className: "a3d-scorebar", title: `${t} of 100`, children: [
    /* @__PURE__ */ e("span", { className: "a3d-track", children: /* @__PURE__ */ e("i", { style: { width: `${t}%` } }) }),
    /* @__PURE__ */ e("b", { children: t })
  ] });
}
function Ss({ s: t }) {
  const i = new Set(t.estimated ?? []);
  return /* @__PURE__ */ e("dl", { className: "a3d-dims", children: yt.map((l) => {
    const s = t.scores?.[l.id];
    return /* @__PURE__ */ a("div", { children: [
      /* @__PURE__ */ a("dt", { children: [
        l.label,
        i.has(l.id) ? /* @__PURE__ */ e("span", { className: "a3d-muted", title: "estimated, no source", children: " ~" }) : null
      ] }),
      /* @__PURE__ */ a("dd", { children: [
        /* @__PURE__ */ e("span", { className: "a3d-dimbar", "aria-hidden": "true", children: [1, 2, 3, 4, 5].map((o) => /* @__PURE__ */ e("i", { className: typeof s == "number" && o <= s ? "on" : "" }, o)) }),
        /* @__PURE__ */ e("span", { children: typeof s == "number" ? `${s} / 5` : "–" })
      ] })
    ] }, l.id);
  }) });
}
const js = ["animal", "character", "object", "other"], yi = /\.(png|jpe?g|webp|gif)$/i;
function Ds({ onCancel: t, onCreate: i }) {
  const [l, s] = A(""), [o, g] = A("animal"), [w, m] = A(""), C = (k) => {
    l.trim() && i(l.trim(), o, w.trim(), k);
  };
  return /* @__PURE__ */ e("div", { className: "a3d-overlay", onClick: t, children: /* @__PURE__ */ a("form", { className: "a3d-dialog a3d-dialog-wide", onClick: (k) => k.stopPropagation(), onSubmit: (k) => {
    k.preventDefault(), C(!0);
  }, children: [
    /* @__PURE__ */ e("h3", { children: "New idea" }),
    /* @__PURE__ */ e("p", { className: "a3d-muted", children: "An animal, a character or a thing you want to turn into a model. It is saved in insights/ at once; preparing it is an agent run." }),
    /* @__PURE__ */ a("label", { children: [
      "Name",
      /* @__PURE__ */ e("input", { autoFocus: !0, value: l, onChange: (k) => s(k.target.value), placeholder: "Axolotl dragon" })
    ] }),
    /* @__PURE__ */ a("label", { children: [
      "Kind",
      /* @__PURE__ */ e("select", { value: o, onChange: (k) => g(k.target.value), children: js.map((k) => /* @__PURE__ */ e("option", { children: k }, k)) })
    ] }),
    /* @__PURE__ */ a("label", { children: [
      "What you have in mind",
      /* @__PURE__ */ e("textarea", { rows: 4, value: w, onChange: (k) => m(k.target.value), placeholder: "Chibi axolotl with small dragon wings, flexi, about 12 cm, for kids." })
    ] }),
    /* @__PURE__ */ a("span", { className: "a3d-row a3d-row-end", children: [
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: t, children: "Cancel" }),
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", disabled: !l.trim(), onClick: () => C(!1), children: "Save only" }),
      /* @__PURE__ */ e("button", { type: "submit", className: "a3d-btn a3d-btn-primary", disabled: !l.trim(), children: "Save and prepare (Muse)" })
    ] })
  ] }) });
}
function Ut({ n: t, title: i, state: l, text: s, running: o, children: g }) {
  return /* @__PURE__ */ a("li", { className: `a3d-stage a3d-stage-${l}`, children: [
    /* @__PURE__ */ a("span", { className: "a3d-stage-top", children: [
      /* @__PURE__ */ e("span", { className: "a3d-stage-n", children: l === "done" ? "✓" : t }),
      /* @__PURE__ */ e("strong", { children: i }),
      o ? /* @__PURE__ */ e("span", { className: "a3d-tag a3d-tag-run", children: "running" }) : l === "next" ? /* @__PURE__ */ e("span", { className: "a3d-tag a3d-tag-waiting", children: "next" }) : null
    ] }),
    /* @__PURE__ */ e("span", { className: "a3d-muted a3d-small", children: s }),
    /* @__PURE__ */ e("span", { className: "a3d-row", children: g })
  ] });
}
function As({ host: t, scan: i, selected: l, running: s, onSelect: o, onCreate: g, onAgent: w, onDecide: m, onRef: C, onRemoveRef: k, onPickImage: S, onZoom: f, onSelectTrend: x, onSelectModel: L, onReveal: M, onOpen: B }) {
  const [I, F] = A("open"), [p, O] = A(!1), [T, _] = A(""), [v, E] = A(""), [b, j] = A(""), h = i.config.score_weights, d = je(() => i.ideas.filter((N) => I === "all" || !["no", "modeled"].includes(N.status)).sort((N, ne) => (ne.updated_at ?? "").localeCompare(N.updated_at ?? "")), [i.ideas, I]), c = i.ideas.find((N) => N.slug === l) ?? d[0] ?? null, V = c?.trend ? i.trends.find((N) => N.slug === c.trend) : null, Y = c?.model ? i.models.find((N) => N.slug === c.model) : null, Q = c?.references ?? [], ae = new Set(Q.map((N) => (N.file ?? "").replace(/^refs\//, "")).filter(Boolean)), X = (c?._refs ?? []).filter((N) => yi.test(N) && !ae.has(N)), me = [
    ...Q.map((N, ne) => ({ r: N, n: ne })).filter((N) => N.r.file && yi.test(N.r.file)).map((N) => ({ file: N.r.file.replace(/^refs\//, ""), title: N.r.title, note: N.r.note, url: N.r.url, n: N.n })),
    ...X.map((N) => ({ file: N, title: N, note: void 0, url: void 0, n: null }))
  ], Oe = Q.map((N, ne) => ({ r: N, n: ne })).filter((N) => N.r.url), Ne = (c?.evidence ?? []).filter((N) => N.label || N.url), R = !!c && (c.status !== "draft" || (c.traits ?? []).length > 0 || (c.variants ?? []).length > 0), G = !!c && Object.keys(c.scores ?? {}).length > 0, q = !!c?.decision, fe = !!Y || c?.status === "modeled", ce = [R, G, q, fe], Be = ce.indexOf(!1), xe = (N) => ce[N] ? "done" : N === Be ? "next" : "todo", Xe = (N) => !!c && s.some((ne) => ne.startsWith(N) && ne.includes(c.title)), rt = /^https?:\/\/\S+$/i.test(T.trim());
  return /* @__PURE__ */ a("section", { className: "a3d-trends", children: [
    /* @__PURE__ */ a("header", { className: "a3d-head", children: [
      /* @__PURE__ */ a("div", { children: [
        /* @__PURE__ */ e("h1", { children: "Insights" }),
        /* @__PURE__ */ e("p", { className: "a3d-muted", children: "An idea goes through four stages: prepare (traits, references from the web, variants, market, IP), score, decide, create the model. You can create the model at any stage." })
      ] }),
      /* @__PURE__ */ e("span", { className: "a3d-row", children: /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-primary", onClick: () => O(!0), children: "New idea…" }) })
    ] }),
    /* @__PURE__ */ a("div", { className: "a3d-split", children: [
      /* @__PURE__ */ a("aside", { className: "a3d-split-list", children: [
        /* @__PURE__ */ a("span", { className: "a3d-seg a3d-seg-small", role: "group", "aria-label": "Filter", children: [
          /* @__PURE__ */ e("button", { type: "button", "aria-pressed": I === "open", onClick: () => F("open"), children: "Open" }),
          /* @__PURE__ */ e("button", { type: "button", "aria-pressed": I === "all", onClick: () => F("all"), children: "All" })
        ] }),
        d.length === 0 && /* @__PURE__ */ e("p", { className: "a3d-muted", children: "No ideas yet. Add one, or “Prepare” an idea from a trend." }),
        /* @__PURE__ */ e("ul", { children: d.map((N) => /* @__PURE__ */ e("li", { children: /* @__PURE__ */ a("button", { type: "button", className: N.slug === c?.slug ? "a3d-li a3d-li-sel" : "a3d-li", onClick: () => o(N.slug), children: [
          /* @__PURE__ */ a("span", { className: "a3d-li-title", children: [
            N.title,
            " ",
            /* @__PURE__ */ e("span", { className: `a3d-pill a3d-is-${N.status}`, children: N.status })
          ] }),
          /* @__PURE__ */ a("span", { className: "a3d-muted", children: [
            N.subject_kind,
            N.trend ? ` · from ${i.trends.find((ne) => ne.slug === N.trend)?.title ?? N.trend}` : ""
          ] }),
          /* @__PURE__ */ e(Dn, { value: vt(N, h) })
        ] }) }, N.slug)) })
      ] }),
      c ? /* @__PURE__ */ a("article", { className: "a3d-split-detail", children: [
        /* @__PURE__ */ a("header", { className: "a3d-detail-top", children: [
          /* @__PURE__ */ a("div", { children: [
            /* @__PURE__ */ a("h2", { className: "a3d-h2", children: [
              c.title,
              " ",
              /* @__PURE__ */ e("span", { className: `a3d-pill a3d-is-${c.status}`, children: c.status }),
              c.subject_kind && /* @__PURE__ */ e("span", { className: "a3d-pill", children: c.subject_kind })
            ] }),
            /* @__PURE__ */ a("p", { className: "a3d-muted", children: [
              V ? /* @__PURE__ */ a(te, { children: [
                "From trend ",
                /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: () => x(V.slug), children: V.title }),
                " · "
              ] }) : null,
              c.description || "No description yet."
            ] })
          ] }),
          /* @__PURE__ */ a("span", { className: "a3d-row", children: [
            c._files.includes("brief.md") && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => B(`${c._dir}/brief.md`), children: "Open brief" }),
            /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => M(c._dir), children: "Show in Finder" })
          ] })
        ] }),
        /* @__PURE__ */ a("ol", { className: "a3d-stages", "aria-label": "Stages of this idea", children: [
          /* @__PURE__ */ e(
            Ut,
            {
              n: 1,
              title: "Prepare",
              state: xe(0),
              running: Xe("Prepare") || Xe("References"),
              text: R ? `${(c.traits ?? []).length} traits · ${Q.length + X.length} references · ${(c.variants ?? []).length} variants` : "Muse searches the web, collects references, traits, variants, similar models and the IP risk, and writes the brief.",
              children: /* @__PURE__ */ e(
                "button",
                {
                  type: "button",
                  className: xe(0) === "next" ? "a3d-btn a3d-btn-primary" : "a3d-btn",
                  onClick: () => w("prepare", c),
                  title: "Agent run: ai3d-muse *prepare",
                  children: R ? "Prepare again" : "Prepare (Muse)"
                }
              )
            }
          ),
          /* @__PURE__ */ e(
            Ut,
            {
              n: 2,
              title: "Score",
              state: xe(1),
              running: Xe("Score"),
              text: G ? `Total ${vt(c, h) ?? "–"} of 100 with your weights.` : "Prism scores demand, print fit, stand-out, IP safety and ease, with evidence.",
              children: /* @__PURE__ */ e("button", { type: "button", className: xe(1) === "next" ? "a3d-btn a3d-btn-primary" : "a3d-btn", onClick: () => w("score", c), title: "Agent run: ai3d-prism *score insight", children: G ? "Score again" : "Score (Prism)" })
            }
          ),
          /* @__PURE__ */ e(
            Ut,
            {
              n: 3,
              title: "Decide",
              state: xe(2),
              text: c.decision ? `Decided ${c.decision.verdict}${c.decision.reason ? `: ${c.decision.reason}` : ""}.` : "Your call. It only marks the idea; nothing is deleted.",
              children: ["go", "later", "no"].map((N) => /* @__PURE__ */ e(
                "button",
                {
                  type: "button",
                  className: "a3d-btn a3d-btn-small",
                  "aria-pressed": c.decision?.verdict === N,
                  disabled: c.status === "modeled",
                  onClick: () => m(c, N),
                  title: `Runs: trend_lib.py decide <idea folder> ${N}`,
                  children: N === "go" ? "Go" : N === "later" ? "Later" : "No"
                },
                N
              ))
            }
          ),
          /* @__PURE__ */ e(
            Ut,
            {
              n: 4,
              title: "Model",
              state: xe(3),
              running: Xe("New model"),
              text: Y ? "The model exists; work on it in Flow." : R ? "Muse writes the concept from the brief and creates the model folder, linked to this idea." : "Possible now: Muse works from the description only. Preparing first gives it references and a variant.",
              children: Y ? /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-primary", onClick: () => L(Y.slug), children: "Open model" }) : /* @__PURE__ */ e(
                "button",
                {
                  type: "button",
                  className: xe(3) === "next" || c.decision?.verdict === "go" ? "a3d-btn a3d-btn-primary" : "a3d-btn",
                  onClick: () => w("concept", c),
                  title: "Agent run: ai3d-muse *concept with this idea",
                  children: "Create model"
                }
              )
            }
          )
        ] }),
        /* @__PURE__ */ a("section", { className: "a3d-block", children: [
          /* @__PURE__ */ a("h4", { children: [
            "References ",
            /* @__PURE__ */ e("span", { className: "a3d-count", children: Q.length + X.length })
          ] }),
          /* @__PURE__ */ a("p", { className: "a3d-muted a3d-small", children: [
            "Pictures and pages Muse and Lumen work from. Found on the web by Muse, or added by you. Pictures are saved in the idea’s ",
            /* @__PURE__ */ e("code", { children: "refs/" }),
            " folder."
          ] }),
          /* @__PURE__ */ a("form", { className: "a3d-row a3d-refbar", onSubmit: (N) => {
            N.preventDefault(), w("refs", c, b.trim() || void 0), j("");
          }, children: [
            /* @__PURE__ */ e("input", { className: "a3d-in-grow", "aria-label": "What to look for", placeholder: "What to look for (optional): side view, chibi style, printed flexi versions…", value: b, onChange: (N) => j(N.target.value) }),
            /* @__PURE__ */ e("button", { type: "submit", className: "a3d-btn a3d-btn-primary", title: "Agent run: ai3d-muse *refs — web search for pages and pictures, saved with trend_lib.py ref", children: "Find on the web (Muse)" })
          ] }),
          /* @__PURE__ */ a("form", { className: "a3d-row a3d-refbar", onSubmit: (N) => {
            N.preventDefault(), rt && (C(c, { url: T.trim(), note: v.trim() || void 0 }), _(""), E(""));
          }, children: [
            /* @__PURE__ */ e("input", { className: "a3d-in-grow", "aria-label": "Link", placeholder: "Paste a link to a page or a picture (https://…)", value: T, onChange: (N) => _(N.target.value) }),
            /* @__PURE__ */ e("input", { className: "a3d-in-small", "aria-label": "Note", placeholder: "note", value: v, onChange: (N) => E(N.target.value) }),
            /* @__PURE__ */ e("button", { type: "submit", className: "a3d-btn", disabled: !rt, title: "Runs: trend_lib.py ref <idea folder> --url … (a picture link is downloaded into refs/)", children: "Add link" }),
            /* @__PURE__ */ e(
              "button",
              {
                type: "button",
                className: "a3d-btn",
                title: "Runs: trend_lib.py ref <idea folder> --file …",
                onClick: async () => {
                  const N = await S();
                  for (const ne of N ?? []) C(c, { file: ne });
                },
                children: "Add picture…"
              }
            )
          ] }),
          me.length > 0 && /* @__PURE__ */ e("div", { className: "a3d-gallery", children: me.map((N) => {
            const ne = `${c._dir}/refs/${N.file}`;
            return /* @__PURE__ */ a("figure", { children: [
              /* @__PURE__ */ e(Fe, { host: t, path: ne, mtime: c._mtime, alt: N.title || N.file, onClick: () => f({ path: ne, mtime: c._mtime, name: N.title || N.file }) }),
              /* @__PURE__ */ e("figcaption", { title: N.note, children: N.note || N.title || N.file })
            ] }, N.file);
          }) }),
          Oe.length > 0 && /* @__PURE__ */ e("ul", { className: "a3d-reflist", children: Oe.map(({ r: N, n: ne }) => /* @__PURE__ */ a("li", { children: [
            /* @__PURE__ */ e("a", { href: N.url, target: "_blank", rel: "noreferrer", children: N.title || N.url }),
            N.file ? /* @__PURE__ */ e("span", { className: "a3d-pill", children: "picture saved" }) : null,
            N.note ? /* @__PURE__ */ a("span", { className: "a3d-muted", children: [
              " — ",
              N.note
            ] }) : null,
            /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", "aria-label": `Remove reference ${N.title || N.url}`, onClick: () => k(c, ne + 1), children: "remove" })
          ] }, ne)) }),
          me.length === 0 && Oe.length === 0 && /* @__PURE__ */ e("p", { className: "a3d-muted", children: "No references yet. “Find on the web” searches for the real subject, the style and existing printed models." })
        ] }),
        /* @__PURE__ */ a("div", { className: "a3d-two", children: [
          /* @__PURE__ */ a("section", { className: "a3d-block", children: [
            /* @__PURE__ */ e("h4", { children: "Recognisable traits" }),
            (c.traits ?? []).length ? /* @__PURE__ */ e("p", { className: "a3d-chips", children: c.traits.map((N) => /* @__PURE__ */ e("span", { className: "a3d-pill", children: N }, N)) }) : /* @__PURE__ */ e("p", { className: "a3d-muted", children: "Filled by Prepare: the 3–6 features that must survive at print size." }),
            /* @__PURE__ */ e("h4", { children: "IP risk" }),
            /* @__PURE__ */ a("p", { children: [
              /* @__PURE__ */ e("span", { className: `a3d-pill a3d-risk-${c.ip?.risk ?? "unknown"}`, children: c.ip?.risk ?? "not assessed" }),
              " ",
              c.ip?.notes
            ] })
          ] }),
          /* @__PURE__ */ a("section", { className: "a3d-block", children: [
            /* @__PURE__ */ a("h4", { children: [
              "Scores ",
              /* @__PURE__ */ e(Dn, { value: vt(c, h) })
            ] }),
            G ? /* @__PURE__ */ e(Ss, { s: c }) : /* @__PURE__ */ e("p", { className: "a3d-muted", children: "Not scored yet." }),
            Ne.length > 0 && /* @__PURE__ */ e("ul", { className: "a3d-evidence", children: Ne.map((N, ne) => /* @__PURE__ */ e("li", { children: N.url ? /* @__PURE__ */ e("a", { href: N.url, target: "_blank", rel: "noreferrer", children: N.label || N.url }) : N.label }, ne)) })
          ] })
        ] }),
        (c.variants ?? []).length > 0 && /* @__PURE__ */ a("section", { className: "a3d-block", children: [
          /* @__PURE__ */ e("h4", { children: "Variants" }),
          /* @__PURE__ */ a("table", { className: "a3d-filetable", children: [
            /* @__PURE__ */ e("thead", { children: /* @__PURE__ */ a("tr", { children: [
              /* @__PURE__ */ e("th", {}),
              /* @__PURE__ */ e("th", { children: "Type" }),
              /* @__PURE__ */ e("th", { children: "Style" }),
              /* @__PURE__ */ e("th", { children: "Size" }),
              /* @__PURE__ */ e("th", { children: "Printability" }),
              /* @__PURE__ */ e("th", { children: "Notes" })
            ] }) }),
            /* @__PURE__ */ e("tbody", { children: c.variants.map((N) => /* @__PURE__ */ a("tr", { children: [
              /* @__PURE__ */ e("td", { children: c.chosen_variant === N.id ? /* @__PURE__ */ e("span", { className: "a3d-pill a3d-pill-done", children: "chosen" }) : N.id }),
              /* @__PURE__ */ e("td", { children: N.model_type }),
              /* @__PURE__ */ e("td", { children: N.style }),
              /* @__PURE__ */ e("td", { className: "a3d-num", children: N.size_mm ? `${N.size_mm} mm` : "" }),
              /* @__PURE__ */ e("td", { className: "a3d-num", children: N.printability != null ? `${N.printability} / 5` : "" }),
              /* @__PURE__ */ e("td", { children: N.notes })
            ] }, N.id)) })
          ] })
        ] }),
        (c.similar ?? []).length > 0 && /* @__PURE__ */ a("section", { className: "a3d-block", children: [
          /* @__PURE__ */ e("h4", { children: "Already on the market" }),
          /* @__PURE__ */ a("table", { className: "a3d-filetable", children: [
            /* @__PURE__ */ e("thead", { children: /* @__PURE__ */ a("tr", { children: [
              /* @__PURE__ */ e("th", { children: "Model" }),
              /* @__PURE__ */ e("th", { children: "Downloads" }),
              /* @__PURE__ */ e("th", { children: "Price" }),
              /* @__PURE__ */ e("th", { children: "Note" })
            ] }) }),
            /* @__PURE__ */ e("tbody", { children: c.similar.map((N, ne) => /* @__PURE__ */ a("tr", { children: [
              /* @__PURE__ */ e("td", { children: N.url ? /* @__PURE__ */ e("a", { href: N.url, target: "_blank", rel: "noreferrer", children: N.title || N.url }) : N.title }),
              /* @__PURE__ */ e("td", { className: "a3d-num", children: N.downloads ?? "" }),
              /* @__PURE__ */ e("td", { className: "a3d-num", children: N.price ?? "" }),
              /* @__PURE__ */ e("td", { children: N.note })
            ] }, ne)) })
          ] })
        ] })
      ] }) : /* @__PURE__ */ e("div", { className: "a3d-placeholder", children: "Add an idea to prepare it." })
    ] }),
    p && /* @__PURE__ */ e(Ds, { onCancel: () => O(!1), onCreate: (...N) => {
      O(!1), g(...N);
    } })
  ] });
}
function Fi({ host: t, path: i, mtime: l, title: s }) {
  const [o, g] = A(null), [w, m] = A(null);
  ke(() => {
    let k = !0;
    return m(null), t.exec(`cat ${$(i)}`, { timeout: 2e4, maxBuffer: 3e7 }).then((S) => {
      k && (S.success ? g(S.stdout) : m(S.stderr.trim() || "Could not read the dashboard."));
    }), () => {
      k = !1;
    };
  }, [t, i, l]);
  const C = /dark/i.test(t.theme);
  return w ? /* @__PURE__ */ e("p", { className: "a3d-banner a3d-banner-error", children: w }) : o ? /* @__PURE__ */ e(
    "iframe",
    {
      className: "a3d-dash-frame",
      title: s,
      sandbox: "allow-scripts",
      srcDoc: o.replace('<html lang="en">', `<html lang="en" data-theme="${C ? "dark" : "light"}">`)
    }
  ) : /* @__PURE__ */ e("p", { className: "a3d-muted", children: "Loading the dashboard…" });
}
function Rs({ host: t, scan: i, stepsBySlug: l, selected: s, onSelect: o, onNew: g, onScout: w, onPortfolio: m, onSelectTrend: C }) {
  const [k, S] = A("cards"), f = i.dashboards.find((p) => p.name === "portfolio.html"), x = i.models, L = (p) => (l[p] ?? []).find((O) => O.state === "active" || O.state === "waiting") ?? null, M = x.map((p) => ({ m: p, s: L(p.slug) })).filter((p) => p.s?.state === "waiting"), I = [
    ...(l[x[0]?.slug ?? ""] ?? []).map((p) => ({ id: p.id, title: p.title, items: x.map((O) => ({ m: O, s: L(O.slug) })).filter((O) => O.s?.id === p.id) })),
    { id: "done", title: "Done", items: x.map((p) => ({ m: p, s: L(p.slug) })).filter((p) => !p.s) }
  ], F = x.filter((p) => (l[p.slug] ?? []).some((O) => O.state === "waiting")).length;
  return /* @__PURE__ */ a("section", { className: "a3d-models-tab", children: [
    /* @__PURE__ */ a("header", { className: "a3d-head", children: [
      /* @__PURE__ */ a("div", { children: [
        /* @__PURE__ */ e("h1", { children: "Models" }),
        /* @__PURE__ */ a("p", { className: "a3d-muted", children: [
          x.length,
          " model",
          x.length === 1 ? "" : "s",
          " in ",
          /* @__PURE__ */ e("code", { children: i.root.startsWith(i.workspace) ? i.root.slice(i.workspace.length + 1) || "." : i.root }),
          F > 0 ? ` · ${F} waiting for you` : "",
          ". Pick one: Flow and Files follow it."
        ] })
      ] }),
      /* @__PURE__ */ a("span", { className: "a3d-row", children: [
        /* @__PURE__ */ a("span", { className: "a3d-seg", role: "group", "aria-label": "View", children: [
          /* @__PURE__ */ e("button", { type: "button", "aria-pressed": k === "cards", onClick: () => S("cards"), children: "Cards" }),
          /* @__PURE__ */ e("button", { type: "button", "aria-pressed": k === "board", onClick: () => S("board"), children: "Board" }),
          /* @__PURE__ */ e("button", { type: "button", "aria-pressed": k === "portfolio", onClick: () => S("portfolio"), children: "Portfolio" })
        ] }),
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: w, children: "Trends" }),
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-primary", onClick: g, children: "New model" })
      ] })
    ] }),
    M.length > 0 && k !== "portfolio" && /* @__PURE__ */ a("section", { className: "a3d-queue", "aria-label": "Waiting for you", children: [
      /* @__PURE__ */ a("h3", { children: [
        "Waiting for you ",
        /* @__PURE__ */ e("span", { className: "a3d-count", children: M.length })
      ] }),
      /* @__PURE__ */ e("ul", { children: M.map(({ m: p, s: O }) => /* @__PURE__ */ e("li", { children: /* @__PURE__ */ a("button", { type: "button", className: "a3d-queue-item", onClick: () => o(p.slug), children: [
        /* @__PURE__ */ e("strong", { children: p.meta.title || p.slug }),
        /* @__PURE__ */ a("span", { className: "a3d-muted", children: [
          "Step ",
          O.n,
          " · ",
          O.title,
          ": ",
          O.hint
        ] })
      ] }) }, p.slug)) })
    ] }),
    k === "board" && /* @__PURE__ */ e("section", { className: "a3d-board", "aria-label": "Board", children: I.map((p) => /* @__PURE__ */ a("div", { className: "a3d-board-col", children: [
      /* @__PURE__ */ a("h4", { children: [
        p.title,
        " ",
        /* @__PURE__ */ e("span", { className: "a3d-count", children: p.items.length })
      ] }),
      p.items.map(({ m: O, s: T }) => /* @__PURE__ */ a("button", { type: "button", className: O.slug === s ? "a3d-board-card a3d-card-selected" : "a3d-board-card", onClick: () => o(O.slug), children: [
        /* @__PURE__ */ e("strong", { children: O.meta.title || O.slug }),
        /* @__PURE__ */ e("span", { className: "a3d-muted", children: T?.state === "waiting" ? "your turn" : O.flow.nodes.some((_) => _.status === "running") ? "running" : T ? "next" : O.meta.status ?? "" })
      ] }, O.slug))
    ] }, p.id)) }),
    k === "portfolio" && /* @__PURE__ */ a("section", { className: "a3d-block", children: [
      /* @__PURE__ */ a("p", { className: "a3d-row", children: [
        /* @__PURE__ */ e("span", { className: "a3d-muted", children: "Charts across every model: pipeline, overhang before and after, size, rounds spent." }),
        /* @__PURE__ */ e("span", { className: "a3d-tabs-spacer" }),
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", disabled: !i.tools.buildInsights, onClick: m, children: f ? "Rebuild" : "Build" })
      ] }),
      f ? /* @__PURE__ */ e(Fi, { host: t, path: `${i.root}/_insights/portfolio.html`, mtime: f.mtime, title: "Portfolio" }) : /* @__PURE__ */ e("p", { className: "a3d-muted", children: "Not built yet." })
    ] }),
    k === "cards" && x.length === 0 && /* @__PURE__ */ a("p", { className: "a3d-empty", children: [
      i.rootExists ? "No models yet." : `Folder not found: ${i.root}`,
      /* @__PURE__ */ e("br", {}),
      "Start with Scout to pick a subject, or New model if you already have an idea."
    ] }),
    k === "cards" && /* @__PURE__ */ e("ul", { className: "a3d-cards", children: x.map((p) => {
      const O = l[p.slug] ?? [], T = O.find((h) => h.state === "active" || h.state === "waiting"), _ = O.filter((h) => h.state === "done").length, v = ["renders", "images", "inbox"].map((h) => ({ folder: h, f: ue(p.files[h])[0] })).find((h) => h.f), E = p.flow.nodes.some((h) => h.status === "running"), b = p.files.mesh.filter((h) => /\.(stl|glb|gltf|obj|fbx)$/i.test(h.name)).length + p.attempts.length + p.files.print.filter((h) => /\.3mf$/i.test(h.name)).length, j = ue(p.files.inbox).length + ue(p.files.images).length + ue(p.files.renders).length;
      return /* @__PURE__ */ e("li", { children: /* @__PURE__ */ a("button", { type: "button", className: p.slug === s ? "a3d-card a3d-card-selected" : "a3d-card", "aria-pressed": p.slug === s, onClick: () => o(p.slug), children: [
        /* @__PURE__ */ e("span", { className: "a3d-card-thumb", children: v ? /* @__PURE__ */ e(Fe, { host: t, path: `${p.dir}/${v.folder}/${v.f.name}`, mtime: v.f.mtime, alt: "" }) : /* @__PURE__ */ e("span", { className: "a3d-muted", children: "no image yet" }) }),
        /* @__PURE__ */ a("span", { className: "a3d-card-body", children: [
          /* @__PURE__ */ a("span", { className: "a3d-card-title", children: [
            p.meta.title || p.slug,
            E ? /* @__PURE__ */ e("span", { className: "a3d-tag a3d-tag-run", children: "running" }) : T?.state === "waiting" ? /* @__PURE__ */ e("span", { className: "a3d-tag a3d-tag-waiting", children: "your turn" }) : null
          ] }),
          /* @__PURE__ */ e("span", { className: "a3d-muted", children: [p.meta.model_type, p.meta.status].filter(Boolean).join(" · ") || "no metadata" }),
          /* @__PURE__ */ e("span", { className: "a3d-card-step", children: T ? `Step ${T.n} of ${O.length} · ${T.title}` : `${_} of ${O.length} done` }),
          /* @__PURE__ */ e("span", { className: "a3d-progress", "aria-hidden": "true", children: O.map((h) => /* @__PURE__ */ e("i", { className: `a3d-pip a3d-${h.state}` }, h.id)) }),
          p.meta.origin?.trend && /* @__PURE__ */ a("span", { className: "a3d-card-origin", children: [
            "from ",
            /* @__PURE__ */ e(
              "span",
              {
                role: "link",
                tabIndex: 0,
                className: "a3d-link",
                onClick: (h) => {
                  h.stopPropagation(), C(p.meta.origin.trend);
                },
                onKeyDown: (h) => {
                  h.key === "Enter" && (h.stopPropagation(), C(p.meta.origin.trend));
                },
                children: i.trends.find((h) => h.slug === p.meta.origin.trend)?.title ?? p.meta.origin.trend
              }
            )
          ] }),
          /* @__PURE__ */ a("span", { className: "a3d-muted a3d-card-counts", children: [
            j,
            " image",
            j === 1 ? "" : "s",
            " · ",
            b,
            " 3D file",
            b === 1 ? "" : "s",
            " · ",
            p.flow.nodes.length,
            " attempt",
            p.flow.nodes.length === 1 ? "" : "s",
            (() => {
              const h = (p.branches ?? []).filter((d) => d.status !== "archived").length;
              return h > 1 ? ` · ${h} branches` : "";
            })()
          ] })
        ] })
      ] }) }, p.slug);
    }) })
  ] });
}
const kn = { trend: "Trend", similar: "Similar model", season: "Season" }, wt = (t) => t ? (/* @__PURE__ */ new Date(`${t.slice(0, 10)}T12:00:00`)).toLocaleDateString([], { month: "short", day: "numeric" }) : "", An = (t) => t === 0 ? "today" : t > 0 ? `in ${t} day${t === 1 ? "" : "s"}` : `${-t} day${t === -1 ? "" : "s"} ago`;
function Ps({ events: t, trends: i, onSeason: l }) {
  const s = t.filter((o) => o.days_left >= 0).slice(0, 6);
  return s.length ? /* @__PURE__ */ e("section", { className: "a3d-cal", "aria-label": "Upcoming events", children: s.map((o) => {
    const g = i.find((m) => m.kind === "season" && m.event?.date === o.date && (m.event?.name ?? "").toLowerCase().startsWith(o.name.toLowerCase().slice(0, 8))), w = o.days_to_publish < 0;
    return /* @__PURE__ */ a(
      "button",
      {
        type: "button",
        className: w ? "a3d-cal-item a3d-cal-late" : o.days_to_publish <= 14 ? "a3d-cal-item a3d-cal-soon" : "a3d-cal-item",
        onClick: () => l(o.name),
        title: w ? "The usual publish-by date has passed: only quick, simple models still make it." : "Analyse what to make for this event",
        children: [
          /* @__PURE__ */ e("strong", { children: o.name }),
          /* @__PURE__ */ a("span", { children: [
            wt(o.date),
            " · ",
            An(o.days_left)
          ] }),
          /* @__PURE__ */ e("span", { className: "a3d-cal-pub", children: w ? `publish-by passed ${-o.days_to_publish} d ago` : `publish by ${wt(o.publish_by)} (${An(o.days_to_publish)})` }),
          g && /* @__PURE__ */ e("span", { className: "a3d-pill a3d-pill-done", children: "analysed" })
        ]
      },
      o.id
    );
  }) }) : null;
}
function Bs({ host: t, scan: i, busy: l, apify: s, selected: o, onSelectTrend: g, onAgent: w, onSet: m, onPrepare: C, onCreateModel: k, onSelectModel: S, onSelectIdea: f, onReveal: x, onOpen: L }) {
  const [M, B] = A("all"), [I, F] = A(!1), [p, O] = A(!1), T = je(() => i.trends.filter((d) => (M === "all" || d.kind === M) && (I || d.status !== "dropped")).sort((d, c) => (c.updated_at ?? "").localeCompare(d.updated_at ?? "")), [i.trends, M, I]), _ = i.trends.find((d) => d.slug === o) ?? T[0] ?? null, v = (d) => i.models.filter((c) => c.meta.origin?.trend === d), E = i.config.score_weights, b = !!_?._files.includes("dashboard.html"), j = _ ? [..._.ideas].sort((d, c) => (vt(c, E) ?? -1) - (vt(d, E) ?? -1)) : [], h = (d) => d.meta.status ?? "concept";
  return /* @__PURE__ */ a("section", { className: "a3d-trends", children: [
    /* @__PURE__ */ a("header", { className: "a3d-head", children: [
      /* @__PURE__ */ a("div", { children: [
        /* @__PURE__ */ e("h1", { children: "Trends" }),
        /* @__PURE__ */ a("p", { className: "a3d-muted", children: [
          "What sells now, what to make like an existing model, what to make for a date. Scout researches; ideas go to Insights or straight to a model.",
          " ",
          /* @__PURE__ */ e("span", { className: s ? "a3d-pill a3d-pill-done" : "a3d-pill", title: s ? `registered in ${s}` : "Not found in the Claude Code config: Scout falls back to web search.", children: s ? "Apify connected" : "Apify not registered" })
        ] })
      ] }),
      /* @__PURE__ */ a("span", { className: "a3d-row", children: [
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-primary", disabled: l, onClick: () => w("trend", null), children: "Analyse trend…" }),
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-primary", disabled: l, onClick: () => w("similar", null), children: "Similar model…" }),
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", disabled: l, onClick: () => w("season", null), children: "Season…" }),
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", disabled: l || !i.trends.some((d) => d.status === "watching"), onClick: () => w("watch", null), children: "Re-check watched" })
      ] })
    ] }),
    /* @__PURE__ */ e(Ps, { events: i.calendar, trends: i.trends, onSeason: (d) => w("season", null, d) }),
    /* @__PURE__ */ a("div", { className: "a3d-split", children: [
      /* @__PURE__ */ a("aside", { className: "a3d-split-list", children: [
        /* @__PURE__ */ e("span", { className: "a3d-seg a3d-seg-small", role: "group", "aria-label": "Kind", children: ["all", "trend", "similar", "season"].map((d) => /* @__PURE__ */ e("button", { type: "button", "aria-pressed": M === d, onClick: () => B(d), children: d === "all" ? "All" : kn[d] }, d)) }),
        /* @__PURE__ */ a("label", { className: "a3d-check", children: [
          /* @__PURE__ */ e("input", { type: "checkbox", checked: I, onChange: (d) => F(d.target.checked) }),
          " show dropped"
        ] }),
        T.length === 0 && /* @__PURE__ */ e("p", { className: "a3d-muted", children: "No trends yet. Analyse one, or click an event above." }),
        /* @__PURE__ */ e("ul", { children: T.map((d) => /* @__PURE__ */ e("li", { children: /* @__PURE__ */ a("button", { type: "button", className: d.slug === _?.slug ? "a3d-li a3d-li-sel" : "a3d-li", onClick: () => {
          g(d.slug), O(!1);
        }, children: [
          /* @__PURE__ */ e("span", { className: "a3d-li-title", children: d.title }),
          /* @__PURE__ */ a("span", { className: "a3d-muted", children: [
            kn[d.kind],
            " · ",
            d.status,
            " · ",
            d.ideas.length,
            " idea",
            d.ideas.length === 1 ? "" : "s",
            v(d.slug).length ? ` · ${v(d.slug).length} model${v(d.slug).length === 1 ? "" : "s"}` : ""
          ] })
        ] }) }, d.slug)) })
      ] }),
      _ ? /* @__PURE__ */ a("article", { className: "a3d-split-detail", children: [
        /* @__PURE__ */ a("header", { className: "a3d-detail-top", children: [
          /* @__PURE__ */ a("div", { children: [
            /* @__PURE__ */ a("h2", { className: "a3d-h2", children: [
              _.title,
              " ",
              /* @__PURE__ */ e("span", { className: "a3d-pill", children: kn[_.kind] }),
              _.saturation && /* @__PURE__ */ a("span", { className: `a3d-pill a3d-sat-${_.saturation}`, children: [
                "saturation: ",
                _.saturation
              ] })
            ] }),
            /* @__PURE__ */ a("p", { className: "a3d-muted", children: [
              _.query && _.query !== _.title ? `“${_.query}” · ` : "",
              "updated ",
              wt(_.updated_at)
            ] })
          ] }),
          /* @__PURE__ */ a("span", { className: "a3d-row", children: [
            /* @__PURE__ */ a("label", { className: "a3d-inline", children: [
              "Status",
              /* @__PURE__ */ e("select", { value: _.status, onChange: (d) => m(_, [`status=${d.target.value}`]), children: ["new", "watching", "used", "dropped"].map((d) => /* @__PURE__ */ e("option", { value: d, children: d }, d)) })
            ] }),
            _.status === "watching" && /* @__PURE__ */ a("label", { className: "a3d-inline", children: [
              "Re-check",
              /* @__PURE__ */ e("input", { type: "date", value: _.recheck_at ?? "", onChange: (d) => m(_, [`recheck_at=${d.target.value}`]) })
            ] })
          ] })
        ] }),
        _.summary ? /* @__PURE__ */ e("p", { className: "a3d-summary", children: _.summary }) : /* @__PURE__ */ e("p", { className: "a3d-muted", children: "No summary yet: Scout writes it when the analysis runs." }),
        _.kind === "season" && _.event?.date && /* @__PURE__ */ a("p", { className: "a3d-banner", children: [
          _.event.name,
          ": ",
          wt(_.event.date),
          ". Publish by ",
          wt(_.event.publish_by),
          _.event.publish_by ? ` (${An(Math.round((new Date(_.event.publish_by).getTime() - Date.now()) / 864e5))})` : "",
          "."
        ] }),
        _.kind === "similar" && /* @__PURE__ */ a("section", { className: "a3d-block", children: [
          /* @__PURE__ */ e("h4", { children: "Original model" }),
          /* @__PURE__ */ e("p", { children: _.source?.url ? /* @__PURE__ */ e("a", { href: _.source.url, target: "_blank", rel: "noreferrer", children: _.source.title || _.source.url }) : _.source?.title || _.source?.input || "—" }),
          /* @__PURE__ */ e("p", { className: "a3d-muted", children: [_.source?.license && `licence: ${_.source.license}`, _.source?.price != null && `price: ${_.source.price}`, _.source?.downloads != null && `downloads: ${_.source.downloads}`].filter(Boolean).join(" · ") || "Licence, price and downloads not read yet." }),
          _.ip && /* @__PURE__ */ a("div", { className: "a3d-ip", children: [
            /* @__PURE__ */ a("div", { children: [
              /* @__PURE__ */ e("h5", { children: "Can take" }),
              /* @__PURE__ */ e("ul", { children: (_.ip.can_take ?? []).map((d) => /* @__PURE__ */ e("li", { children: d }, d)) })
            ] }),
            /* @__PURE__ */ a("div", { children: [
              /* @__PURE__ */ e("h5", { children: "Must avoid" }),
              /* @__PURE__ */ e("ul", { children: (_.ip.must_avoid ?? []).map((d) => /* @__PURE__ */ e("li", { children: d }, d)) })
            ] }),
            /* @__PURE__ */ a("div", { children: [
              /* @__PURE__ */ e("h5", { children: "Risk" }),
              /* @__PURE__ */ e("span", { className: `a3d-pill a3d-risk-${_.ip.risk ?? "unknown"}`, children: _.ip.risk ?? "not assessed" })
            ] })
          ] })
        ] }),
        /* @__PURE__ */ a("section", { className: "a3d-block", children: [
          /* @__PURE__ */ a("h4", { children: [
            "Ideas ",
            /* @__PURE__ */ e("span", { className: "a3d-count", children: _.ideas.length }),
            /* @__PURE__ */ a("span", { className: "a3d-block-actions", children: [
              /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", disabled: l || !_.ideas.length, onClick: () => w("score", _), children: "Score ideas (Prism)" }),
              b && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", "aria-pressed": p, onClick: () => O((d) => !d), children: "Dashboard" })
            ] })
          ] }),
          p && b && /* @__PURE__ */ e(Fi, { host: t, path: `${_._dir}/dashboard.html`, mtime: _._mtime, title: `${_.title} ideas` }),
          j.length === 0 ? /* @__PURE__ */ e("p", { className: "a3d-muted", children: "No ideas yet." }) : /* @__PURE__ */ a("table", { className: "a3d-filetable a3d-ideas", children: [
            /* @__PURE__ */ e("thead", { children: /* @__PURE__ */ a("tr", { children: [
              /* @__PURE__ */ e("th", { children: "Idea" }),
              /* @__PURE__ */ e("th", { children: "Type" }),
              /* @__PURE__ */ e("th", { children: "Score" }),
              /* @__PURE__ */ e("th", { children: "Status" }),
              /* @__PURE__ */ e("th", { children: /* @__PURE__ */ e("span", { className: "a3d-sr", children: "Actions" }) })
            ] }) }),
            /* @__PURE__ */ e("tbody", { children: j.map((d) => {
              const c = d.model ? i.models.find((V) => V.slug === d.model) : null;
              return /* @__PURE__ */ a("tr", { children: [
                /* @__PURE__ */ a("td", { children: [
                  /* @__PURE__ */ e("strong", { children: d.name }),
                  d.pitch && /* @__PURE__ */ e("div", { className: "a3d-muted", children: d.pitch })
                ] }),
                /* @__PURE__ */ e("td", { children: d.model_type ?? "" }),
                /* @__PURE__ */ e("td", { children: /* @__PURE__ */ e(Dn, { value: vt(d, E) }) }),
                /* @__PURE__ */ e("td", { children: d.status ?? "candidate" }),
                /* @__PURE__ */ e("td", { children: /* @__PURE__ */ a("span", { className: "a3d-row a3d-row-end", children: [
                  d.insight ? /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => f(d.insight), children: "Open in Insights" }) : /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => C(_, d), title: "Create it in Insights to prepare before modelling", children: "Prepare" }),
                  c ? /* @__PURE__ */ a("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => S(c.slug), children: [
                    "Model: ",
                    c.meta.title || c.slug
                  ] }) : /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", disabled: l, onClick: () => k(_, d), children: "Create model" })
                ] }) })
              ] }, d.id);
            }) })
          ] })
        ] }),
        _.signals.length > 0 && /* @__PURE__ */ a("section", { className: "a3d-block", children: [
          /* @__PURE__ */ a("h4", { children: [
            "Signals ",
            /* @__PURE__ */ e("span", { className: "a3d-count", children: _.signals.length })
          ] }),
          /* @__PURE__ */ a("table", { className: "a3d-filetable", children: [
            /* @__PURE__ */ e("thead", { children: /* @__PURE__ */ a("tr", { children: [
              /* @__PURE__ */ e("th", { children: "What" }),
              /* @__PURE__ */ e("th", { children: "Value" }),
              /* @__PURE__ */ e("th", { children: "Date" }),
              /* @__PURE__ */ e("th", { children: "Source" })
            ] }) }),
            /* @__PURE__ */ e("tbody", { children: _.signals.map((d, c) => /* @__PURE__ */ a("tr", { children: [
              /* @__PURE__ */ a("td", { children: [
                d.metric,
                d.note && /* @__PURE__ */ e("div", { className: "a3d-muted", children: d.note })
              ] }),
              /* @__PURE__ */ e("td", { className: "a3d-num", children: String(d.value ?? "") }),
              /* @__PURE__ */ e("td", { className: "a3d-num", children: wt(d.at) }),
              /* @__PURE__ */ e("td", { children: d.url ? /* @__PURE__ */ e("a", { href: d.url, target: "_blank", rel: "noreferrer", children: d.source || "link" }) : d.source })
            ] }, c)) })
          ] })
        ] }),
        /* @__PURE__ */ a("section", { className: "a3d-block", children: [
          /* @__PURE__ */ a("h4", { children: [
            "Models from this trend ",
            /* @__PURE__ */ e("span", { className: "a3d-count", children: v(_.slug).length })
          ] }),
          v(_.slug).length === 0 ? /* @__PURE__ */ e("p", { className: "a3d-muted", children: "None yet. “Create model” on an idea starts one and links it here." }) : /* @__PURE__ */ e("p", { className: "a3d-row", children: v(_.slug).map((d) => /* @__PURE__ */ a("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => S(d.slug), children: [
            d.meta.title || d.slug,
            " · ",
            h(d)
          ] }, d.slug)) })
        ] }),
        /* @__PURE__ */ a("p", { className: "a3d-row", children: [
          /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", disabled: l, onClick: () => w("refresh", _), children: "Refresh signals (Scout)" }),
          _._files.includes("trend.md") && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => L(`${_._dir}/trend.md`), children: "Open report" }),
          /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => L(`${_._dir}/trend.json`), children: "Open trend.json" }),
          /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => x(_._dir), children: "Show in Finder" })
        ] })
      ] }) : /* @__PURE__ */ e("div", { className: "a3d-placeholder", children: "Pick a trend, or start one above." })
    ] })
  ] });
}
function Ts({ commands: t, onClose: i }) {
  const [l, s] = A(""), [o, g] = A(0), w = qe(null), m = je(() => {
    const S = l.toLowerCase().split(/\s+/).filter(Boolean);
    return t.filter((f) => S.every((x) => `${f.title} ${f.hint ?? ""}`.toLowerCase().includes(x)));
  }, [l, t]);
  ke(() => {
    w.current?.focus();
  }, []), ke(() => {
    g(0);
  }, [l]);
  const C = (S) => {
    !S || S.disabled || (i(), S.run());
  };
  return /* @__PURE__ */ e("div", { className: "a3d-overlay a3d-overlay-top", onClick: i, children: /* @__PURE__ */ a("div", { className: "a3d-palette", role: "dialog", "aria-label": "Commands", onClick: (S) => S.stopPropagation(), onKeyDown: (S) => {
    S.key === "ArrowDown" ? (S.preventDefault(), g((f) => Math.min(m.length - 1, f + 1))) : S.key === "ArrowUp" ? (S.preventDefault(), g((f) => Math.max(0, f - 1))) : S.key === "Enter" ? (S.preventDefault(), C(m[o])) : S.key === "Escape" && (S.preventDefault(), i());
  }, children: [
    /* @__PURE__ */ e("input", { ref: w, value: l, placeholder: "Type a command…", "aria-label": "Filter commands", onChange: (S) => s(S.target.value) }),
    /* @__PURE__ */ a("ul", { role: "listbox", children: [
      m.length === 0 && /* @__PURE__ */ e("li", { className: "a3d-muted a3d-palette-empty", children: "No command matches." }),
      m.map((S, f) => /* @__PURE__ */ e("li", { role: "option", "aria-selected": f === o, "aria-disabled": !!S.disabled, children: /* @__PURE__ */ a("button", { type: "button", className: f === o ? "a3d-cmd a3d-cmd-on" : "a3d-cmd", disabled: !!S.disabled, onMouseEnter: () => g(f), onClick: () => C(S), children: [
        /* @__PURE__ */ e("span", { children: S.title }),
        /* @__PURE__ */ e("span", { className: "a3d-muted", children: S.disabled || S.hint || "" })
      ] }) }, S.id))
    ] })
  ] }) });
}
function Oi({ workspace: t, io: i, onSaved: l }) {
  const s = `${t}/_bmad/ai3d/config.yaml`, [o, g] = A(null), [w, m] = A(!1), [C, k] = A({}), [S, f] = A({}), [x, L] = A(null), [M, B] = A(!1), I = H(async () => {
    try {
      const v = await i.read(s), E = { ...Ns, ...v ? _s(v) : {} };
      g(v), k(E), f(E);
    } catch (v) {
      L({ tone: "error", msg: v instanceof Error ? v.message : String(v) });
    } finally {
      m(!0);
    }
  }, [i, s]);
  ke(() => {
    I();
  }, [I]);
  const F = je(() => Object.keys(C).filter((v) => C[v] !== S[v]), [C, S]), p = (v, E) => {
    L(null), k((b) => ({ ...b, [v]: E }));
  }, O = je(() => {
    const v = [];
    wi(C.bed_mm ?? "").some((j) => !(j > 0 && j <= 2e3)) && v.push("Bed size must be between 1 and 2000 mm on each axis.");
    const b = Number(C.overhang_deg);
    return b >= 20 && b <= 75 || v.push("Overhang angle must be between 20 and 75 degrees."), v;
  }, [C]), T = async () => {
    if (!(o === null || O.length)) {
      B(!0);
      try {
        const v = Object.fromEntries(F.map((E) => [E, C[E]]));
        await i.write(s, Cs(o, v)), L({ tone: "ok", msg: `Saved ${F.length} setting${F.length === 1 ? "" : "s"}. Agents and scripts use them from their next run.` }), await I(), l?.();
      } catch (v) {
        L({ tone: "error", msg: `Could not save: ${v instanceof Error ? v.message : String(v)}` });
      } finally {
        B(!1);
      }
    }
  }, _ = (v) => {
    const E = C[v.key] ?? v.def, b = `a3d-set-${v.key}`;
    switch (v.kind) {
      case "select": {
        const j = v.options.some((h) => h.value === E) ? v.options : [...v.options, { value: E, label: `${E} (current)` }];
        return /* @__PURE__ */ e("select", { id: b, value: E, onChange: (h) => p(v.key, h.target.value), children: j.map((h) => /* @__PURE__ */ e("option", { value: h.value, children: h.label }, h.value)) });
      }
      case "toggle":
        return /* @__PURE__ */ a("label", { className: "a3d-switch", children: [
          /* @__PURE__ */ e("input", { id: b, type: "checkbox", checked: E === "true", onChange: (j) => p(v.key, j.target.checked ? "true" : "false") }),
          /* @__PURE__ */ e("span", { children: E === "true" ? "On" : "Off" })
        ] });
      case "text":
        return /* @__PURE__ */ e("input", { id: b, value: E, onChange: (j) => p(v.key, j.target.value) });
      case "bed": {
        const j = wi(E);
        return /* @__PURE__ */ a("div", { className: "a3d-bed", children: [
          /* @__PURE__ */ e("span", { className: "a3d-row", children: ["X", "Y", "Z"].map((h, d) => /* @__PURE__ */ a("label", { className: "a3d-num", children: [
            h,
            /* @__PURE__ */ e("input", { type: "number", min: 1, max: 2e3, value: j[d], onChange: (c) => {
              const V = [...j];
              V[d] = Number(c.target.value), p(v.key, $s(V));
            } })
          ] }, h)) }),
          /* @__PURE__ */ e("span", { className: "a3d-row", children: ys.map((h) => /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", "aria-pressed": E === h.value, onClick: () => p(v.key, h.value), children: h.label }, h.value)) })
        ] });
      }
      case "angle":
        return /* @__PURE__ */ a("label", { className: "a3d-slider a3d-slider-angle", children: [
          /* @__PURE__ */ e("input", { id: b, type: "range", min: 20, max: 75, step: 1, value: Number(E) || 45, onChange: (j) => p(v.key, j.target.value) }),
          /* @__PURE__ */ a("output", { children: [
            E,
            "°"
          ] })
        ] });
      case "hidden":
        return null;
      case "runs": {
        const j = qt(C.step_models, Ri), h = qt(C.step_effort, Pi);
        return /* @__PURE__ */ a("table", { className: "a3d-runs", children: [
          /* @__PURE__ */ e("thead", { children: /* @__PURE__ */ a("tr", { children: [
            /* @__PURE__ */ e("th", { children: "Step / agent" }),
            /* @__PURE__ */ e("th", { children: "Model" }),
            /* @__PURE__ */ e("th", { children: "Reasoning" })
          ] }) }),
          /* @__PURE__ */ e("tbody", { children: Ai.map((d) => /* @__PURE__ */ a("tr", { children: [
            /* @__PURE__ */ e("td", { children: d.label }),
            /* @__PURE__ */ e("td", { children: /* @__PURE__ */ e("select", { "aria-label": `Model for ${d.label}`, value: j[d.id] === "default" ? "" : j[d.id] ?? "", onChange: (c) => p("step_models", oi({ ...j, [d.id]: c.target.value || "default" })), children: Di.map((c) => /* @__PURE__ */ e("option", { value: c.value.replace(/^claude-code:/, ""), children: c.label }, c.value)) }) }),
            /* @__PURE__ */ e("td", { children: /* @__PURE__ */ e("select", { "aria-label": `Reasoning for ${d.label}`, value: h[d.id] ?? "medium", onChange: (c) => p("step_effort", oi({ ...h, [d.id]: c.target.value })), children: tn.map((c) => /* @__PURE__ */ e("option", { value: c.value, children: c.label }, c.value)) }) })
          ] }, d.id)) })
        ] });
      }
      case "weights": {
        const j = Ei(E);
        return /* @__PURE__ */ e("div", { className: "a3d-weights", children: yt.map((h) => /* @__PURE__ */ a("label", { className: "a3d-slider", children: [
          /* @__PURE__ */ e("span", { children: h.label }),
          /* @__PURE__ */ e("input", { type: "range", min: 0, max: 5, step: 1, value: j[h.id], onChange: (d) => p(v.key, xs({ ...j, [h.id]: Number(d.target.value) })) }),
          /* @__PURE__ */ e("output", { children: j[h.id] })
        ] }, h.id)) });
      }
    }
  };
  return w ? /* @__PURE__ */ a("form", { className: "a3d-settings", onSubmit: (v) => {
    v.preventDefault(), T();
  }, children: [
    o === null && /* @__PURE__ */ a("p", { className: "a3d-banner", children: [
      "No ",
      /* @__PURE__ */ e("code", { children: "_bmad/ai3d/config.yaml" }),
      " in this workspace. Install the AI3D Forge module first; the form shows defaults until then."
    ] }),
    Li.map((v) => /* @__PURE__ */ a("section", { className: "a3d-set-group", children: [
      /* @__PURE__ */ e("h3", { children: v.title }),
      v.fields.filter((E) => E.kind !== "hidden").map((E) => /* @__PURE__ */ a("div", { className: "a3d-field", children: [
        /* @__PURE__ */ e("label", { htmlFor: `a3d-set-${E.key}`, children: E.label }),
        /* @__PURE__ */ e("div", { className: "a3d-field-control", children: _(E) }),
        /* @__PURE__ */ e("p", { className: "a3d-muted", children: E.help })
      ] }, E.key))
    ] }, v.title)),
    O.map((v) => /* @__PURE__ */ e("p", { className: "a3d-banner a3d-banner-error", children: v }, v)),
    x && /* @__PURE__ */ e("p", { className: x.tone === "error" ? "a3d-banner a3d-banner-error" : "a3d-banner", role: "status", children: x.msg }),
    /* @__PURE__ */ a("span", { className: "a3d-row", children: [
      /* @__PURE__ */ e("button", { type: "submit", className: "a3d-btn a3d-btn-primary", disabled: !F.length || O.length > 0 || o === null || M, children: M ? "Saving…" : F.length ? `Save ${F.length} change${F.length === 1 ? "" : "s"}` : "Saved" }),
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", disabled: !F.length, onClick: () => {
        k(S), L(null);
      }, children: "Discard" }),
      /* @__PURE__ */ a("span", { className: "a3d-muted", children: [
        "Writes ",
        s.replace(t + "/", "")
      ] })
    ] })
  ] }) : /* @__PURE__ */ e("p", { className: "a3d-muted", children: "Reading settings…" });
}
const Ii = "runs", Ms = 15;
let Me = {}, Rn = null, Zt = null, Ye = [];
const Ls = 2700 * 1e3, Xt = /* @__PURE__ */ new Set(), Pn = /* @__PURE__ */ new Set();
function Es(t) {
  return Pn.add(t), () => {
    Pn.delete(t);
  };
}
function Qt() {
  Me = { ...Me }, Xt.forEach((t) => t()), Rn?.set(Ii, Me);
}
function Wi(t) {
  Zt = t;
}
function Fs() {
  return !!Zt;
}
function Os(t) {
  if (Rn) return;
  Rn = t;
  const i = t.get(Ii) ?? {};
  for (const l of Object.values(i))
    for (const s of l) s.status === "running" && (s.status = "done");
  Me = { ...i, ...Me }, Xt.forEach((l) => l());
}
function Is(t) {
  return Xt.add(t), () => {
    Xt.delete(t);
  };
}
function Ws() {
  return Me;
}
const On = () => Ye.filter((t) => Date.now() - t.at < Ls);
function zs() {
  const t = [];
  for (const i of On()) {
    const l = Object.keys(Me).find((s) => Me[s].includes(i));
    l && t.push({ key: l, run: i });
  }
  return t.reverse();
}
function zi(t, i) {
  return t === void 0 ? !1 : On().some((l) => l.label === i && (Me[t] ?? []).includes(l));
}
function Ks(t) {
  const i = Ye.find((l) => l.at === t);
  i && (Ye = Ye.filter((l) => l !== i), i.status = "done", Qt());
}
function Gs(t) {
  const i = Ye.find((l) => !l.sessionId);
  i && (i.sessionId = t, Qt());
}
function Us(t, i, l, s, o, g, w) {
  if (!Zt || zi(t, l)) return null;
  const m = { sessionId: null, step: i, label: l, at: Date.now(), status: "running", model: w || void 0 };
  return Me[t] = [m, ...Me[t] ?? []].slice(0, Ms), Ye = [...On(), m], Qt(), Zt.sendPrompt(w ? { prompt: s, sessionName: o, model: w } : { prompt: s, sessionName: o }).then(
    (C) => {
      m.sessionId = C.sessionId, m.status = "done";
    },
    (C) => {
      m.status = "error", m.error = C instanceof Error ? C.message : String(C);
    }
  ).finally(() => {
    Ye = Ye.filter((C) => C !== m), Qt();
    try {
      g?.(m.status === "error" ? "error" : "done", m.error);
    } catch {
    }
    Pn.forEach((C) => {
      try {
        C(t, m);
      } catch {
      }
    });
  }), m;
}
const Ke = (t) => `'${t.replace(/'/g, "'\\''")}'`, se = (t, i, l) => ({ kind: "agent", label: t, skill: i, trigger: l }), Ki = {
  concept: [se("Write concept", "ai3d-muse", "*concept"), se("Re-check model type", "ai3d-muse", "*type")],
  image: [
    se("Write image prompt", "ai3d-lumen", "*prompt"),
    se("Review inbox", "ai3d-lumen", "*review"),
    se("Accept image", "ai3d-lumen", "*accept"),
    se("Prepare views for 3D (front, left, back, right)", "ai3d-lumen", "*views"),
    se("Review the views", "ai3d-lumen", "*review-views")
  ],
  mesh: [se("Write 3D spec", "ai3d-chisel", "*3d-prompt"), se("Review mesh", "ai3d-chisel", "*review-mesh"), se("Accept mesh", "ai3d-chisel", "*accept-mesh")],
  blender: [
    se("Optimize in Blender", "ai3d-kiln", "*optimize"),
    se("Inspect only", "ai3d-kiln", "*inspect"),
    se("Build flexi joints", "ai3d-kiln", "*flexi"),
    se("Render previews", "ai3d-kiln", "*render"),
    se("Export clearance coupon", "ai3d-kiln", "*coupon"),
    se("Blender command (free text)", "ai3d-kiln", "*run")
  ],
  validate: [se("Validate and write slicing notes", "ai3d-anvil", "*validate"), se("Slicing notes", "ai3d-anvil", "*slice")],
  print: [se("Log with Anvil (reads the photos)", "ai3d-anvil", "*print-log")],
  publish: [se("Write README", "ai3d-herald", "*readme"), se("Mark ready", "ai3d-herald", "*ready"), se("Write listing", "ai3d-herald", "*listing"), se("Mark published", "ai3d-herald", "*publish")]
}, W = {
  dir: "<branch folder>",
  root: "<models folder>",
  model: "<model folder>",
  flow: "<skills>/ai3d-forge/scripts/flow_log.py",
  readme: "<skills>/ai3d-herald/scripts/build-readme.py",
  viewer: "<skills>/ai3d-prism/scripts/build-viewer.py",
  insights: "<skills>/ai3d-prism/scripts/build-insights.py",
  print: "<skills>/ai3d-anvil/scripts/print_log.py",
  kiln: "<skills>/ai3d-kiln/scripts/kiln_run.py",
  trend: "<skills>/ai3d-scout/scripts/trend_lib.py",
  status: "<skills>/ai3d-help/scripts/status.py",
  blender: "<Blender>"
}, pe = (t) => t.startsWith("<") ? t : Ke(t), oe = {
  readme: (t, i, l) => `python3 ${pe(t)} ${pe(i)} && python3 ${pe(t)} ${pe(l)} --catalog`,
  view: (t, i) => `python3 ${pe(t)} ${pe(i)}`,
  portfolio: (t, i) => `python3 ${pe(t)} portfolio ${pe(i)}`,
  printSkip: (t, i) => `python3 ${pe(t)} skip ${pe(i)} --reason ${Ke("skipped from the panel")}`,
  branchAdd: (t, i, l) => [
    `python3 ${pe(t)} branch add ${pe(i)} --name ${Ke(l.name)}`,
    l.fromNode ? `--from-node ${Ke(l.fromNode)}` : "",
    l.fromStep ? `--from-step ${l.fromStep}` : "",
    l.source ? `--source ${Ke(l.source)}` : "",
    l.review ? "--review" : "",
    l.description ? `--description ${Ke(l.description)}` : ""
  ].filter(Boolean).join(" "),
  branchPromote: (t, i, l) => `python3 ${pe(t)} branch promote ${pe(i)} ${Ke(l)}`,
  branchSet: (t, i, l, s) => `python3 ${pe(t)} branch set ${pe(i)} ${Ke(l)} --status ${s}`,
  migrate: (t, i) => `python3 ${pe(t)} migrate-branches ${pe(i)}`,
  helpStatus: (t, i, l) => `python3 ${pe(t)} ${pe(i)}${l ? ` --model ${Ke(l)}` : ""}`
};
function Bn(t, i, l) {
  const s = i?.tools, o = l?.dir ?? W.dir;
  switch (t.kind) {
    case "agent":
      return `Starts a new agent session: skill ${t.skill}, command ${t.trigger}${l ? ` on ${l.slug}${l.branches.length > 1 ? ` / ${l.branch}` : ""}` : ""}. ⋯ shows the full prompt.`;
    case "script":
      return t.script === "readme" ? `Runs: ${oe.readme(s?.buildReadme ?? W.readme, o, i?.root ?? W.root)}` : t.script === "view" ? `Runs: ${oe.view(s?.buildViewer ?? W.viewer, o)}, then opens view/index.html` : t.script === "views-all" ? "Runs build-viewer.py for every model with an STL" : `Runs: ${oe.portfolio(s?.buildInsights ?? W.insights, i?.root ?? W.root)}`;
    case "form":
      return t.form === "print-skip" ? `Runs: ${oe.printSkip(s?.printLog ?? W.print, o)}` : "Opens the test print form; Save runs print_log.py add and flow_log.py add";
    default:
      return t.copy ? "Copies the text to the clipboard; you do this step yourself" : "You do this step yourself";
  }
}
const Nn = (t) => `agent session → ${t.skill} ${t.trigger} (prompt + model, branch work folder, flow node, your instruction)`, Vs = { concept: "Concept", image: "Image", mesh: "3D mesh", blender: "Blender", validate: "Validate", print: "Test print", publish: "Publish" }, ki = [
  ...Object.entries(Ki).flatMap(([t, i]) => i.map((l) => ({ area: `Flow · ${Vs[t]}`, button: l.label, kind: "agent", runs: Nn(l) }))),
  { area: "Flow · every step", button: "Run command…", kind: "agent", runs: "any command of the step with your instruction added to the prompt; an attempt command first runs flow_log.py add (below)" },
  {
    area: "Flow · every attempt",
    button: "New attempt… / Run again with changes… / Continue from here…",
    kind: "shell",
    runs: `python3 ${W.flow} add ${W.dir} --step <step> --label <label> --status running --parent <node> --settings-json '{…}' → agent session → python3 ${W.flow} settle ${W.dir} <node> --status open|error`
  },
  { area: "Flow · node", button: "Accepted / Rejected / Clear", kind: "shell", runs: `python3 ${W.flow} update ${W.dir} <node> --verdict accepted|rejected|none` },
  { area: "Flow · node", button: "Add note", kind: "shell", runs: `python3 ${W.flow} note ${W.dir} <node> '<text>'` },
  { area: "Flow · node", button: "Cost Save", kind: "shell", runs: `python3 ${W.flow} update ${W.dir} <node> --cost <service>:<credits>` },
  { area: "Flow · node", button: "Archive / Unarchive attempt", kind: "shell", runs: `python3 ${W.flow} update ${W.dir} <node> --archived yes|no` },
  {
    area: "Flow · branches",
    button: "New branch… / New branch from here…",
    kind: "shell",
    runs: oe.branchAdd(W.flow, W.model, { name: "<name>", fromNode: "<node>", fromStep: "<step>", source: "image:<file>|mesh:<file>|link:<url>|text:<brief>" }) + " [--review]"
  },
  { area: "Flow · branches", button: "Make primary", kind: "shell", runs: oe.branchPromote(W.flow, W.model, "<branch>") },
  { area: "Flow · branches", button: "Mark as variant / Archive / Reopen", kind: "shell", runs: oe.branchSet(W.flow, W.model, "<branch>", "variant|archived|open") },
  { area: "Flow · branches", button: "Move files to branches/", kind: "shell", runs: oe.migrate(W.flow, W.model) },
  { area: "Flow · Blender", button: "Analyze", kind: "headless Blender", runs: `${W.blender} -b --factory-startup -P ${W.kiln} -- analyze ${W.dir}` },
  { area: "Flow · Blender", button: "Quick prep…", kind: "headless Blender", runs: `flow_log.py add (blender, running) → ${W.blender} -b --factory-startup -P ${W.kiln} -- prep ${W.dir} side=<side> cut_mm=<mm> … → flow_log.py update` },
  { area: "Flow · Blender", button: "Flexi…", kind: "headless Blender", runs: `flow_log.py add → ${W.blender} -b --factory-startup -P ${W.kiln} -- flexi ${W.dir} segments=<n> clearance_mm=<mm> → flow_log.py update` },
  { area: "Flow · Blender", button: "Render previews / Coupon", kind: "headless Blender", runs: `${W.blender} -b --factory-startup -P ${W.kiln} -- render|coupon ${W.dir}` },
  { area: "Flow · Blender", button: "Open in Blender", kind: "shell", runs: 'open -a Blender <file>.blend, or Blender --python-expr "import …" for a mesh' },
  { area: "Flow · Blender", button: "Blender command…", kind: "agent", runs: Nn(se("", "ai3d-kiln", "*run")) + " — Kiln runs your instruction in the open Blender through the Blender MCP" },
  { area: "Flow · Test print", button: "Log a test print…", kind: "form", runs: `python3 ${W.print} add ${W.dir} --result ok|issues|fail --printer … --photos … → flow_log.py add --step print` },
  { area: "Flow · Test print", button: "Skip", kind: "shell", runs: oe.printSkip(W.print, W.dir) },
  { area: "Flow · Publish", button: "Build README / Rebuild README (no agent)", kind: "script", runs: oe.readme(W.readme, W.dir, W.root) },
  { area: "Flow · header", button: "3D view", kind: "script", runs: oe.view(W.viewer, W.dir) + " → opens view/index.html" },
  { area: "Flow · header", button: "Open STL in slicer / Show in Finder", kind: "shell", runs: "open <file> · open -R <file>" },
  { area: "Flow · Image", button: "Add views… (after Prepare views)", kind: "shell", runs: `osascript (file dialog) → python3 - ${W.dir} view <files> (import.py: copies into inbox/views/)` },
  {
    area: "Flow · every step",
    button: "Model and reasoning (Run command…, New attempt…, Settings → Agent runs)",
    kind: "agent",
    runs: "sendPrompt({ model: claude-code:opus|sonnet|haiku }) + a thinking line in the prompt (think / think hard / ultrathink); recorded on the node as run_model, run_effort"
  },
  { area: "Files", button: "Add image… / Add 3D model… / drop", kind: "shell", runs: `osascript (file dialog) → python3 - ${W.dir} image|mesh <files> (import.py: images → inbox/; one 3D file → mesh/raw.<ext>, the old one goes to mesh/attempts/; several → mesh/candidates/; identical files are skipped)` },
  { area: "Files", button: "Use as raw mesh (on a candidate)", kind: "shell", runs: `python3 - ${W.dir} promote copy mesh/candidates/<file> (import.py: copies it to mesh/raw.<ext>)` },
  { area: "Models", button: "Portfolio", kind: "script", runs: oe.portfolio(W.insights, W.root) },
  { area: "Models", button: "New model…", kind: "agent", runs: Nn(se("", "ai3d-muse", "*concept")) },
  { area: "Trends", button: "Analyse a trend / Similar model / Season / Re-check", kind: "agent", runs: "agent session: ai3d-scout *trend | *similar | *season | *watch" },
  { area: "Trends", button: "Status, ideas, links", kind: "shell", runs: `python3 ${W.trend} set|new|link …` },
  { area: "Insights", button: "Prepare / Score / New model", kind: "agent", runs: "agent session: ai3d-muse *prepare · ai3d-prism *score · ai3d-muse *concept" },
  { area: "Insights", button: "Find on the web (Muse)", kind: "agent", runs: "agent session → ai3d-muse *refs: web search for pages and pictures; each saved with trend_lib.py ref (pictures downloaded into refs/)" },
  { area: "Insights", button: "Add link / Add picture…", kind: "shell", runs: `python3 ${W.trend} ref <idea folder> --url <URL> | --file <picture> [--note …]` },
  {
    area: "Models · Files",
    button: "New model… / Concept from this… (picture)",
    kind: "agent",
    runs: `agent session → ai3d-muse *concept with the pictures and link in the prompt; as a branch: python3 ${W.flow} branch add ${W.model} --name <name> --from-step concept --source text:<brief> --ref <picture> first`
  },
  { area: "Tab bar", button: "N running → show session / forget", kind: "shell", runs: "no command: lists agent runs still in their first turn; forget only stops the panel waiting" },
  { area: "Insights", button: "Go / Later / No", kind: "shell", runs: `python3 ${W.trend} decide <insight dir> go|later|no` },
  { area: "Help", button: "Status (no agent)", kind: "shell", runs: oe.helpStatus(W.status, W.root, "<slug>") },
  { area: "Help", button: "Ask ai3d-help: status / next / how / tips", kind: "agent", runs: "agent session: ai3d-help *status | *next | *how <step> | *tips <step>" },
  { area: "Tab bar", button: "Blender chip → Check", kind: "shell", runs: "python3 - <workspace> (blender_status.py: finds Blender, its version, MCP servers in .mcp.json and ~/.claude.json)" },
  { area: "Every few seconds", button: "(refresh)", kind: "shell", runs: "python3 - <workspace> (scan.py: reads models/, trends/, insights/ and flow_log.py list for every model)" }
];
function Hs(t) {
  const i = {};
  if (!t) return i;
  let l = null;
  for (const s of t.split(`
`)) {
    const o = /^## (\S+)\s*$/.exec(s);
    if (o) {
      l = o[1].toLowerCase(), i[l] = "";
      continue;
    }
    l && (i[l] += `${s}
`);
  }
  return i;
}
function Ni(t, i) {
  return t.split(/(`[^`]+`)/g).filter(Boolean).map((l, s) => l.startsWith("`") && l.endsWith("`") && l.length > 1 ? /* @__PURE__ */ e("code", { children: l.slice(1, -1) }, `${i}c${s}`) : l);
}
function $n(t) {
  return t.split(/(\*\*.+?\*\*)/g).filter(Boolean).flatMap((i, l) => i.startsWith("**") && i.endsWith("**") && i.length > 4 ? [/* @__PURE__ */ e("strong", { children: Ni(i.slice(2, -2), `b${l}`) }, `b${l}`)] : Ni(i, `t${l}`));
}
function Js({ text: t }) {
  const i = [];
  let l = [], s = [];
  const o = () => {
    l.length && (i.push(/* @__PURE__ */ e("ul", { children: l.map((g, w) => /* @__PURE__ */ e("li", { children: $n(g) }, w)) }, i.length)), l = []), s.length && (i.push(/* @__PURE__ */ e("p", { children: $n(s.join(" ")) }, i.length)), s = []);
  };
  for (const g of t.split(`
`)) {
    const w = g.trimEnd();
    if (!w.trim()) {
      o();
      continue;
    }
    const m = /^###\s+(.*)$/.exec(w);
    if (m) {
      o(), i.push(/* @__PURE__ */ e("h4", { children: $n(m[1]) }, i.length));
      continue;
    }
    const C = /^\s*-\s+(.*)$/.exec(w);
    if (C) {
      s.length && o(), l.push(C[1]);
      continue;
    }
    if (l.length && /^\s+/.test(g)) {
      l[l.length - 1] += ` ${w.trim()}`;
      continue;
    }
    l.length && o(), s.push(w.trim());
  }
  return o(), /* @__PURE__ */ e(te, { children: i });
}
function In({ tips: t, step: i, onClose: l }) {
  const s = t[i];
  return /* @__PURE__ */ a("section", { className: "a3d-tips", "aria-label": `Tips for ${i}`, children: [
    l && /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", style: { float: "right" }, onClick: l, children: "Close" }),
    s ? /* @__PURE__ */ e(Js, { text: s }) : /* @__PURE__ */ a("p", { className: "a3d-muted", children: [
      "No tips found. They come from ",
      /* @__PURE__ */ e("code", { children: "ai3d-help/references/step-tips.md" }),
      ": update the module if it is missing."
    ] })
  ] });
}
const nn = "2.2.1", qs = "0.11.1", $i = (t) => (t ?? "").split(/[^0-9]+/).filter(Boolean).slice(0, 3).map(Number);
function Gi(t, i) {
  const l = $i(t), s = $i(i);
  for (let o = 0; o < 3; o++)
    if ((l[o] ?? 0) !== (s[o] ?? 0)) return (l[o] ?? 0) < (s[o] ?? 0);
  return !1;
}
function Ui(t) {
  const i = t.module?.newer;
  return i && !Gi(i.version, nn) ? `cd '${t.workspace}' && bash '${i.path}/scripts/update.sh'` : null;
}
function Wn(t) {
  const i = t.features;
  return i ? [i.branches ? "" : "branches", i.help ? "" : "Help and status", i.views ? "" : "views for multi-view 3D", i.webRefs ? "" : "references from the web"].filter(Boolean) : [];
}
function Vi(t) {
  return !t.installed && !t.tools.flowLog ? !1 : Wn(t).length > 0 || !!t.module?.version && Gi(t.module.version, nn);
}
function Ys(t, i) {
  const l = Ui(t), s = l ? `Run in a terminal: ${l}` : "Unpack the new module and run: bash <ai3d>/scripts/update.sh from the project root.", o = Wn(t), g = t.module?.version, w = i?.servers ?? [], m = (t.config.scrape_mcp || "apify").toLowerCase(), C = w.find((f) => f.forSessions && f.name.toLowerCase().includes(m)), k = (i?.mcp ?? []).find((f) => f.forSessions), S = ["models_folder", "trends_folder", "insights_folder", "step_models", "step_effort"].filter((f) => !t.config[f]);
  return [
    { name: "Python 3", state: t.python ? "ok" : "missing", detail: t.python ? `python3 ${t.python}` : "not found", fix: "Install Python 3 (brew install python)." },
    {
      name: "AI3D Forge skills",
      state: !t.installed && !t.tools.flowLog ? "missing" : Vi(t) ? "warn" : "ok",
      detail: !t.installed && !t.tools.flowLog ? "not installed in this project" : `installed ${g ?? "version unknown"} · panel ${qs} is built for ${nn}${o.length ? ` · missing: ${o.join(", ")}` : ""}`,
      fix: s
    },
    {
      name: "Module config",
      state: S.length ? "warn" : "ok",
      detail: S.length ? `missing keys: ${S.join(", ")} (defaults are used)` : t.configPath.replace(`${t.workspace}/`, ""),
      fix: "Run: python3 .claude/skills/ai3d-setup/scripts/merge-config.py (update.sh does it)."
    },
    {
      name: "Models folder",
      state: t.rootExists ? "ok" : "warn",
      detail: t.rootExists ? `${t.root.replace(`${t.workspace}/`, "")} · ${t.models.length} models` : `${t.root} does not exist yet`,
      fix: "It is created with the first model (Models → New model…)."
    },
    {
      name: "Branch layout",
      state: t.models.some((f) => !f.migrated) ? "warn" : "ok",
      detail: t.models.some((f) => !f.migrated) ? `${t.models.filter((f) => !f.migrated).length} model(s) keep their files in the model folder` : "every model has branches/",
      fix: "Works as it is; the first new branch moves the files, or run scripts/migrate-content.sh."
    },
    {
      name: "Blender",
      state: i?.bin ? "ok" : "warn",
      detail: i ? i.bin ? `${i.version ?? "found"} · ${i.bin}` : "not found" : "not checked yet",
      fix: "Install Blender 5.1+ or set blender_bin in Settings. Needed for the quick tools and for Kiln."
    },
    {
      name: "Blender MCP",
      state: k ? "ok" : "warn",
      detail: k ? `registered in ${k.where}` : "not registered for Claude Code sessions",
      fix: 'claude mcp add --scope project blender -- uv --directory "$HOME/blender_mcp/mcp" run blender-mcp (guide: Blender chip → Setup guide). Needed for Kiln *optimize, *flexi, *run.'
    },
    {
      name: "Scrape MCP (Apify)",
      state: C ? "ok" : "warn",
      detail: C ? `registered in ${C.where}` : `“${m}” not registered: Scout and Muse use plain web search`,
      fix: 'claude mcp add --scope project --transport http apify "https://mcp.apify.com?tools=actors,docs,apify/rag-web-browser", then /mcp → authenticate.'
    }
  ];
}
const Zs = [
  ["concept", "1 · Concept"],
  ["image", "2 · Image"],
  ["mesh", "3 · 3D mesh"],
  ["blender", "4 · Blender"],
  ["validate", "5 · Validate"],
  ["print", "6 · Test print"],
  ["publish", "7 · Publish"],
  ["branches", "Branches"],
  ["runs", "Model & reasoning"]
];
function Xs({ scan: t, model: i, blender: l, steps: s, stepsBySlug: o, tips: g, busy: w, statusText: m, statusBusy: C, onStatus: k, onAsk: S, onGo: f, onSelectModel: x }) {
  const [L, M] = A(() => s.find((T) => T.state === "active" || T.state === "waiting")?.id ?? "concept"), [B, I] = A(""), F = s.find((T) => T.state === "active" || T.state === "waiting") ?? null, p = t.models.filter((T) => (o[T.slug] ?? []).some((_) => _.state === "waiting")), O = je(() => {
    const T = B.trim().toLowerCase();
    return T ? ki.filter((_) => `${_.area} ${_.button} ${_.runs}`.toLowerCase().includes(T)) : ki;
  }, [B]);
  return /* @__PURE__ */ a("section", { className: "a3d-help", children: [
    /* @__PURE__ */ a("header", { className: "a3d-row", children: [
      /* @__PURE__ */ e("h1", { style: { margin: 0 }, children: "Help" }),
      /* @__PURE__ */ e("span", { className: "a3d-tabs-spacer" }),
      /* @__PURE__ */ e(
        "button",
        {
          type: "button",
          className: "a3d-btn",
          disabled: !t.tools.helpStatus || C,
          onClick: k,
          title: t.tools.helpStatus ? Qs(t) : "ai3d-help is not installed: update the module",
          children: C ? "Reading…" : "Status of all models (no agent)"
        }
      ),
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", disabled: w, onClick: () => S("*next", i?.slug), title: "Starts an agent session: ai3d-help *next", children: "Ask Compass: what next?" })
    ] }),
    i && /* @__PURE__ */ a("div", { className: "a3d-next", children: [
      /* @__PURE__ */ a("strong", { children: [
        i.meta.title || i.slug,
        i.branches.length > 1 ? ` · branch ${i.branch}` : ""
      ] }),
      F ? /* @__PURE__ */ a(te, { children: [
        /* @__PURE__ */ a("span", { children: [
          "Step ",
          F.n,
          " of 7, ",
          F.title,
          " — ",
          F.state === "waiting" ? "your turn" : "next: agent"
        ] }),
        /* @__PURE__ */ e("span", { children: F.hint }),
        F.primary && /* @__PURE__ */ a("span", { className: "a3d-muted a3d-small", children: [
          "Button: “",
          F.primary.label,
          "” · ",
          Bn(F.primary, t, i)
        ] }),
        /* @__PURE__ */ a("span", { className: "a3d-row", children: [
          /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small a3d-btn-primary", onClick: () => f(F.id), children: "Go to this step" }),
          /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => M(F.id), children: "Tips for it" })
        ] })
      ] }) : /* @__PURE__ */ e("span", { children: "All seven steps are done in this branch." })
    ] }),
    (() => {
      const T = Ys(t, l), _ = T.filter((v) => v.state !== "ok");
      return /* @__PURE__ */ a("details", { className: "a3d-health", open: _.some((v) => v.name === "AI3D Forge skills" || v.state === "missing"), children: [
        /* @__PURE__ */ a("summary", { children: [
          /* @__PURE__ */ e("h2", { style: { display: "inline" }, children: "Setup check" }),
          " ",
          /* @__PURE__ */ e("span", { className: _.length ? "a3d-tag a3d-tag-waiting" : "a3d-pill a3d-pill-done", children: _.length ? `${_.length} to look at` : "all good" })
        ] }),
        /* @__PURE__ */ e("table", { children: /* @__PURE__ */ e("tbody", { children: T.map((v) => /* @__PURE__ */ a("tr", { children: [
          /* @__PURE__ */ a("td", { children: [
            /* @__PURE__ */ e("span", { className: `a3d-hc a3d-hc-${v.state}`, children: v.state === "ok" ? "✓" : v.state === "warn" ? "!" : "✗" }),
            " ",
            v.name
          ] }),
          /* @__PURE__ */ a("td", { children: [
            v.detail,
            v.state !== "ok" && v.fix ? /* @__PURE__ */ e("div", { className: "a3d-muted a3d-small", children: v.fix }) : null
          ] })
        ] }, v.name)) }) })
      ] });
    })(),
    p.length > 0 && /* @__PURE__ */ a("section", { children: [
      /* @__PURE__ */ a("h2", { children: [
        "Your turn (",
        p.length,
        ")"
      ] }),
      /* @__PURE__ */ e("ul", { children: p.map((T) => {
        const _ = (o[T.slug] ?? []).find((v) => v.state === "waiting");
        return /* @__PURE__ */ a("li", { children: [
          /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: () => x(T.slug), children: T.meta.title || T.slug }),
          " — ",
          _?.title,
          ": ",
          _?.hint
        ] }, T.slug);
      }) })
    ] }),
    m && /* @__PURE__ */ a("section", { children: [
      /* @__PURE__ */ e("h2", { children: "Status report" }),
      /* @__PURE__ */ e("pre", { className: "a3d-cmd", children: m })
    ] }),
    /* @__PURE__ */ a("section", { children: [
      /* @__PURE__ */ e("h2", { children: "Step guide" }),
      /* @__PURE__ */ a("p", { className: "a3d-row", role: "tablist", children: [
        Zs.map(([T, _]) => /* @__PURE__ */ e("button", { type: "button", role: "tab", "aria-selected": L === T, className: "a3d-btn a3d-btn-small", "aria-pressed": L === T, onClick: () => M(T), children: _ }, T)),
        /* @__PURE__ */ e("span", { className: "a3d-tabs-spacer" }),
        L !== "branches" && L !== "runs" && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", disabled: w, onClick: () => S("*tips", L), title: "Starts an agent session: ai3d-help *tips with your print lessons", children: "Ask Compass about this step" })
      ] }),
      /* @__PURE__ */ e(In, { tips: g, step: L })
    ] }),
    /* @__PURE__ */ a("section", { children: [
      /* @__PURE__ */ e("h2", { children: "What each button runs" }),
      /* @__PURE__ */ a("p", { className: "a3d-muted", children: [
        "Agent buttons start a new session with a prompt (open “Run command…” on a step to see it in full). Script buttons run the shell command shown. ",
        /* @__PURE__ */ e("code", { children: "<skills>" }),
        " is where the module is installed, usually ",
        /* @__PURE__ */ e("code", { children: ".claude/skills" }),
        "."
      ] }),
      /* @__PURE__ */ e("input", { className: "a3d-in-grow", "aria-label": "Filter commands", placeholder: "Filter: blender, branch, README…", value: B, onChange: (T) => I(T.target.value) }),
      /* @__PURE__ */ a("table", { children: [
        /* @__PURE__ */ e("thead", { children: /* @__PURE__ */ a("tr", { children: [
          /* @__PURE__ */ e("th", { children: "Where" }),
          /* @__PURE__ */ e("th", { children: "Button" }),
          /* @__PURE__ */ e("th", { children: "Kind" }),
          /* @__PURE__ */ e("th", { children: "Runs" })
        ] }) }),
        /* @__PURE__ */ e("tbody", { children: O.map((T, _) => /* @__PURE__ */ a("tr", { children: [
          /* @__PURE__ */ e("td", { children: T.area }),
          /* @__PURE__ */ e("td", { children: T.button }),
          /* @__PURE__ */ e("td", { children: T.kind }),
          /* @__PURE__ */ e("td", { children: /* @__PURE__ */ e("code", { children: T.runs }) })
        ] }, _)) })
      ] })
    ] })
  ] });
}
function Qs(t) {
  return `Runs: python3 ${t.tools.helpStatus} ${t.workspace}`;
}
const xi = [
  { id: "image", label: "Another image", hint: "A picture file. It is accepted at once (or put in inbox/ for Lumen to review); the branch goes on with the 3D mesh." },
  { id: "link", label: "A link", hint: "A model or picture you like (MakerWorld, Printables, Etsy, Pinterest…). Saved in refs/source.md; Lumen writes the image prompt from it." },
  { id: "mesh", label: "A 3D file", hint: "A mesh from another service or another run (GLB, OBJ, STL…). Saved as mesh/raw.*; Chisel reviews it." },
  { id: "text", label: "A brief", hint: "A change in words (other colour scheme, other pose, bigger). Saved in refs/source.md; the first step reads it." },
  { id: "none", label: "Same inputs", hint: "Copies everything up to the node and starts the next step with other settings, in its own folder." }
];
function el(t, i) {
  return t === "image" || t === "link" || t === "text" ? "image" : t === "mesh" ? "mesh" : i ? De[Math.min(Ze(i.step) + 1, De.length - 1)] : "image";
}
function tl({ model: t, from: i, stepTitle: l, busy: s, onPick: o, onCancel: g, onCreate: w }) {
  const [m, C] = A(""), [k, S] = A(i?.id ?? ""), [f, x] = A("image"), [L, M] = A(""), [B, I] = A(!1), [F, p] = A(""), O = t.flow.nodes.find((c) => c.id === k) ?? null, [T, _] = A(null), v = T ?? el(f, O), E = f !== "none", b = f === "image" || f === "mesh", j = t.flow.nodes.filter((c) => !c.archived), h = m.trim() && (!E || L.trim()) && (f !== "link" || /^https?:\/\//i.test(L.trim())), d = async () => {
    const c = await o(f === "mesh" ? "mesh" : "image");
    c && c[0] && M(c[0]);
  };
  return /* @__PURE__ */ e("div", { className: "a3d-overlay", onClick: g, children: /* @__PURE__ */ a(
    "form",
    {
      className: "a3d-dialog a3d-dialog-wide",
      onClick: (c) => c.stopPropagation(),
      onSubmit: (c) => {
        c.preventDefault(), h && w({ name: m.trim(), fromNode: k || null, fromStep: v, kind: f, ref: L.trim(), review: B, description: F.trim() });
      },
      children: [
        /* @__PURE__ */ a("h3", { children: [
          "New branch · ",
          t.meta.title || t.slug
        ] }),
        /* @__PURE__ */ a("p", { className: "a3d-muted", children: [
          "A branch is a separate line with its own folder (",
          /* @__PURE__ */ e("code", { children: "branches/<name>/" }),
          "). It copies what it needs from the branch it grows from and then goes through every step on its own, to its own print and README."
        ] }),
        /* @__PURE__ */ a("label", { children: [
          "Name",
          /* @__PURE__ */ e("input", { autoFocus: !0, value: m, onChange: (c) => C(c.target.value), placeholder: "Red fox, Thicker base, Meshy try…" })
        ] }),
        /* @__PURE__ */ a("fieldset", { className: "a3d-fields", children: [
          /* @__PURE__ */ e("legend", { children: "Start with" }),
          /* @__PURE__ */ e("div", { className: "a3d-row", children: xi.map((c) => /* @__PURE__ */ a("label", { className: "a3d-check", children: [
            /* @__PURE__ */ e("input", { type: "radio", name: "a3d-kind", checked: f === c.id, onChange: () => {
              x(c.id), M(""), _(null);
            } }),
            " ",
            c.label
          ] }, c.id)) }),
          /* @__PURE__ */ e("p", { className: "a3d-muted a3d-small", children: xi.find((c) => c.id === f)?.hint }),
          f === "text" ? /* @__PURE__ */ e("textarea", { rows: 3, "aria-label": "Brief", value: L, onChange: (c) => M(c.target.value), placeholder: "Same fox, but sitting, tail around the paws." }) : E && /* @__PURE__ */ a("span", { className: "a3d-row a3d-pathrow", children: [
            /* @__PURE__ */ e(
              "input",
              {
                className: "a3d-in-grow",
                "aria-label": f === "link" ? "Link" : "File path",
                value: L,
                onChange: (c) => M(c.target.value),
                placeholder: f === "link" ? "https://makerworld.com/…" : "/Users/you/Downloads/picture.png"
              }
            ),
            b && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => {
              d();
            }, children: "Choose…" })
          ] }),
          f === "image" && /* @__PURE__ */ a("label", { className: "a3d-check", children: [
            /* @__PURE__ */ e("input", { type: "checkbox", checked: B, onChange: (c) => I(c.target.checked) }),
            " Put it in inbox/ for Lumen to review first"
          ] })
        ] }),
        /* @__PURE__ */ a("label", { children: [
          "Grows from",
          /* @__PURE__ */ a("select", { value: k, onChange: (c) => {
            S(c.target.value), _(null);
          }, children: [
            /* @__PURE__ */ e("option", { value: "", children: "Start of the model (copies the concept only)" }),
            j.map((c) => /* @__PURE__ */ a("option", { value: c.id, children: [
              t.branches.length > 1 ? `[${Pe(c)}] ` : "",
              l(c.step),
              " · ",
              c.label,
              c.verdict ? ` (${c.verdict})` : ""
            ] }, c.id))
          ] })
        ] }),
        /* @__PURE__ */ a("label", { children: [
          "First step of the branch",
          /* @__PURE__ */ e("select", { value: v, onChange: (c) => _(c.target.value), children: De.filter((c) => c !== "publish").map((c) => /* @__PURE__ */ e("option", { value: c, children: l(c) }, c)) }),
          /* @__PURE__ */ a("span", { className: "a3d-muted a3d-small", children: [
            "Everything before it is copied from ",
            O ? `branch ${Pe(O)}` : "main",
            "; this step and the ones after it are new."
          ] })
        ] }),
        /* @__PURE__ */ a("label", { children: [
          "Why this branch (optional)",
          /* @__PURE__ */ e("input", { value: F, onChange: (c) => p(c.target.value), placeholder: "Customer asked for a red version; try Meshy instead of Tripo…" })
        ] }),
        /* @__PURE__ */ a("span", { className: "a3d-row a3d-row-end", children: [
          /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: g, children: "Cancel" }),
          /* @__PURE__ */ e("button", { type: "submit", className: "a3d-btn a3d-btn-primary", disabled: s || !h, children: "Create branch" })
        ] })
      ]
    }
  ) });
}
function nl({ model: t, scan: i, step: l, initial: s, tips: o, busy: g, onCancel: w, onRun: m }) {
  const C = Ki[l.id] ?? [], k = s ? Math.max(0, C.findIndex((v) => v.skill === s.skill && v.trigger === s.trigger)) : 0, [S, f] = A(k), [x, L] = A(""), [M, B] = A(!1), [I, F] = A(null), p = C[S] ?? s ?? null, O = p ? _n(p) : !1, T = I ?? (p ? bt(i.config, l.id, p.skill, p.trigger) : { model: "", effort: "medium" }), _ = je(() => {
    if (!p) return "";
    const v = O ? {
      id: "<new node id>",
      step: l.id,
      agent: "",
      label: "",
      parent: null,
      status: "running",
      verdict: null,
      created_at: "",
      finished_at: null,
      settings: {},
      description: x.trim(),
      outcome: "",
      files: [],
      branch: t.branch
    } : null;
    return Tn(p, t, i, O ? void 0 : x.trim() || void 0, v ? { node: v, flowLog: i.tools.flowLog } : void 0, T.effort);
  }, [p, O, t, i, l.id, x, T.effort]);
  return /* @__PURE__ */ e("div", { className: "a3d-overlay", onClick: w, children: /* @__PURE__ */ a(
    "form",
    {
      className: "a3d-dialog a3d-dialog-wide",
      onClick: (v) => v.stopPropagation(),
      onSubmit: (v) => {
        v.preventDefault(), p && m({ action: p, instruction: x.trim(), run: T });
      },
      children: [
        /* @__PURE__ */ a("h3", { children: [
          "Run command · ",
          l.title,
          t.branches.length > 1 ? ` · branch ${t.branch}` : ""
        ] }),
        /* @__PURE__ */ a("label", { children: [
          "Command",
          /* @__PURE__ */ e("select", { value: S, onChange: (v) => f(Number(v.target.value)), children: C.map((v, E) => /* @__PURE__ */ a("option", { value: E, children: [
            v.label,
            " — ",
            v.skill,
            " ",
            v.trigger
          ] }, v.trigger)) })
        ] }),
        /* @__PURE__ */ a("label", { children: [
          "Your instruction for the agent (optional)",
          /* @__PURE__ */ e(
            "textarea",
            {
              rows: 3,
              autoFocus: !0,
              value: x,
              onChange: (v) => L(v.target.value),
              placeholder: l.id === "blender" ? "For example: base 3 mm thicker, keep the tail on the bed, overhang under 8 %." : l.id === "image" ? "For example: three-quarter view, legs apart, no shadow on the ground." : "What to do differently or what to watch for."
            }
          )
        ] }),
        /* @__PURE__ */ a("p", { className: "a3d-muted a3d-small", children: [
          O ? "This command makes a new attempt (a box in the graph); your instruction is saved as its description." : "Your instruction is added to the prompt; this command does not make a new attempt.",
          " ",
          /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: () => B((v) => !v), children: M ? "Hide tips" : "Tips for this step" })
        ] }),
        M && /* @__PURE__ */ e(In, { tips: o, step: l.id }),
        /* @__PURE__ */ e(Mn, { value: T, onChange: F }),
        /* @__PURE__ */ a("details", { children: [
          /* @__PURE__ */ e("summary", { children: "Prompt sent to the agent session" }),
          /* @__PURE__ */ e("pre", { className: "a3d-cmd", children: _ })
        ] }),
        /* @__PURE__ */ a("span", { className: "a3d-row a3d-row-end", children: [
          /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: w, children: "Cancel" }),
          /* @__PURE__ */ a("button", { type: "submit", className: "a3d-btn a3d-btn-primary", disabled: g || !p, children: [
            "Run: ",
            p?.label
          ] })
        ] })
      ]
    }
  ) });
}
function il({ host: t, model: i, pictures: l, defaultRun: s, busy: o, onPick: g, onCancel: w, onRun: m }) {
  const [C, k] = A("model"), [S, f] = A(""), [x, L] = A(l), [M, B] = A(""), [I, F] = A(""), [p, O] = A(""), [T, _] = A(s), v = (j) => L((h) => Array.from(/* @__PURE__ */ new Set([...h, ...j.map((d) => d.trim()).filter(Boolean)]))), E = !I.trim() || /^https?:\/\/\S+$/i.test(I.trim()), b = (S.trim() || x.length > 0 || I.trim()) && E && (C === "model" || p.trim());
  return /* @__PURE__ */ e("div", { className: "a3d-overlay", onClick: w, children: /* @__PURE__ */ a(
    "form",
    {
      className: "a3d-dialog a3d-dialog-wide a3d-attempt",
      onClick: (j) => j.stopPropagation(),
      onSubmit: (j) => {
        j.preventDefault(), b && m({ target: C, text: S.trim(), pictures: x, link: I.trim(), branchName: p.trim(), run: T });
      },
      children: [
        /* @__PURE__ */ a("header", { children: [
          /* @__PURE__ */ e("h3", { children: "New concept" }),
          /* @__PURE__ */ e("p", { className: "a3d-muted", children: "Muse writes the concept from what you give it: words, pictures, a link, or any mix. With a picture, Muse looks at it first and describes what it sees." })
        ] }),
        i && /* @__PURE__ */ a("fieldset", { className: "a3d-fields", children: [
          /* @__PURE__ */ e("legend", { children: "Make it" }),
          /* @__PURE__ */ a("span", { className: "a3d-row", children: [
            /* @__PURE__ */ a("label", { className: "a3d-check", children: [
              /* @__PURE__ */ e("input", { type: "radio", name: "a3d-nm-target", checked: C === "model", onChange: () => k("model") }),
              " A new model"
            ] }),
            /* @__PURE__ */ a("label", { className: "a3d-check", children: [
              /* @__PURE__ */ e("input", { type: "radio", name: "a3d-nm-target", checked: C === "branch", onChange: () => k("branch") }),
              " A new branch of ",
              i.meta.title || i.slug
            ] })
          ] }),
          C === "branch" && /* @__PURE__ */ a("label", { children: [
            "Branch name",
            /* @__PURE__ */ e("input", { value: p, onChange: (j) => O(j.target.value), placeholder: "Wizard kitten, With shield…" })
          ] })
        ] }),
        /* @__PURE__ */ a("section", { className: "a3d-attempt-sec", children: [
          /* @__PURE__ */ e("strong", { children: "Pictures to make it from" }),
          x.length > 0 && /* @__PURE__ */ e("div", { className: "a3d-gallery", children: x.map((j) => /* @__PURE__ */ a("figure", { children: [
            /* @__PURE__ */ e(Fe, { host: t, path: j, mtime: 0, alt: j.split("/").pop() ?? j }),
            /* @__PURE__ */ a("figcaption", { title: j, children: [
              j.split("/").pop(),
              " ",
              /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: () => L((h) => h.filter((d) => d !== j)), children: "remove" })
            ] })
          ] }, j)) }),
          /* @__PURE__ */ a("span", { className: "a3d-row a3d-pathrow", children: [
            /* @__PURE__ */ e(
              "input",
              {
                className: "a3d-in-grow",
                "aria-label": "Picture path",
                placeholder: "Path to a picture, or use Choose…",
                value: M,
                onChange: (j) => B(j.target.value),
                onKeyDown: (j) => {
                  j.key === "Enter" && M.trim() && (j.preventDefault(), v([M]), B(""));
                }
              }
            ),
            /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", disabled: !M.trim(), onClick: () => {
              v([M]), B("");
            }, children: "Add" }),
            /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: async () => {
              const j = await g();
              j && v(j);
            }, children: "Choose…" })
          ] })
        ] }),
        /* @__PURE__ */ a("label", { children: [
          "Link (optional)",
          /* @__PURE__ */ e("input", { value: I, onChange: (j) => F(j.target.value), placeholder: "https://… a model, a picture or a page to take the idea from" }),
          !E && /* @__PURE__ */ e("span", { className: "a3d-muted a3d-small", children: "A link starts with http:// or https://" })
        ] }),
        /* @__PURE__ */ a("label", { children: [
          "What to make",
          x.length || I.trim() ? " (optional: what to keep, what to change)" : "",
          /* @__PURE__ */ e(
            "textarea",
            {
              rows: 3,
              autoFocus: !l.length,
              value: S,
              onChange: (j) => f(j.target.value),
              placeholder: x.length ? "Same character, but chibi proportions, standing, 60 mm, static, no cape." : "Subject, style, size, static or flexi."
            }
          )
        ] }),
        /* @__PURE__ */ a("details", { className: "a3d-attempt-more", children: [
          /* @__PURE__ */ e("summary", { children: "More: model and reasoning" }),
          /* @__PURE__ */ e(Mn, { value: T, onChange: _ })
        ] }),
        /* @__PURE__ */ a("footer", { className: "a3d-attempt-foot", children: [
          /* @__PURE__ */ a("span", { className: "a3d-muted a3d-small", children: [
            "Agent run: ai3d-muse *concept",
            C === "branch" ? " in a new branch (flow_log.py branch add)" : "",
            ". Pictures are copied into refs/."
          ] }),
          /* @__PURE__ */ a("span", { className: "a3d-row a3d-row-end", children: [
            /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: w, children: "Cancel" }),
            /* @__PURE__ */ e("button", { type: "submit", className: "a3d-btn a3d-btn-primary", disabled: o || !b, children: "Run: write concept" })
          ] })
        ] })
      ]
    }
  ) });
}
const al = 4e3;
function sl(t, i, l, s) {
  const o = { ...bt(t, i, l.skill, l.trigger), ...s ?? {} };
  return { run_model: o.model ? o.model.replace(/^claude-code:/, "") : "default", run_effort: o.effort };
}
const jt = "_global";
async function ll(t) {
  const i = `python3 - ${$(t.workspacePath)} ${$(Ti.modelsRoot)} <<'A3D_SCAN'
${Ra}
A3D_SCAN`, l = await t.exec(i, { timeout: 2e4 });
  if (!l.success) throw new Error(l.stderr.trim() || "Could not scan the models folder (is python3 installed?).");
  return JSON.parse(l.stdout);
}
function rl(t) {
  return {
    read: async (i) => {
      const l = await t.exec(`[ -f ${$(i)} ] && cat ${$(i)}`, { timeout: 1e4 });
      return l.success ? l.stdout : null;
    },
    write: async (i, l) => {
      if (l.includes("A3D_CFG_EOF")) throw new Error("Refusing to write: the text contains the heredoc marker.");
      const s = await t.exec(`cat > ${$(i)} <<'A3D_CFG_EOF'
${l.replace(/\n*$/, `
`)}A3D_CFG_EOF`, { timeout: 1e4 });
      if (!s.success) throw new Error(s.stderr.trim() || "write failed");
    }
  };
}
function ft({ host: t, model: i, folder: l, title: s, onZoom: o, empty: g }) {
  const w = ue(i.files[l]);
  return !w.length && !g ? null : /* @__PURE__ */ a("section", { className: "a3d-block", children: [
    /* @__PURE__ */ a("h4", { children: [
      s,
      " ",
      /* @__PURE__ */ e("span", { className: "a3d-count", children: w.length })
    ] }),
    w.length === 0 ? /* @__PURE__ */ e("p", { className: "a3d-muted", children: g }) : /* @__PURE__ */ e("div", { className: "a3d-gallery", children: w.map((m) => {
      const C = `${i.dir}/${l}/${m.name}`;
      return /* @__PURE__ */ a("figure", { children: [
        /* @__PURE__ */ e(Fe, { host: t, path: C, mtime: m.mtime, alt: m.name, onClick: () => o({ path: C, mtime: m.mtime, name: m.name }) }),
        /* @__PURE__ */ e("figcaption", { title: m.name, children: m.name })
      ] }, m.name);
    }) })
  ] });
}
function Vt({ title: t, text: i, onOpen: l, copyLabel: s }) {
  const [o, g] = A(!1);
  return i ? /* @__PURE__ */ a("section", { className: "a3d-block", children: [
    /* @__PURE__ */ a("h4", { children: [
      t,
      /* @__PURE__ */ a("span", { className: "a3d-block-actions", children: [
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: async () => {
          await navigator.clipboard.writeText(i), g(!0), setTimeout(() => g(!1), 1500);
        }, children: o ? "Copied" : s ?? "Copy" }),
        l && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: l, children: "Open file" })
      ] })
    ] }),
    /* @__PURE__ */ e("pre", { className: "a3d-text", children: i })
  ] }) : null;
}
function ol({ title: t, model: i, folder: l, files: s, onOpen: o, onExternal: g }) {
  return s.length ? /* @__PURE__ */ a("section", { className: "a3d-block", children: [
    /* @__PURE__ */ e("h4", { children: t }),
    /* @__PURE__ */ e("ul", { className: "a3d-files", children: s.map((w) => {
      const m = `${i.dir}/${l}/${w.name}`, C = /\.(md|json|txt|ya?ml)$/i.test(w.name);
      return /* @__PURE__ */ a("li", { children: [
        /* @__PURE__ */ a("span", { className: "a3d-file-name", children: [
          l,
          "/",
          w.name
        ] }),
        /* @__PURE__ */ e("span", { className: "a3d-muted", children: Si(w.size) }),
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => C ? o(m) : g(m), children: C ? "Open" : "Open in app" })
      ] }, w.name);
    }) })
  ] }) : null;
}
function _i({ model: t }) {
  const i = t.analysis, l = i?.after ?? i?.analysis ?? null, s = i?.flexi ?? null;
  if (!l && !s) return null;
  const o = [];
  return l?.overhang_pct != null && o.push(["Overhang", `${l.overhang_pct} %`]), i?.before?.overhang_pct != null && o.push(["Overhang before", `${i.before.overhang_pct} %`]), i?.side_on_bed && o.push(["Side on bed", String(i.side_on_bed)]), i?.cut_mm != null && o.push(["Flat cut", `${i.cut_mm} mm`]), l?.size_mm && o.push(["Size", `${l.size_mm.join(" × ")} mm`]), l?.watertight != null && o.push(["Watertight", l.watertight ? "yes" : "no", l.watertight ? "good" : "bad"]), l?.shells != null && o.push(["Shells", String(l.shells)]), s && (o.push(["Joints", `${s.joints} of ${Math.max(0, (s.segments ?? 1) - 1 + (s.skipped_cuts?.length ?? 0))} cuts`]), o.push(["Joint check", s.ok ? "all held and free" : "failed", s.ok ? "good" : "bad"]), s.clearance_mm != null && o.push(["Clearance", `${s.clearance_mm} mm`])), /* @__PURE__ */ a("section", { className: "a3d-block", children: [
    /* @__PURE__ */ e("h4", { children: "Print analysis" }),
    /* @__PURE__ */ e("dl", { className: "a3d-metrics", children: o.map(([g, w, m]) => /* @__PURE__ */ a("div", { className: m ? `a3d-metric a3d-${m}` : "a3d-metric", children: [
      /* @__PURE__ */ e("dt", { children: g }),
      /* @__PURE__ */ e("dd", { children: w })
    ] }, g)) })
  ] });
}
function Ci(t) {
  const i = new Date(t);
  return (/* @__PURE__ */ new Date()).toDateString() === i.toDateString() ? i.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : i.toLocaleDateString([], { month: "short", day: "numeric" });
}
function dl({ host: t }) {
  const [i, l] = A(() => String(t.theme ?? "light"));
  ke(() => t.onThemeChanged?.((n) => l(String(n))), [t]);
  const [s, o] = A(null), [g, w] = A(null), [m, C] = A(null), [k, S] = A(null), [f, x] = A(jt), [L, M] = A(null), [B, I] = A(null), [F, p] = A("models"), [O, T] = A(!1), [_, v] = A(""), [E, b] = A(null), [j, h] = A(null), [d, c] = A(!1), [V, Y] = A("graph"), [Q, ae] = A(null), [X, me] = A(null), [Oe, Ne] = A(null), [R, G] = A(null), [q, fe] = A(null), [ce, Be] = A([]), [xe, Xe] = A(!1), [rt, N] = A(!1), [ne, Hi] = A(() => t.storage.get("notify") ?? !0), [zn, Kn] = A(!1), [be, Ji] = A(null), [Gn, Un] = A(!1), [an, kt] = A(!1), [qi, Vn] = A(null), [Yi, Zi] = A({}), [Dt, Nt] = A(null), [Hn, Xi] = A(() => t.storage.get("branchSel") ?? {}), [Le, Qe] = A(null), [ot, Ge] = A(null), [sn, $t] = A(null), [Jn, At] = A(!1), [qn, Qi] = A(null), [ea, ta] = A(null), [na, Yn] = A(!1), Zn = qe(""), ln = qe(!1), [xt, ia] = A(() => t.storage.get("off") === !0), dt = qe(xt ? "off" : null), Xn = qe(0), Rt = H((n) => {
    ia(n), dt.current = n ? "off" : null, t.storage.set("off", n);
  }, [t]), aa = Aa(Is, Ws), ee = H(async () => {
    if (!ln.current) {
      ln.current = !0;
      try {
        const n = await ll(t);
        Xn.current = Date.now(), dt.current !== "off" && (dt.current = !n.installed && !n.tools.flowLog && n.models.length === 0 ? "none" : null);
        const r = JSON.stringify(n);
        r !== Zn.current && (Zn.current = r, o(n)), w(null);
      } catch (n) {
        w(n instanceof Error ? n.message : String(n));
      } finally {
        ln.current = !1;
      }
    }
  }, [t]);
  ke(() => {
    Os(t.storage), dt.current !== "off" && ee();
    const n = setInterval(() => {
      document.hidden || dt.current === "off" || dt.current === "none" && Date.now() - Xn.current < 6e4 || ee();
    }, al), r = t.onWorkspaceEvent("sessions:refresh-list", (y) => {
      const P = y?.sessionId;
      typeof P == "string" && Gs(P);
    });
    return () => {
      clearInterval(n), r();
    };
  }, [t, ee]), ke(() => Es((n, r) => {
    if (!ne) return;
    const y = n === jt ? "" : ` · ${n}`, P = `${r.status === "error" ? "Failed" : "Finished"}: ${r.label}${y}`;
    h(`${P}. ${r.status === "error" ? r.error ?? "" : "Check the agent session for questions."}`);
    try {
      document.hidden && typeof Notification < "u" && Notification.permission === "granted" && new Notification("AI3D Forge", { body: P });
    } catch {
    }
  }), [ne]);
  const sa = H(() => {
    const n = !ne;
    Hi(n), t.storage.set("notify", n);
    try {
      n && typeof Notification < "u" && Notification.permission === "default" && Notification.requestPermission();
    } catch {
    }
    h(n ? "Notifications on: a message when an agent run ends (a system notification when the panel is hidden)." : "Notifications off.");
  }, [ne, t]);
  ke(() => {
    const n = (r) => {
      (r.metaKey || r.ctrlKey) && r.key.toLowerCase() === "k" && (r.preventDefault(), T((y) => !y));
    };
    return window.addEventListener("keydown", n), () => window.removeEventListener("keydown", n);
  }, []), ke(() => {
    if (!E && !B && !X && !Le && !ot) return;
    const n = (r) => {
      r.key === "Escape" && (b(null), I(null), me(null), Qe(null), Ge(null));
    };
    return window.addEventListener("keydown", n), () => window.removeEventListener("keydown", n);
  }, [E, B, X, Le, ot]);
  const ve = s?.models ?? [], et = ve.find((n) => n.slug === m) ?? null, u = je(() => et ? za(et, Hn[et.slug]) : null, [et, Hn]), rn = je(() => Hs(qn), [qn]), Pt = je(() => {
    const n = {};
    if (s) for (const r of s.models) n[r.slug] = ri(r, s);
    return n;
  }, [s]);
  ke(() => {
    s && (m && !ve.some((n) => n.slug === m) ? C(null) : !m && ve.length && (C(ve[0].slug), x(ve[0].slug)));
  }, [s, m, ve]), ke(() => {
    const n = Object.values(Pt).filter((r) => r.some((y) => y.state === "waiting")).length;
    t.setGutterBadge?.(n > 0 ? n : null, { tone: "warning" });
  }, [Pt, t]);
  const he = je(() => u && s ? ri(u, s) : [], [u, s]), Te = H((n) => {
    et && (Xi((r) => {
      const y = { ...r, [et.slug]: n };
      return t.storage.set("branchSel", y), y;
    }), ae(null), S(null), Be([]), Ne(null), c(!1));
  }, [et, t]), on = s?.tools.stepTips ?? null;
  ke(() => {
    on && t.exec(`cat ${$(on)}`, { timeout: 1e4 }).then((n) => {
      n.success && Qi(n.stdout);
    });
  }, [on, t]);
  const ct = he.find((n) => n.state === "active" || n.state === "waiting") ?? he[he.length - 1], K = he.find((n) => n.id === k) ?? ct, _e = !1, Bt = zs(), Ae = H(async (n) => {
    const r = await t.exec(`${pi()} ${$(n)}`, { timeout: 15e3 });
    r.success || h(`Could not open ${n}: ${r.stderr.trim()}`);
  }, [t]), tt = H(async (n) => {
    if (!s?.tools.flowLog) return n.flow.nodes;
    const r = await t.exec(`python3 ${$(s.tools.flowLog)} list ${$(n.dir)}`, { timeout: 15e3 });
    try {
      return r.success ? JSON.parse(r.stdout).nodes : n.flow.nodes;
    } catch {
      return n.flow.nodes;
    }
  }, [s, t]), Qn = u, J = H(async (n, r, y, P) => {
    if (!s) return;
    const D = P?.target ?? Qn;
    if (h(null), c(!1), n.kind === "script") {
      if (n.script === "readme") {
        if (!D || !s.tools.buildReadme) return;
        const ie = $(s.tools.buildReadme), de = await t.exec(`python3 ${ie} ${$(D.dir)} && python3 ${ie} ${$(s.root)} --catalog`, { timeout: 6e4 });
        h(de.success ? "README and catalog rebuilt." : `README build failed: ${de.stderr.trim()}`);
      } else if (n.script === "view" || n.script === "views-all") {
        if (!s.tools.buildViewer) {
          h("The Prism scripts were not found. Update the AI3D Forge module.");
          return;
        }
        const ie = n.script === "view" ? D ? [D] : [] : s.models.filter((Se) => Se.files.mesh.some((it) => /\.stl$/i.test(it.name)));
        if (!ie.length) {
          h(n.script === "view" ? "Select a model first." : "No model has an STL yet.");
          return;
        }
        h(`Building ${ie.length === 1 ? "the 3D view" : `${ie.length} 3D views`}…`);
        let de = null;
        const $e = [];
        for (const Se of ie) {
          const it = await t.exec(`python3 ${$(s.tools.buildViewer)} ${$(Se.dir)}`, { timeout: 12e4, maxBuffer: 2e7 });
          if (!it.success) {
            $e.push(`${Se.slug}: ${it.stderr.trim().split(`
`).pop()}`);
            continue;
          }
          try {
            de = JSON.parse(it.stdout.trim().split(`
`).pop() ?? "{}");
          } catch {
            de = null;
          }
        }
        ie.length === 1 && de?.view && await Ae(de.view), h($e.length ? `3D view failed: ${$e.join("; ")}` : ie.length === 1 ? `3D view built (${de?.mb ?? "?"} MB) and opened in your browser.${de?.note ? " " + de.note : ""}` : `${ie.length} 3D views built. Open one from its model.`);
      } else if (n.script === "portfolio") {
        if (!s.tools.buildInsights) {
          h("The Prism scripts were not found. Update the AI3D Forge module.");
          return;
        }
        h("Building the portfolio dashboard…");
        const ie = await t.exec(`python3 ${$(s.tools.buildInsights)} portfolio ${$(s.root)}`, { timeout: 6e4 });
        h(ie.success ? "Portfolio dashboard built." : `Portfolio build failed: ${ie.stderr.trim()}`), ie.success && p("insights");
      }
      ee();
      return;
    }
    if (n.kind === "form") {
      if (n.form === "print-log") N(!0);
      else if (D && s.tools.printLog) {
        const ie = await t.exec(`python3 ${$(s.tools.printLog)} skip ${$(D.dir)} --reason ${$("skipped from the panel")}`, { timeout: 15e3 });
        h(ie.success ? "Test print skipped for this model. Log a print later if you make one." : `Could not save: ${ie.stderr.trim()}`), ee();
      }
      return;
    }
    if (n.kind !== "agent") return;
    if (!Fs()) {
      h("The AI service is not available to this extension. Check its AI permission in Settings.");
      return;
    }
    const z = D && r ? D.slug : jt, U = D && r ? `AI3D · ${D.slug}${D.branch !== "main" ? `/${D.branch}` : ""} · ${n.label}` : `AI3D · ${n.label}`;
    if (zi(z, n.label)) {
      h(`“${n.label}” is already running. Its session is in the pane on the right.`);
      return;
    }
    let re;
    const le = s.tools.flowLog;
    if (D && r && le && _n(n)) {
      const ie = await tt(D), de = st(D, ie), $e = P?.parent !== void 0 ? P.parent : It(D, ie, r.id), Se = lt(de, r.id).filter((ze) => !ze.inferred).length + 1, it = Math.max(
        0,
        ...D.files.prompts.map((ze) => Number(/^image-v(\d+)\.md$/.exec(ze.name)?.[1] ?? 0)),
        ...de.map((ze) => Number(/^Image prompt v(\d+)/.exec(ze.label)?.[1] ?? 0))
      ) + 1, Ca = Math.max(
        0,
        ...de.map((ze) => Number(/^Views v(\d+)/.exec(ze.label)?.[1] ?? 0)),
        ...D.files.prompts.map((ze) => Number(/^views-v(\d+)\.md$/.exec(ze.name)?.[1] ?? 0))
      ) + 1, si = n.trigger === "*views", Sa = si ? `Views v${Ca}` : r.id === "image" ? `Image prompt v${it}` : `${r.title} · try ${Se}`, ja = si ? { mode: "views", views: "front,left,back,right" } : {}, Da = [
        `python3 ${$(le)} add ${$(D.dir)} --step ${r.id} --label ${$(Sa)} --status running`,
        $e ? `--parent ${$($e)}` : "",
        P?.description ? `--description ${$(P.description)}` : "",
        `--settings-json ${$(JSON.stringify({ ...ja, ...P?.settings ?? {}, ...sl(s.config, r.id, n, P?.run) }))}`
      ].filter(Boolean).join(" "), li = await t.exec(Da, { timeout: 15e3 });
      if (li.success)
        try {
          re = { node: JSON.parse(li.stdout.trim().split(`
`).pop() ?? ""), flowLog: le }, ae(re.node.id);
        } catch {
        }
      re ? ee() : h("The flow node could not be created; the step runs without it.");
    }
    const Ce = { ...bt(s.config, r?.id ?? null, n.skill, n.trigger), ...P?.run ?? {} }, we = re && D && le ? (ie, de) => {
      const $e = ie === "error" ? ` --outcome ${$(`Run failed: ${de ?? "unknown error"}`)}` : "";
      t.exec(`python3 ${$(le)} settle ${$(D.dir)} ${$(re.node.id)} --status ${ie === "error" ? "error" : "open"}${$e}`, { timeout: 15e3 }).then(() => ee());
    } : void 0;
    if (!Us(z, r?.id ?? "global", n.label, Tn(n, r ? D : null, s, y, re, Ce.effort), U, we, Ce.model)) {
      h(`“${n.label}” is already running.`), we?.("error", "not started");
      return;
    }
    x(z), M(null);
  }, [s, Qn, t, ee, Ae, tt]), nt = H((n, r) => {
    if (u) {
      if (n === "print") {
        N(!0);
        return;
      }
      gt[n]?.length && me({
        step: n,
        parent: r?.parent !== void 0 ? r.parent : It(u, u.flow.nodes, n),
        settings: r?.settings ?? {},
        description: r?.description ?? ""
      });
    }
  }, [u]), ei = H((n, r) => {
    const y = u ? `Selected model: ${u.slug}${u.branches.length > 1 ? `, branch ${u.branch}` : ""}.` : "";
    J({ kind: "agent", label: `Compass ${n}${r ? ` ${r}` : ""}`, skill: "ai3d-help", trigger: n }, null, [r, y].filter(Boolean).join(" · "));
  }, [J, u]), la = H((n) => {
    const r = he.find((y) => y.id === Le?.step) ?? null;
    Qe(null), r && (_n(n.action) ? J(n.action, r, void 0, { description: n.instruction, run: n.run }) : J(n.action, r, n.instruction || void 0, { run: n.run }));
  }, [he, Le, J]), dn = H(async (n, r) => {
    if (!u || !s?.tools.flowLog) return;
    const y = await t.exec(`python3 ${$(s.tools.flowLog)} update ${$(u.dir)} ${$(n.id)} --verdict ${r}`, { timeout: 15e3 });
    y.success || h(`Could not save the verdict: ${y.stderr.trim()}`), ee();
  }, [u, s, t, ee]), cn = H(async (n) => {
    if (!u || !s?.tools.flowLog) return !1;
    const r = await t.exec(`python3 ${$(s.tools.flowLog)} ${n}`, { timeout: 15e3 });
    return r.success || h(`Could not save: ${r.stderr.trim().split(`
`).pop()}`), ee(), r.success;
  }, [u, s, t, ee]), ht = H(async (n, r) => {
    const y = await t.exec(n, { timeout: 6e4 });
    if (ee(), !y.success)
      return h(`${r} failed: ${y.stderr.trim().split(`
`).pop()}`), null;
    try {
      return JSON.parse(y.stdout.trim().split(`
`).pop() ?? "null");
    } catch {
      return {};
    }
  }, [t, ee]), ra = H(async (n) => {
    if (Ge(null), !u || !s?.tools.flowLog) {
      h("flow_log.py was not found: update the module.");
      return;
    }
    const r = n.kind === "none" ? void 0 : `${n.kind}:${n.ref}`;
    h(`Creating branch “${n.name}”…`);
    const y = await ht(oe.branchAdd(s.tools.flowLog, u.rootDir, { name: n.name, fromNode: n.fromNode, fromStep: n.fromStep, source: r, review: n.review, description: n.description }), "New branch");
    y?.id && (await ee(), Te(y.id), p("flow"), h(`Branch “${n.name}” created in branches/${y.id}/ (starts at ${n.fromStep}${y.inherited?.length ? `, ${y.inherited.length} files copied` : ""}). Its steps are shown now.`));
  }, [u, s, ht, ee, Te]), oa = H(async (n) => {
    if ($t(null), !s) return;
    const r = [
      n.pictures.length ? `Reference pictures — look at each one with the Read tool before you write anything, describe what you see, and build the concept from them: ${n.pictures.map((we) => `\`${we}\``).join(", ")}.` : "",
      n.link ? `Reference link (open it): ${n.link}` : "",
      n.text ? `What I want: ${n.text}` : n.pictures.length || n.link ? "Make a printable model of what the references show; say what you kept and what you changed for printing." : ""
    ].filter(Boolean);
    if (n.target === "model" || !u || !s.tools.flowLog) {
      const we = n.pictures.length ? " Copy the reference pictures into the new model's work folder refs/." : "";
      J({ kind: "agent", label: `New model${n.text ? `: ${n.text.slice(0, 30)}` : ""}`, skill: "ai3d-muse", trigger: "*concept" }, null, r.join(" ") + we, { run: n.run });
      return;
    }
    const y = [n.text, n.link ? `Link: ${n.link}` : ""].filter(Boolean).join(" · ") || "Concept from the reference pictures", P = `${oe.branchAdd(s.tools.flowLog, u.rootDir, { name: n.branchName, fromStep: "concept", source: `text:${y}`, description: n.text })}${n.pictures.map((we) => ` --ref ${$(we)}`).join("")}`, D = await ht(P, "New branch");
    if (!D?.id) return;
    const z = { inbox: [], images: [], renders: [], refs: [], mesh: [], print: [], prompts: [], publish: [] }, U = {
      id: D.id,
      name: n.branchName,
      parent_branch: "main",
      from_node: null,
      from_step: "concept",
      source: { kind: "text", ref: y },
      description: n.text,
      status: "open",
      created_at: null,
      primary: !1,
      exists: !0,
      work: { dir: D.dir, meta: {}, concept: null, files: z, attempts: [], imagePrompt: null, prompt3d: null, analysis: null, hasReadme: !1, view: null, printLog: [], printPhotos: [], source: null, stamp: 0 }
    }, re = { ...u, ...U.work, meta: { title: u.meta.title }, dir: D.dir, branch: D.id, migrated: !0, branches: [...u.branches, U] }, le = he.find((we) => we.id === "concept") ?? null, Ce = (D.refs ?? []).length ? ` The reference pictures are in this branch: ${D.refs.join(", ")} — look at them with the Read tool first.` : "";
    await J(
      { kind: "agent", label: "Write concept", skill: "ai3d-muse", trigger: "*concept" },
      le,
      void 0,
      { description: `${y}.${Ce} Write this branch's own concept.md and metadata.json in its work folder; do not create a new model.`, run: n.run, target: re }
    ), await ee(), Te(D.id), p("flow");
  }, [s, u, he, J, ht, ee, Te]), _t = H(async (n, r) => {
    if (!u || !s?.tools.flowLog) return;
    const y = s.tools.flowLog, P = n === "promote" ? oe.branchPromote(y, u.rootDir, r) : n === "migrate" ? oe.migrate(y, u.rootDir) : oe.branchSet(y, u.rootDir, r, n);
    await ht(P, n === "migrate" ? "Moving files" : "Branch") && (n === "archived" && r === u.branch && Te(u.primary), h(n === "promote" ? `“${r}” is the primary branch now: the Models tab, the catalog and the portfolio use it.` : n === "migrate" ? "The work files are in branches/main/ now; metadata.json and concept.md stay in the model folder too." : n === "variant" ? `“${r}” is a variant: it gets its own README and listing.` : n === "archived" ? `“${r}” is archived: hidden, nothing deleted.` : `“${r}” is open again.`));
  }, [u, s, ht, Te]), ti = H(async () => {
    if (!s?.tools.helpStatus) return;
    Yn(!0);
    const n = await t.exec(oe.helpStatus(s.tools.helpStatus, s.workspace), { timeout: 3e4 });
    ta(n.success ? n.stdout.trim() : `status.py failed: ${n.stderr.trim()}`), Yn(!1);
  }, [s, t]), da = H((n) => {
    Be((r) => r.includes(n.id) ? r.filter((y) => y !== n.id) : [...r, n.id].slice(-2));
  }, []), ca = H(async (n, r) => {
    if (!u || !s?.tools.buildViewer) {
      h("The Prism scripts were not found.");
      return;
    }
    const y = Sn(u, n), P = `${y}/view/compare-${n.id}.html`, D = await t.exec(`python3 ${$(s.tools.buildViewer)} ${$(y)} --stl ${$(`${y}/${r}`)} --out ${$(P)}`, { timeout: 12e4, maxBuffer: 2e7 });
    if (!D.success) {
      h(`3D view failed: ${D.stderr.trim().split(`
`).pop()}`);
      return;
    }
    await Ae(P);
  }, [u, s, t, Ae]), ha = H(async (n) => {
    if (N(!1), !u || !s?.tools.printLog) {
      h("print_log.py was not found: update the module.");
      return;
    }
    const r = u;
    h("Saving the test print…");
    const y = [...n.photoPaths];
    try {
      for (const U of n.photoFiles) y.push(await Mi(t, r.dir, U));
    } catch (U) {
      h(`Photo upload failed: ${U instanceof Error ? U.message : String(U)}`);
      return;
    }
    const P = [
      `add ${$(r.dir)} --result ${n.result}`,
      `--printer ${$(n.printer)}`,
      `--filament ${$(n.filament)}`,
      `--settings ${$(n.settings)}`,
      `--change ${$(n.change)}`,
      `--notes ${$(n.notes)}`,
      y.length ? `--photos ${$(y.join(","))}` : ""
    ].filter(Boolean).join(" "), D = await t.exec(`python3 ${$(s.tools.printLog)} ${P}`, { timeout: 3e4 });
    if (t.exec(`rm -rf ${$(`${r.dir}/.import-tmp`)}`, { timeout: 1e4 }), !D.success) {
      h(`Could not save: ${D.stderr.trim().split(`
`).pop()}`);
      return;
    }
    let z = {};
    try {
      z = JSON.parse(D.stdout.trim().split(`
`).pop() ?? "{}");
    } catch {
    }
    if (s.tools.flowLog) {
      const U = await tt(r), re = lt(st(r, U), "print").filter((We) => !We.inferred).length + 1, le = It(r, U, "print"), Ce = ["print/print-log.md", ...z.photos ?? []].join(","), we = JSON.stringify(Object.fromEntries(Object.entries({ printer: n.printer, filament: n.filament, settings: n.settings }).filter(([, We]) => We)));
      if (await t.exec([
        `python3 ${$(s.tools.flowLog)} add ${$(r.dir)} --step print --agent you --label ${$(`Test print ${re}`)} --status done`,
        `--outcome ${$(`${n.result}${n.change ? `; change: ${n.change}` : ""}`)}`,
        `--files ${$(Ce)}`,
        `--settings-json ${$(we)}`,
        le ? `--parent ${$(le)}` : ""
      ].filter(Boolean).join(" "), { timeout: 15e3 }), n.result !== "issues") {
        const We = await t.exec(`python3 ${$(s.tools.flowLog)} list ${$(r.dir)}`, { timeout: 15e3 });
        try {
          const ie = st(r, JSON.parse(We.stdout).nodes).filter(($e) => $e.step === "print" && !$e.inferred), de = ie[ie.length - 1];
          de && await t.exec(`python3 ${$(s.tools.flowLog)} update ${$(r.dir)} ${$(de.id)} --verdict ${n.result === "ok" ? "accepted" : "rejected"}`, { timeout: 15e3 });
        } catch {
        }
      }
    }
    h(`Test print saved (${n.result}).${n.result === "fail" ? " Run the Blender step again with the change, or go back to the mesh." : ""}`), ee();
  }, [u, s, t, ee, tt]), ni = H((n, r) => {
    if (!u) return;
    const y = `${r ? Sn(u, r) : u.dir}/${n}`;
    /\.(md|json|txt|ya?ml)$/i.test(n) ? t.openFile(y) : Ae(y);
  }, [u, t, Ae]), Ie = H((n, r) => {
    C(n), S(null), ae(null), Ne(null), x(n), M(null), h(null), r && p(r);
  }, []), Tt = H(async (n, r) => {
    const y = r ? `${n.dir}/${r}` : n.dir, P = await t.exec(r ? bn(y) : `${pi()} ${$(y)}`, { timeout: 15e3 });
    P.success || h(`Could not show ${y}: ${P.stderr.trim()}`);
  }, [t]), pa = H((n, r) => {
    const y = `${n.dir}/${r}`;
    /\.(md|json|txt|ya?ml)$/i.test(r) ? t.openFile(y) : Ae(y);
  }, [t, Ae]), pt = H(async (n) => {
    Kn(!0);
    try {
      const r = await n;
      h(ws(r));
      const y = s?.tools.flowLog;
      if (u && y)
        for (const P of r.placed) {
          if (!P.archived) continue;
          const D = P.file, z = [...st(u)].reverse().find((U) => !U.inferred && U.files.includes(D));
          z && await t.exec(`python3 ${$(y)} update ${$(u.dir)} ${$(z.id)} --move-file ${$(`${D}=${P.archived}`)}`, { timeout: 15e3 });
        }
    } catch (r) {
      h(`Could not add the files: ${r instanceof Error ? r.message : String(r)}`);
    }
    Kn(!1), ee();
  }, [ee, s, u, t]), Mt = H(async (n) => {
    if (!u) return !0;
    const r = await mt(t, n);
    return r === null ? !1 : (r.length && await pt(gs(t, u.dir, n, r)), !0);
  }, [u, t, pt]), ua = H((n) => {
    u && pt(fs(t, u.dir, n));
  }, [u, t, pt]), ma = H((n) => {
    if (!u) return;
    const r = { image: [], mesh: [], view: [] }, y = [];
    for (const D of n) {
      const z = us(D.name);
      z ? r[z].push(D) : y.push(D.name);
    }
    const P = (async () => {
      const D = { placed: [], skipped: y.map((z) => ({ file: z, why: "not an image or a 3D file" })) };
      for (const z of ["image", "mesh"]) {
        if (!r[z].length) continue;
        const U = await bs(t, u.dir, z, r[z]);
        D.placed.push(...U.placed), D.skipped.push(...U.skipped);
      }
      return D;
    })();
    pt(P);
  }, [u, t, pt]), ii = s?.config.blender_bin ?? "auto", Ct = H(async () => {
    Un(!0);
    try {
      Ji(await ns(t, ii));
    } catch (n) {
      h(`Blender check failed: ${n instanceof Error ? n.message : String(n)}`);
    }
    Un(!1);
  }, [t, ii]), ai = !!s, hn = !!s && !s.installed && !s.tools.flowLog && s.models.length === 0;
  ke(() => {
    ai && !xt && !hn && Ct();
  }, [ai, xt, hn, Ct]);
  const fa = H(() => {
    s?.tools.blenderGuide ? t.openFile(s.tools.blenderGuide) : h("The setup guide is in the module: skills/ai3d-kiln/references/blender-setup.md");
  }, [s, t]), Lt = H(async (n, r = {}, y = "") => {
    if (!u || !s) return;
    if (!s.tools.kilnRun || !be?.bin) {
      kt(!0);
      return;
    }
    const P = u, D = s.tools.flowLog;
    Vn(n), h(null);
    let z = null;
    if ((n === "prep" || n === "flexi") && D) {
      const le = await tt(P), Ce = st(P, le), we = lt(Ce, "blender").filter((Se) => Se.verdict !== "rejected" && Se.status !== "error"), We = n === "flexi" && we.length ? we[we.length - 1].id : It(P, le, "blender"), ie = `${n === "prep" ? "Quick prep" : "Flexi (script)"} · try ${lt(Ce, "blender").filter((Se) => !Se.inferred).length + 1}`, de = Object.fromEntries(Object.entries(r).filter(([, Se]) => Se !== "")), $e = await t.exec([
        `python3 ${$(D)} add ${$(P.dir)} --step blender --agent kiln_run --label ${$(ie)} --status running`,
        We ? `--parent ${$(We)}` : "",
        y ? `--description ${$(y)}` : "",
        `--settings-json ${$(JSON.stringify(de))}`
      ].filter(Boolean).join(" "), { timeout: 15e3 });
      try {
        z = $e.success ? JSON.parse($e.stdout.trim().split(`
`).pop() ?? "").id : null;
      } catch {
        z = null;
      }
      ee();
    }
    const U = await as(t, be.bin, s.tools.kilnRun, n, P.dir, r);
    if (z && D) {
      const le = (U.files ?? []).join(",");
      await t.exec([
        `python3 ${$(D)} update ${$(P.dir)} ${$(z)} --status ${U.crashed ? "error" : "done"}`,
        !U.ok && !U.crashed ? "--verdict rejected" : "",
        `--outcome ${$(jn(U))}`,
        le ? `--files ${$(le)}` : ""
      ].filter(Boolean).join(" "), { timeout: 15e3 });
    }
    if (D && typeof U.archived == "string" && U.archived) {
      const le = [...st(P, await tt(P))].reverse().find((Ce) => !Ce.inferred && Ce.id !== z && Ce.files.includes("mesh/print.stl"));
      le && await t.exec(`python3 ${$(D)} update ${$(P.dir)} ${$(le.id)} --move-file ${$(`mesh/print.stl=${U.archived}`)}`, { timeout: 15e3 });
    }
    Zi((le) => ({ ...le, [P.slug]: U }));
    const re = Array.isArray(U.archived) ? U.archived.join(", ") : U.archived;
    h(`${n}: ${jn(U)}${re ? ` Previous file kept as ${re}.` : ""}`), Vn(null), ee();
  }, [u, s, be, t, ee, tt]), pn = H(async (n) => {
    const r = await ss(t, be?.bin ?? null, n && u ? `${u.dir}/${n}` : "");
    r.success ? h(n ? `Opening ${n} in Blender…` : "Opening Blender…") : h(`Could not open Blender: ${r.stderr.trim()}`);
  }, [t, be, u]), Ee = H((n) => s && n.startsWith(s.workspace) ? n.slice(s.workspace.length + 1) || "." : n, [s]), St = (n, r) => ({ kind: "agent", label: n, skill: "ai3d-scout", trigger: r }), Ue = H(async (n) => {
    if (!s?.tools.trendLib)
      return h("trend_lib.py was not found: update the AI3D Forge module."), null;
    const r = await t.exec(`python3 ${$(s.tools.trendLib)} ${n}`, { timeout: 2e4 });
    if (!r.success)
      return h(`Could not save: ${r.stderr.trim().split(`
`).pop()}`), null;
    ee();
    try {
      return JSON.parse(r.stdout.trim().split(`
`).pop() ?? "null");
    } catch {
      return null;
    }
  }, [s, t, ee]), ga = H((n, r, y) => {
    if (!s) return;
    if (n === "trend" || n === "similar" || n === "season") {
      I(n), v(y ?? "");
      return;
    }
    if (n === "watch") {
      J(St("Re-check watched trends", "*watch"), null, `Trends folder: \`${Ee(s.trendsRoot)}\`.`);
      return;
    }
    if (!r) return;
    const P = `Trend: \`${Ee(r._dir)}/trend.json\` (${r.title}).`;
    n === "score" && J({ kind: "agent", label: `Score ideas: ${r.title}`, skill: "ai3d-prism", trigger: "*score" }, null, `trend ${r.slug}. ${P}`), n === "refresh" && J(
      St(`Refresh: ${r.title}`, r.kind === "similar" ? "*similar" : r.kind === "season" ? "*season" : "*trend"),
      null,
      `Refresh the existing trend ${r.slug}: add new dated signals (keep the old ones), update summary and ideas. ${P}`
    );
  }, [s, J, Ee]), ba = H(async (n, r) => {
    if (!s) return;
    const y = await Ue(`new insight ${$(s.ideasRoot)} --title ${$(r.name)} --subject-kind other --trend ${$(n.slug)} --idea ${$(r.id)} --trends-dir ${$(s.trendsRoot)}`);
    y?.slug && (fe(y.slug), p("insights"), h(`“${r.name}” is in Insights now. Prepare runs Muse.`));
  }, [s, Ue]), Et = H((n) => s?.tools.trendLib ? `After the model folder exists, link it: \`python3 ${s.tools.trendLib} link <model dir> ${n} --trends-dir ${s.trendsRoot} --insights-dir ${s.ideasRoot}\`.` : "", [s]), wa = H((n, r) => {
    s && J(
      { kind: "agent", label: `New model: ${r.name}`, skill: "ai3d-muse", trigger: "*concept" },
      null,
      `Idea \`${r.id}\` (${r.name}${r.pitch ? `: ${r.pitch}` : ""}${r.model_type ? `, ${r.model_type}` : ""}) from trend \`${Ee(n._dir)}/trend.json\`. ${Et(`--trend ${n.slug} --idea ${r.id}`)}`
    );
  }, [s, J, Ee, Et]), va = H((n, r, y) => {
    const P = `Insight: \`${Ee(r._dir)}/insight.json\` (${r.title}).`, D = s?.tools.trendLib ? ` Save every reference with \`python3 ${s.tools.trendLib} ref ${r._dir} --url <URL> --title <what it is> --note <why it helps>\` (a picture URL is downloaded into refs/).` : "";
    n === "refs" && J(
      { kind: "agent", label: `References: ${r.title}`, skill: "ai3d-muse", trigger: "*refs" },
      null,
      `${r.slug}. ${P} Search the web for pages and pictures: the real subject from several sides, the target style, and existing printed models.${y ? ` Look especially for: ${y}.` : ""}${D}`
    ), n === "prepare" && J(
      { kind: "agent", label: `Prepare: ${r.title}`, skill: "ai3d-muse", trigger: "*prepare" },
      null,
      `${r.slug}. ${P} Find the references on the web (links and pictures), do not write them from memory.${D}`
    ), n === "score" && J({ kind: "agent", label: `Score: ${r.title}`, skill: "ai3d-prism", trigger: "*score" }, null, `insight ${r.slug}. ${P}`), n === "concept" && J(
      { kind: "agent", label: `New model: ${r.title}`, skill: "ai3d-muse", trigger: "*concept" },
      null,
      `${r.status === "draft" ? `From the idea ${r.slug}, which is not prepared yet: work from its description and whatever references it has, and say what you had to assume.` : `From the prepared insight ${r.slug}: use its brief.md and chosen variant.`} ${P} ${Et(`--insight ${r.slug}`)}`
    );
  }, [J, Ee, Et, s]), ya = H(async (n, r, y, P) => {
    if (!s) return;
    const D = await Ue(`new insight ${$(s.ideasRoot)} --title ${$(n)} --subject-kind ${$(r)} --description ${$(y)}`);
    D?.slug && (fe(D.slug), P && J(
      { kind: "agent", label: `Prepare: ${n}`, skill: "ai3d-muse", trigger: "*prepare" },
      null,
      `${D.slug}. Insight: \`${Ee(D.dir)}/insight.json\` (${n}).`
    ));
  }, [s, Ue, J, Ee]), ka = H(async () => {
    const n = await mt(t, "image");
    if (n === null) {
      h("The file dialog is not available here: paste a link, a path or a name.");
      return;
    }
    n.length && v((r) => [r.trim(), ...n].filter(Boolean).join(" "));
  }, [t]), Na = () => {
    const n = _.trim();
    if (!n) return;
    B === "new" && J({ kind: "agent", label: "New model", skill: "ai3d-muse", trigger: "*concept" }, null, n), B === "score" && J({ kind: "agent", label: `Score ideas: ${n}`, skill: "ai3d-prism", trigger: "*score" }, null, n), B === "blender" && J({ kind: "agent", label: `Blender: ${n.slice(0, 40)}`, skill: "ai3d-kiln", trigger: "*run" }, he.find((y) => y.id === "blender") ?? null, n);
    const r = s ? `Trends folder: \`${Ee(s.trendsRoot)}\`.` : "";
    B === "trend" && J(St(`Trend: ${n.slice(0, 40)}`, "*trend"), null, `${n}. ${r}`), B === "similar" && J(St(`Similar: ${n.slice(0, 40)}`, "*similar"), null, `${n}. ${r}`), B === "season" && J(St(`Season: ${n.slice(0, 40)}`, "*season"), null, `${n}. ${r}`), B === "scout" && J({ kind: "agent", label: `Scout: ${n}`, skill: "ai3d-scout", trigger: "*scout" }, null, n), I(null), v("");
  }, Ft = aa[f] ?? [], Re = Ft.find((n) => n.at === L) ?? Ft[0] ?? null, un = t.components?.SessionTranscript, $a = (n) => {
    const r = n.primary;
    if (!r) return /* @__PURE__ */ e("p", { className: "a3d-done-line", children: "Step complete." });
    if (n.state === "locked") {
      const y = he.find((P) => P.state === "active" || P.state === "waiting");
      return /* @__PURE__ */ a("p", { className: "a3d-muted", children: [
        "Finish step ",
        y?.n,
        " (",
        y?.title,
        ") first."
      ] });
    }
    return r.kind === "human" ? /* @__PURE__ */ a("div", { className: "a3d-your-turn", children: [
      /* @__PURE__ */ e("strong", { children: "Your turn" }),
      /* @__PURE__ */ e("span", { children: r.label }),
      /* @__PURE__ */ a("span", { className: "a3d-row", children: [
        r.copy && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-primary", onClick: async () => {
          await navigator.clipboard.writeText(r.copy), h("Copied to clipboard.");
        }, children: r.copyLabel ?? "Copy" }),
        r.folder === "print" && u && /* @__PURE__ */ a(te, { children: [
          /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-primary", onClick: () => N(!0), children: "Log a test print…" }),
          /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => {
            J({ kind: "form", label: "Skip", form: "print-skip" }, n);
          }, children: "Skip" })
        ] }),
        r.folder && u && (r.folder === "inbox" || r.folder === "mesh" || r.folder === "inbox/views") && /* @__PURE__ */ e(
          "button",
          {
            type: "button",
            className: "a3d-btn a3d-btn-primary",
            disabled: zn,
            onClick: async () => {
              await Mt(r.folder === "inbox" ? "image" : r.folder === "inbox/views" ? "view" : "mesh") || (p("files"), h("Use “Add…” here, or drop the file onto this page."));
            },
            children: r.folder === "inbox" ? "Add image…" : r.folder === "inbox/views" ? "Add views…" : "Add 3D model…"
          }
        ),
        r.folder && u && r.folder !== "print" && /* @__PURE__ */ a("button", { type: "button", className: "a3d-btn", onClick: async () => {
          await t.exec(`mkdir -p ${$(`${u.dir}/${r.folder}`)}`, { timeout: 1e4 }), Ae(`${u.dir}/${r.folder}`);
        }, children: [
          "Open ",
          r.folder,
          "/ folder"
        ] })
      ] })
    ] }) : /* @__PURE__ */ a("span", { className: "a3d-row", children: [
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-primary a3d-btn-large", disabled: _e, onClick: () => J(r, n), title: Bn(r, s, u), children: r.kind === "agent" ? `Run: ${r.label}` : r.label }),
      r.kind === "agent" && /* @__PURE__ */ e(
        "button",
        {
          type: "button",
          className: "a3d-btn",
          disabled: _e,
          "aria-label": "Show the command and add an instruction",
          title: "Show the prompt and add your own instruction",
          onClick: () => Qe({ step: n.id, action: r }),
          children: "⋯"
        }
      )
    ] });
  }, xa = (n, r) => {
    const y = (D) => t.openFile(D), P = (D, z, U) => /* @__PURE__ */ e(ol, { title: D, model: n, folder: z, files: n.files[z].filter(U ?? (() => !0)), onOpen: y, onExternal: Ae });
    switch (r.id) {
      case "concept":
        return /* @__PURE__ */ a(te, { children: [
          /* @__PURE__ */ e(Vt, { title: "concept.md", text: n.concept, onOpen: () => y(`${n.dir}/concept.md`) }),
          /* @__PURE__ */ e(ft, { host: t, model: n, folder: "refs", title: "References", onZoom: b })
        ] });
      case "image":
        return /* @__PURE__ */ a(te, { children: [
          /* @__PURE__ */ e(ft, { host: t, model: n, folder: "inbox", title: "Inbox", onZoom: b, empty: "Empty. Generated images go here." }),
          /* @__PURE__ */ e(ft, { host: t, model: n, folder: "images", title: "Accepted", onZoom: b }),
          n.imagePrompt && /* @__PURE__ */ e(Vt, { title: `Latest prompt — ${n.imagePrompt.name}`, text: n.imagePrompt.text, copyLabel: "Copy prompt", onOpen: () => y(`${n.dir}/prompts/${n.imagePrompt.name}`) }),
          P("Prompt history", "prompts", (D) => /^image-v\d+\.md$|^prompt-log\.md$/.test(D.name)),
          [["images/views", "Views for multi-view 3D", n.views ?? []], ["inbox/views", "Views waiting for review", n.viewsInbox ?? []]].map(([D, z, U]) => ue([...U]).length > 0 && /* @__PURE__ */ a("section", { className: "a3d-block", children: [
            /* @__PURE__ */ a("h4", { children: [
              z,
              " ",
              /* @__PURE__ */ e("span", { className: "a3d-count", children: ue([...U]).length })
            ] }),
            /* @__PURE__ */ e("div", { className: "a3d-gallery", children: ue([...U]).map((re) => {
              const le = `${n.dir}/${D}/${re.name}`;
              return /* @__PURE__ */ a("figure", { children: [
                /* @__PURE__ */ e(Fe, { host: t, path: le, mtime: re.mtime, alt: re.name, onClick: () => b({ path: le, mtime: re.mtime, name: `${D}/${re.name}` }) }),
                /* @__PURE__ */ e("figcaption", { children: re.name })
              ] }, re.name);
            }) })
          ] }, D)),
          n.viewsPrompt && /* @__PURE__ */ e(Vt, { title: `View prompts — ${n.viewsPrompt.name}`, text: n.viewsPrompt.text, copyLabel: "Copy view prompts", onOpen: () => y(`${n.dir}/prompts/${n.viewsPrompt.name}`) })
        ] });
      case "mesh":
        return /* @__PURE__ */ a(te, { children: [
          /* @__PURE__ */ e(Vt, { title: "3D spec — 3d-prompt.md", text: n.prompt3d, copyLabel: "Copy spec", onOpen: () => y(`${n.dir}/prompts/3d-prompt.md`) }),
          P("Mesh files", "mesh"),
          /* @__PURE__ */ e(ft, { host: t, model: n, folder: "images", title: "Source image", onZoom: b }),
          ue(n.views ?? []).length > 0 && /* @__PURE__ */ a("p", { className: "a3d-muted", children: [
            ue(n.views ?? []).length,
            " views in images/views/: Chisel writes a multi-view spec (Tripo3D: front, left, back, right; Meshy: up to 4, front first)."
          ] })
        ] });
      case "blender":
        return /* @__PURE__ */ a(te, { children: [
          /* @__PURE__ */ e(ft, { host: t, model: n, folder: "renders", title: "Renders", onZoom: b, empty: "No renders yet. Kiln saves them here." }),
          n.files.mesh.some((D) => /\.stl$/i.test(D.name)) && /* @__PURE__ */ a("section", { className: "a3d-block", children: [
            /* @__PURE__ */ e("h4", { children: "Interactive view" }),
            /* @__PURE__ */ a("p", { className: "a3d-muted", children: [
              "Orbit the model, shade overhangs in red, cut it at any height and check the bed fit.",
              n.view ? n.view.stale ? " The view is older than the model files: rebuild it." : " The view is up to date." : " Not built yet."
            ] }),
            /* @__PURE__ */ e("p", { className: "a3d-row", children: /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-primary", disabled: !s?.tools.buildViewer, onClick: () => J({ kind: "script", label: "3D view", script: "view" }, null), children: n.view ? "Rebuild and open" : "Build and open" }) })
          ] }),
          /* @__PURE__ */ e(
            hs,
            {
              model: n,
              status: be,
              kilnRun: s?.tools.kilnRun ?? null,
              busy: qi,
              last: Yi[n.slug] ?? null,
              onRun: (D) => {
                Lt(D);
              },
              onPrep: () => Nt("prep"),
              onFlexi: () => Nt("flexi"),
              onOpen: (D) => {
                pn(D);
              },
              onCommand: () => {
                I("blender"), v("");
              },
              onSetup: () => kt(!0)
            }
          ),
          /* @__PURE__ */ e(_i, { model: n }),
          P("Mesh files", "mesh"),
          P("Logs", "print", (D) => /kiln-log|analysis/.test(D.name))
        ] });
      case "print":
        return /* @__PURE__ */ a(te, { children: [
          n.printPhotos.length > 0 && /* @__PURE__ */ a("section", { className: "a3d-block", children: [
            /* @__PURE__ */ a("h4", { children: [
              "Photos ",
              /* @__PURE__ */ e("span", { className: "a3d-count", children: n.printPhotos.length })
            ] }),
            /* @__PURE__ */ e("div", { className: "a3d-gallery", children: ue(n.printPhotos).map((D) => {
              const z = `${n.dir}/print/photos/${D.name}`;
              return /* @__PURE__ */ a("figure", { children: [
                /* @__PURE__ */ e(Fe, { host: t, path: z, mtime: D.mtime, alt: D.name, onClick: () => b({ path: z, mtime: D.mtime, name: D.name }) }),
                /* @__PURE__ */ e("figcaption", { children: D.name })
              ] }, D.name);
            }) })
          ] }),
          n.printLog.length > 0 ? /* @__PURE__ */ a("section", { className: "a3d-block", children: [
            /* @__PURE__ */ a("h4", { children: [
              "Test prints ",
              /* @__PURE__ */ a("span", { className: "a3d-block-actions", children: [
                /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => N(!0), children: "Log another…" }),
                /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => y(`${n.dir}/print/print-log.md`), children: "Open log" })
              ] })
            ] }),
            /* @__PURE__ */ a("table", { className: "a3d-filetable", children: [
              /* @__PURE__ */ e("thead", { children: /* @__PURE__ */ a("tr", { children: [
                /* @__PURE__ */ e("th", { children: "Date" }),
                /* @__PURE__ */ e("th", { children: "Result" }),
                /* @__PURE__ */ e("th", { children: "Printer · filament" }),
                /* @__PURE__ */ e("th", { children: "Change next time" })
              ] }) }),
              /* @__PURE__ */ e("tbody", { children: [...n.printLog].reverse().map((D, z) => /* @__PURE__ */ a("tr", { children: [
                /* @__PURE__ */ e("td", { className: "a3d-num", children: D.at.slice(0, 10) }),
                /* @__PURE__ */ e("td", { children: D.skipped ? /* @__PURE__ */ e("span", { className: "a3d-pill", children: "skipped" }) : /* @__PURE__ */ e("span", { className: `a3d-pill a3d-pr-${D.result}`, children: D.result }) }),
                /* @__PURE__ */ a("td", { children: [
                  [D.printer, D.filament].filter(Boolean).join(" · "),
                  D.settings && /* @__PURE__ */ e("div", { className: "a3d-muted", children: D.settings })
                ] }),
                /* @__PURE__ */ e("td", { children: D.change ?? D.reason })
              ] }, z)) })
            ] })
          ] }) : /* @__PURE__ */ e("p", { className: "a3d-muted", children: "No test print logged yet." }),
          P("3D files", "mesh", (D) => /\.stl$/i.test(D.name))
        ] });
      case "validate":
        return /* @__PURE__ */ a(te, { children: [
          /* @__PURE__ */ e(_i, { model: n }),
          P("Validation and slicing", "print")
        ] });
      default:
        return /* @__PURE__ */ a(te, { children: [
          n.hasReadme && /* @__PURE__ */ a("section", { className: "a3d-block", children: [
            /* @__PURE__ */ e("h4", { children: "README" }),
            /* @__PURE__ */ a("p", { className: "a3d-row", children: [
              /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => y(`${n.dir}/README.md`), children: "Open README.md" }),
              /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => s && y(`${s.root}/README.md`), children: "Open catalog" })
            ] })
          ] }),
          /* @__PURE__ */ e(ft, { host: t, model: n, folder: "renders", title: "Images used in the README", onZoom: b }),
          P("Listings", "publish")
        ] });
    }
  }, Ot = u?.files.mesh.find((n) => n.name === "print.stl") ?? u?.files.mesh.find((n) => n.name === "clean.stl"), _a = [
    { id: "view", title: "Build 3D view of the selected model", hint: u?.slug, disabled: Ot ? s?.tools.buildViewer ? !1 : "Prism not installed" : "needs an STL", run: () => {
      J({ kind: "script", label: "3D view", script: "view" }, null);
    } },
    { id: "views-all", title: "Rebuild every 3D view", disabled: s?.tools.buildViewer ? !1 : "Prism not installed", run: () => {
      J({ kind: "script", label: "All views", script: "views-all" }, null);
    } },
    { id: "portfolio", title: "Build the portfolio dashboard", disabled: s?.tools.buildInsights ? !1 : "Prism not installed", run: () => {
      J({ kind: "script", label: "Portfolio", script: "portfolio" }, null);
    } },
    { id: "new", title: "New model…", hint: "agent run", run: () => $t({ pictures: [] }) },
    { id: "readme", title: "Rebuild README and catalog (no agent)", hint: u?.slug, disabled: u ? s?.tools.buildReadme ? !1 : "script not found" : "select a model", run: () => {
      J({ kind: "script", label: "README", script: "readme" }, null);
    } },
    { id: "attempt", title: "New attempt on the current step…", hint: K ? K.title : void 0, disabled: !u || !K ? "select a model" : s?.tools.flowLog ? !1 : "flow_log.py not found", run: () => {
      K && (p("flow"), nt(K.id));
    } },
    { id: "graph", title: "Show the flow graph", run: () => {
      p("flow"), Y("graph");
    } },
    { id: "branch", title: "New branch… (another image, link, mesh or settings)", hint: u?.slug, disabled: u ? s?.tools.flowLog ? !1 : "flow_log.py not found" : "select a model", run: () => {
      p("flow"), Ge({ from: null });
    } },
    { id: "run-cmd", title: "Run a command on the current step…", hint: K?.title, disabled: !u || !K ? "select a model" : !1, run: () => {
      K && (p("flow"), Qe({ step: K.id, action: null }));
    } },
    { id: "tips", title: "Tips for the current step", hint: K?.title, run: () => {
      p("flow"), At(!0);
    } },
    { id: "help", title: "Help: status, next move, what each button runs", run: () => p("help") },
    { id: "help-status", title: "Status of all models (no agent)", disabled: s?.tools.helpStatus ? !1 : "ai3d-help not installed", run: () => {
      p("help"), ti();
    } },
    { id: "help-next", title: "Ask Compass: what next? (agent)", run: () => ei("*next", u?.slug) },
    ...u && u.branches.length > 1 ? u.branches.map((n) => ({ id: `b-${n.id}`, title: `Switch to branch: ${n.name}`, hint: n.primary ? "primary" : n.status, run: () => {
      Te(n.id), p("flow");
    } })) : [],
    { id: "add-image", title: "Add image to the selected model…", hint: u?.slug, disabled: u ? !1 : "select a model", run: () => {
      p("files"), Mt("image");
    } },
    { id: "add-mesh", title: "Add 3D model to the selected model…", hint: u?.slug, disabled: u ? !1 : "select a model", run: () => {
      p("files"), Mt("mesh");
    } },
    { id: "reveal", title: "Show the model folder in Finder", hint: u?.slug, disabled: u ? !1 : "select a model", run: () => u && void Tt(u, "") },
    { id: "bl-status", title: "Blender: status and setup", hint: be?.version ?? void 0, run: () => {
      kt(!0), Ct();
    } },
    { id: "bl-analyze", title: "Blender: analyze the mesh (no agent)", hint: u?.slug, disabled: u ? be?.bin ? !1 : "Blender not found" : "select a model", run: () => {
      p("flow"), S("blender"), Lt("analyze");
    } },
    { id: "bl-prep", title: "Blender: quick prep… (no agent)", hint: u?.slug, disabled: u ? be?.bin ? !1 : "Blender not found" : "select a model", run: () => {
      p("flow"), S("blender"), Nt("prep");
    } },
    { id: "bl-render", title: "Blender: render previews (no agent)", hint: u?.slug, disabled: u ? be?.bin ? !1 : "Blender not found" : "select a model", run: () => {
      p("flow"), S("blender"), Lt("render");
    } },
    { id: "bl-command", title: "Blender command… (Kiln agent)", hint: u?.slug, disabled: u ? !1 : "select a model", run: () => {
      I("blender"), v("");
    } },
    { id: "bl-open", title: "Open the model in Blender", hint: u?.slug, disabled: u ? be?.bin ? !1 : "Blender not found" : "select a model", run: () => {
      const n = u?.files.mesh.find((r) => r.name === "work.blend") ?? u?.files.mesh.find((r) => r.name === "print.stl") ?? u?.files.mesh.find((r) => /^raw\./.test(r.name));
      pn(n ? `mesh/${n.name}` : null);
    } },
    { id: "tr-trend", title: "Analyse a trend…", hint: "Scout", run: () => {
      p("trends"), I("trend"), v("");
    } },
    { id: "tr-similar", title: "Similar model (photo, link or name)…", hint: "Scout", run: () => {
      p("trends"), I("similar"), v("");
    } },
    { id: "tr-season", title: "Season or event…", hint: "Scout", run: () => {
      p("trends"), I("season"), v("");
    } },
    { id: "in-new", title: "New idea… (Insights)", run: () => p("insights") },
    { id: "tab-trends", title: "Go to Trends", run: () => p("trends") },
    { id: "tab-insights", title: "Go to Insights", run: () => p("insights") },
    { id: "print-log", title: "Log a test print…", hint: u?.slug, disabled: u ? s?.tools.printLog ? !1 : "print_log.py not found" : "select a model", run: () => N(!0) },
    { id: "archived", title: xe ? "Hide archived branches" : "Show archived branches", run: () => Xe((n) => !n) },
    { id: "notify", title: ne ? "Turn notifications off" : "Turn notifications on", run: sa },
    { id: "keys", title: "Keyboard shortcuts", run: () => h("Shortcuts: 1–7 tabs · Alt+↑/↓ previous / next model · in Flow: G graph or steps, N new attempt, B new branch, C run command on the step, T tips, A / R accept or reject the selected attempt · Cmd/Ctrl+K commands.") },
    { id: "tab-models", title: "Go to Models", run: () => p("models") },
    { id: "tab-files", title: "Go to Files", run: () => p("files") },
    { id: "tab-flow", title: "Go to Flow", run: () => p("flow") },
    { id: "tab-settings", title: "Go to Settings", run: () => p("settings") },
    { id: "folder", title: "Open the models folder", disabled: s ? !1 : "still reading", run: () => s && void Ae(s.root) },
    ...ve.map((n) => ({ id: `m-${n.slug}`, title: `Open model: ${n.meta.title || n.slug}`, hint: n.meta.status, run: () => Ie(n.slug, "flow") }))
  ];
  return ke(() => {
    const n = (r) => {
      if (O || B || X || rt || Dt || an || E || Le || ot || sn) return;
      const y = r.target;
      if (y && (y.tagName === "INPUT" || y.tagName === "TEXTAREA" || y.tagName === "SELECT" || y.isContentEditable)) return;
      if (r.altKey && (r.key === "ArrowDown" || r.key === "ArrowUp") && ve.length) {
        r.preventDefault();
        const z = Math.max(0, ve.findIndex((re) => re.slug === m)), U = ve[(z + (r.key === "ArrowDown" ? 1 : ve.length - 1)) % ve.length];
        Ie(U.slug);
        return;
      }
      if (r.metaKey || r.ctrlKey || r.altKey) return;
      const P = r.key.toLowerCase(), D = ["models", "flow", "files", "trends", "insights", "help", "settings"];
      if (/^[1-7]$/.test(P)) {
        p(D[Number(P) - 1]);
        return;
      }
      if (!(F !== "flow" || !u)) {
        if (P === "g") Y((z) => z === "graph" ? "steps" : "graph");
        else if (P === "n" && K && s?.tools.flowLog && gt[K.id]?.length) nt(K.id);
        else if (P === "b" && s?.tools.flowLog) Ge({ from: Q ? u.flow.nodes.find((z) => z.id === Q) ?? null : null });
        else if (P === "c" && K && K.state !== "locked") Qe({ step: K.id, action: null });
        else if (P === "t") At((z) => !z);
        else if ((P === "a" || P === "r") && Q) {
          const z = u.flow.nodes.find((U) => U.id === Q);
          z && !z.inferred && dn(z, P === "a" ? "accepted" : "rejected");
        }
      }
    };
    return window.addEventListener("keydown", n), () => window.removeEventListener("keydown", n);
  }, [O, B, X, rt, Dt, an, E, Le, ot, ve, m, Ie, F, u, K, s, nt, Q, dn]), xt || hn ? /* @__PURE__ */ e("div", { className: "a3d", "data-a3d-theme": /dark/i.test(String(i)) ? "dark" : "light", children: /* @__PURE__ */ a("div", { className: "a3d-idle", children: [
    /* @__PURE__ */ e("h1", { children: "AI3D Forge" }),
    xt ? /* @__PURE__ */ a(te, { children: [
      /* @__PURE__ */ e("p", { children: "Turned off in this project. Nothing is scanned or run here." }),
      /* @__PURE__ */ e("span", { className: "a3d-row", children: /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-primary", onClick: () => {
        Rt(!1), ee();
      }, children: "Turn on in this project" }) })
    ] }) : /* @__PURE__ */ a(te, { children: [
      /* @__PURE__ */ e("p", { children: "This project has no AI3D Forge module, so the panel is idle here: no agents, no Blender check, one look a minute to see if the module appeared." }),
      /* @__PURE__ */ a("p", { className: "a3d-muted", children: [
        "To use it here, install the module from the project root: ",
        /* @__PURE__ */ e("code", { children: "bash <ai3d>/scripts/update.sh" }),
        " (a project with BMAD) — see the module README for a new project."
      ] }),
      /* @__PURE__ */ a("span", { className: "a3d-row", children: [
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => {
          ee();
        }, children: "Check again" }),
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => Rt(!0), title: "Stops even the once-a-minute look in this project", children: "Turn off in this project" })
      ] })
    ] }),
    /* @__PURE__ */ e("p", { className: "a3d-muted a3d-small", children: "The switch is kept per project. To remove the icon from every project, disable the extension in Nimbalyst’s extension settings." })
  ] }) }) : /* @__PURE__ */ a("div", { className: "a3d", "data-a3d-theme": /dark/i.test(String(i)) ? "dark" : "light", children: [
    /* @__PURE__ */ a("main", { className: "a3d-main", children: [
      /* @__PURE__ */ a("div", { className: "a3d-tabs", role: "tablist", children: [
        [["models", "Models"], ["flow", "Flow"], ["files", "Files"], ["trends", "Trends"], ["insights", "Insights"], ["help", "Help"], ["settings", "Settings"]].map(([n, r]) => /* @__PURE__ */ e("button", { type: "button", role: "tab", "aria-selected": F === n, className: "a3d-tab", onClick: () => p(n), children: r }, n)),
        /* @__PURE__ */ e("span", { className: "a3d-tabs-spacer" }),
        ve.length > 0 && /* @__PURE__ */ a("label", { className: "a3d-switch", children: [
          /* @__PURE__ */ e("span", { className: "a3d-muted", children: "Model" }),
          /* @__PURE__ */ e("select", { "aria-label": "Selected model", value: m ?? "", onChange: (n) => Ie(n.target.value), children: ve.map((n) => /* @__PURE__ */ e("option", { value: n.slug, children: n.meta.title || n.slug }, n.slug)) })
        ] }),
        u && u.branches.length > 1 && /* @__PURE__ */ a("label", { className: "a3d-switch", children: [
          /* @__PURE__ */ e("span", { className: "a3d-muted", children: "Branch" }),
          /* @__PURE__ */ e("select", { "aria-label": "Selected branch", value: u.branch, onChange: (n) => Te(n.target.value), children: u.branches.map((n) => /* @__PURE__ */ e("option", { value: n.id, children: Ka(n) }, n.id)) })
        ] }),
        Bt.length > 0 && /* @__PURE__ */ a("details", { className: "a3d-running", children: [
          /* @__PURE__ */ e("summary", { children: /* @__PURE__ */ a("span", { className: "a3d-tag a3d-tag-run", children: [
            Bt.length,
            " running"
          ] }) }),
          /* @__PURE__ */ e("ul", { children: Bt.map(({ key: n, run: r }) => /* @__PURE__ */ a("li", { children: [
            /* @__PURE__ */ a("span", { children: [
              r.label,
              n !== jt ? ` · ${n}` : "",
              " ",
              /* @__PURE__ */ a("span", { className: "a3d-muted", children: [
                "since ",
                Ci(r.at),
                r.model ? ` · ${mn(r.model)}` : ""
              ] })
            ] }),
            /* @__PURE__ */ a("span", { className: "a3d-row", children: [
              /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: () => {
                x(n), M(r.at);
              }, children: "show session" }),
              /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", title: "Stop waiting for this run in the panel. The session itself keeps going in Nimbalyst.", onClick: () => Ks(r.at), children: "forget" })
            ] })
          ] }, r.at)) })
        ] }),
        /* @__PURE__ */ e(rs, { status: be, checking: Gn, onClick: () => {
          kt(!0), Ct();
        } }),
        /* @__PURE__ */ a("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => T(!0), title: "Run a command", children: [
          "Commands ",
          /* @__PURE__ */ a("kbd", { children: [
            /Mac/i.test(navigator.platform) ? "⌘" : "Ctrl",
            "K"
          ] })
        ] })
      ] }),
      g && /* @__PURE__ */ e("div", { className: "a3d-banner a3d-banner-error", children: g }),
      s && !s.installed && !s.tools.kilnLib && /* @__PURE__ */ a("div", { className: "a3d-banner", children: [
        "The AI3D Forge module was not found in this workspace. Install it so the agents exist: see the module README.",
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: () => Rt(!0), children: "Turn off in this project" })
      ] }),
      s && Vi(s) && (() => {
        const n = Ui(s), r = Wn(s);
        return /* @__PURE__ */ a("div", { className: "a3d-banner a3d-banner-warn", children: [
          /* @__PURE__ */ a("span", { children: [
            "The AI3D skills in this project are ",
            s.module?.version ?? "older",
            "; this panel is built for ",
            nn,
            ".",
            r.length ? ` Not available until you update: ${r.join(", ")}.` : "",
            n ? /* @__PURE__ */ a(te, { children: [
              " Run in a terminal: ",
              /* @__PURE__ */ e("code", { children: n })
            ] }) : /* @__PURE__ */ a(te, { children: [
              " Unpack the new module and run ",
              /* @__PURE__ */ e("code", { children: "bash <ai3d>/scripts/update.sh" }),
              " in the project root."
            ] })
          ] }),
          /* @__PURE__ */ a("span", { className: "a3d-row", children: [
            n && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: async () => {
              await navigator.clipboard.writeText(n), h("Update command copied. Paste it into a terminal, then start a new session.");
            }, children: "Copy command" }),
            /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: () => p("help"), children: "Setup check" })
          ] })
        ] });
      })(),
      j && /* @__PURE__ */ a("div", { className: "a3d-banner", role: "status", children: [
        j,
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: () => h(null), children: "Dismiss" })
      ] }),
      F === "models" && (s ? /* @__PURE__ */ e(
        Rs,
        {
          host: t,
          scan: s,
          stepsBySlug: Pt,
          selected: m,
          onSelect: (n) => Ie(n, "flow"),
          onNew: () => $t({ pictures: [] }),
          onScout: () => p("trends"),
          onSelectTrend: (n) => {
            G(n), p("trends");
          },
          onPortfolio: () => {
            J({ kind: "script", label: "Portfolio", script: "portfolio" }, null);
          }
        }
      ) : /* @__PURE__ */ e("div", { className: "a3d-placeholder", children: g ? "" : "Reading models…" })),
      F === "files" && s && /* @__PURE__ */ e(
        vs,
        {
          host: t,
          scan: s,
          model: u,
          nodeFilter: Oe,
          importing: zn,
          onClearFilter: () => Ne(null),
          onSelectModel: (n) => Ie(n),
          onZoom: b,
          onOpen: pa,
          onReveal: Tt,
          onView: () => {
            J({ kind: "script", label: "3D view", script: "view" }, null);
          },
          onPick: Mt,
          onFiles: ma,
          onPromote: ua,
          onConcept: (n) => $t({ pictures: [n] })
        }
      ),
      F === "trends" && s && /* @__PURE__ */ e(
        Bs,
        {
          host: t,
          scan: s,
          busy: _e,
          selected: R,
          onSelectTrend: G,
          apify: be ? (be.servers ?? []).find((n) => n.forSessions && n.name.toLowerCase().includes((s.config.scrape_mcp || "apify").toLowerCase()))?.where ?? null : void 0,
          onAgent: ga,
          onSet: (n, r) => {
            Ue(`set ${$(n._dir)} ${r.map($).join(" ")}`);
          },
          onPrepare: (n, r) => {
            ba(n, r);
          },
          onCreateModel: wa,
          onSelectModel: (n) => Ie(n, "flow"),
          onSelectIdea: (n) => {
            fe(n), p("insights");
          },
          onReveal: (n) => {
            t.exec(bn(n), { timeout: 15e3 });
          },
          onOpen: (n) => {
            t.openFile(n);
          }
        }
      ),
      F === "insights" && s && /* @__PURE__ */ e(
        As,
        {
          host: t,
          scan: s,
          busy: _e,
          selected: q,
          onSelect: fe,
          running: Bt.map((n) => n.run.label),
          onZoom: b,
          onPickImage: () => mt(t, "image"),
          onRef: (n, r) => {
            Ue([`ref ${$(n._dir)}`, r.url ? `--url ${$(r.url)}` : "", r.file ? `--file ${$(r.file)}` : "", r.note ? `--note ${$(r.note)}` : ""].filter(Boolean).join(" ")).then((y) => {
              y && h(y.added === !1 ? "That link is already in the references." : y.reference?.file ? "Reference added; the picture is saved in refs/." : "Link added to the references.");
            });
          },
          onRemoveRef: (n, r) => {
            Ue(`ref ${$(n._dir)} --remove ${r}`);
          },
          onCreate: (...n) => {
            ya(...n);
          },
          onAgent: va,
          onDecide: (n, r) => {
            Ue(`decide ${$(n._dir)} ${r}`);
          },
          onSelectTrend: (n) => {
            G(n), p("trends");
          },
          onSelectModel: (n) => Ie(n, "flow"),
          onReveal: (n) => {
            t.exec(bn(n), { timeout: 15e3 });
          },
          onOpen: (n) => {
            t.openFile(n);
          }
        }
      ),
      F === "help" && s && /* @__PURE__ */ e(
        Xs,
        {
          scan: s,
          model: u,
          blender: be,
          steps: he,
          stepsBySlug: Pt,
          tips: rn,
          busy: _e,
          statusText: ea,
          statusBusy: na,
          onStatus: () => {
            ti();
          },
          onAsk: ei,
          onGo: (n) => {
            p("flow"), Y("steps"), S(n);
          },
          onSelectModel: (n) => Ie(n, "flow")
        }
      ),
      F === "settings" && /* @__PURE__ */ a("section", { className: "a3d-settings-wrap", children: [
        /* @__PURE__ */ e("h1", { children: "Settings" }),
        /* @__PURE__ */ a("p", { className: "a3d-muted", children: [
          "Module settings live in ",
          /* @__PURE__ */ e("code", { children: "_bmad/ai3d/config.yaml" }),
          ", so agents, scripts and this panel always agree. The folder override is in Nimbalyst’s extension settings."
        ] }),
        /* @__PURE__ */ e(Oi, { workspace: t.workspacePath, io: rl(t), onSaved: () => {
          ee();
        } }),
        /* @__PURE__ */ a("section", { className: "a3d-block", children: [
          /* @__PURE__ */ e("h4", { children: "This project" }),
          /* @__PURE__ */ e("p", { className: "a3d-muted", children: "Turn the panel off here: it stops scanning, checking Blender and notifying in this project. Other projects are not affected." }),
          /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => Rt(!0), children: "Turn off in this project" })
        ] })
      ] }),
      F === "flow" && (u ? /* @__PURE__ */ a(te, { children: [
        /* @__PURE__ */ a("header", { className: "a3d-head", children: [
          /* @__PURE__ */ a("div", { children: [
            /* @__PURE__ */ a("h1", { children: [
              u.meta.title || u.slug,
              u.branches.length > 1 && /* @__PURE__ */ a("span", { className: "a3d-muted", style: { fontWeight: 400 }, children: [
                " · ",
                Ht(u)?.name ?? u.branch,
                u.branch === u.primary ? " ★" : ""
              ] })
            ] }),
            /* @__PURE__ */ e("p", { className: "a3d-muted", children: [u.meta.model_type, u.meta.status, u.meta.summary || u.meta.subject].filter(Boolean).join(" · ") })
          ] }),
          /* @__PURE__ */ a("span", { className: "a3d-row", children: [
            /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => {
              Ne(null), p("files");
            }, children: "Files" }),
            /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => Tt(u, ""), children: "Show in Finder" }),
            u.hasReadme && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => t.openFile(`${u.dir}/README.md`), children: "README" }),
            Ot && /* @__PURE__ */ a(
              "button",
              {
                type: "button",
                className: "a3d-btn a3d-btn-primary",
                disabled: !s?.tools.buildViewer,
                onClick: () => J({ kind: "script", label: "3D view", script: "view" }, null),
                title: s?.tools.buildViewer ? "Build the interactive view and open it in your browser" : "Prism scripts not found in this workspace",
                children: [
                  "3D view",
                  u.view?.stale ? " (outdated)" : ""
                ]
              }
            ),
            Ot && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => Ae(`${u.dir}/mesh/${Ot.name}`), children: "Open STL in slicer" })
          ] })
        ] }),
        /* @__PURE__ */ a("div", { className: "a3d-flowbar", children: [
          /* @__PURE__ */ e("p", { className: "a3d-now", children: ct ? /* @__PURE__ */ a(te, { children: [
            "Now: ",
            /* @__PURE__ */ a("strong", { children: [
              "step ",
              ct.n,
              " of ",
              he.length,
              ", ",
              ct.title
            ] }),
            " · ",
            ct.state === "waiting" ? "your turn" : ct.state === "done" ? "everything is done" : "next up"
          ] }) : null }),
          (() => {
            const n = u.flow.nodes.filter((y) => y.cost).reduce((y, P) => (y[P.cost.service] = (y[P.cost.service] ?? 0) + P.cost.credits, y), {}), r = u.flow.nodes.length - Bi(u.flow.nodes, !1).length;
            return /* @__PURE__ */ a("span", { className: "a3d-row a3d-flowmeta", children: [
              Object.keys(n).length > 0 && /* @__PURE__ */ a("span", { className: "a3d-muted", title: "Sum of the costs recorded on attempts", children: [
                "Cost: ",
                Object.entries(n).map(([y, P]) => `${Math.round(P * 100) / 100} ${y}`).join(" · ")
              ] }),
              ce.length > 0 && /* @__PURE__ */ a("span", { className: "a3d-pill", children: [
                ce.length === 1 ? "pick one more to compare" : "comparing 2",
                " ",
                /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: () => Be([]), children: "clear" })
              ] }),
              r > 0 && /* @__PURE__ */ a("label", { className: "a3d-check", children: [
                /* @__PURE__ */ e("input", { type: "checkbox", checked: xe, onChange: (y) => Xe(y.target.checked) }),
                " show archived (",
                r,
                ")"
              ] })
            ] });
          })(),
          /* @__PURE__ */ a("span", { className: "a3d-seg", role: "group", "aria-label": "Flow view", children: [
            /* @__PURE__ */ e("button", { type: "button", "aria-pressed": V === "graph", onClick: () => Y("graph"), children: "Graph" }),
            /* @__PURE__ */ e("button", { type: "button", "aria-pressed": V === "steps", onClick: () => Y("steps"), children: "Steps" })
          ] })
        ] }),
        (() => {
          const n = Ht(u);
          return /* @__PURE__ */ a("div", { className: "a3d-branchbar", "aria-label": "Branches", children: [
            u.branches.length > 1 && u.branches.filter((r) => r.status !== "archived" || r.id === u.branch || xe).map((r) => /* @__PURE__ */ a(
              "button",
              {
                type: "button",
                className: `a3d-branchchip a3d-lane-c${Cn(u, r.id) % 8}`,
                "aria-pressed": r.id === u.branch,
                onClick: () => Te(r.id),
                title: [r.source ? `from ${r.source.kind}: ${r.source.ref}` : null, `starts at ${r.from_step}`, r.description].filter(Boolean).join(" · "),
                children: [
                  /* @__PURE__ */ e("span", { className: "a3d-dot" }),
                  r.name,
                  r.primary ? " ★" : "",
                  r.status !== "open" ? ` · ${r.status}` : ""
                ]
              },
              r.id
            )),
            /* @__PURE__ */ e(
              "button",
              {
                type: "button",
                className: "a3d-btn a3d-btn-small",
                disabled: !s?.tools.flowLog || s?.features?.branches === !1,
                onClick: () => Ge({ from: null }),
                title: `A separate line with its own files: another image, link, mesh or settings, carried to the end. Runs: ${oe.branchAdd("flow_log.py", "<model>", { name: "<name>", source: "<kind>:<ref>" })}`,
                children: "+ New branch…"
              }
            ),
            n && u.branches.length > 1 && /* @__PURE__ */ a(te, { children: [
              /* @__PURE__ */ e("span", { className: "a3d-tabs-spacer" }),
              !n.primary && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => {
                _t("promote", n.id);
              }, title: `This branch becomes the model's main result. Runs: ${oe.branchPromote("flow_log.py", "<model>", n.id)}`, children: "Make primary ★" }),
              !n.primary && n.status !== "variant" && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => {
                _t("variant", n.id);
              }, title: "Publish this branch as its own variant, next to the primary", children: "Mark as variant" }),
              n.status !== "open" && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => {
                _t("open", n.id);
              }, children: "Reopen" }),
              !n.primary && n.status !== "archived" && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => {
                _t("archived", n.id);
              }, title: "Hide the branch; nothing is deleted", children: "Archive branch" }),
              /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => Tt(u, ""), children: "Branch folder" })
            ] })
          ] });
        })(),
        !u.migrated && s?.tools.flowLog && /* @__PURE__ */ a("p", { className: "a3d-muted a3d-small", children: [
          "This model keeps its work files in the model folder. The first new branch moves them into ",
          /* @__PURE__ */ e("code", { children: "branches/main/" }),
          " ",
          "(or ",
          /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: () => {
            _t("migrate", "main");
          }, title: `Runs: ${oe.migrate("flow_log.py", "<model>")}`, children: "move them now" }),
          ")."
        ] }),
        (() => {
          const n = Ht(u);
          return n && n.id !== "main" && (n.source || n.description) ? /* @__PURE__ */ a("p", { className: `a3d-source a3d-lane-c${Cn(u, n.id) % 8}`, children: [
            "Branch ",
            /* @__PURE__ */ e("strong", { children: n.name }),
            n.source ? /* @__PURE__ */ a(te, { children: [
              " started from a ",
              n.source.kind,
              ": ",
              n.source.kind === "link" ? /* @__PURE__ */ e("a", { href: n.source.ref, target: "_blank", rel: "noreferrer", children: n.source.ref }) : n.source.kind === "text" ? /* @__PURE__ */ e("em", { children: n.source.ref }) : /* @__PURE__ */ e("code", { children: n.source.ref.split("/").pop() })
            ] }) : null,
            n.from_step !== "concept" ? `, at the ${n.from_step} step` : "",
            n.description ? ` — ${n.description}` : "",
            "."
          ] }) : null;
        })(),
        V === "graph" && /* @__PURE__ */ a(te, { children: [
          ce.length === 2 && (() => {
            const n = u.flow.nodes.find((y) => y.id === ce[0]), r = u.flow.nodes.find((y) => y.id === ce[1]);
            return n && r ? /* @__PURE__ */ e(
              Qa,
              {
                host: t,
                model: u,
                a: n,
                b: r,
                onClose: () => Be([]),
                onSwap: () => Be(([y, P]) => [P, y]),
                onView3d: (y, P) => {
                  ca(y, P);
                },
                onOpen: (y, P) => ni(y, P)
              }
            ) : null;
          })(),
          /* @__PURE__ */ e(
            qa,
            {
              model: u,
              steps: he,
              selectedNode: Q,
              selectedStep: K?.id ?? null,
              compare: ce,
              showArchived: xe,
              onSelectNode: (n) => {
                const r = u.flow.nodes.find((y) => y.id === n);
                r && Pe(r) !== u.branch && Te(Pe(r)), ae(n), r && S(r.step), c(!1);
              },
              onSelectStep: (n) => {
                ae(null), S(n), c(!1);
              },
              onSelectBranch: (n) => Te(n),
              onNew: (n) => nt(n)
            }
          ),
          (() => {
            const n = Q ? u.flow.nodes.find((r) => r.id === Q) : null;
            return n ? /* @__PURE__ */ e(
              Ya,
              {
                model: u,
                node: n,
                busy: !s?.tools.flowLog,
                canEdit: !!s?.tools.flowLog,
                inCompare: ce.includes(n.id),
                onCompare: da,
                onArchive: (r, y) => {
                  cn(`update ${$(u.dir)} ${$(r.id)} --archived ${y ? "yes" : "no"}`).then(() => {
                    y && !xe && ae(null);
                  });
                },
                onNote: (r, y) => {
                  cn(`note ${$(u.dir)} ${$(r.id)} ${$(y)}`);
                },
                onCost: (r, y, P) => {
                  cn(`update ${$(u.dir)} ${$(r.id)} --cost ${$(`${y}:${P}`)}`);
                },
                onSelectNode: (r) => {
                  ae(r);
                  const y = u.flow.nodes.find((P) => P.id === r);
                  y && S(y.step);
                },
                onRerun: (r) => nt(r.step, { parent: Oa(r), settings: r.settings, description: "" }),
                onNext: (r) => nt(he[Ze(r.step) + 1]?.id ?? r.step, { parent: r.id }),
                onBranch: (r) => Ge({ from: r }),
                onVerdict: dn,
                onOpen: (r) => ni(r, n),
                onFiles: (r) => {
                  Ne(r.id), p("files");
                }
              },
              n.id
            ) : null;
          })()
        ] }),
        V === "steps" && /* @__PURE__ */ e("ol", { className: "a3d-flow", children: he.map((n) => /* @__PURE__ */ e("li", { className: `a3d-step a3d-${n.state}${K?.id === n.id ? " a3d-step-selected" : ""}`, children: /* @__PURE__ */ a("button", { type: "button", onClick: () => {
          S(n.id), c(!1);
        }, children: [
          /* @__PURE__ */ a("span", { className: "a3d-step-top", children: [
            /* @__PURE__ */ e("span", { className: "a3d-step-n", children: n.state === "done" ? "✓" : n.n }),
            /* @__PURE__ */ e("span", { className: "a3d-step-title", children: n.title })
          ] }),
          /* @__PURE__ */ e("span", { className: "a3d-step-thumb", children: n.thumb ? /* @__PURE__ */ e(Fe, { host: t, path: `${u.dir}/${n.thumb}`, mtime: u.stamp, alt: "" }) : /* @__PURE__ */ e("span", { className: "a3d-step-agent", children: n.agent }) }),
          /* @__PURE__ */ e("span", { className: "a3d-step-result", children: n.result }),
          /* @__PURE__ */ e("span", { className: "a3d-step-state", children: n.state === "done" ? "Done" : n.state === "active" ? "Next" : n.state === "waiting" ? "Your turn" : "Locked" })
        ] }) }, n.id)) }),
        K && /* @__PURE__ */ a("section", { className: "a3d-detail", children: [
          /* @__PURE__ */ a("div", { className: "a3d-detail-head", children: [
            /* @__PURE__ */ a("div", { children: [
              /* @__PURE__ */ a("h3", { children: [
                "Step ",
                K.n,
                " · ",
                K.title,
                " ",
                /* @__PURE__ */ a("span", { className: "a3d-muted", children: [
                  "— ",
                  K.agent
                ] })
              ] }),
              /* @__PURE__ */ e("p", { children: K.hint })
            ] }),
            /* @__PURE__ */ a("div", { className: "a3d-detail-actions", children: [
              $a(K),
              K.state !== "locked" && K.id !== "print" && /* @__PURE__ */ e(
                "button",
                {
                  type: "button",
                  className: "a3d-btn",
                  disabled: _e,
                  onClick: () => Qe({ step: K.id, action: K.primary?.kind === "agent" ? K.primary : null }),
                  title: "Pick any command of this step, add your own instruction and see the prompt before it runs",
                  children: "Run command…"
                }
              ),
              /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", "aria-pressed": Jn, onClick: () => At((n) => !n), title: "How this step runs and how to get better results", children: "Tips" }),
              K.state !== "locked" && s?.tools.flowLog && (gt[K.id]?.length ?? 0) > 0 && /* @__PURE__ */ e(
                "button",
                {
                  type: "button",
                  className: "a3d-btn",
                  disabled: _e,
                  onClick: () => nt(K.id),
                  title: "Run this step again with its own settings and description",
                  children: "New attempt…"
                }
              ),
              K.state !== "locked" && K.more.length > 0 && /* @__PURE__ */ a("div", { className: "a3d-more", children: [
                /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", "aria-expanded": d, onClick: () => c((n) => !n), children: "Other actions" }),
                d && /* @__PURE__ */ e("div", { className: "a3d-menu", children: K.more.map((n) => /* @__PURE__ */ e("button", { type: "button", disabled: _e, title: Bn(n, s, u), onClick: () => J(n, K), children: n.label }, n.label)) })
              ] })
            ] })
          ] }),
          K.state !== "locked" && s && (() => {
            const n = bt(s.config, K.id, K.primary?.kind === "agent" ? K.primary.skill : "", K.primary?.kind === "agent" ? K.primary.trigger : void 0);
            return /* @__PURE__ */ a("p", { className: "a3d-muted a3d-runline", children: [
              "Agent runs here use ",
              /* @__PURE__ */ e("strong", { children: mn(n.model) }),
              ", reasoning ",
              /* @__PURE__ */ e("strong", { children: n.effort }),
              di(n.effort) ? ` (“${di(n.effort)}”)` : "",
              ". One run: Run command… · for good: ",
              /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: () => p("settings"), children: "Settings → Agent runs" }),
              "."
            ] });
          })(),
          Jn && /* @__PURE__ */ e(In, { tips: rn, step: K.id, onClose: () => At(!1) }),
          /* @__PURE__ */ e("div", { className: "a3d-results", children: xa(u, K) })
        ] })
      ] }) : /* @__PURE__ */ e("div", { className: "a3d-placeholder", children: s ? /* @__PURE__ */ a(te, { children: [
        "No model selected. ",
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: () => p("models"), children: "Open Models" })
      ] }) : g ? "" : "Reading models…" }))
    ] }),
    /* @__PURE__ */ a("aside", { className: "a3d-session", children: [
      /* @__PURE__ */ a("header", { children: [
        /* @__PURE__ */ e("h2", { children: "Agent session" }),
        Ft.length > 0 && /* @__PURE__ */ e("select", { "aria-label": "Run", value: Re?.at ?? "", onChange: (n) => M(Number(n.target.value)), children: Ft.map((n) => /* @__PURE__ */ a("option", { value: n.at, children: [
          Ci(n.at),
          " · ",
          n.label,
          n.model ? ` · ${mn(n.model)}` : "",
          n.status === "running" ? " (running)" : n.status === "error" ? " (failed)" : ""
        ] }, n.at)) })
      ] }),
      /* @__PURE__ */ a("div", { className: "a3d-session-body", children: [
        !Re && /* @__PURE__ */ e("p", { className: "a3d-empty", children: "Run a step and its agent session appears here. Answer verdict questions in this pane." }),
        Re?.status === "error" && /* @__PURE__ */ e("p", { className: "a3d-banner a3d-banner-error", children: Re.error }),
        Re && !Re.sessionId && Re.status === "running" && /* @__PURE__ */ e("p", { className: "a3d-empty", children: "Starting the session…" }),
        Re?.sessionId && un && /* @__PURE__ */ e(un, { sessionId: Re.sessionId }, Re.sessionId),
        Re?.sessionId && !un && /* @__PURE__ */ a("p", { className: "a3d-empty", children: [
          "This Nimbalyst version cannot embed transcripts in a panel. Open the session “AI3D · ",
          f === jt ? "" : `${f} · `,
          Re.label,
          "” from the session list."
        ] })
      ] })
    ] }),
    B && /* @__PURE__ */ e("div", { className: "a3d-overlay", onClick: () => I(null), children: /* @__PURE__ */ a("form", { className: "a3d-dialog", onClick: (n) => n.stopPropagation(), onSubmit: (n) => {
      n.preventDefault(), Na();
    }, children: [
      /* @__PURE__ */ e("h3", { children: B === "new" ? "New model" : B === "score" ? "Score ideas" : B === "blender" ? `Blender command · ${u?.meta.title || u?.slug || ""}` : B === "trend" ? "Analyse a trend" : B === "similar" ? "Similar model" : B === "season" ? "Season or event" : "Scout a category" }),
      /* @__PURE__ */ e("label", { htmlFor: "a3d-dialog-input", children: B === "trend" ? "Topic or category, for example “flexi dragons” or “desk organisers”. Scout collects dated signals (Apify when connected) and curates ideas." : B === "similar" ? "A link to the model (MakerWorld, Printables, Etsy…), its name, or a photo. Scout explains why it works, the licence and IP split, and proposes original models in the same niche." : B === "season" ? "Event, for example “St Nicholas Day”, “Christmas”, “New Year”. Scout checks the publish-by date and what sold last year." : B === "blender" ? "One instruction for Kiln to do in your open Blender, for example “show the underside and measure the thinnest leg”." : B === "new" ? "Describe the model: subject, style, size, static or flexi." : B === "score" ? "Category with a Scout shortlist to score, for example “lizards”." : "Category to research, for example “lizards” or “owls”." }),
      B === "new" || B === "blender" || B === "similar" || B === "trend" ? /* @__PURE__ */ e("textarea", { id: "a3d-dialog-input", autoFocus: !0, rows: 5, value: _, onChange: (n) => v(n.target.value) }) : /* @__PURE__ */ e("input", { id: "a3d-dialog-input", autoFocus: !0, list: B === "score" ? "a3d-shortlist-names" : B === "season" ? "a3d-events" : void 0, value: _, onChange: (n) => v(n.target.value) }),
      B === "similar" && /* @__PURE__ */ a("p", { className: "a3d-row", children: [
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => {
          ka();
        }, children: "Choose photo…" }),
        /* @__PURE__ */ e("span", { className: "a3d-muted a3d-small", children: "adds the file path; Scout copies it into the trend’s refs/" })
      ] }),
      B === "season" && /* @__PURE__ */ e("datalist", { id: "a3d-events", children: (s?.calendar ?? []).map((n) => /* @__PURE__ */ e("option", { value: n.name }, n.id)) }),
      B === "score" && /* @__PURE__ */ e("datalist", { id: "a3d-shortlist-names", children: (s?.shortlists ?? []).map((n) => /* @__PURE__ */ e("option", { value: n.name.replace(/\.md$/, "") }, n.name)) }),
      /* @__PURE__ */ a("span", { className: "a3d-row a3d-row-end", children: [
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => I(null), children: "Cancel" }),
        /* @__PURE__ */ e("button", { type: "submit", className: "a3d-btn a3d-btn-primary", disabled: !_.trim() || _e, children: B === "new" ? "Run: write concept" : B === "score" ? "Run: score" : B === "blender" ? "Run in Blender (Kiln)" : B === "trend" || B === "similar" || B === "season" ? "Run: Scout" : "Run: scout" })
      ] })
    ] }) }),
    X && u && s && /* @__PURE__ */ e(
      Ja,
      {
        model: u,
        scan: s,
        initial: X,
        busy: _e,
        onBranch: () => {
          const n = X.parent ? u.flow.nodes.find((r) => r.id === X.parent) ?? null : null;
          me(null), Ge({ from: n });
        },
        defaultRun: bt(s?.config ?? {}, X.step, gt[X.step]?.[0]?.skill ?? "", gt[X.step]?.[0]?.trigger),
        stepTitle: (n) => he.find((r) => r.id === n)?.title ?? n,
        onCancel: () => me(null),
        onRun: (n, r) => {
          me(null);
          const y = he.find((P) => P.id === r.step) ?? null;
          J(n, y, void 0, r);
        }
      },
      `${X.step}-${X.parent}`
    ),
    sn && s && /* @__PURE__ */ e(
      il,
      {
        host: t,
        model: u,
        pictures: sn.pictures,
        busy: _e,
        defaultRun: bt(s.config, "concept", "ai3d-muse", "*concept"),
        onPick: () => mt(t, "image"),
        onCancel: () => $t(null),
        onRun: (n) => {
          oa(n);
        }
      }
    ),
    Le && u && s && he.find((n) => n.id === Le.step) && /* @__PURE__ */ e(
      nl,
      {
        model: u,
        scan: s,
        step: he.find((n) => n.id === Le.step),
        initial: Le.action,
        tips: rn,
        busy: _e,
        onCancel: () => Qe(null),
        onRun: la
      }
    ),
    ot && u && /* @__PURE__ */ e(
      tl,
      {
        model: u,
        from: ot.from,
        busy: _e,
        stepTitle: (n) => he.find((r) => r.id === n)?.title ?? n,
        onPick: (n) => mt(t, n),
        onCancel: () => Ge(null),
        onCreate: (n) => {
          ra(n);
        }
      }
    ),
    an && /* @__PURE__ */ e(
      os,
      {
        status: be,
        checking: Gn,
        kilnInstalled: !!s?.tools.kilnRun,
        guide: !!s?.tools.blenderGuide,
        onCheck: () => {
          Ct();
        },
        onGuide: fa,
        onLaunch: () => {
          pn(null);
        },
        onClose: () => kt(!1)
      }
    ),
    Dt && u && /* @__PURE__ */ e(
      cs,
      {
        cmd: Dt,
        model: u,
        onCancel: () => Nt(null),
        onRun: (n) => {
          Nt(null), S("blender"), Lt(n.cmd, n.opts, n.description);
        }
      }
    ),
    rt && u && /* @__PURE__ */ e(
      es,
      {
        model: u,
        last: [...u.printLog].reverse().find((n) => !n.skipped) ?? null,
        onPickPhotos: () => mt(t, "image"),
        onCancel: () => N(!1),
        onSave: (n) => {
          ha(n);
        }
      }
    ),
    O && /* @__PURE__ */ e(Ts, { commands: _a, onClose: () => T(!1) }),
    E && /* @__PURE__ */ e("div", { className: "a3d-overlay", onClick: () => b(null), children: /* @__PURE__ */ a("figure", { className: "a3d-zoom", children: [
      /* @__PURE__ */ e(Fe, { host: t, path: E.path, mtime: E.mtime, alt: E.name }),
      /* @__PURE__ */ e("figcaption", { children: E.name })
    ] }) })
  ] });
}
let en = null;
async function ul(t) {
  Wi(t.services.ai ?? null), Ti.modelsRoot = t.services.configuration?.get("modelsRoot", "") ?? "";
  const i = t.services.filesystem;
  en = {
    read: async (l) => await i.fileExists(l) ? i.readFile(l) : null,
    write: (l, s) => i.writeFile(l, s)
  };
}
async function ml() {
  Wi(null), en = null;
}
const fl = {
  forge: { component: dl }
};
function cl({ workspacePath: t }) {
  return t ? en ? /* @__PURE__ */ a("div", { className: "a3d a3d-settings-page", children: [
    /* @__PURE__ */ e("h2", { children: "AI3D Forge" }),
    /* @__PURE__ */ e(Oi, { workspace: t, io: en })
  ] }) : /* @__PURE__ */ e("p", { className: "a3d-muted", children: "The extension is still starting. Reopen this page in a moment." }) : /* @__PURE__ */ e("p", { className: "a3d-muted", children: "Open a project to edit its AI3D Forge settings." });
}
const gl = { Ai3dSettings: cl };
export {
  ul as activate,
  ml as deactivate,
  fl as panels,
  gl as settingsPanel
};
//# sourceMappingURL=index.js.map
