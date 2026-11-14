import { jsxs as i, jsx as e, Fragment as ee } from "react/jsx-runtime";
import { useState as A, useMemo as je, useRef as qe, useEffect as ke, useCallback as H, useSyncExternalStore as Da } from "react";
const Aa = `"""Scan the AI3D Forge models folder and print one JSON document.
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
`, Ra = /\.(png|jpe?g|webp|gif)$/i, Pa = (t) => Ra.test(t.name), ue = (t) => t.filter(Pa), Ba = (t, a) => t.some((l) => a.test(l.name)), Y = (t, a, l, s) => ({
  kind: "agent",
  label: t,
  skill: a,
  trigger: l,
  extra: s
});
function Nn(t) {
  return t >= 1e6 ? `${(t / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(t / 1e3))} KB`;
}
function Si(t) {
  return Nn(t);
}
function li(t, a) {
  const l = t.meta.stages ?? {}, s = t.files, o = ue(s.inbox), g = ue(s.images), w = ue(s.renders), m = s.mesh.find((W) => /^raw\./i.test(W.name)), x = s.mesh.find((W) => W.name === "print.stl") ?? s.mesh.find((W) => W.name === "clean.stl"), C = t.meta.model_type === "flexi", v = t.analysis?.after ?? t.analysis?.analysis ?? null, f = t.meta.status ?? "concept", S = !!l.concept?.done || /\*\*Subject:\*\*\s*\S/.test(t.concept ?? ""), E = !!l.image?.done || g.length > 0, B = !!l.mesh?.done || !!m && !!x, M = !!x, I = Ba(s.print, /^slicing-notes\.md$/), L = t.hasReadme && (f === "ready" || f === "published"), c = t.printLog.filter((W) => !W.skipped), O = c[c.length - 1] ?? null, T = !O && t.printLog.some((W) => W.skipped), _ = !!l.print_test?.done || t.printLog.length > 0, y = [S, E, B, M, I, _, L];
  !m && (ue(t.viewsInbox ?? []).length || t.viewsPrompt && !ue(t.views ?? []).length) && (y[1] = !1);
  const F = t.branch && t.branch !== "main" ? t.branches?.find((W) => W.id === t.branch) : null, b = F ? Math.max(0, ["concept", "image", "mesh", "blender", "validate", "print", "publish"].indexOf(F.from_step)) : 0;
  for (let W = 0; W < b; W++) y[W] = !0;
  const j = y.indexOf(!1), d = [];
  d.push({
    id: "concept",
    title: "Concept",
    agent: "Muse",
    result: S ? `${t.meta.model_type ?? "type not set"} · ${t.meta.scale_mm ? t.meta.scale_mm + " mm" : "scale not set"}` : "No concept yet",
    hint: S ? "Concept is written. Re-run to change type or scale." : "Muse writes the concept and picks static / flexi / functional.",
    thumb: null,
    primary: S ? null : Y("Write concept", "ai3d-muse", "*concept"),
    more: [Y("Re-check model type", "ai3d-muse", "*type")]
  });
  let u, p;
  const U = ue(t.views ?? []), q = ue(t.viewsInbox ?? []), ie = !!t.viewsPrompt && !U.length && !q.length && !m;
  E && ie ? (u = {
    kind: "human",
    label: "Generate the views in Gemini, save them into inbox/views/",
    copy: t.viewsPrompt?.text ?? "",
    copyLabel: `Copy ${t.viewsPrompt?.name}`,
    folder: "inbox/views"
  }, p = `Your turn: run each view prompt of ${t.viewsPrompt?.name} in Gemini with the accepted image attached; save front.png, left.png, back.png, right.png into inbox/views/.`) : E && q.length > 0 ? (u = Y(`Review ${q.length} view${q.length === 1 ? "" : "s"}`, "ai3d-lumen", "*review-views"), p = "Lumen checks the views against the accepted image (same proportions, colours, pose) and files them as front / left / back / right.") : E ? (u = null, p = `${g.length} image${g.length === 1 ? "" : "s"} accepted.${U.length ? ` ${U.length} views for multi-view 3D.` : " Optional: prepare front / left / back / right views for multi-view 3D (Other actions → Prepare views)."}`) : o.length > 0 ? (u = Y(`Review ${o.length} image${o.length === 1 ? "" : "s"} in inbox`, "ai3d-lumen", "*review"), p = "Lumen reads the inbox images and either accepts one or writes the next prompt.") : t.imagePrompt ? (u = {
    kind: "human",
    label: "Generate in Gemini, save into inbox/",
    copy: t.imagePrompt.text ?? "",
    copyLabel: `Copy ${t.imagePrompt.name}`,
    folder: "inbox"
  }, p = `Your turn: paste ${t.imagePrompt.name} into Gemini and save the image into inbox/.`) : (u = Y("Write image prompt", "ai3d-lumen", "*prompt"), p = "Lumen writes the first Gemini prompt."), d.push({
    id: "image",
    title: "Image",
    agent: "Lumen",
    result: E ? `${g.length} accepted${U.length ? ` · ${U.length} views` : ""}` : o.length ? `${o.length} in inbox` : t.imagePrompt ? `${t.imagePrompt.name} ready` : "No prompt yet",
    hint: p,
    thumb: g[0] ? `images/${g[0].name}` : o[0] ? `inbox/${o[0].name}` : null,
    primary: u,
    more: [
      Y("Write next prompt", "ai3d-lumen", "*prompt"),
      Y("Review inbox", "ai3d-lumen", "*review"),
      Y("Accept image", "ai3d-lumen", "*accept"),
      Y("Prepare views for 3D (front, left, back, right)", "ai3d-lumen", "*views"),
      Y("Review the views", "ai3d-lumen", "*review-views")
    ]
  });
  let Z, X;
  B ? (Z = null, X = "Mesh accepted.") : m ? (Z = Y("Review the mesh", "ai3d-chisel", "*review-mesh"), X = "Chisel checks the mesh against the concept and accepts it or changes the settings.") : t.prompt3d ? (Z = {
    kind: "human",
    label: "Run the 3D service, save mesh/raw.glb",
    copy: t.prompt3d,
    copyLabel: "Copy 3D spec",
    folder: "mesh"
  }, X = "Your turn: upload the accepted image to the 3D service and save the export as mesh/raw.glb.") : (Z = Y("Write 3D spec", "ai3d-chisel", "*3d-prompt"), X = "Chisel writes the service settings for the accepted image."), d.push({
    id: "mesh",
    title: "3D mesh",
    agent: "Chisel",
    result: m ? `${m.name} · ${Nn(m.size)}` : t.prompt3d ? "3D spec ready" : "No mesh yet",
    hint: X,
    thumb: null,
    primary: Z,
    more: [
      Y("Write 3D spec", "ai3d-chisel", "*3d-prompt"),
      Y("Review mesh", "ai3d-chisel", "*review-mesh"),
      Y("Accept mesh", "ai3d-chisel", "*accept-mesh")
    ]
  });
  const $e = [
    Y("Inspect only", "ai3d-kiln", "*inspect"),
    Y("Optimize again", "ai3d-kiln", "*optimize"),
    Y("Build flexi joints", "ai3d-kiln", "*flexi"),
    Y("Render previews", "ai3d-kiln", "*render"),
    { kind: "script", label: "Build interactive 3D view", script: "view" },
    Y("Export clearance coupon", "ai3d-kiln", "*coupon"),
    Y("Blender command (free text)", "ai3d-kiln", "*run")
  ];
  d.push({
    id: "blender",
    title: "Blender",
    agent: "Kiln",
    result: x ? [v?.overhang_pct != null ? `overhang ${v.overhang_pct} %` : null, t.analysis?.side_on_bed ? `${t.analysis.side_on_bed} on bed` : null, Nn(x.size)].filter(Boolean).join(" · ") : "Not optimised yet",
    hint: x ? C ? "Print file exists. Build or rebuild flexi joints if needed." : "Print file exists." : "Kiln works in Blender: solid mesh, bed side, flat cut, overhang check. It asks you for two verdicts.",
    thumb: w[0] ? `renders/${w[0].name}` : null,
    primary: x ? null : Y("Optimize in Blender", "ai3d-kiln", "*optimize"),
    more: $e
  }), d.push({
    id: "validate",
    title: "Validate",
    agent: "Anvil",
    result: I ? "Slicing notes written" : "Not validated yet",
    hint: I ? "Checklist and slicing notes are in print/." : "Anvil runs the print-ready checklist and writes the slicing notes.",
    thumb: null,
    primary: I ? null : Y("Validate and write slicing notes", "ai3d-anvil", "*validate", "When the checklist passes, continue with *slice."),
    more: [Y("Validate", "ai3d-anvil", "*validate"), Y("Slicing notes", "ai3d-anvil", "*slice")]
  });
  const Be = ue(t.printPhotos);
  d.push({
    id: "print",
    title: "Test print",
    agent: "Anvil",
    result: O ? `${O.result}${O.printer ? ` · ${O.printer}` : ""}${c.length > 1 ? ` · ${c.length} prints` : ""}` : T ? "Skipped" : "Not printed yet",
    hint: O ? O.change ? `Change next time: ${O.change}` : "Logged. Print again after changes, or move on." : T ? "Skipped for this model." : "Print mesh/print.stl, then log the result with a photo. Or skip it for a shape you have already proven.",
    thumb: Be.length ? `print/photos/${Be[Be.length - 1].name}` : null,
    primary: _ ? null : { kind: "human", label: "Print mesh/print.stl, then log the result", folder: "print" },
    more: [
      { kind: "form", label: "Log a test print…", form: "print-log" },
      { kind: "form", label: "Skip the test print", form: "print-skip" },
      Y("Log with Anvil (reads the photos)", "ai3d-anvil", "*print-log")
    ]
  });
  let be;
  t.hasReadme ? f !== "ready" && f !== "published" ? be = Y("Mark ready", "ai3d-herald", "*ready") : be = null : be = t.meta.summary && a.tools.buildReadme ? { kind: "script", label: "Build README", script: "readme" } : Y("Write README", "ai3d-herald", "*readme");
  const R = [
    Y("Write README text", "ai3d-herald", "*readme"),
    Y("Mark ready", "ai3d-herald", "*ready"),
    Y("Write listing", "ai3d-herald", "*listing"),
    Y("Mark published", "ai3d-herald", "*publish")
  ];
  return a.tools.buildReadme && R.unshift({ kind: "script", label: "Rebuild README (no agent)", script: "readme" }), d.push({
    id: "publish",
    title: "Publish",
    agent: "Herald",
    result: t.hasReadme ? `README · ${f}` : "No README yet",
    hint: L ? "Model is ready." : t.hasReadme ? "README exists. Mark the model ready when you are happy with it." : "Herald builds the README with images, description and the STL link.",
    thumb: null,
    primary: be,
    more: R
  }), d.map((W, de) => {
    let pe;
    return y[de] ? pe = "done" : j === de ? pe = W.primary?.kind === "human" ? "waiting" : "active" : pe = "locked", { ...W, n: de + 1, state: pe };
  });
}
const De = ["concept", "image", "mesh", "blender", "validate", "print", "publish"], He = (t, a, l) => ({ kind: "agent", label: t, skill: a, trigger: l }), Ta = /* @__PURE__ */ new Set([
  "ai3d-muse *concept",
  "ai3d-lumen *prompt",
  "ai3d-lumen *views",
  "ai3d-chisel *3d-prompt",
  "ai3d-kiln *optimize",
  "ai3d-kiln *flexi",
  "ai3d-anvil *validate",
  "ai3d-herald *readme"
]), $n = (t) => t.kind === "agent" && Ta.has(`${t.skill} ${t.trigger}`), ft = {
  concept: [He("Write concept", "ai3d-muse", "*concept")],
  image: [He("Write image prompt", "ai3d-lumen", "*prompt"), He("Prepare views for 3D", "ai3d-lumen", "*views")],
  mesh: [He("Write 3D spec", "ai3d-chisel", "*3d-prompt")],
  blender: [He("Optimize in Blender", "ai3d-kiln", "*optimize"), He("Build flexi joints", "ai3d-kiln", "*flexi")],
  validate: [He("Validate and write slicing notes", "ai3d-anvil", "*validate")],
  publish: [He("Write README", "ai3d-herald", "*readme")]
};
function Bn(t, a, l, s, o, g) {
  const w = l.root.startsWith(l.workspace) ? l.root.slice(l.workspace.length + 1) || "." : l.root, m = [`Use the \`${t.skill}\` skill from the AI3D Forge BMAD module and run its \`${t.trigger}\` action.`], x = (C) => C.startsWith(l.workspace) ? C.slice(l.workspace.length + 1) || "." : C;
  if (a) {
    if (m.push(`Model: \`${a.slug}\` — model folder \`${x(a.rootDir ?? `${l.root}/${a.slug}`)}/\`. Work only on this model.`), a.migrated || a.branches?.length > 1) {
      const C = a.branches.find((v) => v.id === a.branch);
      m.push(`Branch: \`${a.branch}\`${C && C.name !== a.branch ? ` (${C.name})` : ""}. Work folder: \`${x(a.dir)}/\` — read and write every step file (concept.md, metadata.json, prompts/, inbox/, images/, mesh/, print/, renders/, publish/, README.md) in this folder, not in the model folder. flow.json stays in the model folder; flow_log.py accepts the work folder and records the branch.`), C?.source && m.push(`This branch started from a ${C.source.kind}: ${C.source.kind === "text" ? "see refs/source.md" : C.source.ref}${C.source.kind === "link" ? " (also in refs/source.md)" : ""}.`), C?.description && m.push(`Why this branch: ${C.description}`);
    }
  } else m.push(`Models folder: \`${w}/\`.`);
  if (s && m.push(`Input from the user: ${s}`), o && a) {
    const C = o.node;
    m.push(`Flow node: \`${C.id}\` (step ${C.step}), created by the panel with status running. Do not add a new node: update this one when you finish` + (o.flowLog ? ` with \`python3 ${o.flowLog} update ${a.dir} ${C.id} ...\`` : "") + " (rules: ai3d-forge/references/flow-graph.md)."), C.parent && m.push(`This attempt grows from node \`${C.parent}\`.`);
    const v = Object.entries(C.settings);
    v.length && m.push(`Settings for this attempt, use exactly these and do not fall back to defaults: ${v.map(([f, S]) => `${f}=${S}`).join(", ")}.`), C.description && m.push(`What is different this time: ${C.description}`);
  }
  return t.extra && m.push(t.extra), m.push("Follow the skill's HALT rules: stop and ask me whenever a verdict or an off-tool step is needed."), g === "medium" && m.push("Think about the options before you act."), g === "high" && m.push("Think hard: weigh the options and check the numbers before you act."), g === "max" && m.push("Ultrathink: this step needs your deepest reasoning before you act."), m.join(`
`);
}
const Ze = (t) => De.indexOf(t), ji = (t, a) => t.created_at < a.created_at ? -1 : t.created_at > a.created_at ? 1 : 0;
function lt(t, a) {
  return t.filter((l) => l.step === a).sort(ji);
}
function Ma(t) {
  const a = t.filter((l) => l.verdict !== "rejected" && l.status !== "error");
  return a.length ? a.sort((l, s) => Ze(s.step) - Ze(l.step) || +(s.verdict === "accepted") - +(l.verdict === "accepted") || ji(s, l))[0] : null;
}
function La(t, a) {
  const l = new Map(t.map((g) => [g.id, g])), s = /* @__PURE__ */ new Set();
  let o = a ? l.get(a) : void 0;
  for (; o && !s.has(o.id); )
    s.add(o.id), o = o.parent ? l.get(o.parent) : void 0;
  return s;
}
function Ea(t, a) {
  if (a === "image") {
    const l = lt(t, "image").filter((s) => s.verdict !== "accepted");
    if (l.length) return l[l.length - 1].id;
  }
  for (let l = Ze(a) - 1; l >= 0; l--) {
    const s = lt(t, De[l]).filter((g) => g.verdict !== "rejected" && g.status !== "error");
    if (!s.length) continue;
    const o = s.filter((g) => g.verdict === "accepted");
    return (o.length ? o : s).slice(-1)[0].id;
  }
  return null;
}
function Fa(t) {
  return t.step === "image" ? t.id : t.parent;
}
function Oa(t) {
  const a = De.map(() => 0), l = [];
  for (let s = 0; s < De.length; s++)
    lt(t, De[s]).forEach((o, g) => {
      l.push({ node: o, row: s, slot: g }), a[s] = g + 1;
    });
  return { placed: l, slots: a };
}
function Ia(t, a = 2) {
  const l = Object.entries(t.settings);
  return l.length ? l.slice(0, a).map(([s, o]) => `${s}=${o}`).join(" ") + (l.length > a ? ` +${l.length - a}` : "") : "";
}
const Pe = (t) => t.branch ?? "main";
function Wa(t, a) {
  const l = t.branches.find((s) => s.id === a);
  return !l || l.id === t.branch ? t : { ...t, ...l.work, meta: { ...l.work.meta, title: t.meta.title ?? l.work.meta.title }, branch: l.id };
}
function Ut(t) {
  return t.branches.find((a) => a.id === t.branch) ?? null;
}
function st(t, a = t.flow.nodes) {
  return a.filter((l) => Pe(l) === t.branch);
}
function It(t, a, l) {
  return Ea(st(t, a), l) ?? Ut(t)?.from_node ?? null;
}
function za(t) {
  const a = [t.primary ? "primary" : null, t.status !== "open" ? t.status : null].filter(Boolean);
  return `${t.name}${a.length ? ` (${a.join(", ")})` : ""}`;
}
const Cn = (t, a) => Math.max(0, t.branches.findIndex((l) => l.id === a));
function _n(t, a) {
  return t.branches.find((l) => l.id === Pe(a))?.work.dir ?? t.dir;
}
const Di = [
  { value: "", label: "Default (Nimbalyst setting)" },
  { value: "claude-code:opus", label: "Opus — deepest, slowest, most expensive" },
  { value: "claude-code:sonnet", label: "Sonnet — balanced" },
  { value: "claude-code:haiku", label: "Haiku — fastest, cheapest" }
], en = [
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
function qt(t, a) {
  const l = {};
  for (const s of `${a},${t ?? ""}`.split(/[,\s]+/)) {
    const [o, g] = s.split("=");
    o && g !== void 0 && (l[o.trim()] = g.trim());
  }
  return l;
}
const ri = (t) => Ai.map((a) => `${a.id}=${t[a.id] ?? ""}`).join(","), Ka = {
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
function gt(t, a, l, s) {
  let o = a ?? Ka[l] ?? "concept";
  !a && l === "ai3d-muse" && (s === "*prepare" || s === "*idea") && (o = "ideas");
  const g = qt(t.step_models, Ri), w = qt(t.step_effort, Pi), m = g[o] ?? "", x = !m || m === "default" ? "" : m.includes(":") ? m : `claude-code:${m}`, C = w[o];
  return { model: x, effort: en.some((v) => v.value === C) ? C : "medium" };
}
const un = (t) => t ? t.replace(/^claude-code:/, "").replace(/^./, (a) => a.toUpperCase()) : "default model", oi = (t) => en.find((a) => a.value === t)?.keyword ?? "";
function Tn({ value: t, onChange: a }) {
  return /* @__PURE__ */ i("span", { className: "a3d-row a3d-runpick", children: [
    /* @__PURE__ */ i("label", { children: [
      "Model",
      /* @__PURE__ */ e("select", { value: t.model, onChange: (l) => a({ ...t, model: l.target.value }), children: Di.map((l) => /* @__PURE__ */ e("option", { value: l.value, children: l.label }, l.value)) })
    ] }),
    /* @__PURE__ */ i("label", { children: [
      "Reasoning",
      /* @__PURE__ */ e("select", { value: t.effort, onChange: (l) => a({ ...t, effort: l.target.value }), children: en.map((l) => /* @__PURE__ */ e("option", { value: l.value, children: l.label }, l.value)) })
    ] })
  ] });
}
const me = (...t) => t.map((a) => typeof a == "string" ? { value: a, label: a } : { value: a[0], label: a[1] }), Ga = {
  concept: [
    { key: "model_type", label: "Model type", help: "Static figure, print-in-place flexi, or a functional part.", kind: "choice", choices: me("static", "flexi", "functional") },
    { key: "scale_mm", label: "Size", help: "Longest side of the printed model.", kind: "number", unit: "mm", min: 10, max: 400, step: 5, placeholder: "120" },
    { key: "style", label: "Style", help: "How it should look.", kind: "text", placeholder: "chibi, low-poly, realistic…" },
    { key: "print_target", label: "Printer type", help: "Drives wall thickness and the smallest detail.", kind: "choice", choices: me("FDM", "resin") }
  ],
  image: [
    { key: "mode", label: "How", help: "A new picture from scratch, or an edit of the previous one (keeps the pose, changes a detail).", kind: "choice", choices: me(["new", "New picture"], ["edit", "Edit the previous picture"]) },
    { key: "view", label: "Camera", help: "Three-quarter front suits single-image 3D best.", kind: "choice", choices: me(["three-quarter", "Three-quarter front"], ["front", "Front"], ["side", "Side"]) },
    { key: "style", label: "Style", help: "Overrides the style of the concept for this picture.", kind: "text", placeholder: "chibi, clay toy, low-poly…" },
    { key: "aspect", label: "Aspect ratio", help: "", kind: "choice", choices: me("1:1", "4:3", "3:4") },
    { key: "backend", label: "Image model", help: "Which Gemini model the prompt is written for.", kind: "choice", choices: me(["nano-banana-pro", "Nano Banana Pro (quality)"], ["nano-banana-2", "Nano Banana 2 (speed)"]) }
  ],
  mesh: [
    { key: "service", label: "3D service", help: "The spec is written for this service.", kind: "choice", choices: me(["tripo3d", "Tripo3D"], ["meshy", "Meshy"], ["rodin", "Rodin / Hyper3D"], ["hitem3d", "Hitem3D"]) },
    { key: "mode", label: "Input", help: "Multi-view needs accepted views (Image step → Prepare views).", kind: "choice", choices: me(["single", "One image"], ["multiview", "Multi-view (front, left, back, right)"]) },
    { key: "texture", label: "Texture", help: "Off is enough for printing and costs fewer credits.", kind: "choice", choices: me("off", "on") },
    { key: "topology", label: "Topology", help: "Quad is cleaner to edit in Blender.", kind: "choice", choices: me("quad", "triangle") },
    { key: "face_limit", label: "Face limit", help: "50 000–200 000 is plenty for a print.", kind: "number", min: 5e3, max: 2e6, step: 5e3, placeholder: "100000" },
    { key: "segmentation", label: "Split into parts", help: "On for flexi models and models you will print in parts.", kind: "choice", choices: me("on", "off") },
    { key: "symmetry", label: "Symmetry", help: "On for symmetric animals and characters.", kind: "choice", choices: me("on", "off", "auto") }
  ],
  blender: [
    { key: "side_on_bed", label: "Side on the bed", help: "Which side lies on the print bed. Analyze lists the best ones.", kind: "choice", choices: me("bottom", "back", "front", "left", "right", "top") },
    { key: "cut_mm", label: "Flat cut", help: "How much is cut off for a flat base (0.5–1.5 is usual).", kind: "number", unit: "mm", min: 0, max: 20, step: 0.1, placeholder: "1" },
    { key: "overhang_deg", label: "Overhang angle", help: "Faces steeper than this count as needing support.", kind: "number", unit: "°", min: 20, max: 75, step: 1, placeholder: "45" },
    { key: "scale_mm", label: "Size", help: "Longest side after scaling.", kind: "number", unit: "mm", min: 10, max: 400, step: 5, placeholder: "120" },
    { key: "flexi", label: "Flexi joints", help: "Build print-in-place joints.", kind: "choice", choices: me("yes", "no") },
    { key: "segments", label: "Segments", help: "Number of body segments for flexi.", kind: "number", min: 2, max: 30, step: 1, placeholder: "9" },
    { key: "clearance_mm", label: "Joint clearance", help: "Gap in the joints; take it from your coupon print.", kind: "number", unit: "mm", min: 0.1, max: 1, step: 0.05, placeholder: "0.35" }
  ],
  validate: [
    { key: "slicer", label: "Slicer", help: "The slicing notes use its setting names.", kind: "choice", choices: me("Bambu Studio", "OrcaSlicer", "PrusaSlicer", "Cura") },
    { key: "nozzle_mm", label: "Nozzle", help: "", kind: "choice", choices: me("0.2", "0.4", "0.6", "0.8") },
    { key: "layer_mm", label: "Layer height", help: "", kind: "number", unit: "mm", min: 0.04, max: 0.6, step: 0.02, placeholder: "0.16" },
    { key: "material", label: "Material", help: "", kind: "choice", choices: me("PLA", "PETG", "TPU", "ABS / ASA") }
  ],
  publish: [
    { key: "target", label: "Marketplace", help: "The listing is written for it.", kind: "choice", choices: me(["makerworld", "MakerWorld"], ["printables", "Printables"], ["thingiverse", "Thingiverse"], ["cults3d", "Cults3D"]) },
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
function Ua({ model: t, scan: a, stepTitle: l, initial: s, busy: o, onCancel: g, onRun: w, onBranch: m, defaultRun: x }) {
  const C = Ga[s.step] ?? [], v = new Set(C.map((R) => R.key)), f = Object.entries(s.settings).filter(([R]) => !Ha.has(R)), [S, E] = A(Object.fromEntries(f.filter(([R]) => v.has(R)))), [B, M] = A(f.filter(([R]) => !v.has(R))), [I, L] = A(s.description), [c, O] = A(s.parent ?? ""), T = s.settings.run_model !== void 0 ? { model: s.settings.run_model === "default" ? "" : `claude-code:${s.settings.run_model}`, effort: s.settings.run_effort || x.effort } : null, [_, y] = A(s.run ?? T ?? x), F = ft[s.step] ?? [], [b, j] = A(0), d = Ze(s.step), u = t.flow.nodes.filter((R) => Ze(R.step) <= d && !R.archived), p = t.flow.nodes.find((R) => R.id === c) ?? null, U = Va[s.step] ?? [], q = je(() => {
    const R = {};
    for (const W of C) (S[W.key] ?? "").trim() && (R[W.key] = S[W.key].trim());
    for (const [W, de] of B) W.trim() && de.trim() && (R[W.trim()] = de.trim());
    return R;
  }, [C, S, B]), ie = Object.entries(q), Z = (R, W) => E((de) => ({ ...de, [R]: W })), X = (R, W, de) => M((pe) => pe.map((we, Te) => Te === R ? W === 0 ? [de, we[1]] : [we[0], de] : we)), $e = je(() => {
    const R = F[b];
    if (!R) return "";
    const W = {
      id: "<new node id>",
      step: s.step,
      agent: "",
      label: "",
      parent: c || null,
      status: "running",
      verdict: null,
      created_at: "",
      finished_at: null,
      settings: q,
      description: I.trim(),
      outcome: "",
      files: [],
      branch: t.branch
    };
    return Bn(R, t, a, void 0, { node: W, flowLog: a.tools.flowLog }, _.effort);
  }, [F, b, s.step, c, q, I, t, a, _.effort]), Be = () => w(F[b], { step: s.step, parent: c || null, settings: q, description: I.trim(), run: _ }), be = !I.trim() && ie.length === 0;
  return /* @__PURE__ */ e("div", { className: "a3d-overlay", onClick: g, children: /* @__PURE__ */ i("form", { className: "a3d-dialog a3d-dialog-wide a3d-attempt", onClick: (R) => R.stopPropagation(), onSubmit: (R) => {
    R.preventDefault(), Be();
  }, children: [
    /* @__PURE__ */ i("header", { children: [
      /* @__PURE__ */ i("h3", { children: [
        "Try the ",
        l(s.step),
        " step again"
      ] }),
      /* @__PURE__ */ i("p", { className: "a3d-muted", children: [
        "A new try next to the earlier ones",
        t.branches.length > 1 ? ` in branch ${t.branch}` : "",
        "; nothing is overwritten.",
        p ? /* @__PURE__ */ i(ee, { children: [
          " Continues from ",
          /* @__PURE__ */ e("strong", { children: p.label }),
          "."
        ] }) : null
      ] })
    ] }),
    F.length > 1 && /* @__PURE__ */ i("label", { children: [
      "What to run",
      /* @__PURE__ */ e("select", { value: b, onChange: (R) => j(Number(R.target.value)), children: F.map((R, W) => /* @__PURE__ */ e("option", { value: W, children: R.label }, R.trigger)) })
    ] }),
    /* @__PURE__ */ i("section", { className: "a3d-attempt-sec", children: [
      /* @__PURE__ */ e("label", { htmlFor: "a3d-attempt-what", children: /* @__PURE__ */ e("strong", { children: "1 · What should be different this time?" }) }),
      /* @__PURE__ */ e(
        "textarea",
        {
          id: "a3d-attempt-what",
          rows: 3,
          autoFocus: !0,
          value: I,
          onChange: (R) => L(R.target.value),
          placeholder: "In your own words. The agent reads it first, and it stays on the attempt as its description."
        }
      ),
      U.length > 0 && /* @__PURE__ */ e("span", { className: "a3d-row", children: U.map((R) => /* @__PURE__ */ i("button", { type: "button", className: "a3d-chipbtn", onClick: () => L((W) => W.trim() ? `${W.trim().replace(/[.;]$/, "")}; ${R.charAt(0).toLowerCase()}${R.slice(1)}` : R), children: [
        "+ ",
        R
      ] }, R)) })
    ] }),
    C.length > 0 && /* @__PURE__ */ i("section", { className: "a3d-attempt-sec", children: [
      /* @__PURE__ */ e("strong", { children: "2 · Options to change" }),
      /* @__PURE__ */ e("p", { className: "a3d-muted a3d-small", children: "Leave an option on “agent decides” to keep what the agent would pick. A chosen option is passed as “use exactly this” and saved on the attempt." }),
      /* @__PURE__ */ e("div", { className: "a3d-optgrid", children: C.map((R) => /* @__PURE__ */ i("label", { className: S[R.key] ? "a3d-opt a3d-opt-set" : "a3d-opt", title: R.help, children: [
        /* @__PURE__ */ i("span", { children: [
          R.label,
          R.unit ? /* @__PURE__ */ i("span", { className: "a3d-muted", children: [
            " (",
            R.unit,
            ")"
          ] }) : null
        ] }),
        R.kind === "choice" ? /* @__PURE__ */ i("select", { value: S[R.key] ?? "", onChange: (W) => Z(R.key, W.target.value), children: [
          /* @__PURE__ */ e("option", { value: "", children: "agent decides" }),
          (R.choices.some((W) => W.value === S[R.key]) || !S[R.key] ? R.choices : [...R.choices, { value: S[R.key], label: S[R.key] }]).map((W) => /* @__PURE__ */ e("option", { value: W.value, children: W.label }, W.value))
        ] }) : /* @__PURE__ */ e(
          "input",
          {
            type: R.kind === "number" ? "number" : "text",
            min: R.min,
            max: R.max,
            step: R.step,
            value: S[R.key] ?? "",
            onChange: (W) => Z(R.key, W.target.value),
            placeholder: R.kind === "number" ? `agent decides (e.g. ${R.placeholder})` : R.placeholder
          }
        ),
        R.help && /* @__PURE__ */ e("span", { className: "a3d-muted a3d-small", children: R.help })
      ] }, R.key)) })
    ] }),
    (s.step === "image" || s.step === "mesh") && /* @__PURE__ */ i("p", { className: "a3d-muted a3d-small", children: [
      "Another picture, a link or a ready 3D file instead of other options?",
      " ",
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: m, children: "Start a branch with it" }),
      " — it gets its own files to the end."
    ] }),
    /* @__PURE__ */ i("details", { className: "a3d-attempt-more", children: [
      /* @__PURE__ */ e("summary", { children: "More: continues from, model and reasoning, own option, the prompt" }),
      /* @__PURE__ */ i("label", { children: [
        "Continues from",
        /* @__PURE__ */ i("select", { value: c, onChange: (R) => O(R.target.value), children: [
          /* @__PURE__ */ e("option", { value: "", children: "Nothing (start of this line)" }),
          u.map((R) => /* @__PURE__ */ i("option", { value: R.id, children: [
            t.branches.length > 1 ? `[${Pe(R)}] ` : "",
            l(R.step),
            " · ",
            R.label,
            R.verdict ? ` (${R.verdict})` : ""
          ] }, R.id))
        ] }),
        /* @__PURE__ */ e("span", { className: "a3d-muted a3d-small", children: "The earlier try this one builds on. It only draws the arrow in the graph and tells the agent what to start from." })
      ] }),
      /* @__PURE__ */ e(Tn, { value: _, onChange: y }),
      /* @__PURE__ */ i("fieldset", { className: "a3d-fields", children: [
        /* @__PURE__ */ e("legend", { children: "Own option" }),
        /* @__PURE__ */ i("p", { className: "a3d-muted a3d-small", children: [
          "For something the list does not have: a name and a value, passed to the agent as it is (for example ",
          /* @__PURE__ */ e("code", { children: "pose = sitting" }),
          ")."
        ] }),
        B.map(([R, W], de) => /* @__PURE__ */ i("div", { className: "a3d-kvrow", children: [
          /* @__PURE__ */ e("input", { "aria-label": "Option name", placeholder: "name", value: R, onChange: (pe) => X(de, 0, pe.target.value) }),
          /* @__PURE__ */ e("input", { "aria-label": "Option value", placeholder: "value", value: W, onChange: (pe) => X(de, 1, pe.target.value) }),
          /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", "aria-label": "Remove option", onClick: () => M((pe) => pe.filter((we, Te) => Te !== de)), children: "×" })
        ] }, de)),
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => M((R) => [...R, ["", ""]]), children: "+ Add own option" })
      ] }),
      /* @__PURE__ */ i("details", { children: [
        /* @__PURE__ */ e("summary", { children: "Prompt sent to the agent session" }),
        /* @__PURE__ */ e("pre", { className: "a3d-cmd", children: $e })
      ] })
    ] }),
    /* @__PURE__ */ i("footer", { className: "a3d-attempt-foot", children: [
      /* @__PURE__ */ e("span", { className: "a3d-muted a3d-small", children: ie.length ? /* @__PURE__ */ i(ee, { children: [
        "Changed: ",
        ie.map(([R, W]) => /* @__PURE__ */ i("span", { className: "a3d-pill", children: [
          R,
          " = ",
          W
        ] }, R))
      ] }) : be ? "Nothing changed yet: the agent would repeat the step with its defaults." : "No options changed; the agent follows your text." }),
      /* @__PURE__ */ i("span", { className: "a3d-row a3d-row-end", children: [
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: g, children: "Cancel" }),
        /* @__PURE__ */ i("button", { type: "submit", className: "a3d-btn a3d-btn-primary", disabled: o || !F.length, children: [
          "Run: ",
          F[b]?.label
        ] })
      ] })
    ] })
  ] }) });
}
const ye = 172, Ue = 58, at = 22, Je = 80, mn = 132, pt = 10, Wt = 34, zt = (t, a) => t.length > a ? `${t.slice(0, a - 1)}…` : t, di = { done: "done", active: "next", waiting: "your turn", locked: "locked" }, Jt = { running: "running", open: "waiting", done: "done", error: "failed" }, ci = { running: "", open: "", done: "✓", error: "!" };
function Ja({ model: t, steps: a, selectedNode: l, selectedStep: s, compare: o, showArchived: g, onSelectNode: w, onSelectStep: m, onNew: x, onSelectBranch: C }) {
  const v = Bi(t.flow.nodes, g), f = t.branches.filter((b) => g || b.status !== "archived" || b.id === t.branch), S = new Set(f.map((b) => b.id)), E = v.filter((b) => S.has(Pe(b))), B = f.length > 1, M = Ma(E.filter((b) => Pe(b) === t.branch)), I = La(E, M?.id ?? null), L = pt + (B ? Wt : 0), c = /* @__PURE__ */ new Map(), O = [];
  let T = mn;
  for (const b of f) {
    const j = E.filter((q) => Pe(q) === b.id), { placed: d, slots: u } = Oa(j), p = Math.max(1, ...u) + (b.id === t.branch ? 1 : 0);
    for (const q of d)
      c.set(q.node.id, { x: T + q.slot * (ye + at), y: L + q.row * Je + (Je - Ue) / 2, row: q.row, lane: b.id });
    const U = p * (ye + at) - at + (B ? 16 : 0);
    O.push({ id: b.id, x: T - (B ? 8 : 0), w: U, slots: u, color: Cn(t, b.id) }), T += U + (B ? at + 8 : at);
  }
  const _ = Math.max(T, mn + 2 * (ye + at)), y = L + De.length * Je, F = E.filter((b) => b.parent && c.has(b.parent) && c.has(b.id)).map((b) => {
    const j = c.get(b.parent), d = c.get(b.id);
    let u;
    if (j.row === d.row) {
      const p = j.y + Ue / 2;
      u = j.x < d.x ? `M${j.x + ye},${p} L${d.x},${p}` : `M${j.x},${p} L${d.x + ye},${p}`;
    } else {
      const p = j.x + ye / 2, U = j.y + Ue, q = d.x + ye / 2, ie = d.y, Z = (U + ie) / 2;
      u = `M${p},${U} C${p},${Z} ${q},${Z} ${q},${ie}`;
    }
    return { id: `${b.parent}>${b.id}`, d: u, on: I.has(b.id) && I.has(b.parent), cross: j.lane !== d.lane };
  });
  return /* @__PURE__ */ i("section", { className: "a3d-graph", "aria-label": "Flow graph", children: [
    /* @__PURE__ */ e("div", { className: "a3d-graph-scroll", children: /* @__PURE__ */ i("svg", { width: _, height: y, viewBox: `0 0 ${_} ${y}`, role: "group", "aria-label": `Flow of ${t.meta.title || t.slug}`, children: [
      /* @__PURE__ */ e("defs", { children: /* @__PURE__ */ e("marker", { id: "a3d-arrow", viewBox: "0 0 8 8", refX: "7", refY: "4", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse", children: /* @__PURE__ */ e("path", { d: "M0,0 L8,4 L0,8 z", className: "a3d-g-arrow" }) }) }),
      De.map((b, j) => {
        const d = a.find((U) => U.id === b), u = L + j * Je, p = d?.state === "active" || d?.state === "waiting";
        return /* @__PURE__ */ i("g", { className: `a3d-g-row a3d-g-${d?.state ?? "locked"}${s === b ? " a3d-g-rowsel" : ""}`, children: [
          /* @__PURE__ */ e("rect", { x: 0, y: u, width: _, height: Je, className: j % 2 ? "a3d-g-band a3d-g-band2" : "a3d-g-band" }),
          /* @__PURE__ */ i(
            "g",
            {
              tabIndex: 0,
              role: "button",
              "aria-label": `Step ${j + 1} ${d?.title ?? b}, ${di[d?.state ?? "locked"]}`,
              onClick: () => m(b),
              onKeyDown: (U) => {
                (U.key === "Enter" || U.key === " ") && (U.preventDefault(), m(b));
              },
              className: "a3d-g-label",
              children: [
                /* @__PURE__ */ e("rect", { x: 4, y: u + 6, width: mn - 12, height: Je - 12, rx: 6, className: "a3d-g-labelbg" }),
                /* @__PURE__ */ i("text", { x: 14, y: u + 28, className: "a3d-g-steptitle", children: [
                  p ? "▶ " : "",
                  j + 1,
                  " · ",
                  d?.title ?? b
                ] }),
                /* @__PURE__ */ i("text", { x: 14, y: u + 45, className: "a3d-g-stepsub", children: [
                  d?.agent,
                  " · ",
                  di[d?.state ?? "locked"]
                ] })
              ]
            }
          )
        ] }, b);
      }),
      B && O.map((b) => {
        const j = t.branches.find((u) => u.id === b.id), d = b.id === t.branch;
        return /* @__PURE__ */ i("g", { className: `a3d-g-lane a3d-lane-c${b.color % 8}${d ? " a3d-g-lanesel" : ""}`, children: [
          /* @__PURE__ */ e("rect", { x: b.x, y: pt, width: b.w, height: y - pt, rx: 8, className: "a3d-g-lanebg" }),
          /* @__PURE__ */ i(
            "g",
            {
              tabIndex: 0,
              role: "button",
              "aria-pressed": d,
              "aria-label": `Branch ${j.name}${j.primary ? ", primary" : ""}${j.status !== "open" ? `, ${j.status}` : ""}`,
              onClick: () => C(b.id),
              onKeyDown: (u) => {
                (u.key === "Enter" || u.key === " ") && (u.preventDefault(), C(b.id));
              },
              children: [
                /* @__PURE__ */ e("title", { children: [`Branch ${j.name}`, j.source ? `from ${j.source.kind}: ${j.source.ref}` : null, j.from_step !== "concept" ? `starts at ${j.from_step}` : null, j.description].filter(Boolean).join(`
`) }),
                /* @__PURE__ */ e("rect", { x: b.x, y: pt, width: b.w, height: Wt - 6, rx: 8, className: "a3d-g-lanehead" }),
                /* @__PURE__ */ e("circle", { cx: b.x + 14, cy: pt + (Wt - 6) / 2, r: 5, className: "a3d-g-lanedot" }),
                /* @__PURE__ */ i("text", { x: b.x + 26, y: pt + (Wt - 6) / 2 + 4, className: "a3d-g-lanename", children: [
                  zt(j.name, Math.max(8, Math.floor(b.w / 8) - 12)),
                  j.primary ? " ★" : "",
                  j.status !== "open" ? ` · ${j.status}` : ""
                ] })
              ]
            }
          )
        ] }, `lane-${b.id}`);
      }),
      F.map((b) => /* @__PURE__ */ e("path", { d: b.d, className: ["a3d-g-edge", b.on ? "a3d-g-edge-on" : "", b.cross ? "a3d-g-edge-cross" : ""].filter(Boolean).join(" "), markerEnd: "url(#a3d-arrow)" }, b.id)),
      E.filter((b) => c.has(b.id)).map((b) => {
        const { x: j, y: d, lane: u } = c.get(b.id), p = l === b.id, U = I.has(b.id), q = Ia(b), ie = b.outcome || b.description, Z = ["a3d-g-node", u !== t.branch ? "a3d-g-otherlane" : "", o.includes(b.id) ? "a3d-g-cmp" : "", b.archived ? "a3d-g-archived" : "", `a3d-gs-${b.status}`, b.verdict ? `a3d-gv-${b.verdict}` : "", b.inferred ? "a3d-g-inferred" : "", U ? "a3d-g-on" : "", p ? "a3d-g-sel" : ""].filter(Boolean).join(" ");
        return /* @__PURE__ */ i(
          "g",
          {
            className: Z,
            transform: `translate(${j},${d})`,
            tabIndex: 0,
            role: "button",
            "aria-label": `${b.label}, ${Jt[b.status]}${b.verdict ? ", " + b.verdict : ""}${B ? `, branch ${u}` : ""}${M?.id === b.id ? ", current" : ""}`,
            onClick: () => w(b.id),
            onKeyDown: (X) => {
              (X.key === "Enter" || X.key === " ") && (X.preventDefault(), w(b.id));
            },
            children: [
              /* @__PURE__ */ e("title", { children: [b.label, `${Jt[b.status]}${b.verdict ? ` · ${b.verdict}` : ""}${b.inferred ? " · rebuilt from files" : ""}`, B ? `branch: ${u}` : "", q, b.description, b.outcome].filter(Boolean).join(`
`) }),
              /* @__PURE__ */ e("rect", { width: ye, height: Ue, rx: 8, className: "a3d-g-box" }),
              /* @__PURE__ */ e("circle", { cx: 14, cy: 16, r: 7, className: "a3d-g-dot" }),
              ci[b.status] && /* @__PURE__ */ e("text", { x: 14, y: 19.5, className: "a3d-g-dotglyph", textAnchor: "middle", children: ci[b.status] }),
              /* @__PURE__ */ e("text", { x: 28, y: 20, className: "a3d-g-label1", children: zt(b.label, b.verdict ? 17 : 19) }),
              b.verdict && /* @__PURE__ */ e("text", { x: ye - 10, y: 20, textAnchor: "end", className: "a3d-g-verdict", children: b.verdict === "accepted" ? "✓" : "✗" }),
              /* @__PURE__ */ e("text", { x: 10, y: 36, className: "a3d-g-line2", children: zt(q || Jt[b.status], 26) }),
              /* @__PURE__ */ e("text", { x: 10, y: 50, className: "a3d-g-line3", children: zt(ie, 26) }),
              o.includes(b.id) && /* @__PURE__ */ e("text", { x: ye - 10, y: Ue - 6, textAnchor: "end", className: "a3d-g-cmpmark", children: o.indexOf(b.id) === 0 ? "A" : "B" }),
              (b.notes?.length ?? 0) > 0 && /* @__PURE__ */ e("text", { x: ye - 28, y: 20, textAnchor: "end", className: "a3d-g-notemark", children: "✎" }),
              M?.id === b.id && /* @__PURE__ */ e("text", { x: ye - 8, y: -4, textAnchor: "end", className: "a3d-g-here", children: "you are here" })
            ]
          },
          b.id
        );
      }),
      (() => {
        const b = O.find((d) => d.id === t.branch);
        if (!b) return null;
        const j = b.x + (B ? 8 : 0);
        return De.map((d, u) => {
          const p = a.find((Z) => Z.id === d);
          if (!p || p.state === "locked" && !b.slots[u]) return null;
          const U = t.branches.find((Z) => Z.id === t.branch);
          if (U && U.id !== "main" && u < Math.max(0, De.indexOf(U.from_step))) return null;
          const q = j + b.slots[u] * (ye + at), ie = L + u * Je + (Je - Ue) / 2;
          return /* @__PURE__ */ i(
            "g",
            {
              className: "a3d-g-new",
              transform: `translate(${q},${ie})`,
              tabIndex: 0,
              role: "button",
              "aria-label": `New attempt on ${p.title}`,
              onClick: () => x(d),
              onKeyDown: (Z) => {
                (Z.key === "Enter" || Z.key === " ") && (Z.preventDefault(), x(d));
              },
              children: [
                /* @__PURE__ */ i("title", { children: [
                  "New attempt on ",
                  p.title,
                  " in this branch, with its own settings and description"
                ] }),
                /* @__PURE__ */ e("rect", { width: ye - 40, height: Ue, rx: 8, className: "a3d-g-newbox" }),
                /* @__PURE__ */ e("text", { x: (ye - 40) / 2, y: Ue / 2 + 5, textAnchor: "middle", className: "a3d-g-newtext", children: "+ New attempt" })
              ]
            },
            `new-${d}`
          );
        });
      })()
    ] }) }),
    /* @__PURE__ */ i("p", { className: "a3d-graph-legend a3d-muted", children: [
      "Rows are the steps, each box is one attempt.",
      B ? " Each column is a branch with its own files; click its header to work in it (★ primary)." : "",
      " Blue line: the path of the selected branch. ✓ accepted, ✗ rejected, dashed box: an attempt you left. Grey box: rebuilt from files. Ring: waiting for you. Pulsing: running. ✎ has notes. A / B: picked for comparison."
    ] })
  ] });
}
function Bi(t, a) {
  if (a) return t;
  const l = new Set(t.filter((o) => o.archived).map((o) => o.id));
  let s = !0;
  for (; s; ) {
    s = !1;
    for (const o of t) !l.has(o.id) && o.parent && l.has(o.parent) && (l.add(o.id), s = !0);
  }
  return t.filter((o) => !l.has(o.id));
}
const fn = (t) => {
  const a = new Date(t);
  return Number.isNaN(a.getTime()) ? t : a.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};
function qa({ model: t, node: a, busy: l, canEdit: s, inCompare: o, onSelectNode: g, onRerun: w, onNext: m, onBranch: x, onVerdict: C, onOpen: v, onFiles: f, onCompare: S, onArchive: E, onNote: B, onCost: M }) {
  const [I, L] = A(""), [c, O] = A(a.cost?.service ?? ""), [T, _] = A(a.cost ? String(a.cost.credits) : ""), y = a.parent ? t.flow.nodes.find((d) => d.id === a.parent) : null, F = t.flow.nodes.filter((d) => d.parent === a.id), b = De[Ze(a.step) + 1], j = Object.entries(a.settings);
  return /* @__PURE__ */ i("section", { className: "a3d-node-detail", children: [
    /* @__PURE__ */ i("header", { children: [
      /* @__PURE__ */ i("div", { children: [
        /* @__PURE__ */ i("h3", { children: [
          a.label,
          " ",
          /* @__PURE__ */ e("span", { className: `a3d-pill a3d-pill-${a.status}`, children: Jt[a.status] }),
          a.verdict && /* @__PURE__ */ e("span", { className: `a3d-pill a3d-pill-${a.verdict}`, children: a.verdict }),
          a.inferred && /* @__PURE__ */ e("span", { className: "a3d-pill", children: "rebuilt from files" })
        ] }),
        /* @__PURE__ */ i("p", { className: "a3d-muted", children: [
          a.step,
          " · ",
          a.agent,
          t.branches.length > 1 ? ` · branch ${a.branch ?? "main"}` : "",
          " · ",
          fn(a.created_at),
          a.finished_at ? ` → ${fn(a.finished_at)}` : ""
        ] })
      ] }),
      /* @__PURE__ */ i("span", { className: "a3d-row", children: [
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", "aria-pressed": o, onClick: () => S(a), title: "Pick two attempts of the same step and compare them", children: o ? "In comparison" : "Compare" }),
        a.files.length > 0 && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => f(a), title: "Open the Files tab with only this attempt's files", children: "Show files" }),
        /* @__PURE__ */ e(
          "button",
          {
            type: "button",
            className: "a3d-btn",
            disabled: l,
            onClick: () => w(a),
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
            onClick: () => m(a),
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
            onClick: () => x(a),
            title: "A separate line with its own files from here to the end: another image, link, mesh, or other settings",
            children: "New branch from here…"
          }
        )
      ] })
    ] }),
    /* @__PURE__ */ i("dl", { className: "a3d-node-grid", children: [
      /* @__PURE__ */ e("dt", { children: "Settings" }),
      /* @__PURE__ */ e("dd", { children: j.length ? /* @__PURE__ */ e("ul", { className: "a3d-kv", children: j.map(([d, u]) => /* @__PURE__ */ i("li", { children: [
        /* @__PURE__ */ e("code", { children: d }),
        " ",
        u
      ] }, d)) }) : /* @__PURE__ */ e("span", { className: "a3d-muted", children: "none recorded" }) }),
      /* @__PURE__ */ e("dt", { children: "Description" }),
      /* @__PURE__ */ e("dd", { children: a.description || /* @__PURE__ */ e("span", { className: "a3d-muted", children: "none" }) }),
      /* @__PURE__ */ e("dt", { children: "Outcome" }),
      /* @__PURE__ */ e("dd", { children: a.outcome || /* @__PURE__ */ e("span", { className: "a3d-muted", children: "not recorded yet" }) }),
      a.files.length > 0 && /* @__PURE__ */ i(ee, { children: [
        /* @__PURE__ */ e("dt", { children: "Files" }),
        /* @__PURE__ */ e("dd", { children: /* @__PURE__ */ e("ul", { className: "a3d-kv", children: a.files.map((d) => /* @__PURE__ */ e("li", { children: /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: () => v(d), children: d }) }, d)) }) })
      ] }),
      /* @__PURE__ */ e("dt", { children: "Cost" }),
      /* @__PURE__ */ e("dd", { children: s && !a.inferred ? /* @__PURE__ */ i("span", { className: "a3d-row", children: [
        /* @__PURE__ */ e("input", { className: "a3d-in-small", "aria-label": "Service", list: "a3d-services", placeholder: "service", value: c, onChange: (d) => O(d.target.value) }),
        /* @__PURE__ */ e("input", { className: "a3d-in-small", "aria-label": "Credits", type: "number", min: "0", step: "any", placeholder: "credits", value: T, onChange: (d) => _(d.target.value) }),
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", disabled: !c.trim() || T === "" || a.cost?.service === c && String(a.cost?.credits) === T, onClick: () => M(a, c.trim(), T), children: "Save" }),
        /* @__PURE__ */ i("datalist", { id: "a3d-services", children: [
          /* @__PURE__ */ e("option", { value: "tripo3d" }),
          /* @__PURE__ */ e("option", { value: "gemini" }),
          /* @__PURE__ */ e("option", { value: "meshy" }),
          /* @__PURE__ */ e("option", { value: "rodin" }),
          /* @__PURE__ */ e("option", { value: "apify" }),
          /* @__PURE__ */ e("option", { value: "usd" })
        ] })
      ] }) : a.cost ? `${a.cost.credits} ${a.cost.service}` : /* @__PURE__ */ e("span", { className: "a3d-muted", children: "not recorded" }) }),
      /* @__PURE__ */ e("dt", { children: "Notes" }),
      /* @__PURE__ */ i("dd", { children: [
        (a.notes ?? []).length > 0 && /* @__PURE__ */ e("ul", { className: "a3d-notes", children: a.notes.map((d, u) => /* @__PURE__ */ i("li", { children: [
          /* @__PURE__ */ e("span", { className: "a3d-muted", children: fn(d.at) }),
          " ",
          d.text
        ] }, u)) }),
        s && /* @__PURE__ */ i("form", { className: "a3d-row", onSubmit: (d) => {
          d.preventDefault(), I.trim() && (B(a, I.trim()), L(""));
        }, children: [
          /* @__PURE__ */ e("input", { className: "a3d-in-grow", "aria-label": "New note", placeholder: "Add a note: what you saw, what to try", value: I, onChange: (d) => L(d.target.value) }),
          /* @__PURE__ */ e("button", { type: "submit", className: "a3d-btn a3d-btn-small", disabled: !I.trim(), children: "Add" })
        ] })
      ] }),
      /* @__PURE__ */ e("dt", { children: "Position" }),
      /* @__PURE__ */ i("dd", { children: [
        y ? /* @__PURE__ */ i(ee, { children: [
          "grows from ",
          /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: () => g(y.id), children: y.label })
        ] }) : "first attempt",
        F.length > 0 && /* @__PURE__ */ i(ee, { children: [
          " · leads to ",
          F.map((d, u) => /* @__PURE__ */ i("span", { children: [
            u ? ", " : "",
            /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: () => g(d.id), children: d.label })
          ] }, d.id))
        ] })
      ] })
    ] }),
    s && !a.inferred && /* @__PURE__ */ i("p", { className: "a3d-row", children: [
      /* @__PURE__ */ e("span", { className: "a3d-muted", children: "Verdict" }),
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", "aria-pressed": a.verdict === "accepted", onClick: () => C(a, "accepted"), children: "Accepted" }),
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", "aria-pressed": a.verdict === "rejected", onClick: () => C(a, "rejected"), children: "Rejected" }),
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", disabled: !a.verdict, onClick: () => C(a, "none"), children: "Clear" }),
      /* @__PURE__ */ e("span", { className: "a3d-tabs-spacer" }),
      /* @__PURE__ */ e(
        "button",
        {
          type: "button",
          className: "a3d-btn a3d-btn-small",
          onClick: () => E(a, !a.archived),
          title: a.archived ? "Show this attempt again" : "Hide this attempt and everything that grew from it; nothing is deleted",
          children: a.archived ? "Unarchive attempt" : "Archive attempt"
        }
      )
    ] })
  ] });
}
const $ = (t) => `'${t.replace(/'/g, "'\\''")}'`, hi = () => /Win/i.test(navigator.platform) ? 'start ""' : /Mac/i.test(navigator.platform) ? "open" : "xdg-open", pi = (t, a) => `file://${encodeURI(t).replace(/#/g, "%23").replace(/\?/g, "%3F")}?v=${a}`, Ya = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" }, Mn = () => /Mac/i.test(navigator.platform), Za = () => /Win/i.test(navigator.platform);
function gn(t) {
  return Mn() ? `open -R ${$(t)}` : Za() ? `explorer /select,"${t.replace(/\//g, "\\")}"` : `xdg-open ${$(t.replace(/\/[^/]*$/, ""))}`;
}
function Oe({ host: t, path: a, mtime: l, alt: s, onClick: o }) {
  const [g, w] = A(() => pi(a, l)), m = qe(!1);
  return ke(() => {
    m.current = !1, w(pi(a, l));
  }, [a, l]), /* @__PURE__ */ e("img", { src: g, alt: s, onError: async () => {
    if (m.current) return;
    m.current = !0;
    const C = await t.exec(`base64 < ${$(a)}`, { timeout: 2e4 }), v = a.split(".").pop()?.toLowerCase() ?? "png";
    C.success && w(`data:${Ya[v] ?? "image/png"};base64,${C.stdout.replace(/\s+/g, "")}`);
  }, onClick: o, loading: "lazy" });
}
const ui = /\.(png|jpe?g|webp|gif)$/i;
function Xa({ host: t, model: a, a: l, b: s, onClose: o, onSwap: g, onView3d: w, onOpen: m }) {
  const x = Array.from(/* @__PURE__ */ new Set([...Object.keys(l.settings), ...Object.keys(s.settings)])).sort(), C = (f, S, E) => /* @__PURE__ */ i("tr", { className: S !== E ? "a3d-diff" : void 0, children: [
    /* @__PURE__ */ e("th", { children: f }),
    /* @__PURE__ */ e("td", { children: S || /* @__PURE__ */ e("span", { className: "a3d-muted", children: "–" }) }),
    /* @__PURE__ */ e("td", { children: E || /* @__PURE__ */ e("span", { className: "a3d-muted", children: "–" }) })
  ] }, f), v = (f) => {
    const S = f.files.filter((B) => ui.test(B)), E = f.files.filter((B) => /\.stl$/i.test(B));
    return /* @__PURE__ */ i("div", { className: "a3d-cmp-side", children: [
      S.length > 0 && /* @__PURE__ */ e("div", { className: "a3d-gallery", children: S.map((B) => /* @__PURE__ */ i("figure", { children: [
        /* @__PURE__ */ e(Oe, { host: t, path: `${_n(a, f)}/${B}`, mtime: a.stamp, alt: B }),
        /* @__PURE__ */ e("figcaption", { children: B })
      ] }, B)) }),
      /* @__PURE__ */ i("p", { className: "a3d-row", children: [
        E.map((B) => /* @__PURE__ */ i("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => w(f, B), children: [
          "3D: ",
          B.split("/").pop()
        ] }, B)),
        f.files.filter((B) => !ui.test(B) && !/\.stl$/i.test(B)).map((B) => /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: () => m(B, f), children: B }, B))
      ] })
    ] });
  };
  return /* @__PURE__ */ i("section", { className: "a3d-node-detail a3d-compare", children: [
    /* @__PURE__ */ i("header", { children: [
      /* @__PURE__ */ i("h3", { children: [
        "Compare attempts",
        l.step !== s.step ? /* @__PURE__ */ e("span", { className: "a3d-pill", children: "different steps" }) : null
      ] }),
      /* @__PURE__ */ i("span", { className: "a3d-row", children: [
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: g, children: "Swap" }),
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: o, children: "Close" })
      ] })
    ] }),
    /* @__PURE__ */ i("table", { className: "a3d-filetable a3d-cmp-table", children: [
      /* @__PURE__ */ e("thead", { children: /* @__PURE__ */ i("tr", { children: [
        /* @__PURE__ */ e("th", {}),
        /* @__PURE__ */ i("th", { children: [
          "A · ",
          l.label
        ] }),
        /* @__PURE__ */ i("th", { children: [
          "B · ",
          s.label
        ] })
      ] }) }),
      /* @__PURE__ */ i("tbody", { children: [
        a.branches.length > 1 && C("Branch", Pe(l), Pe(s)),
        C("Status", `${l.status}${l.verdict ? ` · ${l.verdict}` : ""}`, `${s.status}${s.verdict ? ` · ${s.verdict}` : ""}`),
        x.map((f) => C(f, l.settings[f] ?? "", s.settings[f] ?? "")),
        C("Description", l.description, s.description),
        C("Outcome", l.outcome, s.outcome),
        C("Cost", l.cost ? `${l.cost.credits} ${l.cost.service}` : "", s.cost ? `${s.cost.credits} ${s.cost.service}` : ""),
        C("Notes", (l.notes ?? []).map((f) => f.text).join(" · "), (s.notes ?? []).map((f) => f.text).join(" · "))
      ] })
    ] }),
    /* @__PURE__ */ i("div", { className: "a3d-two", children: [
      v(l),
      v(s)
    ] }),
    /* @__PURE__ */ e("p", { className: "a3d-muted a3d-small", children: "Rows that differ are highlighted. A file an attempt replaced later lives in mesh/attempts/; older attempts that did not record their files show none." })
  ] });
}
function Qa({ model: t, last: a, onPickPhotos: l, onCancel: s, onSave: o }) {
  const [g, w] = A({
    result: "ok",
    printer: a?.printer ?? "",
    filament: a?.filament ?? "",
    settings: a?.settings ?? "",
    change: "",
    notes: "",
    photoPaths: [],
    photoFiles: []
  }), m = qe(null), x = (f, S) => w((E) => ({ ...E, [f]: S })), C = async () => {
    const f = await l();
    f === null ? m.current?.click() : f.length && w((S) => ({ ...S, photoPaths: [...S.photoPaths, ...f] }));
  }, v = g.photoPaths.length + g.photoFiles.length;
  return /* @__PURE__ */ e("div", { className: "a3d-overlay", onClick: s, children: /* @__PURE__ */ i("form", { className: "a3d-dialog a3d-dialog-wide", onClick: (f) => f.stopPropagation(), onSubmit: (f) => {
    f.preventDefault(), o(g);
  }, children: [
    /* @__PURE__ */ i("h3", { children: [
      "Test print · ",
      t.meta.title || t.slug
    ] }),
    /* @__PURE__ */ i("fieldset", { className: "a3d-fields a3d-result", children: [
      /* @__PURE__ */ e("legend", { children: "Result" }),
      [["ok", "OK, prints as intended"], ["issues", "Prints, with issues"], ["fail", "Failed"]].map(([f, S]) => /* @__PURE__ */ i("label", { className: "a3d-radio", children: [
        /* @__PURE__ */ e("input", { type: "radio", name: "a3d-result", checked: g.result === f, onChange: () => x("result", f) }),
        " ",
        S
      ] }, f))
    ] }),
    /* @__PURE__ */ i("div", { className: "a3d-form-grid", children: [
      /* @__PURE__ */ i("label", { children: [
        "Printer",
        /* @__PURE__ */ e("input", { value: g.printer, onChange: (f) => x("printer", f.target.value), placeholder: "Bambu A1" })
      ] }),
      /* @__PURE__ */ i("label", { children: [
        "Filament",
        /* @__PURE__ */ e("input", { value: g.filament, onChange: (f) => x("filament", f.target.value), placeholder: "PLA Basic, green" })
      ] })
    ] }),
    /* @__PURE__ */ i("label", { children: [
      "Settings",
      /* @__PURE__ */ e("input", { value: g.settings, onChange: (f) => x("settings", f.target.value), placeholder: "0.2 mm layers, 3 walls, 15 % infill, no supports" })
    ] }),
    /* @__PURE__ */ i("label", { children: [
      "What to change next time",
      /* @__PURE__ */ e("input", { value: g.change, onChange: (f) => x("change", f.target.value), placeholder: "clearance 0.45 instead of 0.4; tail joint stuck" })
    ] }),
    /* @__PURE__ */ i("label", { children: [
      "Notes",
      /* @__PURE__ */ e("textarea", { rows: 2, value: g.notes, onChange: (f) => x("notes", f.target.value) })
    ] }),
    /* @__PURE__ */ i("p", { className: "a3d-row", children: [
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => {
        C();
      }, children: "Add photos…" }),
      /* @__PURE__ */ e("span", { className: "a3d-muted", children: v ? `${v} photo${v === 1 ? "" : "s"}` : "Photos are copied into print/photos/." }),
      /* @__PURE__ */ e("input", { ref: m, type: "file", accept: "image/*", multiple: !0, hidden: !0, onChange: (f) => {
        const S = Array.from(f.target.files ?? []);
        f.target.value = "", w((E) => ({ ...E, photoFiles: [...E.photoFiles, ...S] }));
      } })
    ] }),
    /* @__PURE__ */ i("span", { className: "a3d-row a3d-row-end", children: [
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: s, children: "Cancel" }),
      /* @__PURE__ */ e("button", { type: "submit", className: "a3d-btn a3d-btn-primary", children: "Save" })
    ] })
  ] }) });
}
const Ti = { modelsRoot: "" }, es = `"""Blender readiness for the AI3D Forge panel. Run as:  python3 - <workspace> <blender_bin or auto>  (source on stdin).
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
async function ts(t, a) {
  const l = await t.exec(`python3 - ${$(t.workspacePath)} ${$(a || "auto")} <<'A3D_BL'
${es}
A3D_BL`, { timeout: 6e4 });
  if (!l.success) throw new Error(l.stderr.trim().split(`
`).pop() || "Blender check failed");
  return JSON.parse(l.stdout.trim().split(`
`).pop() ?? "{}");
}
function ns(t, a, l, s, o = {}) {
  const g = Object.entries(o).filter(([, w]) => w !== "").map(([w, m]) => $(`${w}=${m}`)).join(" ");
  return `${$(t)} -b --factory-startup -P ${$(a)} -- ${l} ${$(s)}${g ? ` ${g}` : ""}`;
}
async function is(t, a, l, s, o, g) {
  const w = await t.exec(ns(a, l, s, o, g), { timeout: 9e5, maxBuffer: 2e7 }), m = (w.stdout ?? "").split(`
`).reverse().find((C) => C.startsWith("A3D_RESULT "));
  if (m) return JSON.parse(m.slice(11));
  const x = `${w.stderr ?? ""}
${w.stdout ?? ""}`.trim().split(`
`).filter(Boolean).slice(-3).join(" · ");
  return { ok: !1, command: s, problems: [`Blender did not finish: ${x || "no output"}`], crashed: !0 };
}
async function as(t, a, l) {
  const s = Mn() && (!a || a.includes(".app/"));
  if (!l) return t.exec(s ? "open -a Blender" : `nohup ${$(a ?? "blender")} >/dev/null 2>&1 &`, { timeout: 15e3 });
  const o = l.split(".").pop()?.toLowerCase() ?? "";
  if (o === "blend") {
    const x = s ? `open -a Blender ${$(l)}` : `nohup ${$(a ?? "blender")} ${$(l)} >/dev/null 2>&1 &`;
    return t.exec(x, { timeout: 15e3 });
  }
  const g = JSON.stringify(l), m = `import bpy; bpy.ops.wm.read_homefile(use_empty=True); ${o === "stl" ? `bpy.ops.wm.stl_import(filepath=${g})` : o === "obj" ? `bpy.ops.wm.obj_import(filepath=${g})` : o === "fbx" ? `bpy.ops.import_scene.fbx(filepath=${g})` : `bpy.ops.import_scene.gltf(filepath=${g})`}`;
  return t.exec(`nohup ${$(a ?? "blender")} --python-expr ${$(m)} >/dev/null 2>&1 &`, { timeout: 15e3 });
}
function xn(t) {
  if (!t.ok && t.problems?.length) return t.problems.join(" ");
  const a = t.after ?? t.analysis, l = t.before, s = [];
  return t.command === "flexi" && t.flexi && s.push(`${t.flexi.joints ?? "?"} joints`), a?.overhang_pct != null && s.push(`overhang ${a.overhang_pct} %${l?.overhang_pct != null ? ` (was ${l.overhang_pct} %)` : ""}`), t.side_on_bed && s.push(`${t.side_on_bed} on bed`), a?.size_mm && s.push(`${a.size_mm.map((o) => Math.round(o)).join("×")} mm`), a?.watertight === !1 && s.push("not watertight"), s.join(", ") || (t.files?.length ? `wrote ${t.files.join(", ")}` : "done");
}
function ss(t) {
  return t ? t.bin ? t.mcp.some((a) => a.forSessions) ? "ready" : "partial" : "missing" : "unknown";
}
const mi = (t) => t?.match(/\d+\.\d+(\.\d+)?/)?.[0] ?? "";
function ls({ status: t, checking: a, onClick: l }) {
  const s = ss(t), o = a ? "checking…" : s === "ready" ? `${mi(t.version)} · MCP` : s === "partial" ? `${mi(t.version)} · no MCP` : s === "missing" ? "not found" : "";
  return /* @__PURE__ */ i("button", { type: "button", className: `a3d-chip a3d-chip-${s}`, onClick: l, title: "Blender and the Blender MCP: status, setup guide", children: [
    /* @__PURE__ */ e("i", { "aria-hidden": "true" }),
    "Blender ",
    /* @__PURE__ */ e("span", { className: "a3d-muted", children: o })
  ] });
}
function Kt({ ok: t, label: a, value: l, hint: s }) {
  return /* @__PURE__ */ i("div", { className: "a3d-status-row", children: [
    /* @__PURE__ */ e("span", { className: t === null ? "a3d-st a3d-st-unknown" : t ? "a3d-st a3d-st-ok" : "a3d-st a3d-st-bad", "aria-hidden": "true", children: t === null ? "?" : t ? "✓" : "✕" }),
    /* @__PURE__ */ e("span", { className: "a3d-status-label", children: a }),
    /* @__PURE__ */ i("span", { className: "a3d-status-value", children: [
      l,
      s && /* @__PURE__ */ i("span", { className: "a3d-muted", children: [
        " — ",
        s
      ] })
    ] })
  ] });
}
function rs({ status: t, checking: a, kilnInstalled: l, guide: s, onCheck: o, onGuide: g, onLaunch: w, onClose: m }) {
  const x = t?.mcp.filter((v) => v.forSessions) ?? [], C = t?.mcp.filter((v) => !v.forSessions) ?? [];
  return /* @__PURE__ */ e("div", { className: "a3d-overlay", onClick: m, children: /* @__PURE__ */ i("div", { className: "a3d-dialog a3d-dialog-wide", role: "dialog", "aria-label": "Blender", onClick: (v) => v.stopPropagation(), children: [
    /* @__PURE__ */ e("h3", { children: "Blender" }),
    /* @__PURE__ */ e("p", { className: "a3d-muted", children: "The Kiln agent drives your open Blender through the Blender MCP. The quick tools in the Blender step run a background Blender and need only the app." }),
    /* @__PURE__ */ i("div", { className: "a3d-status", children: [
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
          ok: t ? x.length > 0 : null,
          label: "MCP for agent sessions",
          value: x.length ? x.map((v) => `${v.name} (${v.where})`).join(", ") : "not registered for Claude Code",
          hint: x.length ? void 0 : C.length ? "found only in the Claude desktop app, which Nimbalyst sessions do not read" : "see the setup guide, step 3"
        }
      ),
      /* @__PURE__ */ e(Kt, { ok: l, label: "Kiln scripts", value: l ? "installed" : "not found", hint: l ? void 0 : "update the AI3D Forge module" })
    ] }),
    /* @__PURE__ */ i("p", { className: "a3d-muted a3d-small", children: [
      "⚠ The panel cannot see inside an agent session: “registered” means the config has it, not that this session connected. In a session, ",
      /* @__PURE__ */ e("code", { children: "/mcp" }),
      " shows the live state."
    ] }),
    /* @__PURE__ */ i("span", { className: "a3d-row a3d-row-end", children: [
      s && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: g, children: "Setup guide" }),
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", disabled: !t?.bin, onClick: w, children: "Open Blender" }),
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", disabled: a, onClick: o, children: a ? "Checking…" : "Check again" }),
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-primary", onClick: m, children: "Close" })
    ] })
  ] }) });
}
const os = ["auto", "bottom", "back", "front", "left", "right", "top"];
function ds({ cmd: t, model: a, initial: l, onCancel: s, onRun: o }) {
  const g = String(a.meta.scale_mm ?? ""), [w, m] = A(() => ({
    ...t === "prep" ? { height: g || "100", orient: "auto", cut: "1.0", voxel: "" } : { segments: "6", clearance: "0.4", gap: "1.5", pin_d: "3.0" },
    ...l ?? {}
  })), [x, C] = A(""), v = (S, E) => m((B) => ({ ...B, [S]: E })), f = (S, E, B, M = "0.1") => /* @__PURE__ */ i("label", { children: [
    E,
    /* @__PURE__ */ e("input", { type: "number", step: M, min: "0", value: w[S] ?? "", onChange: (I) => v(S, I.target.value) }),
    /* @__PURE__ */ e("span", { className: "a3d-muted a3d-small", children: B })
  ] }, S);
  return /* @__PURE__ */ e("div", { className: "a3d-overlay", onClick: s, children: /* @__PURE__ */ i("form", { className: "a3d-dialog a3d-dialog-wide", onClick: (S) => S.stopPropagation(), onSubmit: (S) => {
    S.preventDefault(), o({ cmd: t, opts: w, description: x.trim() });
  }, children: [
    /* @__PURE__ */ e("h3", { children: t === "prep" ? "Quick prep in Blender" : "Flexi joints in Blender" }),
    /* @__PURE__ */ e("p", { className: "a3d-muted", children: "Runs in a background Blender, no agent, no tokens. It becomes a new attempt in the graph; the current print.stl is kept in mesh/attempts/." }),
    /* @__PURE__ */ e("div", { className: "a3d-form-grid", children: t === "prep" ? /* @__PURE__ */ i(ee, { children: [
      f("height", "Size (mm)", "tallest dimension after scaling", "1"),
      /* @__PURE__ */ i("label", { children: [
        "Side on the bed",
        /* @__PURE__ */ e("select", { value: w.orient, onChange: (S) => v("orient", S.target.value), children: os.map((S) => /* @__PURE__ */ e("option", { value: S, children: S }, S)) }),
        /* @__PURE__ */ e("span", { className: "a3d-muted a3d-small", children: "auto picks the lowest overhang among stable sides" })
      ] }),
      f("cut", "Flat cut (mm)", "sliced off the bed side for a flat base"),
      f("voxel", "Voxel size (mm)", "empty = automatic; smaller keeps detail, slower")
    ] }) : /* @__PURE__ */ i(ee, { children: [
      f("segments", "Segments", "number of body parts", "1"),
      f("clearance", "Clearance (mm)", "gap in the joint; use your coupon result", "0.05"),
      f("gap", "Gap between segments (mm)", "cut width"),
      f("pin_d", "Pin diameter (mm)", "smaller for narrow bodies")
    ] }) }),
    /* @__PURE__ */ i("label", { children: [
      "Description: what is different this time",
      /* @__PURE__ */ e("textarea", { rows: 2, value: x, onChange: (S) => C(S.target.value), placeholder: t === "prep" ? "Back on the bed instead of bottom: the belly has the detail." : "Six segments, clearance from the coupon." })
    ] }),
    /* @__PURE__ */ i("span", { className: "a3d-row a3d-row-end", children: [
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: s, children: "Cancel" }),
      /* @__PURE__ */ e("button", { type: "submit", className: "a3d-btn a3d-btn-primary", children: "Run in Blender" })
    ] })
  ] }) });
}
function cs({ model: t, status: a, kilnRun: l, busy: s, last: o, onRun: g, onPrep: w, onFlexi: m, onOpen: x, onCommand: C, onSetup: v }) {
  const f = !!a?.bin && !!l && !s, S = t.files.mesh.find((c) => /^raw\./i.test(c.name)), E = t.files.mesh.find((c) => c.name === "print.stl") ?? t.files.mesh.find((c) => c.name === "clean.stl"), B = t.files.mesh.find((c) => c.name === "work.blend"), M = a ? a.bin ? l ? null : "Kiln scripts not found: update the module." : "Blender not found." : "Checking Blender…", I = o?.command === "analyze" ? o.orientations ?? [] : [], L = o?.analysis ?? o?.after;
  return /* @__PURE__ */ i("section", { className: "a3d-block", children: [
    /* @__PURE__ */ i("h4", { children: [
      "Blender quick tools ",
      /* @__PURE__ */ e("span", { className: "a3d-muted", children: "no agent, no tokens" })
    ] }),
    M && /* @__PURE__ */ i("p", { className: "a3d-muted", children: [
      M,
      " ",
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: v, children: "Blender setup" })
    ] }),
    /* @__PURE__ */ i("p", { className: "a3d-row", children: [
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", disabled: !f || !S && !E, onClick: () => g("analyze"), children: s === "analyze" ? "Analyzing…" : "Analyze" }),
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", disabled: !f || !S, onClick: w, title: S ? "" : "needs mesh/raw.*", children: s === "prep" ? "Preparing…" : "Quick prep…" }),
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", disabled: !f || !E, onClick: m, title: E ? "" : "needs mesh/print.stl", children: s === "flexi" ? "Building joints…" : "Flexi…" }),
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", disabled: !f || !S && !E, onClick: () => g("render"), children: s === "render" ? "Rendering…" : "Render previews" }),
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", disabled: !f, onClick: () => g("coupon"), children: s === "coupon" ? "Exporting…" : "Clearance coupon" })
    ] }),
    /* @__PURE__ */ i("p", { className: "a3d-row", children: [
      /* @__PURE__ */ e("span", { className: "a3d-muted", children: "Open in Blender:" }),
      B && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", disabled: !a?.bin, onClick: () => x("mesh/work.blend"), children: "work.blend" }),
      E && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", disabled: !a?.bin, onClick: () => x(`mesh/${E.name}`), children: E.name }),
      S && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", disabled: !a?.bin, onClick: () => x(`mesh/${S.name}`), children: S.name }),
      /* @__PURE__ */ e("span", { className: "a3d-tabs-spacer" }),
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: C, title: "Kiln agent runs one instruction in your open Blender", children: "Blender command…" })
    ] }),
    s && /* @__PURE__ */ e("p", { className: "a3d-muted", children: "Running in a background Blender. Voxel remesh on a large mesh can take a minute or two." }),
    o && !s && /* @__PURE__ */ i("div", { className: o.ok ? "a3d-kiln-result" : "a3d-kiln-result a3d-kiln-bad", children: [
      /* @__PURE__ */ i("p", { children: [
        /* @__PURE__ */ i("strong", { children: [
          o.command === "analyze" ? "Analysis" : o.command === "prep" ? "Quick prep" : o.command === "flexi" ? "Flexi" : o.command === "render" ? "Render" : "Coupon",
          o.ok ? "" : " — problem",
          ":"
        ] }),
        " ",
        xn(o)
      ] }),
      L && o.command === "analyze" && /* @__PURE__ */ i("dl", { className: "a3d-metrics", children: [
        L.size_mm && /* @__PURE__ */ i("div", { className: "a3d-metric", children: [
          /* @__PURE__ */ e("dt", { children: "Size" }),
          /* @__PURE__ */ i("dd", { children: [
            L.size_mm.join(" × "),
            " mm"
          ] })
        ] }),
        L.watertight != null && /* @__PURE__ */ i("div", { className: L.watertight ? "a3d-metric a3d-good" : "a3d-metric a3d-bad", children: [
          /* @__PURE__ */ e("dt", { children: "Watertight" }),
          /* @__PURE__ */ e("dd", { children: L.watertight ? "yes" : "no" })
        ] }),
        L.shells != null && /* @__PURE__ */ i("div", { className: "a3d-metric", children: [
          /* @__PURE__ */ e("dt", { children: "Shells" }),
          /* @__PURE__ */ e("dd", { children: L.shells })
        ] }),
        L.overhang_pct != null && /* @__PURE__ */ i("div", { className: "a3d-metric", children: [
          /* @__PURE__ */ e("dt", { children: "Overhang" }),
          /* @__PURE__ */ i("dd", { children: [
            L.overhang_pct,
            " %"
          ] })
        ] }),
        L.triangles != null && /* @__PURE__ */ i("div", { className: "a3d-metric", children: [
          /* @__PURE__ */ e("dt", { children: "Triangles" }),
          /* @__PURE__ */ e("dd", { children: Number(L.triangles).toLocaleString() })
        ] })
      ] }),
      I.length > 0 && /* @__PURE__ */ i("table", { className: "a3d-filetable a3d-orient", children: [
        /* @__PURE__ */ e("thead", { children: /* @__PURE__ */ i("tr", { children: [
          /* @__PURE__ */ e("th", { children: "Side on bed" }),
          /* @__PURE__ */ e("th", { children: "Overhang" }),
          /* @__PURE__ */ e("th", { children: "Height" }),
          /* @__PURE__ */ e("th", { children: "Stable" })
        ] }) }),
        /* @__PURE__ */ e("tbody", { children: I.map((c) => /* @__PURE__ */ i("tr", { children: [
          /* @__PURE__ */ e("td", { children: c.side }),
          /* @__PURE__ */ i("td", { className: "a3d-num", children: [
            c.overhang_pct,
            " %"
          ] }),
          /* @__PURE__ */ e("td", { className: "a3d-num", children: c.height_mm != null ? `${c.height_mm} mm` : "" }),
          /* @__PURE__ */ e("td", { children: c.stable == null ? "" : c.stable ? "yes" : "no" })
        ] }, c.side)) })
      ] }),
      o.command === "analyze" && /* @__PURE__ */ i("p", { className: "a3d-muted a3d-small", children: [
        "Measured on ",
        String(o.source ?? ""),
        "."
      ] })
    ] })
  ] });
}
const hs = `"""Place files the user picked into the right folder of a model. Run by the Nimbalyst panel:
    python3 - <model dir> <image|mesh> <move|copy> <source path>...   (source on stdin)
Images go to inbox/ (kind view: inbox/views/). Meshes: .glb/.gltf/.obj/.fbx become mesh/raw.<ext> (the previous raw.* is archived to
mesh/attempts/), .stl goes to mesh/, .3mf goes to print/. Nothing is overwritten. Prints one JSON document."""
import json
import os
import shutil
import sys
import time

model, kind, mode = sys.argv[1], sys.argv[2], sys.argv[3]
sources = sys.argv[4:]
IMG = (".png", ".jpg", ".jpeg", ".webp", ".gif")
RAW = (".glb", ".gltf", ".obj", ".fbx")
placed, skipped = [], []


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


for src in sources:
    if not os.path.isfile(src):
        skipped.append({"file": src, "why": "not a file"})
        continue
    base = os.path.basename(src)
    ext = os.path.splitext(base)[1].lower()
    archived = None
    if kind in ("image", "view"):
        if ext not in IMG:
            skipped.append({"file": base, "why": "not an image (png, jpg, webp, gif)"})
            continue
        # views for multi-view 3D wait in inbox/views/ for Lumen *review-views
        folder, name = ("inbox/views" if kind == "view" else "inbox"), None
    elif ext in RAW:
        folder, name = "mesh", "raw" + ext
        mesh_dir = os.path.join(model, "mesh")
        if os.path.isdir(mesh_dir):
            for old in sorted(os.listdir(mesh_dir)):
                if old.lower().startswith("raw.") and os.path.isfile(os.path.join(mesh_dir, old)):
                    archived = archive(os.path.join(mesh_dir, old))
    elif ext == ".stl":
        folder, name = "mesh", None
        existing = os.path.join(model, "mesh", base)
        if base.lower() == "print.stl" and os.path.isfile(existing):
            archived = archive(existing)
    elif ext == ".3mf":
        folder, name = "print", None
    else:
        skipped.append({"file": base, "why": "not a 3D file (glb, gltf, obj, fbx, stl, 3mf)"})
        continue
    dest_dir = os.path.join(model, folder)
    os.makedirs(dest_dir, exist_ok=True)
    name = name if name and not os.path.exists(os.path.join(dest_dir, name)) else free_name(dest_dir, name or base)
    dest = os.path.join(dest_dir, name)
    if os.path.abspath(src) == os.path.abspath(dest):
        skipped.append({"file": base, "why": "already there"})
        continue
    (shutil.move if mode == "move" else shutil.copy2)(src, dest)
    placed.append({"file": "%s/%s" % (folder, name), "archived": archived})
print(json.dumps({"placed": placed, "skipped": skipped}))
`, Ln = ["png", "jpg", "jpeg", "webp", "gif"], En = ["glb", "gltf", "obj", "fbx", "stl", "3mf"], ps = (t) => {
  const a = t.split(".").pop()?.toLowerCase() ?? "";
  return Ln.includes(a) ? "image" : En.includes(a) ? "mesh" : null;
};
async function ut(t, a) {
  if (!Mn()) return null;
  const l = (a !== "mesh" ? Ln : En).map((w) => `"${w}"`).join(", "), o = [
    'tell application "Finder" to activate',
    `tell application "Finder" to set fs to choose file with prompt "${a === "image" ? "Choose the generated image(s)" : a === "view" ? "Choose the view images (front, left, back, right)" : "Choose the 3D file (GLB, STL, 3MF…)"}" of type {${l}} with multiple selections allowed`,
    'set out to ""',
    "repeat with f in fs",
    "set out to out & POSIX path of f & linefeed",
    "end repeat",
    "return out"
  ].map((w) => `-e ${$(w)}`).join(" "), g = await t.exec(`osascript ${o}`, { timeout: 6e5 });
  return g.success ? g.stdout.split(`
`).map((w) => w.trim()).filter(Boolean) : /-128|cancel/i.test(g.stderr) ? [] : null;
}
function us(t) {
  let a = "";
  for (let l = 0; l < t.length; l += 32768) a += String.fromCharCode(...t.subarray(l, l + 32768));
  return btoa(a);
}
async function Mi(t, a, l) {
  const s = `${a}/.import-tmp`, o = `${s}/${l.name.replace(/[^\w.\- ]+/g, "_")}`, g = await t.exec(`mkdir -p ${$(s)} && : > ${$(o)}`, { timeout: 15e3 });
  if (!g.success) throw new Error(g.stderr.trim() || "could not create the temporary file");
  const w = 6e4;
  if (l.size > 12e7) throw new Error(`${l.name} is too large to add this way; copy it into the model folder instead`);
  for (let m = 0; m < l.size; m += w) {
    const x = new Uint8Array(await l.slice(m, m + w).arrayBuffer()), C = await t.exec(
      `python3 -c "import sys,base64;open(sys.argv[1],'ab').write(base64.b64decode(sys.stdin.read()))" ${$(o)} <<'A3D_B64'
${us(x)}
A3D_B64`,
      { timeout: 6e4 }
    );
    if (!C.success) throw new Error(C.stderr.trim() || `upload of ${l.name} failed`);
  }
  return o;
}
async function Sn(t, a, l, s, o) {
  const g = await t.exec(
    `python3 - ${$(a)} ${l} ${s} ${o.map($).join(" ")} <<'A3D_IMPORT'
${hs}
A3D_IMPORT`,
    { timeout: 12e4 }
  );
  if (!g.success) throw new Error(g.stderr.trim().split(`
`).pop() || "import failed");
  return JSON.parse(g.stdout.trim().split(`
`).pop() ?? "{}");
}
function ms(t, a, l, s) {
  return Sn(t, a, l, "copy", s);
}
async function fs(t, a, l, s) {
  const o = s.map((m) => m.path).filter((m) => !!m);
  if (o.length === s.length) return Sn(t, a, l, "copy", o);
  const g = [];
  for (const m of s) g.push(await Mi(t, a, m));
  const w = await Sn(t, a, l, "move", g);
  return t.exec(`rmdir ${$(`${a}/.import-tmp`)} 2>/dev/null; true`, { timeout: 1e4 }), w;
}
function gs(t) {
  const a = [];
  t.placed.length && a.push(`Added ${t.placed.map((s) => s.file).join(", ")}.`);
  const l = t.placed.filter((s) => s.archived).map((s) => s.archived);
  return l.length && a.push(`The previous file was kept as ${l.join(", ")}.`), t.skipped.length && a.push(`Skipped: ${t.skipped.map((s) => `${s.file} (${s.why})`).join("; ")}.`), a.join(" ") || "Nothing was added.";
}
const Gt = /\.(png|jpe?g|webp|gif)$/i, fi = /\.(stl|3mf|glb|gltf|obj|fbx|blend)$/i, bn = /\.(md|json|txt|ya?ml)$/i;
function wn(t, a) {
  const l = (o, g, w) => g.filter((m) => w.test(m.name)).map((m) => ({ rel: `${o}/${m.name}`, f: m }));
  if (a === "images") return [...l("inbox", t.files.inbox, Gt), ...l("images", t.files.images, Gt), ...l("renders", t.files.renders, Gt), ...l("refs", t.files.refs, Gt)];
  if (a === "meshes") return [...l("mesh", t.files.mesh, fi), ...l("print", t.files.print, /\.3mf$/i), ...l("mesh/attempts", t.attempts, fi)];
  const s = [];
  return t.concept && s.push({ rel: "concept.md", f: { name: "concept.md", size: t.concept.length, mtime: t.stamp } }), t.hasReadme && s.push({ rel: "README.md", f: { name: "README.md", size: 0, mtime: t.stamp } }), [...s, ...l("prompts", t.files.prompts, bn), ...l("print", t.files.print, bn), ...l("publish", t.files.publish, bn)];
}
const gi = (t) => new Date(t * 1e3).toLocaleDateString([], { month: "short", day: "numeric" });
function bi({ host: t, model: a, type: l, rows: s, onZoom: o, onOpen: g, onReveal: w, onView: m, onConcept: x }) {
  const C = /* @__PURE__ */ new Map();
  for (const v of a.flow.nodes) for (const f of v.files) C.set(f, v.label);
  return s.length ? l === "images" ? /* @__PURE__ */ e("div", { className: "a3d-gallery a3d-gallery-files", children: s.map(({ rel: v, f }) => {
    const S = `${a.dir}/${v}`;
    return /* @__PURE__ */ i("figure", { children: [
      /* @__PURE__ */ e(Oe, { host: t, path: S, mtime: f.mtime, alt: f.name, onClick: () => o({ path: S, mtime: f.mtime, name: v }) }),
      /* @__PURE__ */ i("figcaption", { title: v, children: [
        /* @__PURE__ */ e("span", { className: "a3d-file-folder", children: v.split("/")[0] }),
        " ",
        f.name
      ] }),
      /* @__PURE__ */ i("span", { className: "a3d-fig-actions", children: [
        /* @__PURE__ */ e("span", { className: "a3d-muted", children: C.get(v) ?? gi(f.mtime) }),
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: () => w(a, v), children: "Show in Finder" }),
        x && /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", title: "Muse writes a concept from this picture: a new model, or a new branch of this one", onClick: () => x(S), children: "Concept from this…" })
      ] })
    ] }, v);
  }) }) : /* @__PURE__ */ i("table", { className: "a3d-filetable", children: [
    /* @__PURE__ */ e("thead", { children: /* @__PURE__ */ i("tr", { children: [
      /* @__PURE__ */ e("th", { children: "File" }),
      /* @__PURE__ */ e("th", { children: "Size" }),
      /* @__PURE__ */ e("th", { children: "Date" }),
      /* @__PURE__ */ e("th", { children: "From attempt" }),
      /* @__PURE__ */ e("th", { children: /* @__PURE__ */ e("span", { className: "a3d-sr", children: "Actions" }) })
    ] }) }),
    /* @__PURE__ */ e("tbody", { children: s.map(({ rel: v, f }) => /* @__PURE__ */ i("tr", { children: [
      /* @__PURE__ */ i("td", { children: [
        /* @__PURE__ */ e("span", { className: "a3d-file-folder", children: v.slice(0, v.lastIndexOf("/") + 1) }),
        /* @__PURE__ */ e("strong", { children: f.name }),
        /^mesh\/print\.stl$/.test(v) && /* @__PURE__ */ e("span", { className: "a3d-pill a3d-pill-done", children: "to print" }),
        /^mesh\/raw\./.test(v) && /* @__PURE__ */ e("span", { className: "a3d-pill", children: "as generated" })
      ] }),
      /* @__PURE__ */ e("td", { className: "a3d-num", children: f.size ? Si(f.size) : "" }),
      /* @__PURE__ */ e("td", { className: "a3d-num", children: gi(f.mtime) }),
      /* @__PURE__ */ e("td", { className: "a3d-muted", children: C.get(v) ?? "" }),
      /* @__PURE__ */ e("td", { children: /* @__PURE__ */ i("span", { className: "a3d-row a3d-row-end", children: [
        m && /\.stl$/i.test(f.name) && v.startsWith("mesh/") && !v.includes("attempts") && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => m(a), children: "3D view" }),
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => g(a, v), children: l === "docs" ? "Open" : /\.(stl|3mf)$/i.test(f.name) ? "Open in slicer" : "Open in app" }),
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => w(a, v), children: "Show in Finder" })
      ] }) })
    ] }, v)) })
  ] }) : /* @__PURE__ */ e("p", { className: "a3d-muted a3d-files-empty", children: l === "images" ? "No images." : l === "meshes" ? "No 3D files." : "No documents." });
}
function bs({ host: t, scan: a, model: l, nodeFilter: s, importing: o, onClearFilter: g, onSelectModel: w, onZoom: m, onOpen: x, onReveal: C, onView: v, onPick: f, onFiles: S, onConcept: E }) {
  const [B, M] = A("images"), [I, L] = A(!1), c = qe(null), [O, T] = A("image"), _ = l && s ? l.flow.nodes.find((d) => d.id === s) ?? null : null, y = a.models.filter((d) => d.slug !== l?.slug), F = (d, u) => wn(d, u).length, b = async (d) => {
    await f(d) || (T(d), setTimeout(() => c.current?.click(), 0));
  }, j = l ? wn(l, B).filter((d) => !_ || _.files.includes(d.rel)) : [];
  return /* @__PURE__ */ i("section", { className: "a3d-files-tab", children: [
    /* @__PURE__ */ i("header", { className: "a3d-head", children: [
      /* @__PURE__ */ i("div", { children: [
        /* @__PURE__ */ e("h1", { children: "Files" }),
        /* @__PURE__ */ e("p", { className: "a3d-muted", children: l ? /* @__PURE__ */ e(ee, { children: "The selected model first, every other model below." }) : "Pick a model in Models to see its files first." })
      ] }),
      /* @__PURE__ */ e("span", { className: "a3d-seg", role: "group", "aria-label": "File type", children: [["images", "Images"], ["meshes", "3D files"], ["docs", "Documents"]].map(([d, u]) => /* @__PURE__ */ i("button", { type: "button", "aria-pressed": B === d, onClick: () => M(d), children: [
        u,
        l ? ` ${F(l, d)}` : ""
      ] }, d)) })
    ] }),
    l && /* @__PURE__ */ i(
      "section",
      {
        className: I ? "a3d-files-current a3d-drop-over" : "a3d-files-current",
        onDragOver: (d) => {
          d.preventDefault(), L(!0);
        },
        onDragLeave: () => L(!1),
        onDrop: (d) => {
          d.preventDefault(), L(!1);
          const u = Array.from(d.dataTransfer.files);
          u.length && S(u);
        },
        children: [
          /* @__PURE__ */ i("div", { className: "a3d-files-bar", children: [
            /* @__PURE__ */ i("h3", { children: [
              l.meta.title || l.slug,
              l.branches?.length > 1 && /* @__PURE__ */ i("span", { className: "a3d-muted", style: { fontWeight: 400 }, children: [
                " · branch ",
                l.branches.find((d) => d.id === l.branch)?.name ?? l.branch
              ] })
            ] }),
            /* @__PURE__ */ i("span", { className: "a3d-row", children: [
              /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-primary", disabled: o, onClick: () => {
                b("image");
              }, children: "Add image…" }),
              /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-primary", disabled: o, onClick: () => {
                b("mesh");
              }, children: "Add 3D model…" }),
              /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => C(l, ""), children: "Show folder in Finder" })
            ] })
          ] }),
          /* @__PURE__ */ e("p", { className: "a3d-muted a3d-files-hint", children: o ? "Adding files…" : "Or drop files here. Images go to inbox/, a GLB becomes mesh/raw.glb (the previous one is kept in mesh/attempts/), STL goes to mesh/, 3MF to print/." }),
          _ && /* @__PURE__ */ i("p", { className: "a3d-banner", children: [
            "Only the files of the attempt “",
            _.label,
            "”.",
            /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: g, children: "Show all files" })
          ] }),
          /* @__PURE__ */ e(bi, { host: t, model: l, type: B, rows: j, onZoom: m, onOpen: x, onReveal: C, onView: v, onConcept: E }),
          /* @__PURE__ */ e(
            "input",
            {
              ref: c,
              type: "file",
              multiple: !0,
              hidden: !0,
              accept: (O === "image" ? Ln : En).map((d) => `.${d}`).join(","),
              onChange: (d) => {
                const u = Array.from(d.target.files ?? []);
                d.target.value = "", u.length && S(u);
              }
            }
          )
        ]
      }
    ),
    y.length > 0 && /* @__PURE__ */ i("section", { className: "a3d-files-others", children: [
      /* @__PURE__ */ e("h3", { className: "a3d-files-others-title", children: "Other models" }),
      y.map((d) => /* @__PURE__ */ i("details", { children: [
        /* @__PURE__ */ i("summary", { children: [
          /* @__PURE__ */ e("span", { className: "a3d-files-name", children: d.meta.title || d.slug }),
          /* @__PURE__ */ i("span", { className: "a3d-muted", children: [
            F(d, B),
            " ",
            B === "images" ? "images" : B === "meshes" ? "3D files" : "documents"
          ] }),
          /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: (u) => {
            u.preventDefault(), w(d.slug);
          }, children: "Select" })
        ] }),
        /* @__PURE__ */ e(bi, { host: t, model: d, type: B, rows: wn(d, B), onZoom: m, onOpen: x, onReveal: C, onConcept: E })
      ] }, d.slug))
    ] })
  ] });
}
const vt = [
  { id: "demand", label: "Demand" },
  { id: "print_fit", label: "Print fit" },
  { id: "differentiation", label: "Stand-out" },
  { id: "ip_safety", label: "IP safety" },
  { id: "ease", label: "Ease" }
], ws = [
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
], vs = Li.flatMap((t) => t.fields), ys = Object.fromEntries(vs.map((t) => [t.key, t.def]));
function wi(t) {
  const a = (t.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  return a.length === 1 ? [a[0], a[0], a[0]] : a.length >= 3 ? [a[0], a[1], a[2]] : [256, 256, 256];
}
const ks = (t) => t.join("x");
function Ei(t) {
  const a = Object.fromEntries(vt.map((l) => [l.id, 1]));
  for (const l of t.split(/[,\s]+/)) {
    const [s, o] = l.split("=");
    s in a && o !== void 0 && !Number.isNaN(Number(o)) && (a[s] = Number(o));
  }
  return a;
}
const Ns = (t) => vt.map((a) => `${a.id}=${t[a.id]}`).join(",");
function $s(t) {
  const a = {};
  for (const l of t.split(/\r?\n/)) {
    const s = l.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*(?:#.*)?$/);
    s && s[2] !== "" && (a[s[1]] = s[2].trim().replace(/^["']|["']$/g, ""));
  }
  return a;
}
const vi = (t) => `"${t.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
function Cs(t, a) {
  let l = t;
  const s = [];
  for (const [o, g] of Object.entries(a)) {
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
Object.fromEntries(vt.map((t) => [t.id, t.label]));
function wt(t, a) {
  const l = Ei(a ?? ""), s = t.scores ?? {};
  let o = 0, g = 0;
  for (const w of vt) {
    const m = s[w.id];
    if (typeof m != "number") return null;
    o += l[w.id] * (m - 1) / 4, g += l[w.id];
  }
  return g ? Math.round(100 * o / g) : null;
}
function jn({ value: t }) {
  return t == null ? /* @__PURE__ */ e("span", { className: "a3d-muted", children: "not scored" }) : /* @__PURE__ */ i("span", { className: "a3d-scorebar", title: `${t} of 100`, children: [
    /* @__PURE__ */ e("span", { className: "a3d-track", children: /* @__PURE__ */ e("i", { style: { width: `${t}%` } }) }),
    /* @__PURE__ */ e("b", { children: t })
  ] });
}
function _s({ s: t }) {
  const a = new Set(t.estimated ?? []);
  return /* @__PURE__ */ e("dl", { className: "a3d-dims", children: vt.map((l) => {
    const s = t.scores?.[l.id];
    return /* @__PURE__ */ i("div", { children: [
      /* @__PURE__ */ i("dt", { children: [
        l.label,
        a.has(l.id) ? /* @__PURE__ */ e("span", { className: "a3d-muted", title: "estimated, no source", children: " ~" }) : null
      ] }),
      /* @__PURE__ */ i("dd", { children: [
        /* @__PURE__ */ e("span", { className: "a3d-dimbar", "aria-hidden": "true", children: [1, 2, 3, 4, 5].map((o) => /* @__PURE__ */ e("i", { className: typeof s == "number" && o <= s ? "on" : "" }, o)) }),
        /* @__PURE__ */ e("span", { children: typeof s == "number" ? `${s} / 5` : "–" })
      ] })
    ] }, l.id);
  }) });
}
const xs = ["animal", "character", "object", "other"], yi = /\.(png|jpe?g|webp|gif)$/i;
function Ss({ onCancel: t, onCreate: a }) {
  const [l, s] = A(""), [o, g] = A("animal"), [w, m] = A(""), x = (C) => {
    l.trim() && a(l.trim(), o, w.trim(), C);
  };
  return /* @__PURE__ */ e("div", { className: "a3d-overlay", onClick: t, children: /* @__PURE__ */ i("form", { className: "a3d-dialog a3d-dialog-wide", onClick: (C) => C.stopPropagation(), onSubmit: (C) => {
    C.preventDefault(), x(!0);
  }, children: [
    /* @__PURE__ */ e("h3", { children: "New idea" }),
    /* @__PURE__ */ e("p", { className: "a3d-muted", children: "An animal, a character or a thing you want to turn into a model. It is saved in insights/ at once; preparing it is an agent run." }),
    /* @__PURE__ */ i("label", { children: [
      "Name",
      /* @__PURE__ */ e("input", { autoFocus: !0, value: l, onChange: (C) => s(C.target.value), placeholder: "Axolotl dragon" })
    ] }),
    /* @__PURE__ */ i("label", { children: [
      "Kind",
      /* @__PURE__ */ e("select", { value: o, onChange: (C) => g(C.target.value), children: xs.map((C) => /* @__PURE__ */ e("option", { children: C }, C)) })
    ] }),
    /* @__PURE__ */ i("label", { children: [
      "What you have in mind",
      /* @__PURE__ */ e("textarea", { rows: 4, value: w, onChange: (C) => m(C.target.value), placeholder: "Chibi axolotl with small dragon wings, flexi, about 12 cm, for kids." })
    ] }),
    /* @__PURE__ */ i("span", { className: "a3d-row a3d-row-end", children: [
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: t, children: "Cancel" }),
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", disabled: !l.trim(), onClick: () => x(!1), children: "Save only" }),
      /* @__PURE__ */ e("button", { type: "submit", className: "a3d-btn a3d-btn-primary", disabled: !l.trim(), children: "Save and prepare (Muse)" })
    ] })
  ] }) });
}
function Vt({ n: t, title: a, state: l, text: s, running: o, children: g }) {
  return /* @__PURE__ */ i("li", { className: `a3d-stage a3d-stage-${l}`, children: [
    /* @__PURE__ */ i("span", { className: "a3d-stage-top", children: [
      /* @__PURE__ */ e("span", { className: "a3d-stage-n", children: l === "done" ? "✓" : t }),
      /* @__PURE__ */ e("strong", { children: a }),
      o ? /* @__PURE__ */ e("span", { className: "a3d-tag a3d-tag-run", children: "running" }) : l === "next" ? /* @__PURE__ */ e("span", { className: "a3d-tag a3d-tag-waiting", children: "next" }) : null
    ] }),
    /* @__PURE__ */ e("span", { className: "a3d-muted a3d-small", children: s }),
    /* @__PURE__ */ e("span", { className: "a3d-row", children: g })
  ] });
}
function js({ host: t, scan: a, selected: l, running: s, onSelect: o, onCreate: g, onAgent: w, onDecide: m, onRef: x, onRemoveRef: C, onPickImage: v, onZoom: f, onSelectTrend: S, onSelectModel: E, onReveal: B, onOpen: M }) {
  const [I, L] = A("open"), [c, O] = A(!1), [T, _] = A(""), [y, F] = A(""), [b, j] = A(""), d = a.config.score_weights, u = je(() => a.ideas.filter((N) => I === "all" || !["no", "modeled"].includes(N.status)).sort((N, te) => (te.updated_at ?? "").localeCompare(N.updated_at ?? "")), [a.ideas, I]), p = a.ideas.find((N) => N.slug === l) ?? u[0] ?? null, U = p?.trend ? a.trends.find((N) => N.slug === p.trend) : null, q = p?.model ? a.models.find((N) => N.slug === p.model) : null, ie = p?.references ?? [], Z = new Set(ie.map((N) => (N.file ?? "").replace(/^refs\//, "")).filter(Boolean)), X = (p?._refs ?? []).filter((N) => yi.test(N) && !Z.has(N)), $e = [
    ...ie.map((N, te) => ({ r: N, n: te })).filter((N) => N.r.file && yi.test(N.r.file)).map((N) => ({ file: N.r.file.replace(/^refs\//, ""), title: N.r.title, note: N.r.note, url: N.r.url, n: N.n })),
    ...X.map((N) => ({ file: N, title: N, note: void 0, url: void 0, n: null }))
  ], Be = ie.map((N, te) => ({ r: N, n: te })).filter((N) => N.r.url), be = (p?.evidence ?? []).filter((N) => N.label || N.url), R = !!p && (p.status !== "draft" || (p.traits ?? []).length > 0 || (p.variants ?? []).length > 0), W = !!p && Object.keys(p.scores ?? {}).length > 0, de = !!p?.decision, pe = !!q || p?.status === "modeled", we = [R, W, de, pe], Te = we.indexOf(!1), Ce = (N) => we[N] ? "done" : N === Te ? "next" : "todo", Xe = (N) => !!p && s.some((te) => te.startsWith(N) && te.includes(p.title)), rt = /^https?:\/\/\S+$/i.test(T.trim());
  return /* @__PURE__ */ i("section", { className: "a3d-trends", children: [
    /* @__PURE__ */ i("header", { className: "a3d-head", children: [
      /* @__PURE__ */ i("div", { children: [
        /* @__PURE__ */ e("h1", { children: "Insights" }),
        /* @__PURE__ */ e("p", { className: "a3d-muted", children: "An idea goes through four stages: prepare (traits, references from the web, variants, market, IP), score, decide, create the model. You can create the model at any stage." })
      ] }),
      /* @__PURE__ */ e("span", { className: "a3d-row", children: /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-primary", onClick: () => O(!0), children: "New idea…" }) })
    ] }),
    /* @__PURE__ */ i("div", { className: "a3d-split", children: [
      /* @__PURE__ */ i("aside", { className: "a3d-split-list", children: [
        /* @__PURE__ */ i("span", { className: "a3d-seg a3d-seg-small", role: "group", "aria-label": "Filter", children: [
          /* @__PURE__ */ e("button", { type: "button", "aria-pressed": I === "open", onClick: () => L("open"), children: "Open" }),
          /* @__PURE__ */ e("button", { type: "button", "aria-pressed": I === "all", onClick: () => L("all"), children: "All" })
        ] }),
        u.length === 0 && /* @__PURE__ */ e("p", { className: "a3d-muted", children: "No ideas yet. Add one, or “Prepare” an idea from a trend." }),
        /* @__PURE__ */ e("ul", { children: u.map((N) => /* @__PURE__ */ e("li", { children: /* @__PURE__ */ i("button", { type: "button", className: N.slug === p?.slug ? "a3d-li a3d-li-sel" : "a3d-li", onClick: () => o(N.slug), children: [
          /* @__PURE__ */ i("span", { className: "a3d-li-title", children: [
            N.title,
            " ",
            /* @__PURE__ */ e("span", { className: `a3d-pill a3d-is-${N.status}`, children: N.status })
          ] }),
          /* @__PURE__ */ i("span", { className: "a3d-muted", children: [
            N.subject_kind,
            N.trend ? ` · from ${a.trends.find((te) => te.slug === N.trend)?.title ?? N.trend}` : ""
          ] }),
          /* @__PURE__ */ e(jn, { value: wt(N, d) })
        ] }) }, N.slug)) })
      ] }),
      p ? /* @__PURE__ */ i("article", { className: "a3d-split-detail", children: [
        /* @__PURE__ */ i("header", { className: "a3d-detail-top", children: [
          /* @__PURE__ */ i("div", { children: [
            /* @__PURE__ */ i("h2", { className: "a3d-h2", children: [
              p.title,
              " ",
              /* @__PURE__ */ e("span", { className: `a3d-pill a3d-is-${p.status}`, children: p.status }),
              p.subject_kind && /* @__PURE__ */ e("span", { className: "a3d-pill", children: p.subject_kind })
            ] }),
            /* @__PURE__ */ i("p", { className: "a3d-muted", children: [
              U ? /* @__PURE__ */ i(ee, { children: [
                "From trend ",
                /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: () => S(U.slug), children: U.title }),
                " · "
              ] }) : null,
              p.description || "No description yet."
            ] })
          ] }),
          /* @__PURE__ */ i("span", { className: "a3d-row", children: [
            p._files.includes("brief.md") && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => M(`${p._dir}/brief.md`), children: "Open brief" }),
            /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => B(p._dir), children: "Show in Finder" })
          ] })
        ] }),
        /* @__PURE__ */ i("ol", { className: "a3d-stages", "aria-label": "Stages of this idea", children: [
          /* @__PURE__ */ e(
            Vt,
            {
              n: 1,
              title: "Prepare",
              state: Ce(0),
              running: Xe("Prepare") || Xe("References"),
              text: R ? `${(p.traits ?? []).length} traits · ${ie.length + X.length} references · ${(p.variants ?? []).length} variants` : "Muse searches the web, collects references, traits, variants, similar models and the IP risk, and writes the brief.",
              children: /* @__PURE__ */ e(
                "button",
                {
                  type: "button",
                  className: Ce(0) === "next" ? "a3d-btn a3d-btn-primary" : "a3d-btn",
                  onClick: () => w("prepare", p),
                  title: "Agent run: ai3d-muse *prepare",
                  children: R ? "Prepare again" : "Prepare (Muse)"
                }
              )
            }
          ),
          /* @__PURE__ */ e(
            Vt,
            {
              n: 2,
              title: "Score",
              state: Ce(1),
              running: Xe("Score"),
              text: W ? `Total ${wt(p, d) ?? "–"} of 100 with your weights.` : "Prism scores demand, print fit, stand-out, IP safety and ease, with evidence.",
              children: /* @__PURE__ */ e("button", { type: "button", className: Ce(1) === "next" ? "a3d-btn a3d-btn-primary" : "a3d-btn", onClick: () => w("score", p), title: "Agent run: ai3d-prism *score insight", children: W ? "Score again" : "Score (Prism)" })
            }
          ),
          /* @__PURE__ */ e(
            Vt,
            {
              n: 3,
              title: "Decide",
              state: Ce(2),
              text: p.decision ? `Decided ${p.decision.verdict}${p.decision.reason ? `: ${p.decision.reason}` : ""}.` : "Your call. It only marks the idea; nothing is deleted.",
              children: ["go", "later", "no"].map((N) => /* @__PURE__ */ e(
                "button",
                {
                  type: "button",
                  className: "a3d-btn a3d-btn-small",
                  "aria-pressed": p.decision?.verdict === N,
                  disabled: p.status === "modeled",
                  onClick: () => m(p, N),
                  title: `Runs: trend_lib.py decide <idea folder> ${N}`,
                  children: N === "go" ? "Go" : N === "later" ? "Later" : "No"
                },
                N
              ))
            }
          ),
          /* @__PURE__ */ e(
            Vt,
            {
              n: 4,
              title: "Model",
              state: Ce(3),
              running: Xe("New model"),
              text: q ? "The model exists; work on it in Flow." : R ? "Muse writes the concept from the brief and creates the model folder, linked to this idea." : "Possible now: Muse works from the description only. Preparing first gives it references and a variant.",
              children: q ? /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-primary", onClick: () => E(q.slug), children: "Open model" }) : /* @__PURE__ */ e(
                "button",
                {
                  type: "button",
                  className: Ce(3) === "next" || p.decision?.verdict === "go" ? "a3d-btn a3d-btn-primary" : "a3d-btn",
                  onClick: () => w("concept", p),
                  title: "Agent run: ai3d-muse *concept with this idea",
                  children: "Create model"
                }
              )
            }
          )
        ] }),
        /* @__PURE__ */ i("section", { className: "a3d-block", children: [
          /* @__PURE__ */ i("h4", { children: [
            "References ",
            /* @__PURE__ */ e("span", { className: "a3d-count", children: ie.length + X.length })
          ] }),
          /* @__PURE__ */ i("p", { className: "a3d-muted a3d-small", children: [
            "Pictures and pages Muse and Lumen work from. Found on the web by Muse, or added by you. Pictures are saved in the idea’s ",
            /* @__PURE__ */ e("code", { children: "refs/" }),
            " folder."
          ] }),
          /* @__PURE__ */ i("form", { className: "a3d-row a3d-refbar", onSubmit: (N) => {
            N.preventDefault(), w("refs", p, b.trim() || void 0), j("");
          }, children: [
            /* @__PURE__ */ e("input", { className: "a3d-in-grow", "aria-label": "What to look for", placeholder: "What to look for (optional): side view, chibi style, printed flexi versions…", value: b, onChange: (N) => j(N.target.value) }),
            /* @__PURE__ */ e("button", { type: "submit", className: "a3d-btn a3d-btn-primary", title: "Agent run: ai3d-muse *refs — web search for pages and pictures, saved with trend_lib.py ref", children: "Find on the web (Muse)" })
          ] }),
          /* @__PURE__ */ i("form", { className: "a3d-row a3d-refbar", onSubmit: (N) => {
            N.preventDefault(), rt && (x(p, { url: T.trim(), note: y.trim() || void 0 }), _(""), F(""));
          }, children: [
            /* @__PURE__ */ e("input", { className: "a3d-in-grow", "aria-label": "Link", placeholder: "Paste a link to a page or a picture (https://…)", value: T, onChange: (N) => _(N.target.value) }),
            /* @__PURE__ */ e("input", { className: "a3d-in-small", "aria-label": "Note", placeholder: "note", value: y, onChange: (N) => F(N.target.value) }),
            /* @__PURE__ */ e("button", { type: "submit", className: "a3d-btn", disabled: !rt, title: "Runs: trend_lib.py ref <idea folder> --url … (a picture link is downloaded into refs/)", children: "Add link" }),
            /* @__PURE__ */ e(
              "button",
              {
                type: "button",
                className: "a3d-btn",
                title: "Runs: trend_lib.py ref <idea folder> --file …",
                onClick: async () => {
                  const N = await v();
                  for (const te of N ?? []) x(p, { file: te });
                },
                children: "Add picture…"
              }
            )
          ] }),
          $e.length > 0 && /* @__PURE__ */ e("div", { className: "a3d-gallery", children: $e.map((N) => {
            const te = `${p._dir}/refs/${N.file}`;
            return /* @__PURE__ */ i("figure", { children: [
              /* @__PURE__ */ e(Oe, { host: t, path: te, mtime: p._mtime, alt: N.title || N.file, onClick: () => f({ path: te, mtime: p._mtime, name: N.title || N.file }) }),
              /* @__PURE__ */ e("figcaption", { title: N.note, children: N.note || N.title || N.file })
            ] }, N.file);
          }) }),
          Be.length > 0 && /* @__PURE__ */ e("ul", { className: "a3d-reflist", children: Be.map(({ r: N, n: te }) => /* @__PURE__ */ i("li", { children: [
            /* @__PURE__ */ e("a", { href: N.url, target: "_blank", rel: "noreferrer", children: N.title || N.url }),
            N.file ? /* @__PURE__ */ e("span", { className: "a3d-pill", children: "picture saved" }) : null,
            N.note ? /* @__PURE__ */ i("span", { className: "a3d-muted", children: [
              " — ",
              N.note
            ] }) : null,
            /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", "aria-label": `Remove reference ${N.title || N.url}`, onClick: () => C(p, te + 1), children: "remove" })
          ] }, te)) }),
          $e.length === 0 && Be.length === 0 && /* @__PURE__ */ e("p", { className: "a3d-muted", children: "No references yet. “Find on the web” searches for the real subject, the style and existing printed models." })
        ] }),
        /* @__PURE__ */ i("div", { className: "a3d-two", children: [
          /* @__PURE__ */ i("section", { className: "a3d-block", children: [
            /* @__PURE__ */ e("h4", { children: "Recognisable traits" }),
            (p.traits ?? []).length ? /* @__PURE__ */ e("p", { className: "a3d-chips", children: p.traits.map((N) => /* @__PURE__ */ e("span", { className: "a3d-pill", children: N }, N)) }) : /* @__PURE__ */ e("p", { className: "a3d-muted", children: "Filled by Prepare: the 3–6 features that must survive at print size." }),
            /* @__PURE__ */ e("h4", { children: "IP risk" }),
            /* @__PURE__ */ i("p", { children: [
              /* @__PURE__ */ e("span", { className: `a3d-pill a3d-risk-${p.ip?.risk ?? "unknown"}`, children: p.ip?.risk ?? "not assessed" }),
              " ",
              p.ip?.notes
            ] })
          ] }),
          /* @__PURE__ */ i("section", { className: "a3d-block", children: [
            /* @__PURE__ */ i("h4", { children: [
              "Scores ",
              /* @__PURE__ */ e(jn, { value: wt(p, d) })
            ] }),
            W ? /* @__PURE__ */ e(_s, { s: p }) : /* @__PURE__ */ e("p", { className: "a3d-muted", children: "Not scored yet." }),
            be.length > 0 && /* @__PURE__ */ e("ul", { className: "a3d-evidence", children: be.map((N, te) => /* @__PURE__ */ e("li", { children: N.url ? /* @__PURE__ */ e("a", { href: N.url, target: "_blank", rel: "noreferrer", children: N.label || N.url }) : N.label }, te)) })
          ] })
        ] }),
        (p.variants ?? []).length > 0 && /* @__PURE__ */ i("section", { className: "a3d-block", children: [
          /* @__PURE__ */ e("h4", { children: "Variants" }),
          /* @__PURE__ */ i("table", { className: "a3d-filetable", children: [
            /* @__PURE__ */ e("thead", { children: /* @__PURE__ */ i("tr", { children: [
              /* @__PURE__ */ e("th", {}),
              /* @__PURE__ */ e("th", { children: "Type" }),
              /* @__PURE__ */ e("th", { children: "Style" }),
              /* @__PURE__ */ e("th", { children: "Size" }),
              /* @__PURE__ */ e("th", { children: "Printability" }),
              /* @__PURE__ */ e("th", { children: "Notes" })
            ] }) }),
            /* @__PURE__ */ e("tbody", { children: p.variants.map((N) => /* @__PURE__ */ i("tr", { children: [
              /* @__PURE__ */ e("td", { children: p.chosen_variant === N.id ? /* @__PURE__ */ e("span", { className: "a3d-pill a3d-pill-done", children: "chosen" }) : N.id }),
              /* @__PURE__ */ e("td", { children: N.model_type }),
              /* @__PURE__ */ e("td", { children: N.style }),
              /* @__PURE__ */ e("td", { className: "a3d-num", children: N.size_mm ? `${N.size_mm} mm` : "" }),
              /* @__PURE__ */ e("td", { className: "a3d-num", children: N.printability != null ? `${N.printability} / 5` : "" }),
              /* @__PURE__ */ e("td", { children: N.notes })
            ] }, N.id)) })
          ] })
        ] }),
        (p.similar ?? []).length > 0 && /* @__PURE__ */ i("section", { className: "a3d-block", children: [
          /* @__PURE__ */ e("h4", { children: "Already on the market" }),
          /* @__PURE__ */ i("table", { className: "a3d-filetable", children: [
            /* @__PURE__ */ e("thead", { children: /* @__PURE__ */ i("tr", { children: [
              /* @__PURE__ */ e("th", { children: "Model" }),
              /* @__PURE__ */ e("th", { children: "Downloads" }),
              /* @__PURE__ */ e("th", { children: "Price" }),
              /* @__PURE__ */ e("th", { children: "Note" })
            ] }) }),
            /* @__PURE__ */ e("tbody", { children: p.similar.map((N, te) => /* @__PURE__ */ i("tr", { children: [
              /* @__PURE__ */ e("td", { children: N.url ? /* @__PURE__ */ e("a", { href: N.url, target: "_blank", rel: "noreferrer", children: N.title || N.url }) : N.title }),
              /* @__PURE__ */ e("td", { className: "a3d-num", children: N.downloads ?? "" }),
              /* @__PURE__ */ e("td", { className: "a3d-num", children: N.price ?? "" }),
              /* @__PURE__ */ e("td", { children: N.note })
            ] }, te)) })
          ] })
        ] })
      ] }) : /* @__PURE__ */ e("div", { className: "a3d-placeholder", children: "Add an idea to prepare it." })
    ] }),
    c && /* @__PURE__ */ e(Ss, { onCancel: () => O(!1), onCreate: (...N) => {
      O(!1), g(...N);
    } })
  ] });
}
function Fi({ host: t, path: a, mtime: l, title: s }) {
  const [o, g] = A(null), [w, m] = A(null);
  ke(() => {
    let C = !0;
    return m(null), t.exec(`cat ${$(a)}`, { timeout: 2e4, maxBuffer: 3e7 }).then((v) => {
      C && (v.success ? g(v.stdout) : m(v.stderr.trim() || "Could not read the dashboard."));
    }), () => {
      C = !1;
    };
  }, [t, a, l]);
  const x = /dark/i.test(t.theme);
  return w ? /* @__PURE__ */ e("p", { className: "a3d-banner a3d-banner-error", children: w }) : o ? /* @__PURE__ */ e(
    "iframe",
    {
      className: "a3d-dash-frame",
      title: s,
      sandbox: "allow-scripts",
      srcDoc: o.replace('<html lang="en">', `<html lang="en" data-theme="${x ? "dark" : "light"}">`)
    }
  ) : /* @__PURE__ */ e("p", { className: "a3d-muted", children: "Loading the dashboard…" });
}
function Ds({ host: t, scan: a, stepsBySlug: l, selected: s, onSelect: o, onNew: g, onScout: w, onPortfolio: m, onSelectTrend: x }) {
  const [C, v] = A("cards"), f = a.dashboards.find((c) => c.name === "portfolio.html"), S = a.models, E = (c) => (l[c] ?? []).find((O) => O.state === "active" || O.state === "waiting") ?? null, B = S.map((c) => ({ m: c, s: E(c.slug) })).filter((c) => c.s?.state === "waiting"), I = [
    ...(l[S[0]?.slug ?? ""] ?? []).map((c) => ({ id: c.id, title: c.title, items: S.map((O) => ({ m: O, s: E(O.slug) })).filter((O) => O.s?.id === c.id) })),
    { id: "done", title: "Done", items: S.map((c) => ({ m: c, s: E(c.slug) })).filter((c) => !c.s) }
  ], L = S.filter((c) => (l[c.slug] ?? []).some((O) => O.state === "waiting")).length;
  return /* @__PURE__ */ i("section", { className: "a3d-models-tab", children: [
    /* @__PURE__ */ i("header", { className: "a3d-head", children: [
      /* @__PURE__ */ i("div", { children: [
        /* @__PURE__ */ e("h1", { children: "Models" }),
        /* @__PURE__ */ i("p", { className: "a3d-muted", children: [
          S.length,
          " model",
          S.length === 1 ? "" : "s",
          " in ",
          /* @__PURE__ */ e("code", { children: a.root.startsWith(a.workspace) ? a.root.slice(a.workspace.length + 1) || "." : a.root }),
          L > 0 ? ` · ${L} waiting for you` : "",
          ". Pick one: Flow and Files follow it."
        ] })
      ] }),
      /* @__PURE__ */ i("span", { className: "a3d-row", children: [
        /* @__PURE__ */ i("span", { className: "a3d-seg", role: "group", "aria-label": "View", children: [
          /* @__PURE__ */ e("button", { type: "button", "aria-pressed": C === "cards", onClick: () => v("cards"), children: "Cards" }),
          /* @__PURE__ */ e("button", { type: "button", "aria-pressed": C === "board", onClick: () => v("board"), children: "Board" }),
          /* @__PURE__ */ e("button", { type: "button", "aria-pressed": C === "portfolio", onClick: () => v("portfolio"), children: "Portfolio" })
        ] }),
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: w, children: "Trends" }),
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-primary", onClick: g, children: "New model" })
      ] })
    ] }),
    B.length > 0 && C !== "portfolio" && /* @__PURE__ */ i("section", { className: "a3d-queue", "aria-label": "Waiting for you", children: [
      /* @__PURE__ */ i("h3", { children: [
        "Waiting for you ",
        /* @__PURE__ */ e("span", { className: "a3d-count", children: B.length })
      ] }),
      /* @__PURE__ */ e("ul", { children: B.map(({ m: c, s: O }) => /* @__PURE__ */ e("li", { children: /* @__PURE__ */ i("button", { type: "button", className: "a3d-queue-item", onClick: () => o(c.slug), children: [
        /* @__PURE__ */ e("strong", { children: c.meta.title || c.slug }),
        /* @__PURE__ */ i("span", { className: "a3d-muted", children: [
          "Step ",
          O.n,
          " · ",
          O.title,
          ": ",
          O.hint
        ] })
      ] }) }, c.slug)) })
    ] }),
    C === "board" && /* @__PURE__ */ e("section", { className: "a3d-board", "aria-label": "Board", children: I.map((c) => /* @__PURE__ */ i("div", { className: "a3d-board-col", children: [
      /* @__PURE__ */ i("h4", { children: [
        c.title,
        " ",
        /* @__PURE__ */ e("span", { className: "a3d-count", children: c.items.length })
      ] }),
      c.items.map(({ m: O, s: T }) => /* @__PURE__ */ i("button", { type: "button", className: O.slug === s ? "a3d-board-card a3d-card-selected" : "a3d-board-card", onClick: () => o(O.slug), children: [
        /* @__PURE__ */ e("strong", { children: O.meta.title || O.slug }),
        /* @__PURE__ */ e("span", { className: "a3d-muted", children: T?.state === "waiting" ? "your turn" : O.flow.nodes.some((_) => _.status === "running") ? "running" : T ? "next" : O.meta.status ?? "" })
      ] }, O.slug))
    ] }, c.id)) }),
    C === "portfolio" && /* @__PURE__ */ i("section", { className: "a3d-block", children: [
      /* @__PURE__ */ i("p", { className: "a3d-row", children: [
        /* @__PURE__ */ e("span", { className: "a3d-muted", children: "Charts across every model: pipeline, overhang before and after, size, rounds spent." }),
        /* @__PURE__ */ e("span", { className: "a3d-tabs-spacer" }),
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", disabled: !a.tools.buildInsights, onClick: m, children: f ? "Rebuild" : "Build" })
      ] }),
      f ? /* @__PURE__ */ e(Fi, { host: t, path: `${a.root}/_insights/portfolio.html`, mtime: f.mtime, title: "Portfolio" }) : /* @__PURE__ */ e("p", { className: "a3d-muted", children: "Not built yet." })
    ] }),
    C === "cards" && S.length === 0 && /* @__PURE__ */ i("p", { className: "a3d-empty", children: [
      a.rootExists ? "No models yet." : `Folder not found: ${a.root}`,
      /* @__PURE__ */ e("br", {}),
      "Start with Scout to pick a subject, or New model if you already have an idea."
    ] }),
    C === "cards" && /* @__PURE__ */ e("ul", { className: "a3d-cards", children: S.map((c) => {
      const O = l[c.slug] ?? [], T = O.find((d) => d.state === "active" || d.state === "waiting"), _ = O.filter((d) => d.state === "done").length, y = ["renders", "images", "inbox"].map((d) => ({ folder: d, f: ue(c.files[d])[0] })).find((d) => d.f), F = c.flow.nodes.some((d) => d.status === "running"), b = c.files.mesh.filter((d) => /\.(stl|glb|gltf|obj|fbx)$/i.test(d.name)).length + c.attempts.length + c.files.print.filter((d) => /\.3mf$/i.test(d.name)).length, j = ue(c.files.inbox).length + ue(c.files.images).length + ue(c.files.renders).length;
      return /* @__PURE__ */ e("li", { children: /* @__PURE__ */ i("button", { type: "button", className: c.slug === s ? "a3d-card a3d-card-selected" : "a3d-card", "aria-pressed": c.slug === s, onClick: () => o(c.slug), children: [
        /* @__PURE__ */ e("span", { className: "a3d-card-thumb", children: y ? /* @__PURE__ */ e(Oe, { host: t, path: `${c.dir}/${y.folder}/${y.f.name}`, mtime: y.f.mtime, alt: "" }) : /* @__PURE__ */ e("span", { className: "a3d-muted", children: "no image yet" }) }),
        /* @__PURE__ */ i("span", { className: "a3d-card-body", children: [
          /* @__PURE__ */ i("span", { className: "a3d-card-title", children: [
            c.meta.title || c.slug,
            F ? /* @__PURE__ */ e("span", { className: "a3d-tag a3d-tag-run", children: "running" }) : T?.state === "waiting" ? /* @__PURE__ */ e("span", { className: "a3d-tag a3d-tag-waiting", children: "your turn" }) : null
          ] }),
          /* @__PURE__ */ e("span", { className: "a3d-muted", children: [c.meta.model_type, c.meta.status].filter(Boolean).join(" · ") || "no metadata" }),
          /* @__PURE__ */ e("span", { className: "a3d-card-step", children: T ? `Step ${T.n} of ${O.length} · ${T.title}` : `${_} of ${O.length} done` }),
          /* @__PURE__ */ e("span", { className: "a3d-progress", "aria-hidden": "true", children: O.map((d) => /* @__PURE__ */ e("i", { className: `a3d-pip a3d-${d.state}` }, d.id)) }),
          c.meta.origin?.trend && /* @__PURE__ */ i("span", { className: "a3d-card-origin", children: [
            "from ",
            /* @__PURE__ */ e(
              "span",
              {
                role: "link",
                tabIndex: 0,
                className: "a3d-link",
                onClick: (d) => {
                  d.stopPropagation(), x(c.meta.origin.trend);
                },
                onKeyDown: (d) => {
                  d.key === "Enter" && (d.stopPropagation(), x(c.meta.origin.trend));
                },
                children: a.trends.find((d) => d.slug === c.meta.origin.trend)?.title ?? c.meta.origin.trend
              }
            )
          ] }),
          /* @__PURE__ */ i("span", { className: "a3d-muted a3d-card-counts", children: [
            j,
            " image",
            j === 1 ? "" : "s",
            " · ",
            b,
            " 3D file",
            b === 1 ? "" : "s",
            " · ",
            c.flow.nodes.length,
            " attempt",
            c.flow.nodes.length === 1 ? "" : "s",
            (() => {
              const d = (c.branches ?? []).filter((u) => u.status !== "archived").length;
              return d > 1 ? ` · ${d} branches` : "";
            })()
          ] })
        ] })
      ] }) }, c.slug);
    }) })
  ] });
}
const vn = { trend: "Trend", similar: "Similar model", season: "Season" }, bt = (t) => t ? (/* @__PURE__ */ new Date(`${t.slice(0, 10)}T12:00:00`)).toLocaleDateString([], { month: "short", day: "numeric" }) : "", Dn = (t) => t === 0 ? "today" : t > 0 ? `in ${t} day${t === 1 ? "" : "s"}` : `${-t} day${t === -1 ? "" : "s"} ago`;
function As({ events: t, trends: a, onSeason: l }) {
  const s = t.filter((o) => o.days_left >= 0).slice(0, 6);
  return s.length ? /* @__PURE__ */ e("section", { className: "a3d-cal", "aria-label": "Upcoming events", children: s.map((o) => {
    const g = a.find((m) => m.kind === "season" && m.event?.date === o.date && (m.event?.name ?? "").toLowerCase().startsWith(o.name.toLowerCase().slice(0, 8))), w = o.days_to_publish < 0;
    return /* @__PURE__ */ i(
      "button",
      {
        type: "button",
        className: w ? "a3d-cal-item a3d-cal-late" : o.days_to_publish <= 14 ? "a3d-cal-item a3d-cal-soon" : "a3d-cal-item",
        onClick: () => l(o.name),
        title: w ? "The usual publish-by date has passed: only quick, simple models still make it." : "Analyse what to make for this event",
        children: [
          /* @__PURE__ */ e("strong", { children: o.name }),
          /* @__PURE__ */ i("span", { children: [
            bt(o.date),
            " · ",
            Dn(o.days_left)
          ] }),
          /* @__PURE__ */ e("span", { className: "a3d-cal-pub", children: w ? `publish-by passed ${-o.days_to_publish} d ago` : `publish by ${bt(o.publish_by)} (${Dn(o.days_to_publish)})` }),
          g && /* @__PURE__ */ e("span", { className: "a3d-pill a3d-pill-done", children: "analysed" })
        ]
      },
      o.id
    );
  }) }) : null;
}
function Rs({ host: t, scan: a, busy: l, apify: s, selected: o, onSelectTrend: g, onAgent: w, onSet: m, onPrepare: x, onCreateModel: C, onSelectModel: v, onSelectIdea: f, onReveal: S, onOpen: E }) {
  const [B, M] = A("all"), [I, L] = A(!1), [c, O] = A(!1), T = je(() => a.trends.filter((u) => (B === "all" || u.kind === B) && (I || u.status !== "dropped")).sort((u, p) => (p.updated_at ?? "").localeCompare(u.updated_at ?? "")), [a.trends, B, I]), _ = a.trends.find((u) => u.slug === o) ?? T[0] ?? null, y = (u) => a.models.filter((p) => p.meta.origin?.trend === u), F = a.config.score_weights, b = !!_?._files.includes("dashboard.html"), j = _ ? [..._.ideas].sort((u, p) => (wt(p, F) ?? -1) - (wt(u, F) ?? -1)) : [], d = (u) => u.meta.status ?? "concept";
  return /* @__PURE__ */ i("section", { className: "a3d-trends", children: [
    /* @__PURE__ */ i("header", { className: "a3d-head", children: [
      /* @__PURE__ */ i("div", { children: [
        /* @__PURE__ */ e("h1", { children: "Trends" }),
        /* @__PURE__ */ i("p", { className: "a3d-muted", children: [
          "What sells now, what to make like an existing model, what to make for a date. Scout researches; ideas go to Insights or straight to a model.",
          " ",
          /* @__PURE__ */ e("span", { className: s ? "a3d-pill a3d-pill-done" : "a3d-pill", title: s ? `registered in ${s}` : "Not found in the Claude Code config: Scout falls back to web search.", children: s ? "Apify connected" : "Apify not registered" })
        ] })
      ] }),
      /* @__PURE__ */ i("span", { className: "a3d-row", children: [
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-primary", disabled: l, onClick: () => w("trend", null), children: "Analyse trend…" }),
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-primary", disabled: l, onClick: () => w("similar", null), children: "Similar model…" }),
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", disabled: l, onClick: () => w("season", null), children: "Season…" }),
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", disabled: l || !a.trends.some((u) => u.status === "watching"), onClick: () => w("watch", null), children: "Re-check watched" })
      ] })
    ] }),
    /* @__PURE__ */ e(As, { events: a.calendar, trends: a.trends, onSeason: (u) => w("season", null, u) }),
    /* @__PURE__ */ i("div", { className: "a3d-split", children: [
      /* @__PURE__ */ i("aside", { className: "a3d-split-list", children: [
        /* @__PURE__ */ e("span", { className: "a3d-seg a3d-seg-small", role: "group", "aria-label": "Kind", children: ["all", "trend", "similar", "season"].map((u) => /* @__PURE__ */ e("button", { type: "button", "aria-pressed": B === u, onClick: () => M(u), children: u === "all" ? "All" : vn[u] }, u)) }),
        /* @__PURE__ */ i("label", { className: "a3d-check", children: [
          /* @__PURE__ */ e("input", { type: "checkbox", checked: I, onChange: (u) => L(u.target.checked) }),
          " show dropped"
        ] }),
        T.length === 0 && /* @__PURE__ */ e("p", { className: "a3d-muted", children: "No trends yet. Analyse one, or click an event above." }),
        /* @__PURE__ */ e("ul", { children: T.map((u) => /* @__PURE__ */ e("li", { children: /* @__PURE__ */ i("button", { type: "button", className: u.slug === _?.slug ? "a3d-li a3d-li-sel" : "a3d-li", onClick: () => {
          g(u.slug), O(!1);
        }, children: [
          /* @__PURE__ */ e("span", { className: "a3d-li-title", children: u.title }),
          /* @__PURE__ */ i("span", { className: "a3d-muted", children: [
            vn[u.kind],
            " · ",
            u.status,
            " · ",
            u.ideas.length,
            " idea",
            u.ideas.length === 1 ? "" : "s",
            y(u.slug).length ? ` · ${y(u.slug).length} model${y(u.slug).length === 1 ? "" : "s"}` : ""
          ] })
        ] }) }, u.slug)) })
      ] }),
      _ ? /* @__PURE__ */ i("article", { className: "a3d-split-detail", children: [
        /* @__PURE__ */ i("header", { className: "a3d-detail-top", children: [
          /* @__PURE__ */ i("div", { children: [
            /* @__PURE__ */ i("h2", { className: "a3d-h2", children: [
              _.title,
              " ",
              /* @__PURE__ */ e("span", { className: "a3d-pill", children: vn[_.kind] }),
              _.saturation && /* @__PURE__ */ i("span", { className: `a3d-pill a3d-sat-${_.saturation}`, children: [
                "saturation: ",
                _.saturation
              ] })
            ] }),
            /* @__PURE__ */ i("p", { className: "a3d-muted", children: [
              _.query && _.query !== _.title ? `“${_.query}” · ` : "",
              "updated ",
              bt(_.updated_at)
            ] })
          ] }),
          /* @__PURE__ */ i("span", { className: "a3d-row", children: [
            /* @__PURE__ */ i("label", { className: "a3d-inline", children: [
              "Status",
              /* @__PURE__ */ e("select", { value: _.status, onChange: (u) => m(_, [`status=${u.target.value}`]), children: ["new", "watching", "used", "dropped"].map((u) => /* @__PURE__ */ e("option", { value: u, children: u }, u)) })
            ] }),
            _.status === "watching" && /* @__PURE__ */ i("label", { className: "a3d-inline", children: [
              "Re-check",
              /* @__PURE__ */ e("input", { type: "date", value: _.recheck_at ?? "", onChange: (u) => m(_, [`recheck_at=${u.target.value}`]) })
            ] })
          ] })
        ] }),
        _.summary ? /* @__PURE__ */ e("p", { className: "a3d-summary", children: _.summary }) : /* @__PURE__ */ e("p", { className: "a3d-muted", children: "No summary yet: Scout writes it when the analysis runs." }),
        _.kind === "season" && _.event?.date && /* @__PURE__ */ i("p", { className: "a3d-banner", children: [
          _.event.name,
          ": ",
          bt(_.event.date),
          ". Publish by ",
          bt(_.event.publish_by),
          _.event.publish_by ? ` (${Dn(Math.round((new Date(_.event.publish_by).getTime() - Date.now()) / 864e5))})` : "",
          "."
        ] }),
        _.kind === "similar" && /* @__PURE__ */ i("section", { className: "a3d-block", children: [
          /* @__PURE__ */ e("h4", { children: "Original model" }),
          /* @__PURE__ */ e("p", { children: _.source?.url ? /* @__PURE__ */ e("a", { href: _.source.url, target: "_blank", rel: "noreferrer", children: _.source.title || _.source.url }) : _.source?.title || _.source?.input || "—" }),
          /* @__PURE__ */ e("p", { className: "a3d-muted", children: [_.source?.license && `licence: ${_.source.license}`, _.source?.price != null && `price: ${_.source.price}`, _.source?.downloads != null && `downloads: ${_.source.downloads}`].filter(Boolean).join(" · ") || "Licence, price and downloads not read yet." }),
          _.ip && /* @__PURE__ */ i("div", { className: "a3d-ip", children: [
            /* @__PURE__ */ i("div", { children: [
              /* @__PURE__ */ e("h5", { children: "Can take" }),
              /* @__PURE__ */ e("ul", { children: (_.ip.can_take ?? []).map((u) => /* @__PURE__ */ e("li", { children: u }, u)) })
            ] }),
            /* @__PURE__ */ i("div", { children: [
              /* @__PURE__ */ e("h5", { children: "Must avoid" }),
              /* @__PURE__ */ e("ul", { children: (_.ip.must_avoid ?? []).map((u) => /* @__PURE__ */ e("li", { children: u }, u)) })
            ] }),
            /* @__PURE__ */ i("div", { children: [
              /* @__PURE__ */ e("h5", { children: "Risk" }),
              /* @__PURE__ */ e("span", { className: `a3d-pill a3d-risk-${_.ip.risk ?? "unknown"}`, children: _.ip.risk ?? "not assessed" })
            ] })
          ] })
        ] }),
        /* @__PURE__ */ i("section", { className: "a3d-block", children: [
          /* @__PURE__ */ i("h4", { children: [
            "Ideas ",
            /* @__PURE__ */ e("span", { className: "a3d-count", children: _.ideas.length }),
            /* @__PURE__ */ i("span", { className: "a3d-block-actions", children: [
              /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", disabled: l || !_.ideas.length, onClick: () => w("score", _), children: "Score ideas (Prism)" }),
              b && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", "aria-pressed": c, onClick: () => O((u) => !u), children: "Dashboard" })
            ] })
          ] }),
          c && b && /* @__PURE__ */ e(Fi, { host: t, path: `${_._dir}/dashboard.html`, mtime: _._mtime, title: `${_.title} ideas` }),
          j.length === 0 ? /* @__PURE__ */ e("p", { className: "a3d-muted", children: "No ideas yet." }) : /* @__PURE__ */ i("table", { className: "a3d-filetable a3d-ideas", children: [
            /* @__PURE__ */ e("thead", { children: /* @__PURE__ */ i("tr", { children: [
              /* @__PURE__ */ e("th", { children: "Idea" }),
              /* @__PURE__ */ e("th", { children: "Type" }),
              /* @__PURE__ */ e("th", { children: "Score" }),
              /* @__PURE__ */ e("th", { children: "Status" }),
              /* @__PURE__ */ e("th", { children: /* @__PURE__ */ e("span", { className: "a3d-sr", children: "Actions" }) })
            ] }) }),
            /* @__PURE__ */ e("tbody", { children: j.map((u) => {
              const p = u.model ? a.models.find((U) => U.slug === u.model) : null;
              return /* @__PURE__ */ i("tr", { children: [
                /* @__PURE__ */ i("td", { children: [
                  /* @__PURE__ */ e("strong", { children: u.name }),
                  u.pitch && /* @__PURE__ */ e("div", { className: "a3d-muted", children: u.pitch })
                ] }),
                /* @__PURE__ */ e("td", { children: u.model_type ?? "" }),
                /* @__PURE__ */ e("td", { children: /* @__PURE__ */ e(jn, { value: wt(u, F) }) }),
                /* @__PURE__ */ e("td", { children: u.status ?? "candidate" }),
                /* @__PURE__ */ e("td", { children: /* @__PURE__ */ i("span", { className: "a3d-row a3d-row-end", children: [
                  u.insight ? /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => f(u.insight), children: "Open in Insights" }) : /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => x(_, u), title: "Create it in Insights to prepare before modelling", children: "Prepare" }),
                  p ? /* @__PURE__ */ i("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => v(p.slug), children: [
                    "Model: ",
                    p.meta.title || p.slug
                  ] }) : /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", disabled: l, onClick: () => C(_, u), children: "Create model" })
                ] }) })
              ] }, u.id);
            }) })
          ] })
        ] }),
        _.signals.length > 0 && /* @__PURE__ */ i("section", { className: "a3d-block", children: [
          /* @__PURE__ */ i("h4", { children: [
            "Signals ",
            /* @__PURE__ */ e("span", { className: "a3d-count", children: _.signals.length })
          ] }),
          /* @__PURE__ */ i("table", { className: "a3d-filetable", children: [
            /* @__PURE__ */ e("thead", { children: /* @__PURE__ */ i("tr", { children: [
              /* @__PURE__ */ e("th", { children: "What" }),
              /* @__PURE__ */ e("th", { children: "Value" }),
              /* @__PURE__ */ e("th", { children: "Date" }),
              /* @__PURE__ */ e("th", { children: "Source" })
            ] }) }),
            /* @__PURE__ */ e("tbody", { children: _.signals.map((u, p) => /* @__PURE__ */ i("tr", { children: [
              /* @__PURE__ */ i("td", { children: [
                u.metric,
                u.note && /* @__PURE__ */ e("div", { className: "a3d-muted", children: u.note })
              ] }),
              /* @__PURE__ */ e("td", { className: "a3d-num", children: String(u.value ?? "") }),
              /* @__PURE__ */ e("td", { className: "a3d-num", children: bt(u.at) }),
              /* @__PURE__ */ e("td", { children: u.url ? /* @__PURE__ */ e("a", { href: u.url, target: "_blank", rel: "noreferrer", children: u.source || "link" }) : u.source })
            ] }, p)) })
          ] })
        ] }),
        /* @__PURE__ */ i("section", { className: "a3d-block", children: [
          /* @__PURE__ */ i("h4", { children: [
            "Models from this trend ",
            /* @__PURE__ */ e("span", { className: "a3d-count", children: y(_.slug).length })
          ] }),
          y(_.slug).length === 0 ? /* @__PURE__ */ e("p", { className: "a3d-muted", children: "None yet. “Create model” on an idea starts one and links it here." }) : /* @__PURE__ */ e("p", { className: "a3d-row", children: y(_.slug).map((u) => /* @__PURE__ */ i("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => v(u.slug), children: [
            u.meta.title || u.slug,
            " · ",
            d(u)
          ] }, u.slug)) })
        ] }),
        /* @__PURE__ */ i("p", { className: "a3d-row", children: [
          /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", disabled: l, onClick: () => w("refresh", _), children: "Refresh signals (Scout)" }),
          _._files.includes("trend.md") && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => E(`${_._dir}/trend.md`), children: "Open report" }),
          /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => E(`${_._dir}/trend.json`), children: "Open trend.json" }),
          /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => S(_._dir), children: "Show in Finder" })
        ] })
      ] }) : /* @__PURE__ */ e("div", { className: "a3d-placeholder", children: "Pick a trend, or start one above." })
    ] })
  ] });
}
function Ps({ commands: t, onClose: a }) {
  const [l, s] = A(""), [o, g] = A(0), w = qe(null), m = je(() => {
    const v = l.toLowerCase().split(/\s+/).filter(Boolean);
    return t.filter((f) => v.every((S) => `${f.title} ${f.hint ?? ""}`.toLowerCase().includes(S)));
  }, [l, t]);
  ke(() => {
    w.current?.focus();
  }, []), ke(() => {
    g(0);
  }, [l]);
  const x = (v) => {
    !v || v.disabled || (a(), v.run());
  };
  return /* @__PURE__ */ e("div", { className: "a3d-overlay a3d-overlay-top", onClick: a, children: /* @__PURE__ */ i("div", { className: "a3d-palette", role: "dialog", "aria-label": "Commands", onClick: (v) => v.stopPropagation(), onKeyDown: (v) => {
    v.key === "ArrowDown" ? (v.preventDefault(), g((f) => Math.min(m.length - 1, f + 1))) : v.key === "ArrowUp" ? (v.preventDefault(), g((f) => Math.max(0, f - 1))) : v.key === "Enter" ? (v.preventDefault(), x(m[o])) : v.key === "Escape" && (v.preventDefault(), a());
  }, children: [
    /* @__PURE__ */ e("input", { ref: w, value: l, placeholder: "Type a command…", "aria-label": "Filter commands", onChange: (v) => s(v.target.value) }),
    /* @__PURE__ */ i("ul", { role: "listbox", children: [
      m.length === 0 && /* @__PURE__ */ e("li", { className: "a3d-muted a3d-palette-empty", children: "No command matches." }),
      m.map((v, f) => /* @__PURE__ */ e("li", { role: "option", "aria-selected": f === o, "aria-disabled": !!v.disabled, children: /* @__PURE__ */ i("button", { type: "button", className: f === o ? "a3d-cmd a3d-cmd-on" : "a3d-cmd", disabled: !!v.disabled, onMouseEnter: () => g(f), onClick: () => x(v), children: [
        /* @__PURE__ */ e("span", { children: v.title }),
        /* @__PURE__ */ e("span", { className: "a3d-muted", children: v.disabled || v.hint || "" })
      ] }) }, v.id))
    ] })
  ] }) });
}
function Oi({ workspace: t, io: a, onSaved: l }) {
  const s = `${t}/_bmad/ai3d/config.yaml`, [o, g] = A(null), [w, m] = A(!1), [x, C] = A({}), [v, f] = A({}), [S, E] = A(null), [B, M] = A(!1), I = H(async () => {
    try {
      const y = await a.read(s), F = { ...ys, ...y ? $s(y) : {} };
      g(y), C(F), f(F);
    } catch (y) {
      E({ tone: "error", msg: y instanceof Error ? y.message : String(y) });
    } finally {
      m(!0);
    }
  }, [a, s]);
  ke(() => {
    I();
  }, [I]);
  const L = je(() => Object.keys(x).filter((y) => x[y] !== v[y]), [x, v]), c = (y, F) => {
    E(null), C((b) => ({ ...b, [y]: F }));
  }, O = je(() => {
    const y = [];
    wi(x.bed_mm ?? "").some((j) => !(j > 0 && j <= 2e3)) && y.push("Bed size must be between 1 and 2000 mm on each axis.");
    const b = Number(x.overhang_deg);
    return b >= 20 && b <= 75 || y.push("Overhang angle must be between 20 and 75 degrees."), y;
  }, [x]), T = async () => {
    if (!(o === null || O.length)) {
      M(!0);
      try {
        const y = Object.fromEntries(L.map((F) => [F, x[F]]));
        await a.write(s, Cs(o, y)), E({ tone: "ok", msg: `Saved ${L.length} setting${L.length === 1 ? "" : "s"}. Agents and scripts use them from their next run.` }), await I(), l?.();
      } catch (y) {
        E({ tone: "error", msg: `Could not save: ${y instanceof Error ? y.message : String(y)}` });
      } finally {
        M(!1);
      }
    }
  }, _ = (y) => {
    const F = x[y.key] ?? y.def, b = `a3d-set-${y.key}`;
    switch (y.kind) {
      case "select": {
        const j = y.options.some((d) => d.value === F) ? y.options : [...y.options, { value: F, label: `${F} (current)` }];
        return /* @__PURE__ */ e("select", { id: b, value: F, onChange: (d) => c(y.key, d.target.value), children: j.map((d) => /* @__PURE__ */ e("option", { value: d.value, children: d.label }, d.value)) });
      }
      case "toggle":
        return /* @__PURE__ */ i("label", { className: "a3d-switch", children: [
          /* @__PURE__ */ e("input", { id: b, type: "checkbox", checked: F === "true", onChange: (j) => c(y.key, j.target.checked ? "true" : "false") }),
          /* @__PURE__ */ e("span", { children: F === "true" ? "On" : "Off" })
        ] });
      case "text":
        return /* @__PURE__ */ e("input", { id: b, value: F, onChange: (j) => c(y.key, j.target.value) });
      case "bed": {
        const j = wi(F);
        return /* @__PURE__ */ i("div", { className: "a3d-bed", children: [
          /* @__PURE__ */ e("span", { className: "a3d-row", children: ["X", "Y", "Z"].map((d, u) => /* @__PURE__ */ i("label", { className: "a3d-num", children: [
            d,
            /* @__PURE__ */ e("input", { type: "number", min: 1, max: 2e3, value: j[u], onChange: (p) => {
              const U = [...j];
              U[u] = Number(p.target.value), c(y.key, ks(U));
            } })
          ] }, d)) }),
          /* @__PURE__ */ e("span", { className: "a3d-row", children: ws.map((d) => /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", "aria-pressed": F === d.value, onClick: () => c(y.key, d.value), children: d.label }, d.value)) })
        ] });
      }
      case "angle":
        return /* @__PURE__ */ i("label", { className: "a3d-slider a3d-slider-angle", children: [
          /* @__PURE__ */ e("input", { id: b, type: "range", min: 20, max: 75, step: 1, value: Number(F) || 45, onChange: (j) => c(y.key, j.target.value) }),
          /* @__PURE__ */ i("output", { children: [
            F,
            "°"
          ] })
        ] });
      case "hidden":
        return null;
      case "runs": {
        const j = qt(x.step_models, Ri), d = qt(x.step_effort, Pi);
        return /* @__PURE__ */ i("table", { className: "a3d-runs", children: [
          /* @__PURE__ */ e("thead", { children: /* @__PURE__ */ i("tr", { children: [
            /* @__PURE__ */ e("th", { children: "Step / agent" }),
            /* @__PURE__ */ e("th", { children: "Model" }),
            /* @__PURE__ */ e("th", { children: "Reasoning" })
          ] }) }),
          /* @__PURE__ */ e("tbody", { children: Ai.map((u) => /* @__PURE__ */ i("tr", { children: [
            /* @__PURE__ */ e("td", { children: u.label }),
            /* @__PURE__ */ e("td", { children: /* @__PURE__ */ e("select", { "aria-label": `Model for ${u.label}`, value: j[u.id] === "default" ? "" : j[u.id] ?? "", onChange: (p) => c("step_models", ri({ ...j, [u.id]: p.target.value || "default" })), children: Di.map((p) => /* @__PURE__ */ e("option", { value: p.value.replace(/^claude-code:/, ""), children: p.label }, p.value)) }) }),
            /* @__PURE__ */ e("td", { children: /* @__PURE__ */ e("select", { "aria-label": `Reasoning for ${u.label}`, value: d[u.id] ?? "medium", onChange: (p) => c("step_effort", ri({ ...d, [u.id]: p.target.value })), children: en.map((p) => /* @__PURE__ */ e("option", { value: p.value, children: p.label }, p.value)) }) })
          ] }, u.id)) })
        ] });
      }
      case "weights": {
        const j = Ei(F);
        return /* @__PURE__ */ e("div", { className: "a3d-weights", children: vt.map((d) => /* @__PURE__ */ i("label", { className: "a3d-slider", children: [
          /* @__PURE__ */ e("span", { children: d.label }),
          /* @__PURE__ */ e("input", { type: "range", min: 0, max: 5, step: 1, value: j[d.id], onChange: (u) => c(y.key, Ns({ ...j, [d.id]: Number(u.target.value) })) }),
          /* @__PURE__ */ e("output", { children: j[d.id] })
        ] }, d.id)) });
      }
    }
  };
  return w ? /* @__PURE__ */ i("form", { className: "a3d-settings", onSubmit: (y) => {
    y.preventDefault(), T();
  }, children: [
    o === null && /* @__PURE__ */ i("p", { className: "a3d-banner", children: [
      "No ",
      /* @__PURE__ */ e("code", { children: "_bmad/ai3d/config.yaml" }),
      " in this workspace. Install the AI3D Forge module first; the form shows defaults until then."
    ] }),
    Li.map((y) => /* @__PURE__ */ i("section", { className: "a3d-set-group", children: [
      /* @__PURE__ */ e("h3", { children: y.title }),
      y.fields.filter((F) => F.kind !== "hidden").map((F) => /* @__PURE__ */ i("div", { className: "a3d-field", children: [
        /* @__PURE__ */ e("label", { htmlFor: `a3d-set-${F.key}`, children: F.label }),
        /* @__PURE__ */ e("div", { className: "a3d-field-control", children: _(F) }),
        /* @__PURE__ */ e("p", { className: "a3d-muted", children: F.help })
      ] }, F.key))
    ] }, y.title)),
    O.map((y) => /* @__PURE__ */ e("p", { className: "a3d-banner a3d-banner-error", children: y }, y)),
    S && /* @__PURE__ */ e("p", { className: S.tone === "error" ? "a3d-banner a3d-banner-error" : "a3d-banner", role: "status", children: S.msg }),
    /* @__PURE__ */ i("span", { className: "a3d-row", children: [
      /* @__PURE__ */ e("button", { type: "submit", className: "a3d-btn a3d-btn-primary", disabled: !L.length || O.length > 0 || o === null || B, children: B ? "Saving…" : L.length ? `Save ${L.length} change${L.length === 1 ? "" : "s"}` : "Saved" }),
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", disabled: !L.length, onClick: () => {
        C(v), E(null);
      }, children: "Discard" }),
      /* @__PURE__ */ i("span", { className: "a3d-muted", children: [
        "Writes ",
        s.replace(t + "/", "")
      ] })
    ] })
  ] }) : /* @__PURE__ */ e("p", { className: "a3d-muted", children: "Reading settings…" });
}
const Ii = "runs", Bs = 15;
let Le = {}, An = null, Yt = null, Ye = [];
const Ts = 2700 * 1e3, Zt = /* @__PURE__ */ new Set(), Rn = /* @__PURE__ */ new Set();
function Ms(t) {
  return Rn.add(t), () => {
    Rn.delete(t);
  };
}
function Xt() {
  Le = { ...Le }, Zt.forEach((t) => t()), An?.set(Ii, Le);
}
function Wi(t) {
  Yt = t;
}
function Ls() {
  return !!Yt;
}
function Es(t) {
  if (An) return;
  An = t;
  const a = t.get(Ii) ?? {};
  for (const l of Object.values(a))
    for (const s of l) s.status === "running" && (s.status = "done");
  Le = { ...a, ...Le }, Zt.forEach((l) => l());
}
function Fs(t) {
  return Zt.add(t), () => {
    Zt.delete(t);
  };
}
function Os() {
  return Le;
}
const Fn = () => Ye.filter((t) => Date.now() - t.at < Ts);
function Is() {
  const t = [];
  for (const a of Fn()) {
    const l = Object.keys(Le).find((s) => Le[s].includes(a));
    l && t.push({ key: l, run: a });
  }
  return t.reverse();
}
function zi(t, a) {
  return t === void 0 ? !1 : Fn().some((l) => l.label === a && (Le[t] ?? []).includes(l));
}
function Ws(t) {
  const a = Ye.find((l) => l.at === t);
  a && (Ye = Ye.filter((l) => l !== a), a.status = "done", Xt());
}
function zs(t) {
  const a = Ye.find((l) => !l.sessionId);
  a && (a.sessionId = t, Xt());
}
function Ks(t, a, l, s, o, g, w) {
  if (!Yt || zi(t, l)) return null;
  const m = { sessionId: null, step: a, label: l, at: Date.now(), status: "running", model: w || void 0 };
  return Le[t] = [m, ...Le[t] ?? []].slice(0, Bs), Ye = [...Fn(), m], Xt(), Yt.sendPrompt(w ? { prompt: s, sessionName: o, model: w } : { prompt: s, sessionName: o }).then(
    (x) => {
      m.sessionId = x.sessionId, m.status = "done";
    },
    (x) => {
      m.status = "error", m.error = x instanceof Error ? x.message : String(x);
    }
  ).finally(() => {
    Ye = Ye.filter((x) => x !== m), Xt();
    try {
      g?.(m.status === "error" ? "error" : "done", m.error);
    } catch {
    }
    Rn.forEach((x) => {
      try {
        x(t, m);
      } catch {
      }
    });
  }), m;
}
const Ke = (t) => `'${t.replace(/'/g, "'\\''")}'`, ae = (t, a, l) => ({ kind: "agent", label: t, skill: a, trigger: l }), Ki = {
  concept: [ae("Write concept", "ai3d-muse", "*concept"), ae("Re-check model type", "ai3d-muse", "*type")],
  image: [
    ae("Write image prompt", "ai3d-lumen", "*prompt"),
    ae("Review inbox", "ai3d-lumen", "*review"),
    ae("Accept image", "ai3d-lumen", "*accept"),
    ae("Prepare views for 3D (front, left, back, right)", "ai3d-lumen", "*views"),
    ae("Review the views", "ai3d-lumen", "*review-views")
  ],
  mesh: [ae("Write 3D spec", "ai3d-chisel", "*3d-prompt"), ae("Review mesh", "ai3d-chisel", "*review-mesh"), ae("Accept mesh", "ai3d-chisel", "*accept-mesh")],
  blender: [
    ae("Optimize in Blender", "ai3d-kiln", "*optimize"),
    ae("Inspect only", "ai3d-kiln", "*inspect"),
    ae("Build flexi joints", "ai3d-kiln", "*flexi"),
    ae("Render previews", "ai3d-kiln", "*render"),
    ae("Export clearance coupon", "ai3d-kiln", "*coupon"),
    ae("Blender command (free text)", "ai3d-kiln", "*run")
  ],
  validate: [ae("Validate and write slicing notes", "ai3d-anvil", "*validate"), ae("Slicing notes", "ai3d-anvil", "*slice")],
  print: [ae("Log with Anvil (reads the photos)", "ai3d-anvil", "*print-log")],
  publish: [ae("Write README", "ai3d-herald", "*readme"), ae("Mark ready", "ai3d-herald", "*ready"), ae("Write listing", "ai3d-herald", "*listing"), ae("Mark published", "ai3d-herald", "*publish")]
}, z = {
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
}, he = (t) => t.startsWith("<") ? t : Ke(t), re = {
  readme: (t, a, l) => `python3 ${he(t)} ${he(a)} && python3 ${he(t)} ${he(l)} --catalog`,
  view: (t, a) => `python3 ${he(t)} ${he(a)}`,
  portfolio: (t, a) => `python3 ${he(t)} portfolio ${he(a)}`,
  printSkip: (t, a) => `python3 ${he(t)} skip ${he(a)} --reason ${Ke("skipped from the panel")}`,
  branchAdd: (t, a, l) => [
    `python3 ${he(t)} branch add ${he(a)} --name ${Ke(l.name)}`,
    l.fromNode ? `--from-node ${Ke(l.fromNode)}` : "",
    l.fromStep ? `--from-step ${l.fromStep}` : "",
    l.source ? `--source ${Ke(l.source)}` : "",
    l.review ? "--review" : "",
    l.description ? `--description ${Ke(l.description)}` : ""
  ].filter(Boolean).join(" "),
  branchPromote: (t, a, l) => `python3 ${he(t)} branch promote ${he(a)} ${Ke(l)}`,
  branchSet: (t, a, l, s) => `python3 ${he(t)} branch set ${he(a)} ${Ke(l)} --status ${s}`,
  migrate: (t, a) => `python3 ${he(t)} migrate-branches ${he(a)}`,
  helpStatus: (t, a, l) => `python3 ${he(t)} ${he(a)}${l ? ` --model ${Ke(l)}` : ""}`
};
function Pn(t, a, l) {
  const s = a?.tools, o = l?.dir ?? z.dir;
  switch (t.kind) {
    case "agent":
      return `Starts a new agent session: skill ${t.skill}, command ${t.trigger}${l ? ` on ${l.slug}${l.branches.length > 1 ? ` / ${l.branch}` : ""}` : ""}. ⋯ shows the full prompt.`;
    case "script":
      return t.script === "readme" ? `Runs: ${re.readme(s?.buildReadme ?? z.readme, o, a?.root ?? z.root)}` : t.script === "view" ? `Runs: ${re.view(s?.buildViewer ?? z.viewer, o)}, then opens view/index.html` : t.script === "views-all" ? "Runs build-viewer.py for every model with an STL" : `Runs: ${re.portfolio(s?.buildInsights ?? z.insights, a?.root ?? z.root)}`;
    case "form":
      return t.form === "print-skip" ? `Runs: ${re.printSkip(s?.printLog ?? z.print, o)}` : "Opens the test print form; Save runs print_log.py add and flow_log.py add";
    default:
      return t.copy ? "Copies the text to the clipboard; you do this step yourself" : "You do this step yourself";
  }
}
const yn = (t) => `agent session → ${t.skill} ${t.trigger} (prompt + model, branch work folder, flow node, your instruction)`, Gs = { concept: "Concept", image: "Image", mesh: "3D mesh", blender: "Blender", validate: "Validate", print: "Test print", publish: "Publish" }, ki = [
  ...Object.entries(Ki).flatMap(([t, a]) => a.map((l) => ({ area: `Flow · ${Gs[t]}`, button: l.label, kind: "agent", runs: yn(l) }))),
  { area: "Flow · every step", button: "Run command…", kind: "agent", runs: "any command of the step with your instruction added to the prompt; an attempt command first runs flow_log.py add (below)" },
  {
    area: "Flow · every attempt",
    button: "New attempt… / Run again with changes… / Continue from here…",
    kind: "shell",
    runs: `python3 ${z.flow} add ${z.dir} --step <step> --label <label> --status running --parent <node> --settings-json '{…}' → agent session → python3 ${z.flow} settle ${z.dir} <node> --status open|error`
  },
  { area: "Flow · node", button: "Accepted / Rejected / Clear", kind: "shell", runs: `python3 ${z.flow} update ${z.dir} <node> --verdict accepted|rejected|none` },
  { area: "Flow · node", button: "Add note", kind: "shell", runs: `python3 ${z.flow} note ${z.dir} <node> '<text>'` },
  { area: "Flow · node", button: "Cost Save", kind: "shell", runs: `python3 ${z.flow} update ${z.dir} <node> --cost <service>:<credits>` },
  { area: "Flow · node", button: "Archive / Unarchive attempt", kind: "shell", runs: `python3 ${z.flow} update ${z.dir} <node> --archived yes|no` },
  {
    area: "Flow · branches",
    button: "New branch… / New branch from here…",
    kind: "shell",
    runs: re.branchAdd(z.flow, z.model, { name: "<name>", fromNode: "<node>", fromStep: "<step>", source: "image:<file>|mesh:<file>|link:<url>|text:<brief>" }) + " [--review]"
  },
  { area: "Flow · branches", button: "Make primary", kind: "shell", runs: re.branchPromote(z.flow, z.model, "<branch>") },
  { area: "Flow · branches", button: "Mark as variant / Archive / Reopen", kind: "shell", runs: re.branchSet(z.flow, z.model, "<branch>", "variant|archived|open") },
  { area: "Flow · branches", button: "Move files to branches/", kind: "shell", runs: re.migrate(z.flow, z.model) },
  { area: "Flow · Blender", button: "Analyze", kind: "headless Blender", runs: `${z.blender} -b --factory-startup -P ${z.kiln} -- analyze ${z.dir}` },
  { area: "Flow · Blender", button: "Quick prep…", kind: "headless Blender", runs: `flow_log.py add (blender, running) → ${z.blender} -b --factory-startup -P ${z.kiln} -- prep ${z.dir} side=<side> cut_mm=<mm> … → flow_log.py update` },
  { area: "Flow · Blender", button: "Flexi…", kind: "headless Blender", runs: `flow_log.py add → ${z.blender} -b --factory-startup -P ${z.kiln} -- flexi ${z.dir} segments=<n> clearance_mm=<mm> → flow_log.py update` },
  { area: "Flow · Blender", button: "Render previews / Coupon", kind: "headless Blender", runs: `${z.blender} -b --factory-startup -P ${z.kiln} -- render|coupon ${z.dir}` },
  { area: "Flow · Blender", button: "Open in Blender", kind: "shell", runs: 'open -a Blender <file>.blend, or Blender --python-expr "import …" for a mesh' },
  { area: "Flow · Blender", button: "Blender command…", kind: "agent", runs: yn(ae("", "ai3d-kiln", "*run")) + " — Kiln runs your instruction in the open Blender through the Blender MCP" },
  { area: "Flow · Test print", button: "Log a test print…", kind: "form", runs: `python3 ${z.print} add ${z.dir} --result ok|issues|fail --printer … --photos … → flow_log.py add --step print` },
  { area: "Flow · Test print", button: "Skip", kind: "shell", runs: re.printSkip(z.print, z.dir) },
  { area: "Flow · Publish", button: "Build README / Rebuild README (no agent)", kind: "script", runs: re.readme(z.readme, z.dir, z.root) },
  { area: "Flow · header", button: "3D view", kind: "script", runs: re.view(z.viewer, z.dir) + " → opens view/index.html" },
  { area: "Flow · header", button: "Open STL in slicer / Show in Finder", kind: "shell", runs: "open <file> · open -R <file>" },
  { area: "Flow · Image", button: "Add views… (after Prepare views)", kind: "shell", runs: `osascript (file dialog) → python3 - ${z.dir} view <files> (import.py: copies into inbox/views/)` },
  {
    area: "Flow · every step",
    button: "Model and reasoning (Run command…, New attempt…, Settings → Agent runs)",
    kind: "agent",
    runs: "sendPrompt({ model: claude-code:opus|sonnet|haiku }) + a thinking line in the prompt (think / think hard / ultrathink); recorded on the node as run_model, run_effort"
  },
  { area: "Files", button: "Add image… / Add 3D model… / drop", kind: "shell", runs: `osascript (file dialog) → python3 - ${z.dir} image|mesh <files> (import.py: copies into inbox/ or mesh/, keeps the old file in attempts/)` },
  { area: "Models", button: "Portfolio", kind: "script", runs: re.portfolio(z.insights, z.root) },
  { area: "Models", button: "New model…", kind: "agent", runs: yn(ae("", "ai3d-muse", "*concept")) },
  { area: "Trends", button: "Analyse a trend / Similar model / Season / Re-check", kind: "agent", runs: "agent session: ai3d-scout *trend | *similar | *season | *watch" },
  { area: "Trends", button: "Status, ideas, links", kind: "shell", runs: `python3 ${z.trend} set|new|link …` },
  { area: "Insights", button: "Prepare / Score / New model", kind: "agent", runs: "agent session: ai3d-muse *prepare · ai3d-prism *score · ai3d-muse *concept" },
  { area: "Insights", button: "Find on the web (Muse)", kind: "agent", runs: "agent session → ai3d-muse *refs: web search for pages and pictures; each saved with trend_lib.py ref (pictures downloaded into refs/)" },
  { area: "Insights", button: "Add link / Add picture…", kind: "shell", runs: `python3 ${z.trend} ref <idea folder> --url <URL> | --file <picture> [--note …]` },
  {
    area: "Models · Files",
    button: "New model… / Concept from this… (picture)",
    kind: "agent",
    runs: `agent session → ai3d-muse *concept with the pictures and link in the prompt; as a branch: python3 ${z.flow} branch add ${z.model} --name <name> --from-step concept --source text:<brief> --ref <picture> first`
  },
  { area: "Tab bar", button: "N running → show session / forget", kind: "shell", runs: "no command: lists agent runs still in their first turn; forget only stops the panel waiting" },
  { area: "Insights", button: "Go / Later / No", kind: "shell", runs: `python3 ${z.trend} decide <insight dir> go|later|no` },
  { area: "Help", button: "Status (no agent)", kind: "shell", runs: re.helpStatus(z.status, z.root, "<slug>") },
  { area: "Help", button: "Ask ai3d-help: status / next / how / tips", kind: "agent", runs: "agent session: ai3d-help *status | *next | *how <step> | *tips <step>" },
  { area: "Tab bar", button: "Blender chip → Check", kind: "shell", runs: "python3 - <workspace> (blender_status.py: finds Blender, its version, MCP servers in .mcp.json and ~/.claude.json)" },
  { area: "Every few seconds", button: "(refresh)", kind: "shell", runs: "python3 - <workspace> (scan.py: reads models/, trends/, insights/ and flow_log.py list for every model)" }
];
function Vs(t) {
  const a = {};
  if (!t) return a;
  let l = null;
  for (const s of t.split(`
`)) {
    const o = /^## (\S+)\s*$/.exec(s);
    if (o) {
      l = o[1].toLowerCase(), a[l] = "";
      continue;
    }
    l && (a[l] += `${s}
`);
  }
  return a;
}
function Ni(t, a) {
  return t.split(/(`[^`]+`)/g).filter(Boolean).map((l, s) => l.startsWith("`") && l.endsWith("`") && l.length > 1 ? /* @__PURE__ */ e("code", { children: l.slice(1, -1) }, `${a}c${s}`) : l);
}
function kn(t) {
  return t.split(/(\*\*.+?\*\*)/g).filter(Boolean).flatMap((a, l) => a.startsWith("**") && a.endsWith("**") && a.length > 4 ? [/* @__PURE__ */ e("strong", { children: Ni(a.slice(2, -2), `b${l}`) }, `b${l}`)] : Ni(a, `t${l}`));
}
function Hs({ text: t }) {
  const a = [];
  let l = [], s = [];
  const o = () => {
    l.length && (a.push(/* @__PURE__ */ e("ul", { children: l.map((g, w) => /* @__PURE__ */ e("li", { children: kn(g) }, w)) }, a.length)), l = []), s.length && (a.push(/* @__PURE__ */ e("p", { children: kn(s.join(" ")) }, a.length)), s = []);
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
      o(), a.push(/* @__PURE__ */ e("h4", { children: kn(m[1]) }, a.length));
      continue;
    }
    const x = /^\s*-\s+(.*)$/.exec(w);
    if (x) {
      s.length && o(), l.push(x[1]);
      continue;
    }
    if (l.length && /^\s+/.test(g)) {
      l[l.length - 1] += ` ${w.trim()}`;
      continue;
    }
    l.length && o(), s.push(w.trim());
  }
  return o(), /* @__PURE__ */ e(ee, { children: a });
}
function On({ tips: t, step: a, onClose: l }) {
  const s = t[a];
  return /* @__PURE__ */ i("section", { className: "a3d-tips", "aria-label": `Tips for ${a}`, children: [
    l && /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", style: { float: "right" }, onClick: l, children: "Close" }),
    s ? /* @__PURE__ */ e(Hs, { text: s }) : /* @__PURE__ */ i("p", { className: "a3d-muted", children: [
      "No tips found. They come from ",
      /* @__PURE__ */ e("code", { children: "ai3d-help/references/step-tips.md" }),
      ": update the module if it is missing."
    ] })
  ] });
}
const tn = "2.2.0", Us = "0.11.0", $i = (t) => (t ?? "").split(/[^0-9]+/).filter(Boolean).slice(0, 3).map(Number);
function Gi(t, a) {
  const l = $i(t), s = $i(a);
  for (let o = 0; o < 3; o++)
    if ((l[o] ?? 0) !== (s[o] ?? 0)) return (l[o] ?? 0) < (s[o] ?? 0);
  return !1;
}
function Vi(t) {
  const a = t.module?.newer;
  return a && !Gi(a.version, tn) ? `cd '${t.workspace}' && bash '${a.path}/scripts/update.sh'` : null;
}
function In(t) {
  const a = t.features;
  return a ? [a.branches ? "" : "branches", a.help ? "" : "Help and status", a.views ? "" : "views for multi-view 3D", a.webRefs ? "" : "references from the web"].filter(Boolean) : [];
}
function Hi(t) {
  return !t.installed && !t.tools.flowLog ? !1 : In(t).length > 0 || !!t.module?.version && Gi(t.module.version, tn);
}
function Js(t, a) {
  const l = Vi(t), s = l ? `Run in a terminal: ${l}` : "Unpack the new module and run: bash <ai3d>/scripts/update.sh from the project root.", o = In(t), g = t.module?.version, w = a?.servers ?? [], m = (t.config.scrape_mcp || "apify").toLowerCase(), x = w.find((f) => f.forSessions && f.name.toLowerCase().includes(m)), C = (a?.mcp ?? []).find((f) => f.forSessions), v = ["models_folder", "trends_folder", "insights_folder", "step_models", "step_effort"].filter((f) => !t.config[f]);
  return [
    { name: "Python 3", state: t.python ? "ok" : "missing", detail: t.python ? `python3 ${t.python}` : "not found", fix: "Install Python 3 (brew install python)." },
    {
      name: "AI3D Forge skills",
      state: !t.installed && !t.tools.flowLog ? "missing" : Hi(t) ? "warn" : "ok",
      detail: !t.installed && !t.tools.flowLog ? "not installed in this project" : `installed ${g ?? "version unknown"} · panel ${Us} is built for ${tn}${o.length ? ` · missing: ${o.join(", ")}` : ""}`,
      fix: s
    },
    {
      name: "Module config",
      state: v.length ? "warn" : "ok",
      detail: v.length ? `missing keys: ${v.join(", ")} (defaults are used)` : t.configPath.replace(`${t.workspace}/`, ""),
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
      state: a?.bin ? "ok" : "warn",
      detail: a ? a.bin ? `${a.version ?? "found"} · ${a.bin}` : "not found" : "not checked yet",
      fix: "Install Blender 5.1+ or set blender_bin in Settings. Needed for the quick tools and for Kiln."
    },
    {
      name: "Blender MCP",
      state: C ? "ok" : "warn",
      detail: C ? `registered in ${C.where}` : "not registered for Claude Code sessions",
      fix: 'claude mcp add --scope project blender -- uv --directory "$HOME/blender_mcp/mcp" run blender-mcp (guide: Blender chip → Setup guide). Needed for Kiln *optimize, *flexi, *run.'
    },
    {
      name: "Scrape MCP (Apify)",
      state: x ? "ok" : "warn",
      detail: x ? `registered in ${x.where}` : `“${m}” not registered: Scout and Muse use plain web search`,
      fix: 'claude mcp add --scope project --transport http apify "https://mcp.apify.com?tools=actors,docs,apify/rag-web-browser", then /mcp → authenticate.'
    }
  ];
}
const qs = [
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
function Ys({ scan: t, model: a, blender: l, steps: s, stepsBySlug: o, tips: g, busy: w, statusText: m, statusBusy: x, onStatus: C, onAsk: v, onGo: f, onSelectModel: S }) {
  const [E, B] = A(() => s.find((T) => T.state === "active" || T.state === "waiting")?.id ?? "concept"), [M, I] = A(""), L = s.find((T) => T.state === "active" || T.state === "waiting") ?? null, c = t.models.filter((T) => (o[T.slug] ?? []).some((_) => _.state === "waiting")), O = je(() => {
    const T = M.trim().toLowerCase();
    return T ? ki.filter((_) => `${_.area} ${_.button} ${_.runs}`.toLowerCase().includes(T)) : ki;
  }, [M]);
  return /* @__PURE__ */ i("section", { className: "a3d-help", children: [
    /* @__PURE__ */ i("header", { className: "a3d-row", children: [
      /* @__PURE__ */ e("h1", { style: { margin: 0 }, children: "Help" }),
      /* @__PURE__ */ e("span", { className: "a3d-tabs-spacer" }),
      /* @__PURE__ */ e(
        "button",
        {
          type: "button",
          className: "a3d-btn",
          disabled: !t.tools.helpStatus || x,
          onClick: C,
          title: t.tools.helpStatus ? Zs(t) : "ai3d-help is not installed: update the module",
          children: x ? "Reading…" : "Status of all models (no agent)"
        }
      ),
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", disabled: w, onClick: () => v("*next", a?.slug), title: "Starts an agent session: ai3d-help *next", children: "Ask Compass: what next?" })
    ] }),
    a && /* @__PURE__ */ i("div", { className: "a3d-next", children: [
      /* @__PURE__ */ i("strong", { children: [
        a.meta.title || a.slug,
        a.branches.length > 1 ? ` · branch ${a.branch}` : ""
      ] }),
      L ? /* @__PURE__ */ i(ee, { children: [
        /* @__PURE__ */ i("span", { children: [
          "Step ",
          L.n,
          " of 7, ",
          L.title,
          " — ",
          L.state === "waiting" ? "your turn" : "next: agent"
        ] }),
        /* @__PURE__ */ e("span", { children: L.hint }),
        L.primary && /* @__PURE__ */ i("span", { className: "a3d-muted a3d-small", children: [
          "Button: “",
          L.primary.label,
          "” · ",
          Pn(L.primary, t, a)
        ] }),
        /* @__PURE__ */ i("span", { className: "a3d-row", children: [
          /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small a3d-btn-primary", onClick: () => f(L.id), children: "Go to this step" }),
          /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => B(L.id), children: "Tips for it" })
        ] })
      ] }) : /* @__PURE__ */ e("span", { children: "All seven steps are done in this branch." })
    ] }),
    (() => {
      const T = Js(t, l), _ = T.filter((y) => y.state !== "ok");
      return /* @__PURE__ */ i("details", { className: "a3d-health", open: _.some((y) => y.name === "AI3D Forge skills" || y.state === "missing"), children: [
        /* @__PURE__ */ i("summary", { children: [
          /* @__PURE__ */ e("h2", { style: { display: "inline" }, children: "Setup check" }),
          " ",
          /* @__PURE__ */ e("span", { className: _.length ? "a3d-tag a3d-tag-waiting" : "a3d-pill a3d-pill-done", children: _.length ? `${_.length} to look at` : "all good" })
        ] }),
        /* @__PURE__ */ e("table", { children: /* @__PURE__ */ e("tbody", { children: T.map((y) => /* @__PURE__ */ i("tr", { children: [
          /* @__PURE__ */ i("td", { children: [
            /* @__PURE__ */ e("span", { className: `a3d-hc a3d-hc-${y.state}`, children: y.state === "ok" ? "✓" : y.state === "warn" ? "!" : "✗" }),
            " ",
            y.name
          ] }),
          /* @__PURE__ */ i("td", { children: [
            y.detail,
            y.state !== "ok" && y.fix ? /* @__PURE__ */ e("div", { className: "a3d-muted a3d-small", children: y.fix }) : null
          ] })
        ] }, y.name)) }) })
      ] });
    })(),
    c.length > 0 && /* @__PURE__ */ i("section", { children: [
      /* @__PURE__ */ i("h2", { children: [
        "Your turn (",
        c.length,
        ")"
      ] }),
      /* @__PURE__ */ e("ul", { children: c.map((T) => {
        const _ = (o[T.slug] ?? []).find((y) => y.state === "waiting");
        return /* @__PURE__ */ i("li", { children: [
          /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: () => S(T.slug), children: T.meta.title || T.slug }),
          " — ",
          _?.title,
          ": ",
          _?.hint
        ] }, T.slug);
      }) })
    ] }),
    m && /* @__PURE__ */ i("section", { children: [
      /* @__PURE__ */ e("h2", { children: "Status report" }),
      /* @__PURE__ */ e("pre", { className: "a3d-cmd", children: m })
    ] }),
    /* @__PURE__ */ i("section", { children: [
      /* @__PURE__ */ e("h2", { children: "Step guide" }),
      /* @__PURE__ */ i("p", { className: "a3d-row", role: "tablist", children: [
        qs.map(([T, _]) => /* @__PURE__ */ e("button", { type: "button", role: "tab", "aria-selected": E === T, className: "a3d-btn a3d-btn-small", "aria-pressed": E === T, onClick: () => B(T), children: _ }, T)),
        /* @__PURE__ */ e("span", { className: "a3d-tabs-spacer" }),
        E !== "branches" && E !== "runs" && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", disabled: w, onClick: () => v("*tips", E), title: "Starts an agent session: ai3d-help *tips with your print lessons", children: "Ask Compass about this step" })
      ] }),
      /* @__PURE__ */ e(On, { tips: g, step: E })
    ] }),
    /* @__PURE__ */ i("section", { children: [
      /* @__PURE__ */ e("h2", { children: "What each button runs" }),
      /* @__PURE__ */ i("p", { className: "a3d-muted", children: [
        "Agent buttons start a new session with a prompt (open “Run command…” on a step to see it in full). Script buttons run the shell command shown. ",
        /* @__PURE__ */ e("code", { children: "<skills>" }),
        " is where the module is installed, usually ",
        /* @__PURE__ */ e("code", { children: ".claude/skills" }),
        "."
      ] }),
      /* @__PURE__ */ e("input", { className: "a3d-in-grow", "aria-label": "Filter commands", placeholder: "Filter: blender, branch, README…", value: M, onChange: (T) => I(T.target.value) }),
      /* @__PURE__ */ i("table", { children: [
        /* @__PURE__ */ e("thead", { children: /* @__PURE__ */ i("tr", { children: [
          /* @__PURE__ */ e("th", { children: "Where" }),
          /* @__PURE__ */ e("th", { children: "Button" }),
          /* @__PURE__ */ e("th", { children: "Kind" }),
          /* @__PURE__ */ e("th", { children: "Runs" })
        ] }) }),
        /* @__PURE__ */ e("tbody", { children: O.map((T, _) => /* @__PURE__ */ i("tr", { children: [
          /* @__PURE__ */ e("td", { children: T.area }),
          /* @__PURE__ */ e("td", { children: T.button }),
          /* @__PURE__ */ e("td", { children: T.kind }),
          /* @__PURE__ */ e("td", { children: /* @__PURE__ */ e("code", { children: T.runs }) })
        ] }, _)) })
      ] })
    ] })
  ] });
}
function Zs(t) {
  return `Runs: python3 ${t.tools.helpStatus} ${t.workspace}`;
}
const Ci = [
  { id: "image", label: "Another image", hint: "A picture file. It is accepted at once (or put in inbox/ for Lumen to review); the branch goes on with the 3D mesh." },
  { id: "link", label: "A link", hint: "A model or picture you like (MakerWorld, Printables, Etsy, Pinterest…). Saved in refs/source.md; Lumen writes the image prompt from it." },
  { id: "mesh", label: "A 3D file", hint: "A mesh from another service or another run (GLB, OBJ, STL…). Saved as mesh/raw.*; Chisel reviews it." },
  { id: "text", label: "A brief", hint: "A change in words (other colour scheme, other pose, bigger). Saved in refs/source.md; the first step reads it." },
  { id: "none", label: "Same inputs", hint: "Copies everything up to the node and starts the next step with other settings, in its own folder." }
];
function Xs(t, a) {
  return t === "image" || t === "link" || t === "text" ? "image" : t === "mesh" ? "mesh" : a ? De[Math.min(Ze(a.step) + 1, De.length - 1)] : "image";
}
function Qs({ model: t, from: a, stepTitle: l, busy: s, onPick: o, onCancel: g, onCreate: w }) {
  const [m, x] = A(""), [C, v] = A(a?.id ?? ""), [f, S] = A("image"), [E, B] = A(""), [M, I] = A(!1), [L, c] = A(""), O = t.flow.nodes.find((p) => p.id === C) ?? null, [T, _] = A(null), y = T ?? Xs(f, O), F = f !== "none", b = f === "image" || f === "mesh", j = t.flow.nodes.filter((p) => !p.archived), d = m.trim() && (!F || E.trim()) && (f !== "link" || /^https?:\/\//i.test(E.trim())), u = async () => {
    const p = await o(f === "mesh" ? "mesh" : "image");
    p && p[0] && B(p[0]);
  };
  return /* @__PURE__ */ e("div", { className: "a3d-overlay", onClick: g, children: /* @__PURE__ */ i(
    "form",
    {
      className: "a3d-dialog a3d-dialog-wide",
      onClick: (p) => p.stopPropagation(),
      onSubmit: (p) => {
        p.preventDefault(), d && w({ name: m.trim(), fromNode: C || null, fromStep: y, kind: f, ref: E.trim(), review: M, description: L.trim() });
      },
      children: [
        /* @__PURE__ */ i("h3", { children: [
          "New branch · ",
          t.meta.title || t.slug
        ] }),
        /* @__PURE__ */ i("p", { className: "a3d-muted", children: [
          "A branch is a separate line with its own folder (",
          /* @__PURE__ */ e("code", { children: "branches/<name>/" }),
          "). It copies what it needs from the branch it grows from and then goes through every step on its own, to its own print and README."
        ] }),
        /* @__PURE__ */ i("label", { children: [
          "Name",
          /* @__PURE__ */ e("input", { autoFocus: !0, value: m, onChange: (p) => x(p.target.value), placeholder: "Red fox, Thicker base, Meshy try…" })
        ] }),
        /* @__PURE__ */ i("fieldset", { className: "a3d-fields", children: [
          /* @__PURE__ */ e("legend", { children: "Start with" }),
          /* @__PURE__ */ e("div", { className: "a3d-row", children: Ci.map((p) => /* @__PURE__ */ i("label", { className: "a3d-check", children: [
            /* @__PURE__ */ e("input", { type: "radio", name: "a3d-kind", checked: f === p.id, onChange: () => {
              S(p.id), B(""), _(null);
            } }),
            " ",
            p.label
          ] }, p.id)) }),
          /* @__PURE__ */ e("p", { className: "a3d-muted a3d-small", children: Ci.find((p) => p.id === f)?.hint }),
          f === "text" ? /* @__PURE__ */ e("textarea", { rows: 3, "aria-label": "Brief", value: E, onChange: (p) => B(p.target.value), placeholder: "Same fox, but sitting, tail around the paws." }) : F && /* @__PURE__ */ i("span", { className: "a3d-row a3d-pathrow", children: [
            /* @__PURE__ */ e(
              "input",
              {
                className: "a3d-in-grow",
                "aria-label": f === "link" ? "Link" : "File path",
                value: E,
                onChange: (p) => B(p.target.value),
                placeholder: f === "link" ? "https://makerworld.com/…" : "/Users/you/Downloads/picture.png"
              }
            ),
            b && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => {
              u();
            }, children: "Choose…" })
          ] }),
          f === "image" && /* @__PURE__ */ i("label", { className: "a3d-check", children: [
            /* @__PURE__ */ e("input", { type: "checkbox", checked: M, onChange: (p) => I(p.target.checked) }),
            " Put it in inbox/ for Lumen to review first"
          ] })
        ] }),
        /* @__PURE__ */ i("label", { children: [
          "Grows from",
          /* @__PURE__ */ i("select", { value: C, onChange: (p) => {
            v(p.target.value), _(null);
          }, children: [
            /* @__PURE__ */ e("option", { value: "", children: "Start of the model (copies the concept only)" }),
            j.map((p) => /* @__PURE__ */ i("option", { value: p.id, children: [
              t.branches.length > 1 ? `[${Pe(p)}] ` : "",
              l(p.step),
              " · ",
              p.label,
              p.verdict ? ` (${p.verdict})` : ""
            ] }, p.id))
          ] })
        ] }),
        /* @__PURE__ */ i("label", { children: [
          "First step of the branch",
          /* @__PURE__ */ e("select", { value: y, onChange: (p) => _(p.target.value), children: De.filter((p) => p !== "publish").map((p) => /* @__PURE__ */ e("option", { value: p, children: l(p) }, p)) }),
          /* @__PURE__ */ i("span", { className: "a3d-muted a3d-small", children: [
            "Everything before it is copied from ",
            O ? `branch ${Pe(O)}` : "main",
            "; this step and the ones after it are new."
          ] })
        ] }),
        /* @__PURE__ */ i("label", { children: [
          "Why this branch (optional)",
          /* @__PURE__ */ e("input", { value: L, onChange: (p) => c(p.target.value), placeholder: "Customer asked for a red version; try Meshy instead of Tripo…" })
        ] }),
        /* @__PURE__ */ i("span", { className: "a3d-row a3d-row-end", children: [
          /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: g, children: "Cancel" }),
          /* @__PURE__ */ e("button", { type: "submit", className: "a3d-btn a3d-btn-primary", disabled: s || !d, children: "Create branch" })
        ] })
      ]
    }
  ) });
}
function el({ model: t, scan: a, step: l, initial: s, tips: o, busy: g, onCancel: w, onRun: m }) {
  const x = Ki[l.id] ?? [], C = s ? Math.max(0, x.findIndex((y) => y.skill === s.skill && y.trigger === s.trigger)) : 0, [v, f] = A(C), [S, E] = A(""), [B, M] = A(!1), [I, L] = A(null), c = x[v] ?? s ?? null, O = c ? $n(c) : !1, T = I ?? (c ? gt(a.config, l.id, c.skill, c.trigger) : { model: "", effort: "medium" }), _ = je(() => {
    if (!c) return "";
    const y = O ? {
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
      description: S.trim(),
      outcome: "",
      files: [],
      branch: t.branch
    } : null;
    return Bn(c, t, a, O ? void 0 : S.trim() || void 0, y ? { node: y, flowLog: a.tools.flowLog } : void 0, T.effort);
  }, [c, O, t, a, l.id, S, T.effort]);
  return /* @__PURE__ */ e("div", { className: "a3d-overlay", onClick: w, children: /* @__PURE__ */ i(
    "form",
    {
      className: "a3d-dialog a3d-dialog-wide",
      onClick: (y) => y.stopPropagation(),
      onSubmit: (y) => {
        y.preventDefault(), c && m({ action: c, instruction: S.trim(), run: T });
      },
      children: [
        /* @__PURE__ */ i("h3", { children: [
          "Run command · ",
          l.title,
          t.branches.length > 1 ? ` · branch ${t.branch}` : ""
        ] }),
        /* @__PURE__ */ i("label", { children: [
          "Command",
          /* @__PURE__ */ e("select", { value: v, onChange: (y) => f(Number(y.target.value)), children: x.map((y, F) => /* @__PURE__ */ i("option", { value: F, children: [
            y.label,
            " — ",
            y.skill,
            " ",
            y.trigger
          ] }, y.trigger)) })
        ] }),
        /* @__PURE__ */ i("label", { children: [
          "Your instruction for the agent (optional)",
          /* @__PURE__ */ e(
            "textarea",
            {
              rows: 3,
              autoFocus: !0,
              value: S,
              onChange: (y) => E(y.target.value),
              placeholder: l.id === "blender" ? "For example: base 3 mm thicker, keep the tail on the bed, overhang under 8 %." : l.id === "image" ? "For example: three-quarter view, legs apart, no shadow on the ground." : "What to do differently or what to watch for."
            }
          )
        ] }),
        /* @__PURE__ */ i("p", { className: "a3d-muted a3d-small", children: [
          O ? "This command makes a new attempt (a box in the graph); your instruction is saved as its description." : "Your instruction is added to the prompt; this command does not make a new attempt.",
          " ",
          /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: () => M((y) => !y), children: B ? "Hide tips" : "Tips for this step" })
        ] }),
        B && /* @__PURE__ */ e(On, { tips: o, step: l.id }),
        /* @__PURE__ */ e(Tn, { value: T, onChange: L }),
        /* @__PURE__ */ i("details", { children: [
          /* @__PURE__ */ e("summary", { children: "Prompt sent to the agent session" }),
          /* @__PURE__ */ e("pre", { className: "a3d-cmd", children: _ })
        ] }),
        /* @__PURE__ */ i("span", { className: "a3d-row a3d-row-end", children: [
          /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: w, children: "Cancel" }),
          /* @__PURE__ */ i("button", { type: "submit", className: "a3d-btn a3d-btn-primary", disabled: g || !c, children: [
            "Run: ",
            c?.label
          ] })
        ] })
      ]
    }
  ) });
}
function tl({ host: t, model: a, pictures: l, defaultRun: s, busy: o, onPick: g, onCancel: w, onRun: m }) {
  const [x, C] = A("model"), [v, f] = A(""), [S, E] = A(l), [B, M] = A(""), [I, L] = A(""), [c, O] = A(""), [T, _] = A(s), y = (j) => E((d) => Array.from(/* @__PURE__ */ new Set([...d, ...j.map((u) => u.trim()).filter(Boolean)]))), F = !I.trim() || /^https?:\/\/\S+$/i.test(I.trim()), b = (v.trim() || S.length > 0 || I.trim()) && F && (x === "model" || c.trim());
  return /* @__PURE__ */ e("div", { className: "a3d-overlay", onClick: w, children: /* @__PURE__ */ i(
    "form",
    {
      className: "a3d-dialog a3d-dialog-wide a3d-attempt",
      onClick: (j) => j.stopPropagation(),
      onSubmit: (j) => {
        j.preventDefault(), b && m({ target: x, text: v.trim(), pictures: S, link: I.trim(), branchName: c.trim(), run: T });
      },
      children: [
        /* @__PURE__ */ i("header", { children: [
          /* @__PURE__ */ e("h3", { children: "New concept" }),
          /* @__PURE__ */ e("p", { className: "a3d-muted", children: "Muse writes the concept from what you give it: words, pictures, a link, or any mix. With a picture, Muse looks at it first and describes what it sees." })
        ] }),
        a && /* @__PURE__ */ i("fieldset", { className: "a3d-fields", children: [
          /* @__PURE__ */ e("legend", { children: "Make it" }),
          /* @__PURE__ */ i("span", { className: "a3d-row", children: [
            /* @__PURE__ */ i("label", { className: "a3d-check", children: [
              /* @__PURE__ */ e("input", { type: "radio", name: "a3d-nm-target", checked: x === "model", onChange: () => C("model") }),
              " A new model"
            ] }),
            /* @__PURE__ */ i("label", { className: "a3d-check", children: [
              /* @__PURE__ */ e("input", { type: "radio", name: "a3d-nm-target", checked: x === "branch", onChange: () => C("branch") }),
              " A new branch of ",
              a.meta.title || a.slug
            ] })
          ] }),
          x === "branch" && /* @__PURE__ */ i("label", { children: [
            "Branch name",
            /* @__PURE__ */ e("input", { value: c, onChange: (j) => O(j.target.value), placeholder: "Wizard kitten, With shield…" })
          ] })
        ] }),
        /* @__PURE__ */ i("section", { className: "a3d-attempt-sec", children: [
          /* @__PURE__ */ e("strong", { children: "Pictures to make it from" }),
          S.length > 0 && /* @__PURE__ */ e("div", { className: "a3d-gallery", children: S.map((j) => /* @__PURE__ */ i("figure", { children: [
            /* @__PURE__ */ e(Oe, { host: t, path: j, mtime: 0, alt: j.split("/").pop() ?? j }),
            /* @__PURE__ */ i("figcaption", { title: j, children: [
              j.split("/").pop(),
              " ",
              /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: () => E((d) => d.filter((u) => u !== j)), children: "remove" })
            ] })
          ] }, j)) }),
          /* @__PURE__ */ i("span", { className: "a3d-row a3d-pathrow", children: [
            /* @__PURE__ */ e(
              "input",
              {
                className: "a3d-in-grow",
                "aria-label": "Picture path",
                placeholder: "Path to a picture, or use Choose…",
                value: B,
                onChange: (j) => M(j.target.value),
                onKeyDown: (j) => {
                  j.key === "Enter" && B.trim() && (j.preventDefault(), y([B]), M(""));
                }
              }
            ),
            /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", disabled: !B.trim(), onClick: () => {
              y([B]), M("");
            }, children: "Add" }),
            /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: async () => {
              const j = await g();
              j && y(j);
            }, children: "Choose…" })
          ] })
        ] }),
        /* @__PURE__ */ i("label", { children: [
          "Link (optional)",
          /* @__PURE__ */ e("input", { value: I, onChange: (j) => L(j.target.value), placeholder: "https://… a model, a picture or a page to take the idea from" }),
          !F && /* @__PURE__ */ e("span", { className: "a3d-muted a3d-small", children: "A link starts with http:// or https://" })
        ] }),
        /* @__PURE__ */ i("label", { children: [
          "What to make",
          S.length || I.trim() ? " (optional: what to keep, what to change)" : "",
          /* @__PURE__ */ e(
            "textarea",
            {
              rows: 3,
              autoFocus: !l.length,
              value: v,
              onChange: (j) => f(j.target.value),
              placeholder: S.length ? "Same character, but chibi proportions, standing, 60 mm, static, no cape." : "Subject, style, size, static or flexi."
            }
          )
        ] }),
        /* @__PURE__ */ i("details", { className: "a3d-attempt-more", children: [
          /* @__PURE__ */ e("summary", { children: "More: model and reasoning" }),
          /* @__PURE__ */ e(Tn, { value: T, onChange: _ })
        ] }),
        /* @__PURE__ */ i("footer", { className: "a3d-attempt-foot", children: [
          /* @__PURE__ */ i("span", { className: "a3d-muted a3d-small", children: [
            "Agent run: ai3d-muse *concept",
            x === "branch" ? " in a new branch (flow_log.py branch add)" : "",
            ". Pictures are copied into refs/."
          ] }),
          /* @__PURE__ */ i("span", { className: "a3d-row a3d-row-end", children: [
            /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: w, children: "Cancel" }),
            /* @__PURE__ */ e("button", { type: "submit", className: "a3d-btn a3d-btn-primary", disabled: o || !b, children: "Run: write concept" })
          ] })
        ] })
      ]
    }
  ) });
}
const nl = 4e3;
function il(t, a, l, s) {
  const o = { ...gt(t, a, l.skill, l.trigger), ...s ?? {} };
  return { run_model: o.model ? o.model.replace(/^claude-code:/, "") : "default", run_effort: o.effort };
}
const St = "_global";
async function al(t) {
  const a = `python3 - ${$(t.workspacePath)} ${$(Ti.modelsRoot)} <<'A3D_SCAN'
${Aa}
A3D_SCAN`, l = await t.exec(a, { timeout: 2e4 });
  if (!l.success) throw new Error(l.stderr.trim() || "Could not scan the models folder (is python3 installed?).");
  return JSON.parse(l.stdout);
}
function sl(t) {
  return {
    read: async (a) => {
      const l = await t.exec(`[ -f ${$(a)} ] && cat ${$(a)}`, { timeout: 1e4 });
      return l.success ? l.stdout : null;
    },
    write: async (a, l) => {
      if (l.includes("A3D_CFG_EOF")) throw new Error("Refusing to write: the text contains the heredoc marker.");
      const s = await t.exec(`cat > ${$(a)} <<'A3D_CFG_EOF'
${l.replace(/\n*$/, `
`)}A3D_CFG_EOF`, { timeout: 1e4 });
      if (!s.success) throw new Error(s.stderr.trim() || "write failed");
    }
  };
}
function mt({ host: t, model: a, folder: l, title: s, onZoom: o, empty: g }) {
  const w = ue(a.files[l]);
  return !w.length && !g ? null : /* @__PURE__ */ i("section", { className: "a3d-block", children: [
    /* @__PURE__ */ i("h4", { children: [
      s,
      " ",
      /* @__PURE__ */ e("span", { className: "a3d-count", children: w.length })
    ] }),
    w.length === 0 ? /* @__PURE__ */ e("p", { className: "a3d-muted", children: g }) : /* @__PURE__ */ e("div", { className: "a3d-gallery", children: w.map((m) => {
      const x = `${a.dir}/${l}/${m.name}`;
      return /* @__PURE__ */ i("figure", { children: [
        /* @__PURE__ */ e(Oe, { host: t, path: x, mtime: m.mtime, alt: m.name, onClick: () => o({ path: x, mtime: m.mtime, name: m.name }) }),
        /* @__PURE__ */ e("figcaption", { title: m.name, children: m.name })
      ] }, m.name);
    }) })
  ] });
}
function Ht({ title: t, text: a, onOpen: l, copyLabel: s }) {
  const [o, g] = A(!1);
  return a ? /* @__PURE__ */ i("section", { className: "a3d-block", children: [
    /* @__PURE__ */ i("h4", { children: [
      t,
      /* @__PURE__ */ i("span", { className: "a3d-block-actions", children: [
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: async () => {
          await navigator.clipboard.writeText(a), g(!0), setTimeout(() => g(!1), 1500);
        }, children: o ? "Copied" : s ?? "Copy" }),
        l && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: l, children: "Open file" })
      ] })
    ] }),
    /* @__PURE__ */ e("pre", { className: "a3d-text", children: a })
  ] }) : null;
}
function ll({ title: t, model: a, folder: l, files: s, onOpen: o, onExternal: g }) {
  return s.length ? /* @__PURE__ */ i("section", { className: "a3d-block", children: [
    /* @__PURE__ */ e("h4", { children: t }),
    /* @__PURE__ */ e("ul", { className: "a3d-files", children: s.map((w) => {
      const m = `${a.dir}/${l}/${w.name}`, x = /\.(md|json|txt|ya?ml)$/i.test(w.name);
      return /* @__PURE__ */ i("li", { children: [
        /* @__PURE__ */ i("span", { className: "a3d-file-name", children: [
          l,
          "/",
          w.name
        ] }),
        /* @__PURE__ */ e("span", { className: "a3d-muted", children: Si(w.size) }),
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => x ? o(m) : g(m), children: x ? "Open" : "Open in app" })
      ] }, w.name);
    }) })
  ] }) : null;
}
function _i({ model: t }) {
  const a = t.analysis, l = a?.after ?? a?.analysis ?? null, s = a?.flexi ?? null;
  if (!l && !s) return null;
  const o = [];
  return l?.overhang_pct != null && o.push(["Overhang", `${l.overhang_pct} %`]), a?.before?.overhang_pct != null && o.push(["Overhang before", `${a.before.overhang_pct} %`]), a?.side_on_bed && o.push(["Side on bed", String(a.side_on_bed)]), a?.cut_mm != null && o.push(["Flat cut", `${a.cut_mm} mm`]), l?.size_mm && o.push(["Size", `${l.size_mm.join(" × ")} mm`]), l?.watertight != null && o.push(["Watertight", l.watertight ? "yes" : "no", l.watertight ? "good" : "bad"]), l?.shells != null && o.push(["Shells", String(l.shells)]), s && (o.push(["Joints", `${s.joints} of ${Math.max(0, (s.segments ?? 1) - 1 + (s.skipped_cuts?.length ?? 0))} cuts`]), o.push(["Joint check", s.ok ? "all held and free" : "failed", s.ok ? "good" : "bad"]), s.clearance_mm != null && o.push(["Clearance", `${s.clearance_mm} mm`])), /* @__PURE__ */ i("section", { className: "a3d-block", children: [
    /* @__PURE__ */ e("h4", { children: "Print analysis" }),
    /* @__PURE__ */ e("dl", { className: "a3d-metrics", children: o.map(([g, w, m]) => /* @__PURE__ */ i("div", { className: m ? `a3d-metric a3d-${m}` : "a3d-metric", children: [
      /* @__PURE__ */ e("dt", { children: g }),
      /* @__PURE__ */ e("dd", { children: w })
    ] }, g)) })
  ] });
}
function xi(t) {
  const a = new Date(t);
  return (/* @__PURE__ */ new Date()).toDateString() === a.toDateString() ? a.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : a.toLocaleDateString([], { month: "short", day: "numeric" });
}
function rl({ host: t }) {
  const [a, l] = A(() => String(t.theme ?? "light"));
  ke(() => t.onThemeChanged?.((n) => l(String(n))), [t]);
  const [s, o] = A(null), [g, w] = A(null), [m, x] = A(null), [C, v] = A(null), [f, S] = A(St), [E, B] = A(null), [M, I] = A(null), [L, c] = A("models"), [O, T] = A(!1), [_, y] = A(""), [F, b] = A(null), [j, d] = A(null), [u, p] = A(!1), [U, q] = A("graph"), [ie, Z] = A(null), [X, $e] = A(null), [Be, be] = A(null), [R, W] = A(null), [de, pe] = A(null), [we, Te] = A([]), [Ce, Xe] = A(!1), [rt, N] = A(!1), [te, Ui] = A(() => t.storage.get("notify") ?? !0), [Wn, zn] = A(!1), [fe, Ji] = A(null), [Kn, Gn] = A(!1), [nn, yt] = A(!1), [qi, Vn] = A(null), [Yi, Zi] = A({}), [jt, kt] = A(null), [Hn, Xi] = A(() => t.storage.get("branchSel") ?? {}), [Ee, Qe] = A(null), [ot, Ge] = A(null), [an, Nt] = A(null), [Un, Dt] = A(!1), [Jn, Qi] = A(null), [ea, ta] = A(null), [na, qn] = A(!1), Yn = qe(""), sn = qe(!1), [$t, ia] = A(() => t.storage.get("off") === !0), dt = qe($t ? "off" : null), Zn = qe(0), At = H((n) => {
    ia(n), dt.current = n ? "off" : null, t.storage.set("off", n);
  }, [t]), aa = Da(Fs, Os), Q = H(async () => {
    if (!sn.current) {
      sn.current = !0;
      try {
        const n = await al(t);
        Zn.current = Date.now(), dt.current !== "off" && (dt.current = !n.installed && !n.tools.flowLog && n.models.length === 0 ? "none" : null);
        const r = JSON.stringify(n);
        r !== Yn.current && (Yn.current = r, o(n)), w(null);
      } catch (n) {
        w(n instanceof Error ? n.message : String(n));
      } finally {
        sn.current = !1;
      }
    }
  }, [t]);
  ke(() => {
    Es(t.storage), dt.current !== "off" && Q();
    const n = setInterval(() => {
      document.hidden || dt.current === "off" || dt.current === "none" && Date.now() - Zn.current < 6e4 || Q();
    }, nl), r = t.onWorkspaceEvent("sessions:refresh-list", (k) => {
      const P = k?.sessionId;
      typeof P == "string" && zs(P);
    });
    return () => {
      clearInterval(n), r();
    };
  }, [t, Q]), ke(() => Ms((n, r) => {
    if (!te) return;
    const k = n === St ? "" : ` · ${n}`, P = `${r.status === "error" ? "Failed" : "Finished"}: ${r.label}${k}`;
    d(`${P}. ${r.status === "error" ? r.error ?? "" : "Check the agent session for questions."}`);
    try {
      document.hidden && typeof Notification < "u" && Notification.permission === "granted" && new Notification("AI3D Forge", { body: P });
    } catch {
    }
  }), [te]);
  const sa = H(() => {
    const n = !te;
    Ui(n), t.storage.set("notify", n);
    try {
      n && typeof Notification < "u" && Notification.permission === "default" && Notification.requestPermission();
    } catch {
    }
    d(n ? "Notifications on: a message when an agent run ends (a system notification when the panel is hidden)." : "Notifications off.");
  }, [te, t]);
  ke(() => {
    const n = (r) => {
      (r.metaKey || r.ctrlKey) && r.key.toLowerCase() === "k" && (r.preventDefault(), T((k) => !k));
    };
    return window.addEventListener("keydown", n), () => window.removeEventListener("keydown", n);
  }, []), ke(() => {
    if (!F && !M && !X && !Ee && !ot) return;
    const n = (r) => {
      r.key === "Escape" && (b(null), I(null), $e(null), Qe(null), Ge(null));
    };
    return window.addEventListener("keydown", n), () => window.removeEventListener("keydown", n);
  }, [F, M, X, Ee, ot]);
  const ve = s?.models ?? [], et = ve.find((n) => n.slug === m) ?? null, h = je(() => et ? Wa(et, Hn[et.slug]) : null, [et, Hn]), ln = je(() => Vs(Jn), [Jn]), Rt = je(() => {
    const n = {};
    if (s) for (const r of s.models) n[r.slug] = li(r, s);
    return n;
  }, [s]);
  ke(() => {
    s && (m && !ve.some((n) => n.slug === m) ? x(null) : !m && ve.length && (x(ve[0].slug), S(ve[0].slug)));
  }, [s, m, ve]), ke(() => {
    const n = Object.values(Rt).filter((r) => r.some((k) => k.state === "waiting")).length;
    t.setGutterBadge?.(n > 0 ? n : null, { tone: "warning" });
  }, [Rt, t]);
  const ce = je(() => h && s ? li(h, s) : [], [h, s]), Me = H((n) => {
    et && (Xi((r) => {
      const k = { ...r, [et.slug]: n };
      return t.storage.set("branchSel", k), k;
    }), Z(null), v(null), Te([]), be(null), p(!1));
  }, [et, t]), rn = s?.tools.stepTips ?? null;
  ke(() => {
    rn && t.exec(`cat ${$(rn)}`, { timeout: 1e4 }).then((n) => {
      n.success && Qi(n.stdout);
    });
  }, [rn, t]);
  const ct = ce.find((n) => n.state === "active" || n.state === "waiting") ?? ce[ce.length - 1], G = ce.find((n) => n.id === C) ?? ct, _e = !1, Pt = Is(), Ae = H(async (n) => {
    const r = await t.exec(`${hi()} ${$(n)}`, { timeout: 15e3 });
    r.success || d(`Could not open ${n}: ${r.stderr.trim()}`);
  }, [t]), tt = H(async (n) => {
    if (!s?.tools.flowLog) return n.flow.nodes;
    const r = await t.exec(`python3 ${$(s.tools.flowLog)} list ${$(n.dir)}`, { timeout: 15e3 });
    try {
      return r.success ? JSON.parse(r.stdout).nodes : n.flow.nodes;
    } catch {
      return n.flow.nodes;
    }
  }, [s, t]), Xn = h, J = H(async (n, r, k, P) => {
    if (!s) return;
    const D = P?.target ?? Xn;
    if (d(null), p(!1), n.kind === "script") {
      if (n.script === "readme") {
        if (!D || !s.tools.buildReadme) return;
        const ne = $(s.tools.buildReadme), oe = await t.exec(`python3 ${ne} ${$(D.dir)} && python3 ${ne} ${$(s.root)} --catalog`, { timeout: 6e4 });
        d(oe.success ? "README and catalog rebuilt." : `README build failed: ${oe.stderr.trim()}`);
      } else if (n.script === "view" || n.script === "views-all") {
        if (!s.tools.buildViewer) {
          d("The Prism scripts were not found. Update the AI3D Forge module.");
          return;
        }
        const ne = n.script === "view" ? D ? [D] : [] : s.models.filter((Se) => Se.files.mesh.some((it) => /\.stl$/i.test(it.name)));
        if (!ne.length) {
          d(n.script === "view" ? "Select a model first." : "No model has an STL yet.");
          return;
        }
        d(`Building ${ne.length === 1 ? "the 3D view" : `${ne.length} 3D views`}…`);
        let oe = null;
        const Ne = [];
        for (const Se of ne) {
          const it = await t.exec(`python3 ${$(s.tools.buildViewer)} ${$(Se.dir)}`, { timeout: 12e4, maxBuffer: 2e7 });
          if (!it.success) {
            Ne.push(`${Se.slug}: ${it.stderr.trim().split(`
`).pop()}`);
            continue;
          }
          try {
            oe = JSON.parse(it.stdout.trim().split(`
`).pop() ?? "{}");
          } catch {
            oe = null;
          }
        }
        ne.length === 1 && oe?.view && await Ae(oe.view), d(Ne.length ? `3D view failed: ${Ne.join("; ")}` : ne.length === 1 ? `3D view built (${oe?.mb ?? "?"} MB) and opened in your browser.${oe?.note ? " " + oe.note : ""}` : `${ne.length} 3D views built. Open one from its model.`);
      } else if (n.script === "portfolio") {
        if (!s.tools.buildInsights) {
          d("The Prism scripts were not found. Update the AI3D Forge module.");
          return;
        }
        d("Building the portfolio dashboard…");
        const ne = await t.exec(`python3 ${$(s.tools.buildInsights)} portfolio ${$(s.root)}`, { timeout: 6e4 });
        d(ne.success ? "Portfolio dashboard built." : `Portfolio build failed: ${ne.stderr.trim()}`), ne.success && c("insights");
      }
      Q();
      return;
    }
    if (n.kind === "form") {
      if (n.form === "print-log") N(!0);
      else if (D && s.tools.printLog) {
        const ne = await t.exec(`python3 ${$(s.tools.printLog)} skip ${$(D.dir)} --reason ${$("skipped from the panel")}`, { timeout: 15e3 });
        d(ne.success ? "Test print skipped for this model. Log a print later if you make one." : `Could not save: ${ne.stderr.trim()}`), Q();
      }
      return;
    }
    if (n.kind !== "agent") return;
    if (!Ls()) {
      d("The AI service is not available to this extension. Check its AI permission in Settings.");
      return;
    }
    const K = D && r ? D.slug : St, V = D && r ? `AI3D · ${D.slug}${D.branch !== "main" ? `/${D.branch}` : ""} · ${n.label}` : `AI3D · ${n.label}`;
    if (zi(K, n.label)) {
      d(`“${n.label}” is already running. Its session is in the pane on the right.`);
      return;
    }
    let le;
    const se = s.tools.flowLog;
    if (D && r && se && $n(n)) {
      const ne = await tt(D), oe = st(D, ne), Ne = P?.parent !== void 0 ? P.parent : It(D, ne, r.id), Se = lt(oe, r.id).filter((ze) => !ze.inferred).length + 1, it = Math.max(
        0,
        ...D.files.prompts.map((ze) => Number(/^image-v(\d+)\.md$/.exec(ze.name)?.[1] ?? 0)),
        ...oe.map((ze) => Number(/^Image prompt v(\d+)/.exec(ze.label)?.[1] ?? 0))
      ) + 1, _a = Math.max(
        0,
        ...oe.map((ze) => Number(/^Views v(\d+)/.exec(ze.label)?.[1] ?? 0)),
        ...D.files.prompts.map((ze) => Number(/^views-v(\d+)\.md$/.exec(ze.name)?.[1] ?? 0))
      ) + 1, ai = n.trigger === "*views", xa = ai ? `Views v${_a}` : r.id === "image" ? `Image prompt v${it}` : `${r.title} · try ${Se}`, Sa = ai ? { mode: "views", views: "front,left,back,right" } : {}, ja = [
        `python3 ${$(se)} add ${$(D.dir)} --step ${r.id} --label ${$(xa)} --status running`,
        Ne ? `--parent ${$(Ne)}` : "",
        P?.description ? `--description ${$(P.description)}` : "",
        `--settings-json ${$(JSON.stringify({ ...Sa, ...P?.settings ?? {}, ...il(s.config, r.id, n, P?.run) }))}`
      ].filter(Boolean).join(" "), si = await t.exec(ja, { timeout: 15e3 });
      if (si.success)
        try {
          le = { node: JSON.parse(si.stdout.trim().split(`
`).pop() ?? ""), flowLog: se }, Z(le.node.id);
        } catch {
        }
      le ? Q() : d("The flow node could not be created; the step runs without it.");
    }
    const xe = { ...gt(s.config, r?.id ?? null, n.skill, n.trigger), ...P?.run ?? {} }, ge = le && D && se ? (ne, oe) => {
      const Ne = ne === "error" ? ` --outcome ${$(`Run failed: ${oe ?? "unknown error"}`)}` : "";
      t.exec(`python3 ${$(se)} settle ${$(D.dir)} ${$(le.node.id)} --status ${ne === "error" ? "error" : "open"}${Ne}`, { timeout: 15e3 }).then(() => Q());
    } : void 0;
    if (!Ks(K, r?.id ?? "global", n.label, Bn(n, r ? D : null, s, k, le, xe.effort), V, ge, xe.model)) {
      d(`“${n.label}” is already running.`), ge?.("error", "not started");
      return;
    }
    S(K), B(null);
  }, [s, Xn, t, Q, Ae, tt]), nt = H((n, r) => {
    if (h) {
      if (n === "print") {
        N(!0);
        return;
      }
      ft[n]?.length && $e({
        step: n,
        parent: r?.parent !== void 0 ? r.parent : It(h, h.flow.nodes, n),
        settings: r?.settings ?? {},
        description: r?.description ?? ""
      });
    }
  }, [h]), Qn = H((n, r) => {
    const k = h ? `Selected model: ${h.slug}${h.branches.length > 1 ? `, branch ${h.branch}` : ""}.` : "";
    J({ kind: "agent", label: `Compass ${n}${r ? ` ${r}` : ""}`, skill: "ai3d-help", trigger: n }, null, [r, k].filter(Boolean).join(" · "));
  }, [J, h]), la = H((n) => {
    const r = ce.find((k) => k.id === Ee?.step) ?? null;
    Qe(null), r && ($n(n.action) ? J(n.action, r, void 0, { description: n.instruction, run: n.run }) : J(n.action, r, n.instruction || void 0, { run: n.run }));
  }, [ce, Ee, J]), on = H(async (n, r) => {
    if (!h || !s?.tools.flowLog) return;
    const k = await t.exec(`python3 ${$(s.tools.flowLog)} update ${$(h.dir)} ${$(n.id)} --verdict ${r}`, { timeout: 15e3 });
    k.success || d(`Could not save the verdict: ${k.stderr.trim()}`), Q();
  }, [h, s, t, Q]), dn = H(async (n) => {
    if (!h || !s?.tools.flowLog) return !1;
    const r = await t.exec(`python3 ${$(s.tools.flowLog)} ${n}`, { timeout: 15e3 });
    return r.success || d(`Could not save: ${r.stderr.trim().split(`
`).pop()}`), Q(), r.success;
  }, [h, s, t, Q]), ht = H(async (n, r) => {
    const k = await t.exec(n, { timeout: 6e4 });
    if (Q(), !k.success)
      return d(`${r} failed: ${k.stderr.trim().split(`
`).pop()}`), null;
    try {
      return JSON.parse(k.stdout.trim().split(`
`).pop() ?? "null");
    } catch {
      return {};
    }
  }, [t, Q]), ra = H(async (n) => {
    if (Ge(null), !h || !s?.tools.flowLog) {
      d("flow_log.py was not found: update the module.");
      return;
    }
    const r = n.kind === "none" ? void 0 : `${n.kind}:${n.ref}`;
    d(`Creating branch “${n.name}”…`);
    const k = await ht(re.branchAdd(s.tools.flowLog, h.rootDir, { name: n.name, fromNode: n.fromNode, fromStep: n.fromStep, source: r, review: n.review, description: n.description }), "New branch");
    k?.id && (await Q(), Me(k.id), c("flow"), d(`Branch “${n.name}” created in branches/${k.id}/ (starts at ${n.fromStep}${k.inherited?.length ? `, ${k.inherited.length} files copied` : ""}). Its steps are shown now.`));
  }, [h, s, ht, Q, Me]), oa = H(async (n) => {
    if (Nt(null), !s) return;
    const r = [
      n.pictures.length ? `Reference pictures — look at each one with the Read tool before you write anything, describe what you see, and build the concept from them: ${n.pictures.map((ge) => `\`${ge}\``).join(", ")}.` : "",
      n.link ? `Reference link (open it): ${n.link}` : "",
      n.text ? `What I want: ${n.text}` : n.pictures.length || n.link ? "Make a printable model of what the references show; say what you kept and what you changed for printing." : ""
    ].filter(Boolean);
    if (n.target === "model" || !h || !s.tools.flowLog) {
      const ge = n.pictures.length ? " Copy the reference pictures into the new model's work folder refs/." : "";
      J({ kind: "agent", label: `New model${n.text ? `: ${n.text.slice(0, 30)}` : ""}`, skill: "ai3d-muse", trigger: "*concept" }, null, r.join(" ") + ge, { run: n.run });
      return;
    }
    const k = [n.text, n.link ? `Link: ${n.link}` : ""].filter(Boolean).join(" · ") || "Concept from the reference pictures", P = `${re.branchAdd(s.tools.flowLog, h.rootDir, { name: n.branchName, fromStep: "concept", source: `text:${k}`, description: n.text })}${n.pictures.map((ge) => ` --ref ${$(ge)}`).join("")}`, D = await ht(P, "New branch");
    if (!D?.id) return;
    const K = { inbox: [], images: [], renders: [], refs: [], mesh: [], print: [], prompts: [], publish: [] }, V = {
      id: D.id,
      name: n.branchName,
      parent_branch: "main",
      from_node: null,
      from_step: "concept",
      source: { kind: "text", ref: k },
      description: n.text,
      status: "open",
      created_at: null,
      primary: !1,
      exists: !0,
      work: { dir: D.dir, meta: {}, concept: null, files: K, attempts: [], imagePrompt: null, prompt3d: null, analysis: null, hasReadme: !1, view: null, printLog: [], printPhotos: [], source: null, stamp: 0 }
    }, le = { ...h, ...V.work, meta: { title: h.meta.title }, dir: D.dir, branch: D.id, migrated: !0, branches: [...h.branches, V] }, se = ce.find((ge) => ge.id === "concept") ?? null, xe = (D.refs ?? []).length ? ` The reference pictures are in this branch: ${D.refs.join(", ")} — look at them with the Read tool first.` : "";
    await J(
      { kind: "agent", label: "Write concept", skill: "ai3d-muse", trigger: "*concept" },
      se,
      void 0,
      { description: `${k}.${xe} Write this branch's own concept.md and metadata.json in its work folder; do not create a new model.`, run: n.run, target: le }
    ), await Q(), Me(D.id), c("flow");
  }, [s, h, ce, J, ht, Q, Me]), Ct = H(async (n, r) => {
    if (!h || !s?.tools.flowLog) return;
    const k = s.tools.flowLog, P = n === "promote" ? re.branchPromote(k, h.rootDir, r) : n === "migrate" ? re.migrate(k, h.rootDir) : re.branchSet(k, h.rootDir, r, n);
    await ht(P, n === "migrate" ? "Moving files" : "Branch") && (n === "archived" && r === h.branch && Me(h.primary), d(n === "promote" ? `“${r}” is the primary branch now: the Models tab, the catalog and the portfolio use it.` : n === "migrate" ? "The work files are in branches/main/ now; metadata.json and concept.md stay in the model folder too." : n === "variant" ? `“${r}” is a variant: it gets its own README and listing.` : n === "archived" ? `“${r}” is archived: hidden, nothing deleted.` : `“${r}” is open again.`));
  }, [h, s, ht, Me]), ei = H(async () => {
    if (!s?.tools.helpStatus) return;
    qn(!0);
    const n = await t.exec(re.helpStatus(s.tools.helpStatus, s.workspace), { timeout: 3e4 });
    ta(n.success ? n.stdout.trim() : `status.py failed: ${n.stderr.trim()}`), qn(!1);
  }, [s, t]), da = H((n) => {
    Te((r) => r.includes(n.id) ? r.filter((k) => k !== n.id) : [...r, n.id].slice(-2));
  }, []), ca = H(async (n, r) => {
    if (!h || !s?.tools.buildViewer) {
      d("The Prism scripts were not found.");
      return;
    }
    const k = _n(h, n), P = `${k}/view/compare-${n.id}.html`, D = await t.exec(`python3 ${$(s.tools.buildViewer)} ${$(k)} --stl ${$(`${k}/${r}`)} --out ${$(P)}`, { timeout: 12e4, maxBuffer: 2e7 });
    if (!D.success) {
      d(`3D view failed: ${D.stderr.trim().split(`
`).pop()}`);
      return;
    }
    await Ae(P);
  }, [h, s, t, Ae]), ha = H(async (n) => {
    if (N(!1), !h || !s?.tools.printLog) {
      d("print_log.py was not found: update the module.");
      return;
    }
    const r = h;
    d("Saving the test print…");
    const k = [...n.photoPaths];
    try {
      for (const V of n.photoFiles) k.push(await Mi(t, r.dir, V));
    } catch (V) {
      d(`Photo upload failed: ${V instanceof Error ? V.message : String(V)}`);
      return;
    }
    const P = [
      `add ${$(r.dir)} --result ${n.result}`,
      `--printer ${$(n.printer)}`,
      `--filament ${$(n.filament)}`,
      `--settings ${$(n.settings)}`,
      `--change ${$(n.change)}`,
      `--notes ${$(n.notes)}`,
      k.length ? `--photos ${$(k.join(","))}` : ""
    ].filter(Boolean).join(" "), D = await t.exec(`python3 ${$(s.tools.printLog)} ${P}`, { timeout: 3e4 });
    if (t.exec(`rm -rf ${$(`${r.dir}/.import-tmp`)}`, { timeout: 1e4 }), !D.success) {
      d(`Could not save: ${D.stderr.trim().split(`
`).pop()}`);
      return;
    }
    let K = {};
    try {
      K = JSON.parse(D.stdout.trim().split(`
`).pop() ?? "{}");
    } catch {
    }
    if (s.tools.flowLog) {
      const V = await tt(r), le = lt(st(r, V), "print").filter((We) => !We.inferred).length + 1, se = It(r, V, "print"), xe = ["print/print-log.md", ...K.photos ?? []].join(","), ge = JSON.stringify(Object.fromEntries(Object.entries({ printer: n.printer, filament: n.filament, settings: n.settings }).filter(([, We]) => We)));
      if (await t.exec([
        `python3 ${$(s.tools.flowLog)} add ${$(r.dir)} --step print --agent you --label ${$(`Test print ${le}`)} --status done`,
        `--outcome ${$(`${n.result}${n.change ? `; change: ${n.change}` : ""}`)}`,
        `--files ${$(xe)}`,
        `--settings-json ${$(ge)}`,
        se ? `--parent ${$(se)}` : ""
      ].filter(Boolean).join(" "), { timeout: 15e3 }), n.result !== "issues") {
        const We = await t.exec(`python3 ${$(s.tools.flowLog)} list ${$(r.dir)}`, { timeout: 15e3 });
        try {
          const ne = st(r, JSON.parse(We.stdout).nodes).filter((Ne) => Ne.step === "print" && !Ne.inferred), oe = ne[ne.length - 1];
          oe && await t.exec(`python3 ${$(s.tools.flowLog)} update ${$(r.dir)} ${$(oe.id)} --verdict ${n.result === "ok" ? "accepted" : "rejected"}`, { timeout: 15e3 });
        } catch {
        }
      }
    }
    d(`Test print saved (${n.result}).${n.result === "fail" ? " Run the Blender step again with the change, or go back to the mesh." : ""}`), Q();
  }, [h, s, t, Q, tt]), ti = H((n, r) => {
    if (!h) return;
    const k = `${r ? _n(h, r) : h.dir}/${n}`;
    /\.(md|json|txt|ya?ml)$/i.test(n) ? t.openFile(k) : Ae(k);
  }, [h, t, Ae]), Ie = H((n, r) => {
    x(n), v(null), Z(null), be(null), S(n), B(null), d(null), r && c(r);
  }, []), Bt = H(async (n, r) => {
    const k = r ? `${n.dir}/${r}` : n.dir, P = await t.exec(r ? gn(k) : `${hi()} ${$(k)}`, { timeout: 15e3 });
    P.success || d(`Could not show ${k}: ${P.stderr.trim()}`);
  }, [t]), pa = H((n, r) => {
    const k = `${n.dir}/${r}`;
    /\.(md|json|txt|ya?ml)$/i.test(r) ? t.openFile(k) : Ae(k);
  }, [t, Ae]), Tt = H(async (n) => {
    zn(!0);
    try {
      const r = await n;
      d(gs(r));
      const k = s?.tools.flowLog;
      if (h && k)
        for (const P of r.placed) {
          if (!P.archived) continue;
          const D = P.file, K = [...st(h)].reverse().find((V) => !V.inferred && V.files.includes(D));
          K && await t.exec(`python3 ${$(k)} update ${$(h.dir)} ${$(K.id)} --move-file ${$(`${D}=${P.archived}`)}`, { timeout: 15e3 });
        }
    } catch (r) {
      d(`Could not add the files: ${r instanceof Error ? r.message : String(r)}`);
    }
    zn(!1), Q();
  }, [Q, s, h, t]), Mt = H(async (n) => {
    if (!h) return !0;
    const r = await ut(t, n);
    return r === null ? !1 : (r.length && await Tt(ms(t, h.dir, n, r)), !0);
  }, [h, t, Tt]), ua = H((n) => {
    if (!h) return;
    const r = { image: [], mesh: [], view: [] }, k = [];
    for (const D of n) {
      const K = ps(D.name);
      K ? r[K].push(D) : k.push(D.name);
    }
    const P = (async () => {
      const D = { placed: [], skipped: k.map((K) => ({ file: K, why: "not an image or a 3D file" })) };
      for (const K of ["image", "mesh"]) {
        if (!r[K].length) continue;
        const V = await fs(t, h.dir, K, r[K]);
        D.placed.push(...V.placed), D.skipped.push(...V.skipped);
      }
      return D;
    })();
    Tt(P);
  }, [h, t, Tt]), ni = s?.config.blender_bin ?? "auto", _t = H(async () => {
    Gn(!0);
    try {
      Ji(await ts(t, ni));
    } catch (n) {
      d(`Blender check failed: ${n instanceof Error ? n.message : String(n)}`);
    }
    Gn(!1);
  }, [t, ni]), ii = !!s, cn = !!s && !s.installed && !s.tools.flowLog && s.models.length === 0;
  ke(() => {
    ii && !$t && !cn && _t();
  }, [ii, $t, cn, _t]);
  const ma = H(() => {
    s?.tools.blenderGuide ? t.openFile(s.tools.blenderGuide) : d("The setup guide is in the module: skills/ai3d-kiln/references/blender-setup.md");
  }, [s, t]), Lt = H(async (n, r = {}, k = "") => {
    if (!h || !s) return;
    if (!s.tools.kilnRun || !fe?.bin) {
      yt(!0);
      return;
    }
    const P = h, D = s.tools.flowLog;
    Vn(n), d(null);
    let K = null;
    if ((n === "prep" || n === "flexi") && D) {
      const se = await tt(P), xe = st(P, se), ge = lt(xe, "blender").filter((Se) => Se.verdict !== "rejected" && Se.status !== "error"), We = n === "flexi" && ge.length ? ge[ge.length - 1].id : It(P, se, "blender"), ne = `${n === "prep" ? "Quick prep" : "Flexi (script)"} · try ${lt(xe, "blender").filter((Se) => !Se.inferred).length + 1}`, oe = Object.fromEntries(Object.entries(r).filter(([, Se]) => Se !== "")), Ne = await t.exec([
        `python3 ${$(D)} add ${$(P.dir)} --step blender --agent kiln_run --label ${$(ne)} --status running`,
        We ? `--parent ${$(We)}` : "",
        k ? `--description ${$(k)}` : "",
        `--settings-json ${$(JSON.stringify(oe))}`
      ].filter(Boolean).join(" "), { timeout: 15e3 });
      try {
        K = Ne.success ? JSON.parse(Ne.stdout.trim().split(`
`).pop() ?? "").id : null;
      } catch {
        K = null;
      }
      Q();
    }
    const V = await is(t, fe.bin, s.tools.kilnRun, n, P.dir, r);
    if (K && D) {
      const se = (V.files ?? []).join(",");
      await t.exec([
        `python3 ${$(D)} update ${$(P.dir)} ${$(K)} --status ${V.crashed ? "error" : "done"}`,
        !V.ok && !V.crashed ? "--verdict rejected" : "",
        `--outcome ${$(xn(V))}`,
        se ? `--files ${$(se)}` : ""
      ].filter(Boolean).join(" "), { timeout: 15e3 });
    }
    if (D && typeof V.archived == "string" && V.archived) {
      const se = [...st(P, await tt(P))].reverse().find((xe) => !xe.inferred && xe.id !== K && xe.files.includes("mesh/print.stl"));
      se && await t.exec(`python3 ${$(D)} update ${$(P.dir)} ${$(se.id)} --move-file ${$(`mesh/print.stl=${V.archived}`)}`, { timeout: 15e3 });
    }
    Zi((se) => ({ ...se, [P.slug]: V }));
    const le = Array.isArray(V.archived) ? V.archived.join(", ") : V.archived;
    d(`${n}: ${xn(V)}${le ? ` Previous file kept as ${le}.` : ""}`), Vn(null), Q();
  }, [h, s, fe, t, Q, tt]), hn = H(async (n) => {
    const r = await as(t, fe?.bin ?? null, n && h ? `${h.dir}/${n}` : "");
    r.success ? d(n ? `Opening ${n} in Blender…` : "Opening Blender…") : d(`Could not open Blender: ${r.stderr.trim()}`);
  }, [t, fe, h]), Fe = H((n) => s && n.startsWith(s.workspace) ? n.slice(s.workspace.length + 1) || "." : n, [s]), xt = (n, r) => ({ kind: "agent", label: n, skill: "ai3d-scout", trigger: r }), Ve = H(async (n) => {
    if (!s?.tools.trendLib)
      return d("trend_lib.py was not found: update the AI3D Forge module."), null;
    const r = await t.exec(`python3 ${$(s.tools.trendLib)} ${n}`, { timeout: 2e4 });
    if (!r.success)
      return d(`Could not save: ${r.stderr.trim().split(`
`).pop()}`), null;
    Q();
    try {
      return JSON.parse(r.stdout.trim().split(`
`).pop() ?? "null");
    } catch {
      return null;
    }
  }, [s, t, Q]), fa = H((n, r, k) => {
    if (!s) return;
    if (n === "trend" || n === "similar" || n === "season") {
      I(n), y(k ?? "");
      return;
    }
    if (n === "watch") {
      J(xt("Re-check watched trends", "*watch"), null, `Trends folder: \`${Fe(s.trendsRoot)}\`.`);
      return;
    }
    if (!r) return;
    const P = `Trend: \`${Fe(r._dir)}/trend.json\` (${r.title}).`;
    n === "score" && J({ kind: "agent", label: `Score ideas: ${r.title}`, skill: "ai3d-prism", trigger: "*score" }, null, `trend ${r.slug}. ${P}`), n === "refresh" && J(
      xt(`Refresh: ${r.title}`, r.kind === "similar" ? "*similar" : r.kind === "season" ? "*season" : "*trend"),
      null,
      `Refresh the existing trend ${r.slug}: add new dated signals (keep the old ones), update summary and ideas. ${P}`
    );
  }, [s, J, Fe]), ga = H(async (n, r) => {
    if (!s) return;
    const k = await Ve(`new insight ${$(s.ideasRoot)} --title ${$(r.name)} --subject-kind other --trend ${$(n.slug)} --idea ${$(r.id)} --trends-dir ${$(s.trendsRoot)}`);
    k?.slug && (pe(k.slug), c("insights"), d(`“${r.name}” is in Insights now. Prepare runs Muse.`));
  }, [s, Ve]), Et = H((n) => s?.tools.trendLib ? `After the model folder exists, link it: \`python3 ${s.tools.trendLib} link <model dir> ${n} --trends-dir ${s.trendsRoot} --insights-dir ${s.ideasRoot}\`.` : "", [s]), ba = H((n, r) => {
    s && J(
      { kind: "agent", label: `New model: ${r.name}`, skill: "ai3d-muse", trigger: "*concept" },
      null,
      `Idea \`${r.id}\` (${r.name}${r.pitch ? `: ${r.pitch}` : ""}${r.model_type ? `, ${r.model_type}` : ""}) from trend \`${Fe(n._dir)}/trend.json\`. ${Et(`--trend ${n.slug} --idea ${r.id}`)}`
    );
  }, [s, J, Fe, Et]), wa = H((n, r, k) => {
    const P = `Insight: \`${Fe(r._dir)}/insight.json\` (${r.title}).`, D = s?.tools.trendLib ? ` Save every reference with \`python3 ${s.tools.trendLib} ref ${r._dir} --url <URL> --title <what it is> --note <why it helps>\` (a picture URL is downloaded into refs/).` : "";
    n === "refs" && J(
      { kind: "agent", label: `References: ${r.title}`, skill: "ai3d-muse", trigger: "*refs" },
      null,
      `${r.slug}. ${P} Search the web for pages and pictures: the real subject from several sides, the target style, and existing printed models.${k ? ` Look especially for: ${k}.` : ""}${D}`
    ), n === "prepare" && J(
      { kind: "agent", label: `Prepare: ${r.title}`, skill: "ai3d-muse", trigger: "*prepare" },
      null,
      `${r.slug}. ${P} Find the references on the web (links and pictures), do not write them from memory.${D}`
    ), n === "score" && J({ kind: "agent", label: `Score: ${r.title}`, skill: "ai3d-prism", trigger: "*score" }, null, `insight ${r.slug}. ${P}`), n === "concept" && J(
      { kind: "agent", label: `New model: ${r.title}`, skill: "ai3d-muse", trigger: "*concept" },
      null,
      `${r.status === "draft" ? `From the idea ${r.slug}, which is not prepared yet: work from its description and whatever references it has, and say what you had to assume.` : `From the prepared insight ${r.slug}: use its brief.md and chosen variant.`} ${P} ${Et(`--insight ${r.slug}`)}`
    );
  }, [J, Fe, Et, s]), va = H(async (n, r, k, P) => {
    if (!s) return;
    const D = await Ve(`new insight ${$(s.ideasRoot)} --title ${$(n)} --subject-kind ${$(r)} --description ${$(k)}`);
    D?.slug && (pe(D.slug), P && J(
      { kind: "agent", label: `Prepare: ${n}`, skill: "ai3d-muse", trigger: "*prepare" },
      null,
      `${D.slug}. Insight: \`${Fe(D.dir)}/insight.json\` (${n}).`
    ));
  }, [s, Ve, J, Fe]), ya = H(async () => {
    const n = await ut(t, "image");
    if (n === null) {
      d("The file dialog is not available here: paste a link, a path or a name.");
      return;
    }
    n.length && y((r) => [r.trim(), ...n].filter(Boolean).join(" "));
  }, [t]), ka = () => {
    const n = _.trim();
    if (!n) return;
    M === "new" && J({ kind: "agent", label: "New model", skill: "ai3d-muse", trigger: "*concept" }, null, n), M === "score" && J({ kind: "agent", label: `Score ideas: ${n}`, skill: "ai3d-prism", trigger: "*score" }, null, n), M === "blender" && J({ kind: "agent", label: `Blender: ${n.slice(0, 40)}`, skill: "ai3d-kiln", trigger: "*run" }, ce.find((k) => k.id === "blender") ?? null, n);
    const r = s ? `Trends folder: \`${Fe(s.trendsRoot)}\`.` : "";
    M === "trend" && J(xt(`Trend: ${n.slice(0, 40)}`, "*trend"), null, `${n}. ${r}`), M === "similar" && J(xt(`Similar: ${n.slice(0, 40)}`, "*similar"), null, `${n}. ${r}`), M === "season" && J(xt(`Season: ${n.slice(0, 40)}`, "*season"), null, `${n}. ${r}`), M === "scout" && J({ kind: "agent", label: `Scout: ${n}`, skill: "ai3d-scout", trigger: "*scout" }, null, n), I(null), y("");
  }, Ft = aa[f] ?? [], Re = Ft.find((n) => n.at === E) ?? Ft[0] ?? null, pn = t.components?.SessionTranscript, Na = (n) => {
    const r = n.primary;
    if (!r) return /* @__PURE__ */ e("p", { className: "a3d-done-line", children: "Step complete." });
    if (n.state === "locked") {
      const k = ce.find((P) => P.state === "active" || P.state === "waiting");
      return /* @__PURE__ */ i("p", { className: "a3d-muted", children: [
        "Finish step ",
        k?.n,
        " (",
        k?.title,
        ") first."
      ] });
    }
    return r.kind === "human" ? /* @__PURE__ */ i("div", { className: "a3d-your-turn", children: [
      /* @__PURE__ */ e("strong", { children: "Your turn" }),
      /* @__PURE__ */ e("span", { children: r.label }),
      /* @__PURE__ */ i("span", { className: "a3d-row", children: [
        r.copy && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-primary", onClick: async () => {
          await navigator.clipboard.writeText(r.copy), d("Copied to clipboard.");
        }, children: r.copyLabel ?? "Copy" }),
        r.folder === "print" && h && /* @__PURE__ */ i(ee, { children: [
          /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-primary", onClick: () => N(!0), children: "Log a test print…" }),
          /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => {
            J({ kind: "form", label: "Skip", form: "print-skip" }, n);
          }, children: "Skip" })
        ] }),
        r.folder && h && (r.folder === "inbox" || r.folder === "mesh" || r.folder === "inbox/views") && /* @__PURE__ */ e(
          "button",
          {
            type: "button",
            className: "a3d-btn a3d-btn-primary",
            disabled: Wn,
            onClick: async () => {
              await Mt(r.folder === "inbox" ? "image" : r.folder === "inbox/views" ? "view" : "mesh") || (c("files"), d("Use “Add…” here, or drop the file onto this page."));
            },
            children: r.folder === "inbox" ? "Add image…" : r.folder === "inbox/views" ? "Add views…" : "Add 3D model…"
          }
        ),
        r.folder && h && r.folder !== "print" && /* @__PURE__ */ i("button", { type: "button", className: "a3d-btn", onClick: async () => {
          await t.exec(`mkdir -p ${$(`${h.dir}/${r.folder}`)}`, { timeout: 1e4 }), Ae(`${h.dir}/${r.folder}`);
        }, children: [
          "Open ",
          r.folder,
          "/ folder"
        ] })
      ] })
    ] }) : /* @__PURE__ */ i("span", { className: "a3d-row", children: [
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-primary a3d-btn-large", disabled: _e, onClick: () => J(r, n), title: Pn(r, s, h), children: r.kind === "agent" ? `Run: ${r.label}` : r.label }),
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
  }, $a = (n, r) => {
    const k = (D) => t.openFile(D), P = (D, K, V) => /* @__PURE__ */ e(ll, { title: D, model: n, folder: K, files: n.files[K].filter(V ?? (() => !0)), onOpen: k, onExternal: Ae });
    switch (r.id) {
      case "concept":
        return /* @__PURE__ */ i(ee, { children: [
          /* @__PURE__ */ e(Ht, { title: "concept.md", text: n.concept, onOpen: () => k(`${n.dir}/concept.md`) }),
          /* @__PURE__ */ e(mt, { host: t, model: n, folder: "refs", title: "References", onZoom: b })
        ] });
      case "image":
        return /* @__PURE__ */ i(ee, { children: [
          /* @__PURE__ */ e(mt, { host: t, model: n, folder: "inbox", title: "Inbox", onZoom: b, empty: "Empty. Generated images go here." }),
          /* @__PURE__ */ e(mt, { host: t, model: n, folder: "images", title: "Accepted", onZoom: b }),
          n.imagePrompt && /* @__PURE__ */ e(Ht, { title: `Latest prompt — ${n.imagePrompt.name}`, text: n.imagePrompt.text, copyLabel: "Copy prompt", onOpen: () => k(`${n.dir}/prompts/${n.imagePrompt.name}`) }),
          P("Prompt history", "prompts", (D) => /^image-v\d+\.md$|^prompt-log\.md$/.test(D.name)),
          [["images/views", "Views for multi-view 3D", n.views ?? []], ["inbox/views", "Views waiting for review", n.viewsInbox ?? []]].map(([D, K, V]) => ue([...V]).length > 0 && /* @__PURE__ */ i("section", { className: "a3d-block", children: [
            /* @__PURE__ */ i("h4", { children: [
              K,
              " ",
              /* @__PURE__ */ e("span", { className: "a3d-count", children: ue([...V]).length })
            ] }),
            /* @__PURE__ */ e("div", { className: "a3d-gallery", children: ue([...V]).map((le) => {
              const se = `${n.dir}/${D}/${le.name}`;
              return /* @__PURE__ */ i("figure", { children: [
                /* @__PURE__ */ e(Oe, { host: t, path: se, mtime: le.mtime, alt: le.name, onClick: () => b({ path: se, mtime: le.mtime, name: `${D}/${le.name}` }) }),
                /* @__PURE__ */ e("figcaption", { children: le.name })
              ] }, le.name);
            }) })
          ] }, D)),
          n.viewsPrompt && /* @__PURE__ */ e(Ht, { title: `View prompts — ${n.viewsPrompt.name}`, text: n.viewsPrompt.text, copyLabel: "Copy view prompts", onOpen: () => k(`${n.dir}/prompts/${n.viewsPrompt.name}`) })
        ] });
      case "mesh":
        return /* @__PURE__ */ i(ee, { children: [
          /* @__PURE__ */ e(Ht, { title: "3D spec — 3d-prompt.md", text: n.prompt3d, copyLabel: "Copy spec", onOpen: () => k(`${n.dir}/prompts/3d-prompt.md`) }),
          P("Mesh files", "mesh"),
          /* @__PURE__ */ e(mt, { host: t, model: n, folder: "images", title: "Source image", onZoom: b }),
          ue(n.views ?? []).length > 0 && /* @__PURE__ */ i("p", { className: "a3d-muted", children: [
            ue(n.views ?? []).length,
            " views in images/views/: Chisel writes a multi-view spec (Tripo3D: front, left, back, right; Meshy: up to 4, front first)."
          ] })
        ] });
      case "blender":
        return /* @__PURE__ */ i(ee, { children: [
          /* @__PURE__ */ e(mt, { host: t, model: n, folder: "renders", title: "Renders", onZoom: b, empty: "No renders yet. Kiln saves them here." }),
          n.files.mesh.some((D) => /\.stl$/i.test(D.name)) && /* @__PURE__ */ i("section", { className: "a3d-block", children: [
            /* @__PURE__ */ e("h4", { children: "Interactive view" }),
            /* @__PURE__ */ i("p", { className: "a3d-muted", children: [
              "Orbit the model, shade overhangs in red, cut it at any height and check the bed fit.",
              n.view ? n.view.stale ? " The view is older than the model files: rebuild it." : " The view is up to date." : " Not built yet."
            ] }),
            /* @__PURE__ */ e("p", { className: "a3d-row", children: /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-primary", disabled: !s?.tools.buildViewer, onClick: () => J({ kind: "script", label: "3D view", script: "view" }, null), children: n.view ? "Rebuild and open" : "Build and open" }) })
          ] }),
          /* @__PURE__ */ e(
            cs,
            {
              model: n,
              status: fe,
              kilnRun: s?.tools.kilnRun ?? null,
              busy: qi,
              last: Yi[n.slug] ?? null,
              onRun: (D) => {
                Lt(D);
              },
              onPrep: () => kt("prep"),
              onFlexi: () => kt("flexi"),
              onOpen: (D) => {
                hn(D);
              },
              onCommand: () => {
                I("blender"), y("");
              },
              onSetup: () => yt(!0)
            }
          ),
          /* @__PURE__ */ e(_i, { model: n }),
          P("Mesh files", "mesh"),
          P("Logs", "print", (D) => /kiln-log|analysis/.test(D.name))
        ] });
      case "print":
        return /* @__PURE__ */ i(ee, { children: [
          n.printPhotos.length > 0 && /* @__PURE__ */ i("section", { className: "a3d-block", children: [
            /* @__PURE__ */ i("h4", { children: [
              "Photos ",
              /* @__PURE__ */ e("span", { className: "a3d-count", children: n.printPhotos.length })
            ] }),
            /* @__PURE__ */ e("div", { className: "a3d-gallery", children: ue(n.printPhotos).map((D) => {
              const K = `${n.dir}/print/photos/${D.name}`;
              return /* @__PURE__ */ i("figure", { children: [
                /* @__PURE__ */ e(Oe, { host: t, path: K, mtime: D.mtime, alt: D.name, onClick: () => b({ path: K, mtime: D.mtime, name: D.name }) }),
                /* @__PURE__ */ e("figcaption", { children: D.name })
              ] }, D.name);
            }) })
          ] }),
          n.printLog.length > 0 ? /* @__PURE__ */ i("section", { className: "a3d-block", children: [
            /* @__PURE__ */ i("h4", { children: [
              "Test prints ",
              /* @__PURE__ */ i("span", { className: "a3d-block-actions", children: [
                /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => N(!0), children: "Log another…" }),
                /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => k(`${n.dir}/print/print-log.md`), children: "Open log" })
              ] })
            ] }),
            /* @__PURE__ */ i("table", { className: "a3d-filetable", children: [
              /* @__PURE__ */ e("thead", { children: /* @__PURE__ */ i("tr", { children: [
                /* @__PURE__ */ e("th", { children: "Date" }),
                /* @__PURE__ */ e("th", { children: "Result" }),
                /* @__PURE__ */ e("th", { children: "Printer · filament" }),
                /* @__PURE__ */ e("th", { children: "Change next time" })
              ] }) }),
              /* @__PURE__ */ e("tbody", { children: [...n.printLog].reverse().map((D, K) => /* @__PURE__ */ i("tr", { children: [
                /* @__PURE__ */ e("td", { className: "a3d-num", children: D.at.slice(0, 10) }),
                /* @__PURE__ */ e("td", { children: D.skipped ? /* @__PURE__ */ e("span", { className: "a3d-pill", children: "skipped" }) : /* @__PURE__ */ e("span", { className: `a3d-pill a3d-pr-${D.result}`, children: D.result }) }),
                /* @__PURE__ */ i("td", { children: [
                  [D.printer, D.filament].filter(Boolean).join(" · "),
                  D.settings && /* @__PURE__ */ e("div", { className: "a3d-muted", children: D.settings })
                ] }),
                /* @__PURE__ */ e("td", { children: D.change ?? D.reason })
              ] }, K)) })
            ] })
          ] }) : /* @__PURE__ */ e("p", { className: "a3d-muted", children: "No test print logged yet." }),
          P("3D files", "mesh", (D) => /\.stl$/i.test(D.name))
        ] });
      case "validate":
        return /* @__PURE__ */ i(ee, { children: [
          /* @__PURE__ */ e(_i, { model: n }),
          P("Validation and slicing", "print")
        ] });
      default:
        return /* @__PURE__ */ i(ee, { children: [
          n.hasReadme && /* @__PURE__ */ i("section", { className: "a3d-block", children: [
            /* @__PURE__ */ e("h4", { children: "README" }),
            /* @__PURE__ */ i("p", { className: "a3d-row", children: [
              /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => k(`${n.dir}/README.md`), children: "Open README.md" }),
              /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => s && k(`${s.root}/README.md`), children: "Open catalog" })
            ] })
          ] }),
          /* @__PURE__ */ e(mt, { host: t, model: n, folder: "renders", title: "Images used in the README", onZoom: b }),
          P("Listings", "publish")
        ] });
    }
  }, Ot = h?.files.mesh.find((n) => n.name === "print.stl") ?? h?.files.mesh.find((n) => n.name === "clean.stl"), Ca = [
    { id: "view", title: "Build 3D view of the selected model", hint: h?.slug, disabled: Ot ? s?.tools.buildViewer ? !1 : "Prism not installed" : "needs an STL", run: () => {
      J({ kind: "script", label: "3D view", script: "view" }, null);
    } },
    { id: "views-all", title: "Rebuild every 3D view", disabled: s?.tools.buildViewer ? !1 : "Prism not installed", run: () => {
      J({ kind: "script", label: "All views", script: "views-all" }, null);
    } },
    { id: "portfolio", title: "Build the portfolio dashboard", disabled: s?.tools.buildInsights ? !1 : "Prism not installed", run: () => {
      J({ kind: "script", label: "Portfolio", script: "portfolio" }, null);
    } },
    { id: "new", title: "New model…", hint: "agent run", run: () => Nt({ pictures: [] }) },
    { id: "readme", title: "Rebuild README and catalog (no agent)", hint: h?.slug, disabled: h ? s?.tools.buildReadme ? !1 : "script not found" : "select a model", run: () => {
      J({ kind: "script", label: "README", script: "readme" }, null);
    } },
    { id: "attempt", title: "New attempt on the current step…", hint: G ? G.title : void 0, disabled: !h || !G ? "select a model" : s?.tools.flowLog ? !1 : "flow_log.py not found", run: () => {
      G && (c("flow"), nt(G.id));
    } },
    { id: "graph", title: "Show the flow graph", run: () => {
      c("flow"), q("graph");
    } },
    { id: "branch", title: "New branch… (another image, link, mesh or settings)", hint: h?.slug, disabled: h ? s?.tools.flowLog ? !1 : "flow_log.py not found" : "select a model", run: () => {
      c("flow"), Ge({ from: null });
    } },
    { id: "run-cmd", title: "Run a command on the current step…", hint: G?.title, disabled: !h || !G ? "select a model" : !1, run: () => {
      G && (c("flow"), Qe({ step: G.id, action: null }));
    } },
    { id: "tips", title: "Tips for the current step", hint: G?.title, run: () => {
      c("flow"), Dt(!0);
    } },
    { id: "help", title: "Help: status, next move, what each button runs", run: () => c("help") },
    { id: "help-status", title: "Status of all models (no agent)", disabled: s?.tools.helpStatus ? !1 : "ai3d-help not installed", run: () => {
      c("help"), ei();
    } },
    { id: "help-next", title: "Ask Compass: what next? (agent)", run: () => Qn("*next", h?.slug) },
    ...h && h.branches.length > 1 ? h.branches.map((n) => ({ id: `b-${n.id}`, title: `Switch to branch: ${n.name}`, hint: n.primary ? "primary" : n.status, run: () => {
      Me(n.id), c("flow");
    } })) : [],
    { id: "add-image", title: "Add image to the selected model…", hint: h?.slug, disabled: h ? !1 : "select a model", run: () => {
      c("files"), Mt("image");
    } },
    { id: "add-mesh", title: "Add 3D model to the selected model…", hint: h?.slug, disabled: h ? !1 : "select a model", run: () => {
      c("files"), Mt("mesh");
    } },
    { id: "reveal", title: "Show the model folder in Finder", hint: h?.slug, disabled: h ? !1 : "select a model", run: () => h && void Bt(h, "") },
    { id: "bl-status", title: "Blender: status and setup", hint: fe?.version ?? void 0, run: () => {
      yt(!0), _t();
    } },
    { id: "bl-analyze", title: "Blender: analyze the mesh (no agent)", hint: h?.slug, disabled: h ? fe?.bin ? !1 : "Blender not found" : "select a model", run: () => {
      c("flow"), v("blender"), Lt("analyze");
    } },
    { id: "bl-prep", title: "Blender: quick prep… (no agent)", hint: h?.slug, disabled: h ? fe?.bin ? !1 : "Blender not found" : "select a model", run: () => {
      c("flow"), v("blender"), kt("prep");
    } },
    { id: "bl-render", title: "Blender: render previews (no agent)", hint: h?.slug, disabled: h ? fe?.bin ? !1 : "Blender not found" : "select a model", run: () => {
      c("flow"), v("blender"), Lt("render");
    } },
    { id: "bl-command", title: "Blender command… (Kiln agent)", hint: h?.slug, disabled: h ? !1 : "select a model", run: () => {
      I("blender"), y("");
    } },
    { id: "bl-open", title: "Open the model in Blender", hint: h?.slug, disabled: h ? fe?.bin ? !1 : "Blender not found" : "select a model", run: () => {
      const n = h?.files.mesh.find((r) => r.name === "work.blend") ?? h?.files.mesh.find((r) => r.name === "print.stl") ?? h?.files.mesh.find((r) => /^raw\./.test(r.name));
      hn(n ? `mesh/${n.name}` : null);
    } },
    { id: "tr-trend", title: "Analyse a trend…", hint: "Scout", run: () => {
      c("trends"), I("trend"), y("");
    } },
    { id: "tr-similar", title: "Similar model (photo, link or name)…", hint: "Scout", run: () => {
      c("trends"), I("similar"), y("");
    } },
    { id: "tr-season", title: "Season or event…", hint: "Scout", run: () => {
      c("trends"), I("season"), y("");
    } },
    { id: "in-new", title: "New idea… (Insights)", run: () => c("insights") },
    { id: "tab-trends", title: "Go to Trends", run: () => c("trends") },
    { id: "tab-insights", title: "Go to Insights", run: () => c("insights") },
    { id: "print-log", title: "Log a test print…", hint: h?.slug, disabled: h ? s?.tools.printLog ? !1 : "print_log.py not found" : "select a model", run: () => N(!0) },
    { id: "archived", title: Ce ? "Hide archived branches" : "Show archived branches", run: () => Xe((n) => !n) },
    { id: "notify", title: te ? "Turn notifications off" : "Turn notifications on", run: sa },
    { id: "keys", title: "Keyboard shortcuts", run: () => d("Shortcuts: 1–7 tabs · Alt+↑/↓ previous / next model · in Flow: G graph or steps, N new attempt, B new branch, C run command on the step, T tips, A / R accept or reject the selected attempt · Cmd/Ctrl+K commands.") },
    { id: "tab-models", title: "Go to Models", run: () => c("models") },
    { id: "tab-files", title: "Go to Files", run: () => c("files") },
    { id: "tab-flow", title: "Go to Flow", run: () => c("flow") },
    { id: "tab-settings", title: "Go to Settings", run: () => c("settings") },
    { id: "folder", title: "Open the models folder", disabled: s ? !1 : "still reading", run: () => s && void Ae(s.root) },
    ...ve.map((n) => ({ id: `m-${n.slug}`, title: `Open model: ${n.meta.title || n.slug}`, hint: n.meta.status, run: () => Ie(n.slug, "flow") }))
  ];
  return ke(() => {
    const n = (r) => {
      if (O || M || X || rt || jt || nn || F || Ee || ot || an) return;
      const k = r.target;
      if (k && (k.tagName === "INPUT" || k.tagName === "TEXTAREA" || k.tagName === "SELECT" || k.isContentEditable)) return;
      if (r.altKey && (r.key === "ArrowDown" || r.key === "ArrowUp") && ve.length) {
        r.preventDefault();
        const K = Math.max(0, ve.findIndex((le) => le.slug === m)), V = ve[(K + (r.key === "ArrowDown" ? 1 : ve.length - 1)) % ve.length];
        Ie(V.slug);
        return;
      }
      if (r.metaKey || r.ctrlKey || r.altKey) return;
      const P = r.key.toLowerCase(), D = ["models", "flow", "files", "trends", "insights", "help", "settings"];
      if (/^[1-7]$/.test(P)) {
        c(D[Number(P) - 1]);
        return;
      }
      if (!(L !== "flow" || !h)) {
        if (P === "g") q((K) => K === "graph" ? "steps" : "graph");
        else if (P === "n" && G && s?.tools.flowLog && ft[G.id]?.length) nt(G.id);
        else if (P === "b" && s?.tools.flowLog) Ge({ from: ie ? h.flow.nodes.find((K) => K.id === ie) ?? null : null });
        else if (P === "c" && G && G.state !== "locked") Qe({ step: G.id, action: null });
        else if (P === "t") Dt((K) => !K);
        else if ((P === "a" || P === "r") && ie) {
          const K = h.flow.nodes.find((V) => V.id === ie);
          K && !K.inferred && on(K, P === "a" ? "accepted" : "rejected");
        }
      }
    };
    return window.addEventListener("keydown", n), () => window.removeEventListener("keydown", n);
  }, [O, M, X, rt, jt, nn, F, Ee, ot, ve, m, Ie, L, h, G, s, nt, ie, on]), $t || cn ? /* @__PURE__ */ e("div", { className: "a3d", "data-a3d-theme": /dark/i.test(String(a)) ? "dark" : "light", children: /* @__PURE__ */ i("div", { className: "a3d-idle", children: [
    /* @__PURE__ */ e("h1", { children: "AI3D Forge" }),
    $t ? /* @__PURE__ */ i(ee, { children: [
      /* @__PURE__ */ e("p", { children: "Turned off in this project. Nothing is scanned or run here." }),
      /* @__PURE__ */ e("span", { className: "a3d-row", children: /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-primary", onClick: () => {
        At(!1), Q();
      }, children: "Turn on in this project" }) })
    ] }) : /* @__PURE__ */ i(ee, { children: [
      /* @__PURE__ */ e("p", { children: "This project has no AI3D Forge module, so the panel is idle here: no agents, no Blender check, one look a minute to see if the module appeared." }),
      /* @__PURE__ */ i("p", { className: "a3d-muted", children: [
        "To use it here, install the module from the project root: ",
        /* @__PURE__ */ e("code", { children: "bash <ai3d>/scripts/update.sh" }),
        " (a project with BMAD) — see the module README for a new project."
      ] }),
      /* @__PURE__ */ i("span", { className: "a3d-row", children: [
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => {
          Q();
        }, children: "Check again" }),
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => At(!0), title: "Stops even the once-a-minute look in this project", children: "Turn off in this project" })
      ] })
    ] }),
    /* @__PURE__ */ e("p", { className: "a3d-muted a3d-small", children: "The switch is kept per project. To remove the icon from every project, disable the extension in Nimbalyst’s extension settings." })
  ] }) }) : /* @__PURE__ */ i("div", { className: "a3d", "data-a3d-theme": /dark/i.test(String(a)) ? "dark" : "light", children: [
    /* @__PURE__ */ i("main", { className: "a3d-main", children: [
      /* @__PURE__ */ i("div", { className: "a3d-tabs", role: "tablist", children: [
        [["models", "Models"], ["flow", "Flow"], ["files", "Files"], ["trends", "Trends"], ["insights", "Insights"], ["help", "Help"], ["settings", "Settings"]].map(([n, r]) => /* @__PURE__ */ e("button", { type: "button", role: "tab", "aria-selected": L === n, className: "a3d-tab", onClick: () => c(n), children: r }, n)),
        /* @__PURE__ */ e("span", { className: "a3d-tabs-spacer" }),
        ve.length > 0 && /* @__PURE__ */ i("label", { className: "a3d-switch", children: [
          /* @__PURE__ */ e("span", { className: "a3d-muted", children: "Model" }),
          /* @__PURE__ */ e("select", { "aria-label": "Selected model", value: m ?? "", onChange: (n) => Ie(n.target.value), children: ve.map((n) => /* @__PURE__ */ e("option", { value: n.slug, children: n.meta.title || n.slug }, n.slug)) })
        ] }),
        h && h.branches.length > 1 && /* @__PURE__ */ i("label", { className: "a3d-switch", children: [
          /* @__PURE__ */ e("span", { className: "a3d-muted", children: "Branch" }),
          /* @__PURE__ */ e("select", { "aria-label": "Selected branch", value: h.branch, onChange: (n) => Me(n.target.value), children: h.branches.map((n) => /* @__PURE__ */ e("option", { value: n.id, children: za(n) }, n.id)) })
        ] }),
        Pt.length > 0 && /* @__PURE__ */ i("details", { className: "a3d-running", children: [
          /* @__PURE__ */ e("summary", { children: /* @__PURE__ */ i("span", { className: "a3d-tag a3d-tag-run", children: [
            Pt.length,
            " running"
          ] }) }),
          /* @__PURE__ */ e("ul", { children: Pt.map(({ key: n, run: r }) => /* @__PURE__ */ i("li", { children: [
            /* @__PURE__ */ i("span", { children: [
              r.label,
              n !== St ? ` · ${n}` : "",
              " ",
              /* @__PURE__ */ i("span", { className: "a3d-muted", children: [
                "since ",
                xi(r.at),
                r.model ? ` · ${un(r.model)}` : ""
              ] })
            ] }),
            /* @__PURE__ */ i("span", { className: "a3d-row", children: [
              /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: () => {
                S(n), B(r.at);
              }, children: "show session" }),
              /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", title: "Stop waiting for this run in the panel. The session itself keeps going in Nimbalyst.", onClick: () => Ws(r.at), children: "forget" })
            ] })
          ] }, r.at)) })
        ] }),
        /* @__PURE__ */ e(ls, { status: fe, checking: Kn, onClick: () => {
          yt(!0), _t();
        } }),
        /* @__PURE__ */ i("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => T(!0), title: "Run a command", children: [
          "Commands ",
          /* @__PURE__ */ i("kbd", { children: [
            /Mac/i.test(navigator.platform) ? "⌘" : "Ctrl",
            "K"
          ] })
        ] })
      ] }),
      g && /* @__PURE__ */ e("div", { className: "a3d-banner a3d-banner-error", children: g }),
      s && !s.installed && !s.tools.kilnLib && /* @__PURE__ */ i("div", { className: "a3d-banner", children: [
        "The AI3D Forge module was not found in this workspace. Install it so the agents exist: see the module README.",
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: () => At(!0), children: "Turn off in this project" })
      ] }),
      s && Hi(s) && (() => {
        const n = Vi(s), r = In(s);
        return /* @__PURE__ */ i("div", { className: "a3d-banner a3d-banner-warn", children: [
          /* @__PURE__ */ i("span", { children: [
            "The AI3D skills in this project are ",
            s.module?.version ?? "older",
            "; this panel is built for ",
            tn,
            ".",
            r.length ? ` Not available until you update: ${r.join(", ")}.` : "",
            n ? /* @__PURE__ */ i(ee, { children: [
              " Run in a terminal: ",
              /* @__PURE__ */ e("code", { children: n })
            ] }) : /* @__PURE__ */ i(ee, { children: [
              " Unpack the new module and run ",
              /* @__PURE__ */ e("code", { children: "bash <ai3d>/scripts/update.sh" }),
              " in the project root."
            ] })
          ] }),
          /* @__PURE__ */ i("span", { className: "a3d-row", children: [
            n && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: async () => {
              await navigator.clipboard.writeText(n), d("Update command copied. Paste it into a terminal, then start a new session.");
            }, children: "Copy command" }),
            /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: () => c("help"), children: "Setup check" })
          ] })
        ] });
      })(),
      j && /* @__PURE__ */ i("div", { className: "a3d-banner", role: "status", children: [
        j,
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: () => d(null), children: "Dismiss" })
      ] }),
      L === "models" && (s ? /* @__PURE__ */ e(
        Ds,
        {
          host: t,
          scan: s,
          stepsBySlug: Rt,
          selected: m,
          onSelect: (n) => Ie(n, "flow"),
          onNew: () => Nt({ pictures: [] }),
          onScout: () => c("trends"),
          onSelectTrend: (n) => {
            W(n), c("trends");
          },
          onPortfolio: () => {
            J({ kind: "script", label: "Portfolio", script: "portfolio" }, null);
          }
        }
      ) : /* @__PURE__ */ e("div", { className: "a3d-placeholder", children: g ? "" : "Reading models…" })),
      L === "files" && s && /* @__PURE__ */ e(
        bs,
        {
          host: t,
          scan: s,
          model: h,
          nodeFilter: Be,
          importing: Wn,
          onClearFilter: () => be(null),
          onSelectModel: (n) => Ie(n),
          onZoom: b,
          onOpen: pa,
          onReveal: Bt,
          onView: () => {
            J({ kind: "script", label: "3D view", script: "view" }, null);
          },
          onPick: Mt,
          onFiles: ua,
          onConcept: (n) => Nt({ pictures: [n] })
        }
      ),
      L === "trends" && s && /* @__PURE__ */ e(
        Rs,
        {
          host: t,
          scan: s,
          busy: _e,
          selected: R,
          onSelectTrend: W,
          apify: fe ? (fe.servers ?? []).find((n) => n.forSessions && n.name.toLowerCase().includes((s.config.scrape_mcp || "apify").toLowerCase()))?.where ?? null : void 0,
          onAgent: fa,
          onSet: (n, r) => {
            Ve(`set ${$(n._dir)} ${r.map($).join(" ")}`);
          },
          onPrepare: (n, r) => {
            ga(n, r);
          },
          onCreateModel: ba,
          onSelectModel: (n) => Ie(n, "flow"),
          onSelectIdea: (n) => {
            pe(n), c("insights");
          },
          onReveal: (n) => {
            t.exec(gn(n), { timeout: 15e3 });
          },
          onOpen: (n) => {
            t.openFile(n);
          }
        }
      ),
      L === "insights" && s && /* @__PURE__ */ e(
        js,
        {
          host: t,
          scan: s,
          busy: _e,
          selected: de,
          onSelect: pe,
          running: Pt.map((n) => n.run.label),
          onZoom: b,
          onPickImage: () => ut(t, "image"),
          onRef: (n, r) => {
            Ve([`ref ${$(n._dir)}`, r.url ? `--url ${$(r.url)}` : "", r.file ? `--file ${$(r.file)}` : "", r.note ? `--note ${$(r.note)}` : ""].filter(Boolean).join(" ")).then((k) => {
              k && d(k.added === !1 ? "That link is already in the references." : k.reference?.file ? "Reference added; the picture is saved in refs/." : "Link added to the references.");
            });
          },
          onRemoveRef: (n, r) => {
            Ve(`ref ${$(n._dir)} --remove ${r}`);
          },
          onCreate: (...n) => {
            va(...n);
          },
          onAgent: wa,
          onDecide: (n, r) => {
            Ve(`decide ${$(n._dir)} ${r}`);
          },
          onSelectTrend: (n) => {
            W(n), c("trends");
          },
          onSelectModel: (n) => Ie(n, "flow"),
          onReveal: (n) => {
            t.exec(gn(n), { timeout: 15e3 });
          },
          onOpen: (n) => {
            t.openFile(n);
          }
        }
      ),
      L === "help" && s && /* @__PURE__ */ e(
        Ys,
        {
          scan: s,
          model: h,
          blender: fe,
          steps: ce,
          stepsBySlug: Rt,
          tips: ln,
          busy: _e,
          statusText: ea,
          statusBusy: na,
          onStatus: () => {
            ei();
          },
          onAsk: Qn,
          onGo: (n) => {
            c("flow"), q("steps"), v(n);
          },
          onSelectModel: (n) => Ie(n, "flow")
        }
      ),
      L === "settings" && /* @__PURE__ */ i("section", { className: "a3d-settings-wrap", children: [
        /* @__PURE__ */ e("h1", { children: "Settings" }),
        /* @__PURE__ */ i("p", { className: "a3d-muted", children: [
          "Module settings live in ",
          /* @__PURE__ */ e("code", { children: "_bmad/ai3d/config.yaml" }),
          ", so agents, scripts and this panel always agree. The folder override is in Nimbalyst’s extension settings."
        ] }),
        /* @__PURE__ */ e(Oi, { workspace: t.workspacePath, io: sl(t), onSaved: () => {
          Q();
        } }),
        /* @__PURE__ */ i("section", { className: "a3d-block", children: [
          /* @__PURE__ */ e("h4", { children: "This project" }),
          /* @__PURE__ */ e("p", { className: "a3d-muted", children: "Turn the panel off here: it stops scanning, checking Blender and notifying in this project. Other projects are not affected." }),
          /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => At(!0), children: "Turn off in this project" })
        ] })
      ] }),
      L === "flow" && (h ? /* @__PURE__ */ i(ee, { children: [
        /* @__PURE__ */ i("header", { className: "a3d-head", children: [
          /* @__PURE__ */ i("div", { children: [
            /* @__PURE__ */ i("h1", { children: [
              h.meta.title || h.slug,
              h.branches.length > 1 && /* @__PURE__ */ i("span", { className: "a3d-muted", style: { fontWeight: 400 }, children: [
                " · ",
                Ut(h)?.name ?? h.branch,
                h.branch === h.primary ? " ★" : ""
              ] })
            ] }),
            /* @__PURE__ */ e("p", { className: "a3d-muted", children: [h.meta.model_type, h.meta.status, h.meta.summary || h.meta.subject].filter(Boolean).join(" · ") })
          ] }),
          /* @__PURE__ */ i("span", { className: "a3d-row", children: [
            /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => {
              be(null), c("files");
            }, children: "Files" }),
            /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => Bt(h, ""), children: "Show in Finder" }),
            h.hasReadme && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => t.openFile(`${h.dir}/README.md`), children: "README" }),
            Ot && /* @__PURE__ */ i(
              "button",
              {
                type: "button",
                className: "a3d-btn a3d-btn-primary",
                disabled: !s?.tools.buildViewer,
                onClick: () => J({ kind: "script", label: "3D view", script: "view" }, null),
                title: s?.tools.buildViewer ? "Build the interactive view and open it in your browser" : "Prism scripts not found in this workspace",
                children: [
                  "3D view",
                  h.view?.stale ? " (outdated)" : ""
                ]
              }
            ),
            Ot && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => Ae(`${h.dir}/mesh/${Ot.name}`), children: "Open STL in slicer" })
          ] })
        ] }),
        /* @__PURE__ */ i("div", { className: "a3d-flowbar", children: [
          /* @__PURE__ */ e("p", { className: "a3d-now", children: ct ? /* @__PURE__ */ i(ee, { children: [
            "Now: ",
            /* @__PURE__ */ i("strong", { children: [
              "step ",
              ct.n,
              " of ",
              ce.length,
              ", ",
              ct.title
            ] }),
            " · ",
            ct.state === "waiting" ? "your turn" : ct.state === "done" ? "everything is done" : "next up"
          ] }) : null }),
          (() => {
            const n = h.flow.nodes.filter((k) => k.cost).reduce((k, P) => (k[P.cost.service] = (k[P.cost.service] ?? 0) + P.cost.credits, k), {}), r = h.flow.nodes.length - Bi(h.flow.nodes, !1).length;
            return /* @__PURE__ */ i("span", { className: "a3d-row a3d-flowmeta", children: [
              Object.keys(n).length > 0 && /* @__PURE__ */ i("span", { className: "a3d-muted", title: "Sum of the costs recorded on attempts", children: [
                "Cost: ",
                Object.entries(n).map(([k, P]) => `${Math.round(P * 100) / 100} ${k}`).join(" · ")
              ] }),
              we.length > 0 && /* @__PURE__ */ i("span", { className: "a3d-pill", children: [
                we.length === 1 ? "pick one more to compare" : "comparing 2",
                " ",
                /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: () => Te([]), children: "clear" })
              ] }),
              r > 0 && /* @__PURE__ */ i("label", { className: "a3d-check", children: [
                /* @__PURE__ */ e("input", { type: "checkbox", checked: Ce, onChange: (k) => Xe(k.target.checked) }),
                " show archived (",
                r,
                ")"
              ] })
            ] });
          })(),
          /* @__PURE__ */ i("span", { className: "a3d-seg", role: "group", "aria-label": "Flow view", children: [
            /* @__PURE__ */ e("button", { type: "button", "aria-pressed": U === "graph", onClick: () => q("graph"), children: "Graph" }),
            /* @__PURE__ */ e("button", { type: "button", "aria-pressed": U === "steps", onClick: () => q("steps"), children: "Steps" })
          ] })
        ] }),
        (() => {
          const n = Ut(h);
          return /* @__PURE__ */ i("div", { className: "a3d-branchbar", "aria-label": "Branches", children: [
            h.branches.length > 1 && h.branches.filter((r) => r.status !== "archived" || r.id === h.branch || Ce).map((r) => /* @__PURE__ */ i(
              "button",
              {
                type: "button",
                className: `a3d-branchchip a3d-lane-c${Cn(h, r.id) % 8}`,
                "aria-pressed": r.id === h.branch,
                onClick: () => Me(r.id),
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
                title: `A separate line with its own files: another image, link, mesh or settings, carried to the end. Runs: ${re.branchAdd("flow_log.py", "<model>", { name: "<name>", source: "<kind>:<ref>" })}`,
                children: "+ New branch…"
              }
            ),
            n && h.branches.length > 1 && /* @__PURE__ */ i(ee, { children: [
              /* @__PURE__ */ e("span", { className: "a3d-tabs-spacer" }),
              !n.primary && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => {
                Ct("promote", n.id);
              }, title: `This branch becomes the model's main result. Runs: ${re.branchPromote("flow_log.py", "<model>", n.id)}`, children: "Make primary ★" }),
              !n.primary && n.status !== "variant" && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => {
                Ct("variant", n.id);
              }, title: "Publish this branch as its own variant, next to the primary", children: "Mark as variant" }),
              n.status !== "open" && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => {
                Ct("open", n.id);
              }, children: "Reopen" }),
              !n.primary && n.status !== "archived" && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => {
                Ct("archived", n.id);
              }, title: "Hide the branch; nothing is deleted", children: "Archive branch" }),
              /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => Bt(h, ""), children: "Branch folder" })
            ] })
          ] });
        })(),
        !h.migrated && s?.tools.flowLog && /* @__PURE__ */ i("p", { className: "a3d-muted a3d-small", children: [
          "This model keeps its work files in the model folder. The first new branch moves them into ",
          /* @__PURE__ */ e("code", { children: "branches/main/" }),
          " ",
          "(or ",
          /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: () => {
            Ct("migrate", "main");
          }, title: `Runs: ${re.migrate("flow_log.py", "<model>")}`, children: "move them now" }),
          ")."
        ] }),
        (() => {
          const n = Ut(h);
          return n && n.id !== "main" && (n.source || n.description) ? /* @__PURE__ */ i("p", { className: `a3d-source a3d-lane-c${Cn(h, n.id) % 8}`, children: [
            "Branch ",
            /* @__PURE__ */ e("strong", { children: n.name }),
            n.source ? /* @__PURE__ */ i(ee, { children: [
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
        U === "graph" && /* @__PURE__ */ i(ee, { children: [
          we.length === 2 && (() => {
            const n = h.flow.nodes.find((k) => k.id === we[0]), r = h.flow.nodes.find((k) => k.id === we[1]);
            return n && r ? /* @__PURE__ */ e(
              Xa,
              {
                host: t,
                model: h,
                a: n,
                b: r,
                onClose: () => Te([]),
                onSwap: () => Te(([k, P]) => [P, k]),
                onView3d: (k, P) => {
                  ca(k, P);
                },
                onOpen: (k, P) => ti(k, P)
              }
            ) : null;
          })(),
          /* @__PURE__ */ e(
            Ja,
            {
              model: h,
              steps: ce,
              selectedNode: ie,
              selectedStep: G?.id ?? null,
              compare: we,
              showArchived: Ce,
              onSelectNode: (n) => {
                const r = h.flow.nodes.find((k) => k.id === n);
                r && Pe(r) !== h.branch && Me(Pe(r)), Z(n), r && v(r.step), p(!1);
              },
              onSelectStep: (n) => {
                Z(null), v(n), p(!1);
              },
              onSelectBranch: (n) => Me(n),
              onNew: (n) => nt(n)
            }
          ),
          (() => {
            const n = ie ? h.flow.nodes.find((r) => r.id === ie) : null;
            return n ? /* @__PURE__ */ e(
              qa,
              {
                model: h,
                node: n,
                busy: !s?.tools.flowLog,
                canEdit: !!s?.tools.flowLog,
                inCompare: we.includes(n.id),
                onCompare: da,
                onArchive: (r, k) => {
                  dn(`update ${$(h.dir)} ${$(r.id)} --archived ${k ? "yes" : "no"}`).then(() => {
                    k && !Ce && Z(null);
                  });
                },
                onNote: (r, k) => {
                  dn(`note ${$(h.dir)} ${$(r.id)} ${$(k)}`);
                },
                onCost: (r, k, P) => {
                  dn(`update ${$(h.dir)} ${$(r.id)} --cost ${$(`${k}:${P}`)}`);
                },
                onSelectNode: (r) => {
                  Z(r);
                  const k = h.flow.nodes.find((P) => P.id === r);
                  k && v(k.step);
                },
                onRerun: (r) => nt(r.step, { parent: Fa(r), settings: r.settings, description: "" }),
                onNext: (r) => nt(ce[Ze(r.step) + 1]?.id ?? r.step, { parent: r.id }),
                onBranch: (r) => Ge({ from: r }),
                onVerdict: on,
                onOpen: (r) => ti(r, n),
                onFiles: (r) => {
                  be(r.id), c("files");
                }
              },
              n.id
            ) : null;
          })()
        ] }),
        U === "steps" && /* @__PURE__ */ e("ol", { className: "a3d-flow", children: ce.map((n) => /* @__PURE__ */ e("li", { className: `a3d-step a3d-${n.state}${G?.id === n.id ? " a3d-step-selected" : ""}`, children: /* @__PURE__ */ i("button", { type: "button", onClick: () => {
          v(n.id), p(!1);
        }, children: [
          /* @__PURE__ */ i("span", { className: "a3d-step-top", children: [
            /* @__PURE__ */ e("span", { className: "a3d-step-n", children: n.state === "done" ? "✓" : n.n }),
            /* @__PURE__ */ e("span", { className: "a3d-step-title", children: n.title })
          ] }),
          /* @__PURE__ */ e("span", { className: "a3d-step-thumb", children: n.thumb ? /* @__PURE__ */ e(Oe, { host: t, path: `${h.dir}/${n.thumb}`, mtime: h.stamp, alt: "" }) : /* @__PURE__ */ e("span", { className: "a3d-step-agent", children: n.agent }) }),
          /* @__PURE__ */ e("span", { className: "a3d-step-result", children: n.result }),
          /* @__PURE__ */ e("span", { className: "a3d-step-state", children: n.state === "done" ? "Done" : n.state === "active" ? "Next" : n.state === "waiting" ? "Your turn" : "Locked" })
        ] }) }, n.id)) }),
        G && /* @__PURE__ */ i("section", { className: "a3d-detail", children: [
          /* @__PURE__ */ i("div", { className: "a3d-detail-head", children: [
            /* @__PURE__ */ i("div", { children: [
              /* @__PURE__ */ i("h3", { children: [
                "Step ",
                G.n,
                " · ",
                G.title,
                " ",
                /* @__PURE__ */ i("span", { className: "a3d-muted", children: [
                  "— ",
                  G.agent
                ] })
              ] }),
              /* @__PURE__ */ e("p", { children: G.hint })
            ] }),
            /* @__PURE__ */ i("div", { className: "a3d-detail-actions", children: [
              Na(G),
              G.state !== "locked" && G.id !== "print" && /* @__PURE__ */ e(
                "button",
                {
                  type: "button",
                  className: "a3d-btn",
                  disabled: _e,
                  onClick: () => Qe({ step: G.id, action: G.primary?.kind === "agent" ? G.primary : null }),
                  title: "Pick any command of this step, add your own instruction and see the prompt before it runs",
                  children: "Run command…"
                }
              ),
              /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", "aria-pressed": Un, onClick: () => Dt((n) => !n), title: "How this step runs and how to get better results", children: "Tips" }),
              G.state !== "locked" && s?.tools.flowLog && (ft[G.id]?.length ?? 0) > 0 && /* @__PURE__ */ e(
                "button",
                {
                  type: "button",
                  className: "a3d-btn",
                  disabled: _e,
                  onClick: () => nt(G.id),
                  title: "Run this step again with its own settings and description",
                  children: "New attempt…"
                }
              ),
              G.state !== "locked" && G.more.length > 0 && /* @__PURE__ */ i("div", { className: "a3d-more", children: [
                /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", "aria-expanded": u, onClick: () => p((n) => !n), children: "Other actions" }),
                u && /* @__PURE__ */ e("div", { className: "a3d-menu", children: G.more.map((n) => /* @__PURE__ */ e("button", { type: "button", disabled: _e, title: Pn(n, s, h), onClick: () => J(n, G), children: n.label }, n.label)) })
              ] })
            ] })
          ] }),
          G.state !== "locked" && s && (() => {
            const n = gt(s.config, G.id, G.primary?.kind === "agent" ? G.primary.skill : "", G.primary?.kind === "agent" ? G.primary.trigger : void 0);
            return /* @__PURE__ */ i("p", { className: "a3d-muted a3d-runline", children: [
              "Agent runs here use ",
              /* @__PURE__ */ e("strong", { children: un(n.model) }),
              ", reasoning ",
              /* @__PURE__ */ e("strong", { children: n.effort }),
              oi(n.effort) ? ` (“${oi(n.effort)}”)` : "",
              ". One run: Run command… · for good: ",
              /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: () => c("settings"), children: "Settings → Agent runs" }),
              "."
            ] });
          })(),
          Un && /* @__PURE__ */ e(On, { tips: ln, step: G.id, onClose: () => Dt(!1) }),
          /* @__PURE__ */ e("div", { className: "a3d-results", children: $a(h, G) })
        ] })
      ] }) : /* @__PURE__ */ e("div", { className: "a3d-placeholder", children: s ? /* @__PURE__ */ i(ee, { children: [
        "No model selected. ",
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: () => c("models"), children: "Open Models" })
      ] }) : g ? "" : "Reading models…" }))
    ] }),
    /* @__PURE__ */ i("aside", { className: "a3d-session", children: [
      /* @__PURE__ */ i("header", { children: [
        /* @__PURE__ */ e("h2", { children: "Agent session" }),
        Ft.length > 0 && /* @__PURE__ */ e("select", { "aria-label": "Run", value: Re?.at ?? "", onChange: (n) => B(Number(n.target.value)), children: Ft.map((n) => /* @__PURE__ */ i("option", { value: n.at, children: [
          xi(n.at),
          " · ",
          n.label,
          n.model ? ` · ${un(n.model)}` : "",
          n.status === "running" ? " (running)" : n.status === "error" ? " (failed)" : ""
        ] }, n.at)) })
      ] }),
      /* @__PURE__ */ i("div", { className: "a3d-session-body", children: [
        !Re && /* @__PURE__ */ e("p", { className: "a3d-empty", children: "Run a step and its agent session appears here. Answer verdict questions in this pane." }),
        Re?.status === "error" && /* @__PURE__ */ e("p", { className: "a3d-banner a3d-banner-error", children: Re.error }),
        Re && !Re.sessionId && Re.status === "running" && /* @__PURE__ */ e("p", { className: "a3d-empty", children: "Starting the session…" }),
        Re?.sessionId && pn && /* @__PURE__ */ e(pn, { sessionId: Re.sessionId }, Re.sessionId),
        Re?.sessionId && !pn && /* @__PURE__ */ i("p", { className: "a3d-empty", children: [
          "This Nimbalyst version cannot embed transcripts in a panel. Open the session “AI3D · ",
          f === St ? "" : `${f} · `,
          Re.label,
          "” from the session list."
        ] })
      ] })
    ] }),
    M && /* @__PURE__ */ e("div", { className: "a3d-overlay", onClick: () => I(null), children: /* @__PURE__ */ i("form", { className: "a3d-dialog", onClick: (n) => n.stopPropagation(), onSubmit: (n) => {
      n.preventDefault(), ka();
    }, children: [
      /* @__PURE__ */ e("h3", { children: M === "new" ? "New model" : M === "score" ? "Score ideas" : M === "blender" ? `Blender command · ${h?.meta.title || h?.slug || ""}` : M === "trend" ? "Analyse a trend" : M === "similar" ? "Similar model" : M === "season" ? "Season or event" : "Scout a category" }),
      /* @__PURE__ */ e("label", { htmlFor: "a3d-dialog-input", children: M === "trend" ? "Topic or category, for example “flexi dragons” or “desk organisers”. Scout collects dated signals (Apify when connected) and curates ideas." : M === "similar" ? "A link to the model (MakerWorld, Printables, Etsy…), its name, or a photo. Scout explains why it works, the licence and IP split, and proposes original models in the same niche." : M === "season" ? "Event, for example “St Nicholas Day”, “Christmas”, “New Year”. Scout checks the publish-by date and what sold last year." : M === "blender" ? "One instruction for Kiln to do in your open Blender, for example “show the underside and measure the thinnest leg”." : M === "new" ? "Describe the model: subject, style, size, static or flexi." : M === "score" ? "Category with a Scout shortlist to score, for example “lizards”." : "Category to research, for example “lizards” or “owls”." }),
      M === "new" || M === "blender" || M === "similar" || M === "trend" ? /* @__PURE__ */ e("textarea", { id: "a3d-dialog-input", autoFocus: !0, rows: 5, value: _, onChange: (n) => y(n.target.value) }) : /* @__PURE__ */ e("input", { id: "a3d-dialog-input", autoFocus: !0, list: M === "score" ? "a3d-shortlist-names" : M === "season" ? "a3d-events" : void 0, value: _, onChange: (n) => y(n.target.value) }),
      M === "similar" && /* @__PURE__ */ i("p", { className: "a3d-row", children: [
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => {
          ya();
        }, children: "Choose photo…" }),
        /* @__PURE__ */ e("span", { className: "a3d-muted a3d-small", children: "adds the file path; Scout copies it into the trend’s refs/" })
      ] }),
      M === "season" && /* @__PURE__ */ e("datalist", { id: "a3d-events", children: (s?.calendar ?? []).map((n) => /* @__PURE__ */ e("option", { value: n.name }, n.id)) }),
      M === "score" && /* @__PURE__ */ e("datalist", { id: "a3d-shortlist-names", children: (s?.shortlists ?? []).map((n) => /* @__PURE__ */ e("option", { value: n.name.replace(/\.md$/, "") }, n.name)) }),
      /* @__PURE__ */ i("span", { className: "a3d-row a3d-row-end", children: [
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => I(null), children: "Cancel" }),
        /* @__PURE__ */ e("button", { type: "submit", className: "a3d-btn a3d-btn-primary", disabled: !_.trim() || _e, children: M === "new" ? "Run: write concept" : M === "score" ? "Run: score" : M === "blender" ? "Run in Blender (Kiln)" : M === "trend" || M === "similar" || M === "season" ? "Run: Scout" : "Run: scout" })
      ] })
    ] }) }),
    X && h && s && /* @__PURE__ */ e(
      Ua,
      {
        model: h,
        scan: s,
        initial: X,
        busy: _e,
        onBranch: () => {
          const n = X.parent ? h.flow.nodes.find((r) => r.id === X.parent) ?? null : null;
          $e(null), Ge({ from: n });
        },
        defaultRun: gt(s?.config ?? {}, X.step, ft[X.step]?.[0]?.skill ?? "", ft[X.step]?.[0]?.trigger),
        stepTitle: (n) => ce.find((r) => r.id === n)?.title ?? n,
        onCancel: () => $e(null),
        onRun: (n, r) => {
          $e(null);
          const k = ce.find((P) => P.id === r.step) ?? null;
          J(n, k, void 0, r);
        }
      },
      `${X.step}-${X.parent}`
    ),
    an && s && /* @__PURE__ */ e(
      tl,
      {
        host: t,
        model: h,
        pictures: an.pictures,
        busy: _e,
        defaultRun: gt(s.config, "concept", "ai3d-muse", "*concept"),
        onPick: () => ut(t, "image"),
        onCancel: () => Nt(null),
        onRun: (n) => {
          oa(n);
        }
      }
    ),
    Ee && h && s && ce.find((n) => n.id === Ee.step) && /* @__PURE__ */ e(
      el,
      {
        model: h,
        scan: s,
        step: ce.find((n) => n.id === Ee.step),
        initial: Ee.action,
        tips: ln,
        busy: _e,
        onCancel: () => Qe(null),
        onRun: la
      }
    ),
    ot && h && /* @__PURE__ */ e(
      Qs,
      {
        model: h,
        from: ot.from,
        busy: _e,
        stepTitle: (n) => ce.find((r) => r.id === n)?.title ?? n,
        onPick: (n) => ut(t, n),
        onCancel: () => Ge(null),
        onCreate: (n) => {
          ra(n);
        }
      }
    ),
    nn && /* @__PURE__ */ e(
      rs,
      {
        status: fe,
        checking: Kn,
        kilnInstalled: !!s?.tools.kilnRun,
        guide: !!s?.tools.blenderGuide,
        onCheck: () => {
          _t();
        },
        onGuide: ma,
        onLaunch: () => {
          hn(null);
        },
        onClose: () => yt(!1)
      }
    ),
    jt && h && /* @__PURE__ */ e(
      ds,
      {
        cmd: jt,
        model: h,
        onCancel: () => kt(null),
        onRun: (n) => {
          kt(null), v("blender"), Lt(n.cmd, n.opts, n.description);
        }
      }
    ),
    rt && h && /* @__PURE__ */ e(
      Qa,
      {
        model: h,
        last: [...h.printLog].reverse().find((n) => !n.skipped) ?? null,
        onPickPhotos: () => ut(t, "image"),
        onCancel: () => N(!1),
        onSave: (n) => {
          ha(n);
        }
      }
    ),
    O && /* @__PURE__ */ e(Ps, { commands: Ca, onClose: () => T(!1) }),
    F && /* @__PURE__ */ e("div", { className: "a3d-overlay", onClick: () => b(null), children: /* @__PURE__ */ i("figure", { className: "a3d-zoom", children: [
      /* @__PURE__ */ e(Oe, { host: t, path: F.path, mtime: F.mtime, alt: F.name }),
      /* @__PURE__ */ e("figcaption", { children: F.name })
    ] }) })
  ] });
}
let Qt = null;
async function hl(t) {
  Wi(t.services.ai ?? null), Ti.modelsRoot = t.services.configuration?.get("modelsRoot", "") ?? "";
  const a = t.services.filesystem;
  Qt = {
    read: async (l) => await a.fileExists(l) ? a.readFile(l) : null,
    write: (l, s) => a.writeFile(l, s)
  };
}
async function pl() {
  Wi(null), Qt = null;
}
const ul = {
  forge: { component: rl }
};
function ol({ workspacePath: t }) {
  return t ? Qt ? /* @__PURE__ */ i("div", { className: "a3d a3d-settings-page", children: [
    /* @__PURE__ */ e("h2", { children: "AI3D Forge" }),
    /* @__PURE__ */ e(Oi, { workspace: t, io: Qt })
  ] }) : /* @__PURE__ */ e("p", { className: "a3d-muted", children: "The extension is still starting. Reopen this page in a moment." }) : /* @__PURE__ */ e("p", { className: "a3d-muted", children: "Open a project to edit its AI3D Forge settings." });
}
const ml = { Ai3dSettings: ol };
export {
  hl as activate,
  pl as deactivate,
  ul as panels,
  ml as settingsPanel
};
//# sourceMappingURL=index.js.map
