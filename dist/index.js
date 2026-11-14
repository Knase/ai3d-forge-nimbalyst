import { jsx as e, jsxs as s, Fragment as J } from "react/jsx-runtime";
import { useState as O, useRef as Te, useEffect as ie, useMemo as Le, useCallback as z, useSyncExternalStore as Zn } from "react";
const Yn = `"""Scan the AI3D Forge models folder and print one JSON document.
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
            return {"nodes": g["nodes"], "real": g["real"]}
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


def model(root, slug):
    d = os.path.join(root, slug)
    files = {s: listing(os.path.join(d, s)) for s in SUBS}
    attempts = listing(os.path.join(d, "mesh", "attempts"))
    versions = []
    for f in files["prompts"]:
        m = re.match(r"image-v(\\d+)\\.md$", f["name"])
        if m:
            versions.append((int(m.group(1)), f["name"]))
    latest = max(versions)[1] if versions else None
    has3d = any(f["name"] == "3d-prompt.md" for f in files["prompts"])
    readme = os.path.join(d, "README.md")
    stamp = max([f["mtime"] for s in SUBS for f in files[s]] +
                [int(os.stat(os.path.join(d, n)).st_mtime) for n in ("metadata.json", "concept.md", "README.md", "flow.json")
                 if os.path.isfile(os.path.join(d, n))] + [0])
    return {
        "slug": slug,
        "dir": d,
        "meta": load_json(os.path.join(d, "metadata.json")) or {},
        "concept": text(os.path.join(d, "concept.md"), 4000),
        "files": files,
        "attempts": attempts,
        "imagePrompt": {"name": latest, "text": text(os.path.join(d, "prompts", latest))} if latest else None,
        "prompt3d": text(os.path.join(d, "prompts", "3d-prompt.md")) if has3d else None,
        "analysis": load_json(os.path.join(d, "print", "analysis.json")),
        "printLog": load_json(os.path.join(d, "print", "print-log.json")) or [],
        "printPhotos": listing(os.path.join(d, "print", "photos")),
        "hasReadme": os.path.isfile(readme),
        "view": view_info(d, files),
        "flow": flow_graph(d),
        "stamp": stamp,
    }


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
        if os.path.isfile(os.path.join(root, name, "metadata.json")) or os.path.isfile(os.path.join(root, name, "concept.md")):
            result["models"].append(model(root, name))
print(json.dumps(result))
`, Xn = /\.(png|jpe?g|webp|gif)$/i, Qn = (t) => Xn.test(t.name), me = (t) => t.filter(Qn), ei = (t, n) => t.some((a) => n.test(a.name)), W = (t, n, a, r) => ({
  kind: "agent",
  label: t,
  skill: n,
  trigger: a,
  extra: r
});
function Pt(t) {
  return t >= 1e6 ? `${(t / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(t / 1e3))} KB`;
}
function un(t) {
  return Pt(t);
}
function ti(t, n) {
  const a = t.meta.stages ?? {}, r = t.files, o = me(r.inbox), u = me(r.images), f = me(r.renders), b = r.mesh.find((X) => /^raw\./i.test(X.name)), S = r.mesh.find((X) => X.name === "print.stl") ?? r.mesh.find((X) => X.name === "clean.stl"), k = t.meta.model_type === "flexi", y = t.analysis?.after ?? t.analysis?.analysis ?? null, _ = t.meta.status ?? "concept", D = !!a.concept?.done || /\*\*Subject:\*\*\s*\S/.test(t.concept ?? ""), C = !!a.image?.done || u.length > 0, P = !!a.mesh?.done || !!b && !!S, M = !!S, B = ei(r.print, /^slicing-notes\.md$/), T = t.hasReadme && (_ === "ready" || _ === "published"), d = t.printLog.filter((X) => !X.skipped), p = d[d.length - 1] ?? null, j = !p && t.printLog.some((X) => X.skipped), m = !!a.print_test?.done || t.printLog.length > 0, v = [D, C, P, M, B, m, T], c = v.indexOf(!1), w = [];
  w.push({
    id: "concept",
    title: "Concept",
    agent: "Muse",
    result: D ? `${t.meta.model_type ?? "type not set"} · ${t.meta.scale_mm ? t.meta.scale_mm + " mm" : "scale not set"}` : "No concept yet",
    hint: D ? "Concept is written. Re-run to change type or scale." : "Muse writes the concept and picks static / flexi / functional.",
    thumb: null,
    primary: D ? null : W("Write concept", "ai3d-muse", "*concept"),
    more: [W("Re-check model type", "ai3d-muse", "*type")]
  });
  let $, A;
  C ? ($ = null, A = `${u.length} image${u.length === 1 ? "" : "s"} accepted.`) : o.length > 0 ? ($ = W(`Review ${o.length} image${o.length === 1 ? "" : "s"} in inbox`, "ai3d-lumen", "*review"), A = "Lumen reads the inbox images and either accepts one or writes the next prompt.") : t.imagePrompt ? ($ = {
    kind: "human",
    label: "Generate in Gemini, save into inbox/",
    copy: t.imagePrompt.text ?? "",
    copyLabel: `Copy ${t.imagePrompt.name}`,
    folder: "inbox"
  }, A = `Your turn: paste ${t.imagePrompt.name} into Gemini and save the image into inbox/.`) : ($ = W("Write image prompt", "ai3d-lumen", "*prompt"), A = "Lumen writes the first Gemini prompt."), w.push({
    id: "image",
    title: "Image",
    agent: "Lumen",
    result: C ? `${u.length} accepted` : o.length ? `${o.length} in inbox` : t.imagePrompt ? `${t.imagePrompt.name} ready` : "No prompt yet",
    hint: A,
    thumb: u[0] ? `images/${u[0].name}` : o[0] ? `inbox/${o[0].name}` : null,
    primary: $,
    more: [
      W("Write next prompt", "ai3d-lumen", "*prompt"),
      W("Review inbox", "ai3d-lumen", "*review"),
      W("Accept image", "ai3d-lumen", "*accept")
    ]
  });
  let N, G;
  P ? (N = null, G = "Mesh accepted.") : b ? (N = W("Review the mesh", "ai3d-chisel", "*review-mesh"), G = "Chisel checks the mesh against the concept and accepts it or changes the settings.") : t.prompt3d ? (N = {
    kind: "human",
    label: "Run the 3D service, save mesh/raw.glb",
    copy: t.prompt3d,
    copyLabel: "Copy 3D spec",
    folder: "mesh"
  }, G = "Your turn: upload the accepted image to the 3D service and save the export as mesh/raw.glb.") : (N = W("Write 3D spec", "ai3d-chisel", "*3d-prompt"), G = "Chisel writes the service settings for the accepted image."), w.push({
    id: "mesh",
    title: "3D mesh",
    agent: "Chisel",
    result: b ? `${b.name} · ${Pt(b.size)}` : t.prompt3d ? "3D spec ready" : "No mesh yet",
    hint: G,
    thumb: null,
    primary: N,
    more: [
      W("Write 3D spec", "ai3d-chisel", "*3d-prompt"),
      W("Review mesh", "ai3d-chisel", "*review-mesh"),
      W("Accept mesh", "ai3d-chisel", "*accept-mesh")
    ]
  });
  const te = [
    W("Inspect only", "ai3d-kiln", "*inspect"),
    W("Optimize again", "ai3d-kiln", "*optimize"),
    W("Build flexi joints", "ai3d-kiln", "*flexi"),
    W("Render previews", "ai3d-kiln", "*render"),
    { kind: "script", label: "Build interactive 3D view", script: "view" },
    W("Export clearance coupon", "ai3d-kiln", "*coupon"),
    W("Blender command (free text)", "ai3d-kiln", "*run")
  ];
  w.push({
    id: "blender",
    title: "Blender",
    agent: "Kiln",
    result: S ? [y?.overhang_pct != null ? `overhang ${y.overhang_pct} %` : null, t.analysis?.side_on_bed ? `${t.analysis.side_on_bed} on bed` : null, Pt(S.size)].filter(Boolean).join(" · ") : "Not optimised yet",
    hint: S ? k ? "Print file exists. Build or rebuild flexi joints if needed." : "Print file exists." : "Kiln works in Blender: solid mesh, bed side, flat cut, overhang check. It asks you for two verdicts.",
    thumb: f[0] ? `renders/${f[0].name}` : null,
    primary: S ? null : W("Optimize in Blender", "ai3d-kiln", "*optimize"),
    more: te
  }), w.push({
    id: "validate",
    title: "Validate",
    agent: "Anvil",
    result: B ? "Slicing notes written" : "Not validated yet",
    hint: B ? "Checklist and slicing notes are in print/." : "Anvil runs the print-ready checklist and writes the slicing notes.",
    thumb: null,
    primary: B ? null : W("Validate and write slicing notes", "ai3d-anvil", "*validate", "When the checklist passes, continue with *slice."),
    more: [W("Validate", "ai3d-anvil", "*validate"), W("Slicing notes", "ai3d-anvil", "*slice")]
  });
  const ce = me(t.printPhotos);
  w.push({
    id: "print",
    title: "Test print",
    agent: "Anvil",
    result: p ? `${p.result}${p.printer ? ` · ${p.printer}` : ""}${d.length > 1 ? ` · ${d.length} prints` : ""}` : j ? "Skipped" : "Not printed yet",
    hint: p ? p.change ? `Change next time: ${p.change}` : "Logged. Print again after changes, or move on." : j ? "Skipped for this model." : "Print mesh/print.stl, then log the result with a photo. Or skip it for a shape you have already proven.",
    thumb: ce.length ? `print/photos/${ce[ce.length - 1].name}` : null,
    primary: m ? null : { kind: "human", label: "Print mesh/print.stl, then log the result", folder: "print" },
    more: [
      { kind: "form", label: "Log a test print…", form: "print-log" },
      { kind: "form", label: "Skip the test print", form: "print-skip" },
      W("Log with Anvil (reads the photos)", "ai3d-anvil", "*print-log")
    ]
  });
  let ne;
  t.hasReadme ? _ !== "ready" && _ !== "published" ? ne = W("Mark ready", "ai3d-herald", "*ready") : ne = null : ne = t.meta.summary && n.tools.buildReadme ? { kind: "script", label: "Build README", script: "readme" } : W("Write README", "ai3d-herald", "*readme");
  const $e = [
    W("Write README text", "ai3d-herald", "*readme"),
    W("Mark ready", "ai3d-herald", "*ready"),
    W("Write listing", "ai3d-herald", "*listing"),
    W("Mark published", "ai3d-herald", "*publish")
  ];
  return n.tools.buildReadme && $e.unshift({ kind: "script", label: "Rebuild README (no agent)", script: "readme" }), w.push({
    id: "publish",
    title: "Publish",
    agent: "Herald",
    result: t.hasReadme ? `README · ${_}` : "No README yet",
    hint: T ? "Model is ready." : t.hasReadme ? "README exists. Mark the model ready when you are happy with it." : "Herald builds the README with images, description and the STL link.",
    thumb: null,
    primary: ne,
    more: $e
  }), w.map((X, fe) => {
    let Ee;
    return v[fe] ? Ee = "done" : c === fe ? Ee = X.primary?.kind === "human" ? "waiting" : "active" : Ee = "locked", { ...X, n: fe + 1, state: Ee };
  });
}
const ue = ["concept", "image", "mesh", "blender", "validate", "print", "publish"], je = (t, n, a) => ({ kind: "agent", label: t, skill: n, trigger: a }), ni = /* @__PURE__ */ new Set([
  "ai3d-muse *concept",
  "ai3d-lumen *prompt",
  "ai3d-chisel *3d-prompt",
  "ai3d-kiln *optimize",
  "ai3d-kiln *flexi",
  "ai3d-anvil *validate",
  "ai3d-herald *readme"
]), ii = (t) => t.kind === "agent" && ni.has(`${t.skill} ${t.trigger}`), dt = {
  concept: [je("Write concept", "ai3d-muse", "*concept")],
  image: [je("Write image prompt", "ai3d-lumen", "*prompt")],
  mesh: [je("Write 3D spec", "ai3d-chisel", "*3d-prompt")],
  blender: [je("Optimize in Blender", "ai3d-kiln", "*optimize"), je("Build flexi joints", "ai3d-kiln", "*flexi")],
  validate: [je("Validate and write slicing notes", "ai3d-anvil", "*validate")],
  publish: [je("Write README", "ai3d-herald", "*readme")]
}, si = {
  concept: ["model_type", "scale_mm", "style"],
  image: ["backend", "mode", "aspect", "references"],
  mesh: ["service", "texture", "topology", "segmentation", "symmetry", "face_limit"],
  blender: ["side_on_bed", "cut_mm", "overhang_deg", "flexi", "segments", "clearance_mm"],
  validate: ["slicer", "nozzle_mm", "layer_mm"],
  publish: ["status"]
};
function ai(t, n, a, r, o) {
  const u = a.root.startsWith(a.workspace) ? a.root.slice(a.workspace.length + 1) || "." : a.root, f = [`Use the \`${t.skill}\` skill from the AI3D Forge BMAD module and run its \`${t.trigger}\` action.`];
  if (n ? f.push(`Model: \`${n.slug}\` — directory \`${u}/${n.slug}/\`. Work only on this model.`) : f.push(`Models folder: \`${u}/\`.`), r && f.push(`Input from the user: ${r}`), o && n) {
    const b = o.node;
    f.push(`Flow node: \`${b.id}\` (step ${b.step}), created by the panel with status running. Do not add a new node: update this one when you finish` + (o.flowLog ? ` with \`python3 ${o.flowLog} update ${n.dir} ${b.id} ...\`` : "") + " (rules: ai3d-forge/references/flow-graph.md)."), b.parent && f.push(`This attempt grows from node \`${b.parent}\`.`);
    const S = Object.entries(b.settings);
    S.length && f.push(`Settings for this attempt, use exactly these and do not fall back to defaults: ${S.map(([k, y]) => `${k}=${y}`).join(", ")}.`), b.description && f.push(`What is different this time: ${b.description}`);
  }
  return t.extra && f.push(t.extra), f.push("Follow the skill's HALT rules: stop and ask me whenever a verdict or an off-tool step is needed."), f.join(`
`);
}
const Ae = (t) => ue.indexOf(t), fn = (t, n) => t.created_at < n.created_at ? -1 : t.created_at > n.created_at ? 1 : 0;
function De(t, n) {
  return t.filter((a) => a.step === n).sort(fn);
}
function li(t) {
  const n = t.filter((a) => a.verdict !== "rejected" && a.status !== "error");
  return n.length ? n.sort((a, r) => Ae(r.step) - Ae(a.step) || +(r.verdict === "accepted") - +(a.verdict === "accepted") || fn(r, a))[0] : null;
}
function ri(t, n) {
  const a = new Map(t.map((u) => [u.id, u])), r = /* @__PURE__ */ new Set();
  let o = n ? a.get(n) : void 0;
  for (; o && !r.has(o.id); )
    r.add(o.id), o = o.parent ? a.get(o.parent) : void 0;
  return r;
}
function Ve(t, n) {
  if (n === "image") {
    const a = De(t, "image").filter((r) => r.verdict !== "accepted");
    if (a.length) return a[a.length - 1].id;
  }
  for (let a = Ae(n) - 1; a >= 0; a--) {
    const r = De(t, ue[a]).filter((u) => u.verdict !== "rejected" && u.status !== "error");
    if (!r.length) continue;
    const o = r.filter((u) => u.verdict === "accepted");
    return (o.length ? o : r).slice(-1)[0].id;
  }
  return null;
}
function oi(t) {
  return t.step === "image" ? t.id : t.parent;
}
function di(t) {
  const n = ue.map(() => 0), a = [];
  for (let r = 0; r < ue.length; r++)
    De(t, ue[r]).forEach((o, u) => {
      a.push({ node: o, row: r, slot: u }), n[r] = u + 1;
    });
  return { placed: a, slots: n };
}
function ci(t, n = 2) {
  const a = Object.entries(t.settings);
  return a.length ? a.slice(0, n).map(([r, o]) => `${r}=${o}`).join(" ") + (a.length > n ? ` +${a.length - n}` : "") : "";
}
function pi({ model: t, stepTitle: n, initial: a, busy: r, onCancel: o, onRun: u }) {
  const [f, b] = O(a.parent ?? ""), [S, k] = O(Object.entries(a.settings)), [y, _] = O(a.description), D = dt[a.step] ?? [], [C, P] = O(0), M = Ae(a.step), B = t.flow.nodes.filter((j) => Ae(j.step) <= M), T = si[a.step] ?? [], d = () => {
    const j = {};
    for (const [m, v] of S) m.trim() && v.trim() && (j[m.trim()] = v.trim());
    u(D[C], { step: a.step, parent: f || null, settings: j, description: y.trim() });
  }, p = (j, m, v) => k((c) => c.map((w, $) => $ === j ? m === 0 ? [v, w[1]] : [w[0], v] : w));
  return /* @__PURE__ */ e("div", { className: "a3d-overlay", onClick: o, children: /* @__PURE__ */ s("form", { className: "a3d-dialog a3d-dialog-wide", onClick: (j) => j.stopPropagation(), onSubmit: (j) => {
    j.preventDefault(), d();
  }, children: [
    /* @__PURE__ */ s("h3", { children: [
      "New attempt · ",
      n(a.step)
    ] }),
    /* @__PURE__ */ e("p", { className: "a3d-muted", children: "It becomes a new box in the flow graph. Earlier attempts stay as they are." }),
    D.length > 1 && /* @__PURE__ */ s("label", { children: [
      "Action",
      /* @__PURE__ */ e("select", { value: C, onChange: (j) => P(Number(j.target.value)), children: D.map((j, m) => /* @__PURE__ */ e("option", { value: m, children: j.label }, j.trigger)) })
    ] }),
    /* @__PURE__ */ s("label", { children: [
      "Grows from",
      /* @__PURE__ */ s("select", { value: f, onChange: (j) => b(j.target.value), children: [
        /* @__PURE__ */ e("option", { value: "", children: "Nothing (start of this line)" }),
        B.map((j) => /* @__PURE__ */ s("option", { value: j.id, children: [
          n(j.step),
          " · ",
          j.label,
          j.verdict ? ` (${j.verdict})` : ""
        ] }, j.id))
      ] })
    ] }),
    /* @__PURE__ */ s("fieldset", { className: "a3d-fields", children: [
      /* @__PURE__ */ e("legend", { children: "Settings for this attempt" }),
      S.length === 0 && /* @__PURE__ */ e("p", { className: "a3d-muted", children: "No settings. The agent uses its defaults." }),
      S.map(([j, m], v) => /* @__PURE__ */ s("div", { className: "a3d-kvrow", children: [
        /* @__PURE__ */ e("input", { "aria-label": "Setting name", list: `a3d-keys-${a.step}`, placeholder: "name", value: j, onChange: (c) => p(v, 0, c.target.value) }),
        /* @__PURE__ */ e("input", { "aria-label": "Setting value", placeholder: "value", value: m, onChange: (c) => p(v, 1, c.target.value) }),
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", "aria-label": "Remove setting", onClick: () => k((c) => c.filter((w, $) => $ !== v)), children: "×" })
      ] }, v)),
      /* @__PURE__ */ e("datalist", { id: `a3d-keys-${a.step}`, children: T.map((j) => /* @__PURE__ */ e("option", { value: j }, j)) }),
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => k((j) => [...j, ["", ""]]), children: "+ Add setting" })
    ] }),
    /* @__PURE__ */ s("label", { children: [
      "Description: what is different this time, and why",
      /* @__PURE__ */ e(
        "textarea",
        {
          rows: 3,
          autoFocus: !0,
          value: y,
          onChange: (j) => _(j.target.value),
          placeholder: a.step === "mesh" ? "Texture off and segmentation on, because the last mesh fused the wings." : "One or two lines. The agent reads it and it stays on the node."
        }
      )
    ] }),
    /* @__PURE__ */ s("span", { className: "a3d-row a3d-row-end", children: [
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: o, children: "Cancel" }),
      /* @__PURE__ */ s("button", { type: "submit", className: "a3d-btn a3d-btn-primary", disabled: r || !D.length, children: [
        "Run: ",
        D[C]?.label
      ] })
    ] })
  ] }) });
}
const ee = 172, we = 58, $t = 22, ye = 80, st = 132, at = 10, _t = (t, n) => t.length > n ? `${t.slice(0, n - 1)}…` : t, en = { done: "done", active: "next", waiting: "your turn", locked: "locked" }, ct = { running: "running", open: "waiting", done: "done", error: "failed" }, tn = { running: "", open: "", done: "✓", error: "!" };
function hi({ model: t, steps: n, selectedNode: a, selectedStep: r, compare: o, showArchived: u, onSelectNode: f, onSelectStep: b, onNew: S }) {
  const k = gn(t.flow.nodes, u), { placed: y, slots: _ } = di(k), D = li(k), C = ri(k, D?.id ?? null), P = /* @__PURE__ */ new Map(), M = Math.max(2, ..._.map((p) => p + 1)), B = st + M * (ee + $t), T = at + ue.length * ye;
  for (const p of y) P.set(p.node.id, { x: st + p.slot * (ee + $t), y: at + p.row * ye + (ye - we) / 2, p });
  const d = k.filter((p) => p.parent && P.has(p.parent) && P.has(p.id)).map((p) => {
    const j = P.get(p.parent), m = P.get(p.id);
    let v;
    if (j.p.row === m.p.row) {
      const c = j.y + we / 2;
      v = j.x < m.x ? `M${j.x + ee},${c} L${m.x},${c}` : `M${j.x},${c} L${m.x + ee},${c}`;
    } else {
      const c = j.x + ee / 2, w = j.y + we, $ = m.x + ee / 2, A = m.y, N = (w + A) / 2;
      v = `M${c},${w} C${c},${N} ${$},${N} ${$},${A}`;
    }
    return { id: `${p.parent}>${p.id}`, d: v, on: C.has(p.id) && C.has(p.parent) };
  });
  return /* @__PURE__ */ s("section", { className: "a3d-graph", "aria-label": "Flow graph", children: [
    /* @__PURE__ */ e("div", { className: "a3d-graph-scroll", children: /* @__PURE__ */ s("svg", { width: B, height: T, viewBox: `0 0 ${B} ${T}`, role: "group", "aria-label": `Flow of ${t.meta.title || t.slug}`, children: [
      /* @__PURE__ */ e("defs", { children: /* @__PURE__ */ e("marker", { id: "a3d-arrow", viewBox: "0 0 8 8", refX: "7", refY: "4", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse", children: /* @__PURE__ */ e("path", { d: "M0,0 L8,4 L0,8 z", className: "a3d-g-arrow" }) }) }),
      ue.map((p, j) => {
        const m = n.find((w) => w.id === p), v = at + j * ye, c = m?.state === "active" || m?.state === "waiting";
        return /* @__PURE__ */ s("g", { className: `a3d-g-row a3d-g-${m?.state ?? "locked"}${r === p ? " a3d-g-rowsel" : ""}`, children: [
          /* @__PURE__ */ e("rect", { x: 0, y: v, width: B, height: ye, className: j % 2 ? "a3d-g-band a3d-g-band2" : "a3d-g-band" }),
          /* @__PURE__ */ s(
            "g",
            {
              tabIndex: 0,
              role: "button",
              "aria-label": `Step ${j + 1} ${m?.title ?? p}, ${en[m?.state ?? "locked"]}`,
              onClick: () => b(p),
              onKeyDown: (w) => {
                (w.key === "Enter" || w.key === " ") && (w.preventDefault(), b(p));
              },
              className: "a3d-g-label",
              children: [
                /* @__PURE__ */ e("rect", { x: 4, y: v + 6, width: st - 12, height: ye - 12, rx: 6, className: "a3d-g-labelbg" }),
                /* @__PURE__ */ s("text", { x: 14, y: v + 28, className: "a3d-g-steptitle", children: [
                  c ? "▶ " : "",
                  j + 1,
                  " · ",
                  m?.title ?? p
                ] }),
                /* @__PURE__ */ s("text", { x: 14, y: v + 45, className: "a3d-g-stepsub", children: [
                  m?.agent,
                  " · ",
                  en[m?.state ?? "locked"]
                ] })
              ]
            }
          )
        ] }, p);
      }),
      d.map((p) => /* @__PURE__ */ e("path", { d: p.d, className: p.on ? "a3d-g-edge a3d-g-edge-on" : "a3d-g-edge", markerEnd: "url(#a3d-arrow)" }, p.id)),
      y.map(({ node: p }) => {
        const { x: j, y: m } = P.get(p.id), v = a === p.id, c = C.has(p.id), w = ci(p), $ = p.outcome || p.description, A = ["a3d-g-node", o.includes(p.id) ? "a3d-g-cmp" : "", p.archived ? "a3d-g-archived" : "", `a3d-gs-${p.status}`, p.verdict ? `a3d-gv-${p.verdict}` : "", p.inferred ? "a3d-g-inferred" : "", c ? "a3d-g-on" : "", v ? "a3d-g-sel" : ""].filter(Boolean).join(" ");
        return /* @__PURE__ */ s(
          "g",
          {
            className: A,
            transform: `translate(${j},${m})`,
            tabIndex: 0,
            role: "button",
            "aria-label": `${p.label}, ${ct[p.status]}${p.verdict ? ", " + p.verdict : ""}${D?.id === p.id ? ", current" : ""}`,
            onClick: () => f(p.id),
            onKeyDown: (N) => {
              (N.key === "Enter" || N.key === " ") && (N.preventDefault(), f(p.id));
            },
            children: [
              /* @__PURE__ */ e("title", { children: [p.label, `${ct[p.status]}${p.verdict ? ` · ${p.verdict}` : ""}${p.inferred ? " · rebuilt from files" : ""}`, w, p.description, p.outcome].filter(Boolean).join(`
`) }),
              /* @__PURE__ */ e("rect", { width: ee, height: we, rx: 8, className: "a3d-g-box" }),
              /* @__PURE__ */ e("circle", { cx: 14, cy: 16, r: 7, className: "a3d-g-dot" }),
              tn[p.status] && /* @__PURE__ */ e("text", { x: 14, y: 19.5, className: "a3d-g-dotglyph", textAnchor: "middle", children: tn[p.status] }),
              /* @__PURE__ */ e("text", { x: 28, y: 20, className: "a3d-g-label1", children: _t(p.label, 19) }),
              p.verdict && /* @__PURE__ */ e("text", { x: ee - 10, y: 20, textAnchor: "end", className: "a3d-g-verdict", children: p.verdict === "accepted" ? "✓" : "✗" }),
              /* @__PURE__ */ e("text", { x: 10, y: 36, className: "a3d-g-line2", children: _t(w || ct[p.status], 26) }),
              /* @__PURE__ */ e("text", { x: 10, y: 50, className: "a3d-g-line3", children: _t($, 26) }),
              o.includes(p.id) && /* @__PURE__ */ e("text", { x: ee - 10, y: we - 6, textAnchor: "end", className: "a3d-g-cmpmark", children: o.indexOf(p.id) === 0 ? "A" : "B" }),
              (p.notes?.length ?? 0) > 0 && /* @__PURE__ */ e("text", { x: ee - 28, y: 20, textAnchor: "end", className: "a3d-g-notemark", children: "✎" }),
              D?.id === p.id && /* @__PURE__ */ e("text", { x: ee - 8, y: -4, textAnchor: "end", className: "a3d-g-here", children: "you are here" })
            ]
          },
          p.id
        );
      }),
      ue.map((p, j) => {
        const m = n.find((w) => w.id === p);
        if (!m || m.state === "locked" && !_[j]) return null;
        const v = st + _[j] * (ee + $t), c = at + j * ye + (ye - we) / 2;
        return /* @__PURE__ */ s(
          "g",
          {
            className: "a3d-g-new",
            transform: `translate(${v},${c})`,
            tabIndex: 0,
            role: "button",
            "aria-label": `New attempt on ${m.title}`,
            onClick: () => S(p),
            onKeyDown: (w) => {
              (w.key === "Enter" || w.key === " ") && (w.preventDefault(), S(p));
            },
            children: [
              /* @__PURE__ */ s("title", { children: [
                "New attempt on ",
                m.title,
                ", with its own settings and description"
              ] }),
              /* @__PURE__ */ e("rect", { width: ee - 40, height: we, rx: 8, className: "a3d-g-newbox" }),
              /* @__PURE__ */ e("text", { x: (ee - 40) / 2, y: we / 2 + 5, textAnchor: "middle", className: "a3d-g-newtext", children: "+ New attempt" })
            ]
          },
          `new-${p}`
        );
      })
    ] }) }),
    /* @__PURE__ */ e("p", { className: "a3d-graph-legend a3d-muted", children: "Rows are the steps, each box is one attempt. Blue line: the path the model took. ✓ accepted, ✗ rejected, dashed box: a branch you left. Grey box: rebuilt from files. Ring: waiting for you. Pulsing: running. ✎ has notes. A / B: picked for comparison." })
  ] });
}
function gn(t, n) {
  if (n) return t;
  const a = new Set(t.filter((o) => o.archived).map((o) => o.id));
  let r = !0;
  for (; r; ) {
    r = !1;
    for (const o of t) !a.has(o.id) && o.parent && a.has(o.parent) && (a.add(o.id), r = !0);
  }
  return t.filter((o) => !a.has(o.id));
}
const Ct = (t) => {
  const n = new Date(t);
  return Number.isNaN(n.getTime()) ? t : n.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};
function mi({ model: t, node: n, busy: a, canEdit: r, inCompare: o, onSelectNode: u, onRerun: f, onNext: b, onVerdict: S, onOpen: k, onFiles: y, onCompare: _, onArchive: D, onNote: C, onCost: P }) {
  const [M, B] = O(""), [T, d] = O(n.cost?.service ?? ""), [p, j] = O(n.cost ? String(n.cost.credits) : ""), m = n.parent ? t.flow.nodes.find(($) => $.id === n.parent) : null, v = t.flow.nodes.filter(($) => $.parent === n.id), c = ue[Ae(n.step) + 1], w = Object.entries(n.settings);
  return /* @__PURE__ */ s("section", { className: "a3d-node-detail", children: [
    /* @__PURE__ */ s("header", { children: [
      /* @__PURE__ */ s("div", { children: [
        /* @__PURE__ */ s("h3", { children: [
          n.label,
          " ",
          /* @__PURE__ */ e("span", { className: `a3d-pill a3d-pill-${n.status}`, children: ct[n.status] }),
          n.verdict && /* @__PURE__ */ e("span", { className: `a3d-pill a3d-pill-${n.verdict}`, children: n.verdict }),
          n.inferred && /* @__PURE__ */ e("span", { className: "a3d-pill", children: "rebuilt from files" })
        ] }),
        /* @__PURE__ */ s("p", { className: "a3d-muted", children: [
          n.step,
          " · ",
          n.agent,
          " · ",
          Ct(n.created_at),
          n.finished_at ? ` → ${Ct(n.finished_at)}` : ""
        ] })
      ] }),
      /* @__PURE__ */ s("span", { className: "a3d-row", children: [
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", "aria-pressed": o, onClick: () => _(n), title: "Pick two attempts of the same step and compare them", children: o ? "In comparison" : "Compare" }),
        n.files.length > 0 && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => y(n), title: "Open the Files tab with only this attempt's files", children: "Show files" }),
        /* @__PURE__ */ e(
          "button",
          {
            type: "button",
            className: "a3d-btn",
            disabled: a,
            onClick: () => f(n),
            title: "Same step again, with the settings of this attempt as a starting point",
            children: "Run again with changes…"
          }
        ),
        c && /* @__PURE__ */ e(
          "button",
          {
            type: "button",
            className: "a3d-btn",
            disabled: a,
            onClick: () => b(n),
            title: "Start the next step from this attempt, making a branch",
            children: "Continue from here…"
          }
        )
      ] })
    ] }),
    /* @__PURE__ */ s("dl", { className: "a3d-node-grid", children: [
      /* @__PURE__ */ e("dt", { children: "Settings" }),
      /* @__PURE__ */ e("dd", { children: w.length ? /* @__PURE__ */ e("ul", { className: "a3d-kv", children: w.map(([$, A]) => /* @__PURE__ */ s("li", { children: [
        /* @__PURE__ */ e("code", { children: $ }),
        " ",
        A
      ] }, $)) }) : /* @__PURE__ */ e("span", { className: "a3d-muted", children: "none recorded" }) }),
      /* @__PURE__ */ e("dt", { children: "Description" }),
      /* @__PURE__ */ e("dd", { children: n.description || /* @__PURE__ */ e("span", { className: "a3d-muted", children: "none" }) }),
      /* @__PURE__ */ e("dt", { children: "Outcome" }),
      /* @__PURE__ */ e("dd", { children: n.outcome || /* @__PURE__ */ e("span", { className: "a3d-muted", children: "not recorded yet" }) }),
      n.files.length > 0 && /* @__PURE__ */ s(J, { children: [
        /* @__PURE__ */ e("dt", { children: "Files" }),
        /* @__PURE__ */ e("dd", { children: /* @__PURE__ */ e("ul", { className: "a3d-kv", children: n.files.map(($) => /* @__PURE__ */ e("li", { children: /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: () => k($), children: $ }) }, $)) }) })
      ] }),
      /* @__PURE__ */ e("dt", { children: "Cost" }),
      /* @__PURE__ */ e("dd", { children: r && !n.inferred ? /* @__PURE__ */ s("span", { className: "a3d-row", children: [
        /* @__PURE__ */ e("input", { className: "a3d-in-small", "aria-label": "Service", list: "a3d-services", placeholder: "service", value: T, onChange: ($) => d($.target.value) }),
        /* @__PURE__ */ e("input", { className: "a3d-in-small", "aria-label": "Credits", type: "number", min: "0", step: "any", placeholder: "credits", value: p, onChange: ($) => j($.target.value) }),
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", disabled: !T.trim() || p === "" || n.cost?.service === T && String(n.cost?.credits) === p, onClick: () => P(n, T.trim(), p), children: "Save" }),
        /* @__PURE__ */ s("datalist", { id: "a3d-services", children: [
          /* @__PURE__ */ e("option", { value: "tripo3d" }),
          /* @__PURE__ */ e("option", { value: "gemini" }),
          /* @__PURE__ */ e("option", { value: "meshy" }),
          /* @__PURE__ */ e("option", { value: "rodin" }),
          /* @__PURE__ */ e("option", { value: "apify" }),
          /* @__PURE__ */ e("option", { value: "usd" })
        ] })
      ] }) : n.cost ? `${n.cost.credits} ${n.cost.service}` : /* @__PURE__ */ e("span", { className: "a3d-muted", children: "not recorded" }) }),
      /* @__PURE__ */ e("dt", { children: "Notes" }),
      /* @__PURE__ */ s("dd", { children: [
        (n.notes ?? []).length > 0 && /* @__PURE__ */ e("ul", { className: "a3d-notes", children: n.notes.map(($, A) => /* @__PURE__ */ s("li", { children: [
          /* @__PURE__ */ e("span", { className: "a3d-muted", children: Ct($.at) }),
          " ",
          $.text
        ] }, A)) }),
        r && /* @__PURE__ */ s("form", { className: "a3d-row", onSubmit: ($) => {
          $.preventDefault(), M.trim() && (C(n, M.trim()), B(""));
        }, children: [
          /* @__PURE__ */ e("input", { className: "a3d-in-grow", "aria-label": "New note", placeholder: "Add a note: what you saw, what to try", value: M, onChange: ($) => B($.target.value) }),
          /* @__PURE__ */ e("button", { type: "submit", className: "a3d-btn a3d-btn-small", disabled: !M.trim(), children: "Add" })
        ] })
      ] }),
      /* @__PURE__ */ e("dt", { children: "Position" }),
      /* @__PURE__ */ s("dd", { children: [
        m ? /* @__PURE__ */ s(J, { children: [
          "grows from ",
          /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: () => u(m.id), children: m.label })
        ] }) : "first attempt",
        v.length > 0 && /* @__PURE__ */ s(J, { children: [
          " · leads to ",
          v.map(($, A) => /* @__PURE__ */ s("span", { children: [
            A ? ", " : "",
            /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: () => u($.id), children: $.label })
          ] }, $.id))
        ] })
      ] })
    ] }),
    r && !n.inferred && /* @__PURE__ */ s("p", { className: "a3d-row", children: [
      /* @__PURE__ */ e("span", { className: "a3d-muted", children: "Verdict" }),
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", "aria-pressed": n.verdict === "accepted", onClick: () => S(n, "accepted"), children: "Accepted" }),
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", "aria-pressed": n.verdict === "rejected", onClick: () => S(n, "rejected"), children: "Rejected" }),
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", disabled: !n.verdict, onClick: () => S(n, "none"), children: "Clear" }),
      /* @__PURE__ */ e("span", { className: "a3d-tabs-spacer" }),
      /* @__PURE__ */ e(
        "button",
        {
          type: "button",
          className: "a3d-btn a3d-btn-small",
          onClick: () => D(n, !n.archived),
          title: n.archived ? "Show this branch again" : "Hide this attempt and everything that grew from it; nothing is deleted",
          children: n.archived ? "Unarchive branch" : "Archive branch"
        }
      )
    ] })
  ] });
}
const g = (t) => `'${t.replace(/'/g, "'\\''")}'`, nn = () => /Win/i.test(navigator.platform) ? 'start ""' : /Mac/i.test(navigator.platform) ? "open" : "xdg-open", sn = (t, n) => `file://${encodeURI(t).replace(/#/g, "%23").replace(/\?/g, "%3F")}?v=${n}`, ui = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" }, Ft = () => /Mac/i.test(navigator.platform), fi = () => /Win/i.test(navigator.platform);
function xt(t) {
  return Ft() ? `open -R ${g(t)}` : fi() ? `explorer /select,"${t.replace(/\//g, "\\")}"` : `xdg-open ${g(t.replace(/\/[^/]*$/, ""))}`;
}
function Ne({ host: t, path: n, mtime: a, alt: r, onClick: o }) {
  const [u, f] = O(() => sn(n, a)), b = Te(!1);
  return ie(() => {
    b.current = !1, f(sn(n, a));
  }, [n, a]), /* @__PURE__ */ e("img", { src: u, alt: r, onError: async () => {
    if (b.current) return;
    b.current = !0;
    const k = await t.exec(`base64 < ${g(n)}`, { timeout: 2e4 }), y = n.split(".").pop()?.toLowerCase() ?? "png";
    k.success && f(`data:${ui[y] ?? "image/png"};base64,${k.stdout.replace(/\s+/g, "")}`);
  }, onClick: o, loading: "lazy" });
}
const an = /\.(png|jpe?g|webp|gif)$/i;
function gi({ host: t, model: n, a, b: r, onClose: o, onSwap: u, onView3d: f, onOpen: b }) {
  const S = Array.from(/* @__PURE__ */ new Set([...Object.keys(a.settings), ...Object.keys(r.settings)])).sort(), k = (_, D, C) => /* @__PURE__ */ s("tr", { className: D !== C ? "a3d-diff" : void 0, children: [
    /* @__PURE__ */ e("th", { children: _ }),
    /* @__PURE__ */ e("td", { children: D || /* @__PURE__ */ e("span", { className: "a3d-muted", children: "–" }) }),
    /* @__PURE__ */ e("td", { children: C || /* @__PURE__ */ e("span", { className: "a3d-muted", children: "–" }) })
  ] }, _), y = (_) => {
    const D = _.files.filter((P) => an.test(P)), C = _.files.filter((P) => /\.stl$/i.test(P));
    return /* @__PURE__ */ s("div", { className: "a3d-cmp-side", children: [
      D.length > 0 && /* @__PURE__ */ e("div", { className: "a3d-gallery", children: D.map((P) => /* @__PURE__ */ s("figure", { children: [
        /* @__PURE__ */ e(Ne, { host: t, path: `${n.dir}/${P}`, mtime: n.stamp, alt: P }),
        /* @__PURE__ */ e("figcaption", { children: P })
      ] }, P)) }),
      /* @__PURE__ */ s("p", { className: "a3d-row", children: [
        C.map((P) => /* @__PURE__ */ s("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => f(_, P), children: [
          "3D: ",
          P.split("/").pop()
        ] }, P)),
        _.files.filter((P) => !an.test(P) && !/\.stl$/i.test(P)).map((P) => /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: () => b(P), children: P }, P))
      ] })
    ] });
  };
  return /* @__PURE__ */ s("section", { className: "a3d-node-detail a3d-compare", children: [
    /* @__PURE__ */ s("header", { children: [
      /* @__PURE__ */ s("h3", { children: [
        "Compare attempts",
        a.step !== r.step ? /* @__PURE__ */ e("span", { className: "a3d-pill", children: "different steps" }) : null
      ] }),
      /* @__PURE__ */ s("span", { className: "a3d-row", children: [
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: u, children: "Swap" }),
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: o, children: "Close" })
      ] })
    ] }),
    /* @__PURE__ */ s("table", { className: "a3d-filetable a3d-cmp-table", children: [
      /* @__PURE__ */ e("thead", { children: /* @__PURE__ */ s("tr", { children: [
        /* @__PURE__ */ e("th", {}),
        /* @__PURE__ */ s("th", { children: [
          "A · ",
          a.label
        ] }),
        /* @__PURE__ */ s("th", { children: [
          "B · ",
          r.label
        ] })
      ] }) }),
      /* @__PURE__ */ s("tbody", { children: [
        k("Status", `${a.status}${a.verdict ? ` · ${a.verdict}` : ""}`, `${r.status}${r.verdict ? ` · ${r.verdict}` : ""}`),
        S.map((_) => k(_, a.settings[_] ?? "", r.settings[_] ?? "")),
        k("Description", a.description, r.description),
        k("Outcome", a.outcome, r.outcome),
        k("Cost", a.cost ? `${a.cost.credits} ${a.cost.service}` : "", r.cost ? `${r.cost.credits} ${r.cost.service}` : ""),
        k("Notes", (a.notes ?? []).map((_) => _.text).join(" · "), (r.notes ?? []).map((_) => _.text).join(" · "))
      ] })
    ] }),
    /* @__PURE__ */ s("div", { className: "a3d-two", children: [
      y(a),
      y(r)
    ] }),
    /* @__PURE__ */ e("p", { className: "a3d-muted a3d-small", children: "Rows that differ are highlighted. A file an attempt replaced later lives in mesh/attempts/; older attempts that did not record their files show none." })
  ] });
}
function bi({ model: t, last: n, onPickPhotos: a, onCancel: r, onSave: o }) {
  const [u, f] = O({
    result: "ok",
    printer: n?.printer ?? "",
    filament: n?.filament ?? "",
    settings: n?.settings ?? "",
    change: "",
    notes: "",
    photoPaths: [],
    photoFiles: []
  }), b = Te(null), S = (_, D) => f((C) => ({ ...C, [_]: D })), k = async () => {
    const _ = await a();
    _ === null ? b.current?.click() : _.length && f((D) => ({ ...D, photoPaths: [...D.photoPaths, ..._] }));
  }, y = u.photoPaths.length + u.photoFiles.length;
  return /* @__PURE__ */ e("div", { className: "a3d-overlay", onClick: r, children: /* @__PURE__ */ s("form", { className: "a3d-dialog a3d-dialog-wide", onClick: (_) => _.stopPropagation(), onSubmit: (_) => {
    _.preventDefault(), o(u);
  }, children: [
    /* @__PURE__ */ s("h3", { children: [
      "Test print · ",
      t.meta.title || t.slug
    ] }),
    /* @__PURE__ */ s("fieldset", { className: "a3d-fields a3d-result", children: [
      /* @__PURE__ */ e("legend", { children: "Result" }),
      [["ok", "OK, prints as intended"], ["issues", "Prints, with issues"], ["fail", "Failed"]].map(([_, D]) => /* @__PURE__ */ s("label", { className: "a3d-radio", children: [
        /* @__PURE__ */ e("input", { type: "radio", name: "a3d-result", checked: u.result === _, onChange: () => S("result", _) }),
        " ",
        D
      ] }, _))
    ] }),
    /* @__PURE__ */ s("div", { className: "a3d-form-grid", children: [
      /* @__PURE__ */ s("label", { children: [
        "Printer",
        /* @__PURE__ */ e("input", { value: u.printer, onChange: (_) => S("printer", _.target.value), placeholder: "Bambu A1" })
      ] }),
      /* @__PURE__ */ s("label", { children: [
        "Filament",
        /* @__PURE__ */ e("input", { value: u.filament, onChange: (_) => S("filament", _.target.value), placeholder: "PLA Basic, green" })
      ] })
    ] }),
    /* @__PURE__ */ s("label", { children: [
      "Settings",
      /* @__PURE__ */ e("input", { value: u.settings, onChange: (_) => S("settings", _.target.value), placeholder: "0.2 mm layers, 3 walls, 15 % infill, no supports" })
    ] }),
    /* @__PURE__ */ s("label", { children: [
      "What to change next time",
      /* @__PURE__ */ e("input", { value: u.change, onChange: (_) => S("change", _.target.value), placeholder: "clearance 0.45 instead of 0.4; tail joint stuck" })
    ] }),
    /* @__PURE__ */ s("label", { children: [
      "Notes",
      /* @__PURE__ */ e("textarea", { rows: 2, value: u.notes, onChange: (_) => S("notes", _.target.value) })
    ] }),
    /* @__PURE__ */ s("p", { className: "a3d-row", children: [
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => {
        k();
      }, children: "Add photos…" }),
      /* @__PURE__ */ e("span", { className: "a3d-muted", children: y ? `${y} photo${y === 1 ? "" : "s"}` : "Photos are copied into print/photos/." }),
      /* @__PURE__ */ e("input", { ref: b, type: "file", accept: "image/*", multiple: !0, hidden: !0, onChange: (_) => {
        const D = Array.from(_.target.files ?? []);
        _.target.value = "", f((C) => ({ ...C, photoFiles: [...C.photoFiles, ...D] }));
      } })
    ] }),
    /* @__PURE__ */ s("span", { className: "a3d-row a3d-row-end", children: [
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: r, children: "Cancel" }),
      /* @__PURE__ */ e("button", { type: "submit", className: "a3d-btn a3d-btn-primary", children: "Save" })
    ] })
  ] }) });
}
const bn = { modelsRoot: "" }, wi = `"""Blender readiness for the AI3D Forge panel. Run as:  python3 - <workspace> <blender_bin or auto>  (source on stdin).
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
async function yi(t, n) {
  const a = await t.exec(`python3 - ${g(t.workspacePath)} ${g(n || "auto")} <<'A3D_BL'
${wi}
A3D_BL`, { timeout: 6e4 });
  if (!a.success) throw new Error(a.stderr.trim().split(`
`).pop() || "Blender check failed");
  return JSON.parse(a.stdout.trim().split(`
`).pop() ?? "{}");
}
async function vi(t, n, a, r, o, u) {
  const f = Object.entries(u).filter(([, y]) => y !== "").map(([y, _]) => g(`${y}=${_}`)).join(" "), b = await t.exec(`${g(n)} -b --factory-startup -P ${g(a)} -- ${r} ${g(o)} ${f}`, { timeout: 9e5, maxBuffer: 2e7 }), S = (b.stdout ?? "").split(`
`).reverse().find((y) => y.startsWith("A3D_RESULT "));
  if (S) return JSON.parse(S.slice(11));
  const k = `${b.stderr ?? ""}
${b.stdout ?? ""}`.trim().split(`
`).filter(Boolean).slice(-3).join(" · ");
  return { ok: !1, command: r, problems: [`Blender did not finish: ${k || "no output"}`], crashed: !0 };
}
async function Ni(t, n, a) {
  const r = Ft() && (!n || n.includes(".app/"));
  if (!a) return t.exec(r ? "open -a Blender" : `nohup ${g(n ?? "blender")} >/dev/null 2>&1 &`, { timeout: 15e3 });
  const o = a.split(".").pop()?.toLowerCase() ?? "";
  if (o === "blend") {
    const S = r ? `open -a Blender ${g(a)}` : `nohup ${g(n ?? "blender")} ${g(a)} >/dev/null 2>&1 &`;
    return t.exec(S, { timeout: 15e3 });
  }
  const u = JSON.stringify(a), b = `import bpy; bpy.ops.wm.read_homefile(use_empty=True); ${o === "stl" ? `bpy.ops.wm.stl_import(filepath=${u})` : o === "obj" ? `bpy.ops.wm.obj_import(filepath=${u})` : o === "fbx" ? `bpy.ops.import_scene.fbx(filepath=${u})` : `bpy.ops.import_scene.gltf(filepath=${u})`}`;
  return t.exec(`nohup ${g(n ?? "blender")} --python-expr ${g(b)} >/dev/null 2>&1 &`, { timeout: 15e3 });
}
function Bt(t) {
  if (!t.ok && t.problems?.length) return t.problems.join(" ");
  const n = t.after ?? t.analysis, a = t.before, r = [];
  return t.command === "flexi" && t.flexi && r.push(`${t.flexi.joints ?? "?"} joints`), n?.overhang_pct != null && r.push(`overhang ${n.overhang_pct} %${a?.overhang_pct != null ? ` (was ${a.overhang_pct} %)` : ""}`), t.side_on_bed && r.push(`${t.side_on_bed} on bed`), n?.size_mm && r.push(`${n.size_mm.map((o) => Math.round(o)).join("×")} mm`), n?.watertight === !1 && r.push("not watertight"), r.join(", ") || (t.files?.length ? `wrote ${t.files.join(", ")}` : "done");
}
function ki(t) {
  return t ? t.bin ? t.mcp.some((n) => n.forSessions) ? "ready" : "partial" : "missing" : "unknown";
}
const ln = (t) => t?.match(/\d+\.\d+(\.\d+)?/)?.[0] ?? "";
function $i({ status: t, checking: n, onClick: a }) {
  const r = ki(t), o = n ? "checking…" : r === "ready" ? `${ln(t.version)} · MCP` : r === "partial" ? `${ln(t.version)} · no MCP` : r === "missing" ? "not found" : "";
  return /* @__PURE__ */ s("button", { type: "button", className: `a3d-chip a3d-chip-${r}`, onClick: a, title: "Blender and the Blender MCP: status, setup guide", children: [
    /* @__PURE__ */ e("i", { "aria-hidden": "true" }),
    "Blender ",
    /* @__PURE__ */ e("span", { className: "a3d-muted", children: o })
  ] });
}
function lt({ ok: t, label: n, value: a, hint: r }) {
  return /* @__PURE__ */ s("div", { className: "a3d-status-row", children: [
    /* @__PURE__ */ e("span", { className: t === null ? "a3d-st a3d-st-unknown" : t ? "a3d-st a3d-st-ok" : "a3d-st a3d-st-bad", "aria-hidden": "true", children: t === null ? "?" : t ? "✓" : "✕" }),
    /* @__PURE__ */ e("span", { className: "a3d-status-label", children: n }),
    /* @__PURE__ */ s("span", { className: "a3d-status-value", children: [
      a,
      r && /* @__PURE__ */ s("span", { className: "a3d-muted", children: [
        " — ",
        r
      ] })
    ] })
  ] });
}
function _i({ status: t, checking: n, kilnInstalled: a, guide: r, onCheck: o, onGuide: u, onLaunch: f, onClose: b }) {
  const S = t?.mcp.filter((y) => y.forSessions) ?? [], k = t?.mcp.filter((y) => !y.forSessions) ?? [];
  return /* @__PURE__ */ e("div", { className: "a3d-overlay", onClick: b, children: /* @__PURE__ */ s("div", { className: "a3d-dialog a3d-dialog-wide", role: "dialog", "aria-label": "Blender", onClick: (y) => y.stopPropagation(), children: [
    /* @__PURE__ */ e("h3", { children: "Blender" }),
    /* @__PURE__ */ e("p", { className: "a3d-muted", children: "The Kiln agent drives your open Blender through the Blender MCP. The quick tools in the Blender step run a background Blender and need only the app." }),
    /* @__PURE__ */ s("div", { className: "a3d-status", children: [
      /* @__PURE__ */ e(
        lt,
        {
          ok: t ? !!t.bin : null,
          label: "Blender app",
          value: t?.bin ? `${t.version ?? "version unknown"}` : "not found",
          hint: t?.bin ? t.bin : "install it into /Applications, or set “Blender executable” in Settings"
        }
      ),
      /* @__PURE__ */ e(
        lt,
        {
          ok: t?.running ?? null,
          label: "Running",
          value: t?.running ? "yes" : t?.running === !1 ? "no" : "unknown",
          hint: t?.running ? void 0 : "the agent needs Blender open with the MCP add-on server started"
        }
      ),
      /* @__PURE__ */ e(
        lt,
        {
          ok: t ? S.length > 0 : null,
          label: "MCP for agent sessions",
          value: S.length ? S.map((y) => `${y.name} (${y.where})`).join(", ") : "not registered for Claude Code",
          hint: S.length ? void 0 : k.length ? "found only in the Claude desktop app, which Nimbalyst sessions do not read" : "see the setup guide, step 3"
        }
      ),
      /* @__PURE__ */ e(lt, { ok: a, label: "Kiln scripts", value: a ? "installed" : "not found", hint: a ? void 0 : "update the AI3D Forge module" })
    ] }),
    /* @__PURE__ */ s("p", { className: "a3d-muted a3d-small", children: [
      "⚠ The panel cannot see inside an agent session: “registered” means the config has it, not that this session connected. In a session, ",
      /* @__PURE__ */ e("code", { children: "/mcp" }),
      " shows the live state."
    ] }),
    /* @__PURE__ */ s("span", { className: "a3d-row a3d-row-end", children: [
      r && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: u, children: "Setup guide" }),
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", disabled: !t?.bin, onClick: f, children: "Open Blender" }),
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", disabled: n, onClick: o, children: n ? "Checking…" : "Check again" }),
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-primary", onClick: b, children: "Close" })
    ] })
  ] }) });
}
const Ci = ["auto", "bottom", "back", "front", "left", "right", "top"];
function xi({ cmd: t, model: n, initial: a, onCancel: r, onRun: o }) {
  const u = String(n.meta.scale_mm ?? ""), [f, b] = O(() => ({
    ...t === "prep" ? { height: u || "100", orient: "auto", cut: "1.0", voxel: "" } : { segments: "6", clearance: "0.4", gap: "1.5", pin_d: "3.0" },
    ...a ?? {}
  })), [S, k] = O(""), y = (D, C) => b((P) => ({ ...P, [D]: C })), _ = (D, C, P, M = "0.1") => /* @__PURE__ */ s("label", { children: [
    C,
    /* @__PURE__ */ e("input", { type: "number", step: M, min: "0", value: f[D] ?? "", onChange: (B) => y(D, B.target.value) }),
    /* @__PURE__ */ e("span", { className: "a3d-muted a3d-small", children: P })
  ] }, D);
  return /* @__PURE__ */ e("div", { className: "a3d-overlay", onClick: r, children: /* @__PURE__ */ s("form", { className: "a3d-dialog a3d-dialog-wide", onClick: (D) => D.stopPropagation(), onSubmit: (D) => {
    D.preventDefault(), o({ cmd: t, opts: f, description: S.trim() });
  }, children: [
    /* @__PURE__ */ e("h3", { children: t === "prep" ? "Quick prep in Blender" : "Flexi joints in Blender" }),
    /* @__PURE__ */ e("p", { className: "a3d-muted", children: "Runs in a background Blender, no agent, no tokens. It becomes a new attempt in the graph; the current print.stl is kept in mesh/attempts/." }),
    /* @__PURE__ */ e("div", { className: "a3d-form-grid", children: t === "prep" ? /* @__PURE__ */ s(J, { children: [
      _("height", "Size (mm)", "tallest dimension after scaling", "1"),
      /* @__PURE__ */ s("label", { children: [
        "Side on the bed",
        /* @__PURE__ */ e("select", { value: f.orient, onChange: (D) => y("orient", D.target.value), children: Ci.map((D) => /* @__PURE__ */ e("option", { value: D, children: D }, D)) }),
        /* @__PURE__ */ e("span", { className: "a3d-muted a3d-small", children: "auto picks the lowest overhang among stable sides" })
      ] }),
      _("cut", "Flat cut (mm)", "sliced off the bed side for a flat base"),
      _("voxel", "Voxel size (mm)", "empty = automatic; smaller keeps detail, slower")
    ] }) : /* @__PURE__ */ s(J, { children: [
      _("segments", "Segments", "number of body parts", "1"),
      _("clearance", "Clearance (mm)", "gap in the joint; use your coupon result", "0.05"),
      _("gap", "Gap between segments (mm)", "cut width"),
      _("pin_d", "Pin diameter (mm)", "smaller for narrow bodies")
    ] }) }),
    /* @__PURE__ */ s("label", { children: [
      "Description: what is different this time",
      /* @__PURE__ */ e("textarea", { rows: 2, value: S, onChange: (D) => k(D.target.value), placeholder: t === "prep" ? "Back on the bed instead of bottom: the belly has the detail." : "Six segments, clearance from the coupon." })
    ] }),
    /* @__PURE__ */ s("span", { className: "a3d-row a3d-row-end", children: [
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: r, children: "Cancel" }),
      /* @__PURE__ */ e("button", { type: "submit", className: "a3d-btn a3d-btn-primary", children: "Run in Blender" })
    ] })
  ] }) });
}
function Si({ model: t, status: n, kilnRun: a, busy: r, last: o, onRun: u, onPrep: f, onFlexi: b, onOpen: S, onCommand: k, onSetup: y }) {
  const _ = !!n?.bin && !!a && !r, D = t.files.mesh.find((d) => /^raw\./i.test(d.name)), C = t.files.mesh.find((d) => d.name === "print.stl") ?? t.files.mesh.find((d) => d.name === "clean.stl"), P = t.files.mesh.find((d) => d.name === "work.blend"), M = n ? n.bin ? a ? null : "Kiln scripts not found: update the module." : "Blender not found." : "Checking Blender…", B = o?.command === "analyze" ? o.orientations ?? [] : [], T = o?.analysis ?? o?.after;
  return /* @__PURE__ */ s("section", { className: "a3d-block", children: [
    /* @__PURE__ */ s("h4", { children: [
      "Blender quick tools ",
      /* @__PURE__ */ e("span", { className: "a3d-muted", children: "no agent, no tokens" })
    ] }),
    M && /* @__PURE__ */ s("p", { className: "a3d-muted", children: [
      M,
      " ",
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: y, children: "Blender setup" })
    ] }),
    /* @__PURE__ */ s("p", { className: "a3d-row", children: [
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", disabled: !_ || !D && !C, onClick: () => u("analyze"), children: r === "analyze" ? "Analyzing…" : "Analyze" }),
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", disabled: !_ || !D, onClick: f, title: D ? "" : "needs mesh/raw.*", children: r === "prep" ? "Preparing…" : "Quick prep…" }),
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", disabled: !_ || !C, onClick: b, title: C ? "" : "needs mesh/print.stl", children: r === "flexi" ? "Building joints…" : "Flexi…" }),
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", disabled: !_ || !D && !C, onClick: () => u("render"), children: r === "render" ? "Rendering…" : "Render previews" }),
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", disabled: !_, onClick: () => u("coupon"), children: r === "coupon" ? "Exporting…" : "Clearance coupon" })
    ] }),
    /* @__PURE__ */ s("p", { className: "a3d-row", children: [
      /* @__PURE__ */ e("span", { className: "a3d-muted", children: "Open in Blender:" }),
      P && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", disabled: !n?.bin, onClick: () => S("mesh/work.blend"), children: "work.blend" }),
      C && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", disabled: !n?.bin, onClick: () => S(`mesh/${C.name}`), children: C.name }),
      D && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", disabled: !n?.bin, onClick: () => S(`mesh/${D.name}`), children: D.name }),
      /* @__PURE__ */ e("span", { className: "a3d-tabs-spacer" }),
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: k, title: "Kiln agent runs one instruction in your open Blender", children: "Blender command…" })
    ] }),
    r && /* @__PURE__ */ e("p", { className: "a3d-muted", children: "Running in a background Blender. Voxel remesh on a large mesh can take a minute or two." }),
    o && !r && /* @__PURE__ */ s("div", { className: o.ok ? "a3d-kiln-result" : "a3d-kiln-result a3d-kiln-bad", children: [
      /* @__PURE__ */ s("p", { children: [
        /* @__PURE__ */ s("strong", { children: [
          o.command === "analyze" ? "Analysis" : o.command === "prep" ? "Quick prep" : o.command === "flexi" ? "Flexi" : o.command === "render" ? "Render" : "Coupon",
          o.ok ? "" : " — problem",
          ":"
        ] }),
        " ",
        Bt(o)
      ] }),
      T && o.command === "analyze" && /* @__PURE__ */ s("dl", { className: "a3d-metrics", children: [
        T.size_mm && /* @__PURE__ */ s("div", { className: "a3d-metric", children: [
          /* @__PURE__ */ e("dt", { children: "Size" }),
          /* @__PURE__ */ s("dd", { children: [
            T.size_mm.join(" × "),
            " mm"
          ] })
        ] }),
        T.watertight != null && /* @__PURE__ */ s("div", { className: T.watertight ? "a3d-metric a3d-good" : "a3d-metric a3d-bad", children: [
          /* @__PURE__ */ e("dt", { children: "Watertight" }),
          /* @__PURE__ */ e("dd", { children: T.watertight ? "yes" : "no" })
        ] }),
        T.shells != null && /* @__PURE__ */ s("div", { className: "a3d-metric", children: [
          /* @__PURE__ */ e("dt", { children: "Shells" }),
          /* @__PURE__ */ e("dd", { children: T.shells })
        ] }),
        T.overhang_pct != null && /* @__PURE__ */ s("div", { className: "a3d-metric", children: [
          /* @__PURE__ */ e("dt", { children: "Overhang" }),
          /* @__PURE__ */ s("dd", { children: [
            T.overhang_pct,
            " %"
          ] })
        ] }),
        T.triangles != null && /* @__PURE__ */ s("div", { className: "a3d-metric", children: [
          /* @__PURE__ */ e("dt", { children: "Triangles" }),
          /* @__PURE__ */ e("dd", { children: Number(T.triangles).toLocaleString() })
        ] })
      ] }),
      B.length > 0 && /* @__PURE__ */ s("table", { className: "a3d-filetable a3d-orient", children: [
        /* @__PURE__ */ e("thead", { children: /* @__PURE__ */ s("tr", { children: [
          /* @__PURE__ */ e("th", { children: "Side on bed" }),
          /* @__PURE__ */ e("th", { children: "Overhang" }),
          /* @__PURE__ */ e("th", { children: "Height" }),
          /* @__PURE__ */ e("th", { children: "Stable" })
        ] }) }),
        /* @__PURE__ */ e("tbody", { children: B.map((d) => /* @__PURE__ */ s("tr", { children: [
          /* @__PURE__ */ e("td", { children: d.side }),
          /* @__PURE__ */ s("td", { className: "a3d-num", children: [
            d.overhang_pct,
            " %"
          ] }),
          /* @__PURE__ */ e("td", { className: "a3d-num", children: d.height_mm != null ? `${d.height_mm} mm` : "" }),
          /* @__PURE__ */ e("td", { children: d.stable == null ? "" : d.stable ? "yes" : "no" })
        ] }, d.side)) })
      ] }),
      o.command === "analyze" && /* @__PURE__ */ s("p", { className: "a3d-muted a3d-small", children: [
        "Measured on ",
        String(o.source ?? ""),
        "."
      ] })
    ] })
  ] });
}
const ji = `"""Place files the user picked into the right folder of a model. Run by the Nimbalyst panel:
    python3 - <model dir> <image|mesh> <move|copy> <source path>...   (source on stdin)
Images go to inbox/. Meshes: .glb/.gltf/.obj/.fbx become mesh/raw.<ext> (the previous raw.* is archived to
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
    if kind == "image":
        if ext not in IMG:
            skipped.append({"file": base, "why": "not an image (png, jpg, webp, gif)"})
            continue
        folder, name = "inbox", None
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
`, zt = ["png", "jpg", "jpeg", "webp", "gif"], Kt = ["glb", "gltf", "obj", "fbx", "stl", "3mf"], Di = (t) => {
  const n = t.split(".").pop()?.toLowerCase() ?? "";
  return zt.includes(n) ? "image" : Kt.includes(n) ? "mesh" : null;
};
async function St(t, n) {
  if (!Ft()) return null;
  const a = (n === "image" ? zt : Kt).map((f) => `"${f}"`).join(", "), o = [
    'tell application "Finder" to activate',
    `tell application "Finder" to set fs to choose file with prompt "${n === "image" ? "Choose the generated image(s)" : "Choose the 3D file (GLB, STL, 3MF…)"}" of type {${a}} with multiple selections allowed`,
    'set out to ""',
    "repeat with f in fs",
    "set out to out & POSIX path of f & linefeed",
    "end repeat",
    "return out"
  ].map((f) => `-e ${g(f)}`).join(" "), u = await t.exec(`osascript ${o}`, { timeout: 6e5 });
  return u.success ? u.stdout.split(`
`).map((f) => f.trim()).filter(Boolean) : /-128|cancel/i.test(u.stderr) ? [] : null;
}
function Ai(t) {
  let n = "";
  for (let a = 0; a < t.length; a += 32768) n += String.fromCharCode(...t.subarray(a, a + 32768));
  return btoa(n);
}
async function wn(t, n, a) {
  const r = `${n}/.import-tmp`, o = `${r}/${a.name.replace(/[^\w.\- ]+/g, "_")}`, u = await t.exec(`mkdir -p ${g(r)} && : > ${g(o)}`, { timeout: 15e3 });
  if (!u.success) throw new Error(u.stderr.trim() || "could not create the temporary file");
  const f = 6e4;
  if (a.size > 12e7) throw new Error(`${a.name} is too large to add this way; copy it into the model folder instead`);
  for (let b = 0; b < a.size; b += f) {
    const S = new Uint8Array(await a.slice(b, b + f).arrayBuffer()), k = await t.exec(
      `python3 -c "import sys,base64;open(sys.argv[1],'ab').write(base64.b64decode(sys.stdin.read()))" ${g(o)} <<'A3D_B64'
${Ai(S)}
A3D_B64`,
      { timeout: 6e4 }
    );
    if (!k.success) throw new Error(k.stderr.trim() || `upload of ${a.name} failed`);
  }
  return o;
}
async function Rt(t, n, a, r, o) {
  const u = await t.exec(
    `python3 - ${g(n)} ${a} ${r} ${o.map(g).join(" ")} <<'A3D_IMPORT'
${ji}
A3D_IMPORT`,
    { timeout: 12e4 }
  );
  if (!u.success) throw new Error(u.stderr.trim().split(`
`).pop() || "import failed");
  return JSON.parse(u.stdout.trim().split(`
`).pop() ?? "{}");
}
function Ei(t, n, a, r) {
  return Rt(t, n, a, "copy", r);
}
async function Pi(t, n, a, r) {
  const o = r.map((b) => b.path).filter((b) => !!b);
  if (o.length === r.length) return Rt(t, n, a, "copy", o);
  const u = [];
  for (const b of r) u.push(await wn(t, n, b));
  const f = await Rt(t, n, a, "move", u);
  return t.exec(`rmdir ${g(`${n}/.import-tmp`)} 2>/dev/null; true`, { timeout: 1e4 }), f;
}
function Bi(t) {
  const n = [];
  t.placed.length && n.push(`Added ${t.placed.map((r) => r.file).join(", ")}.`);
  const a = t.placed.filter((r) => r.archived).map((r) => r.archived);
  return a.length && n.push(`The previous file was kept as ${a.join(", ")}.`), t.skipped.length && n.push(`Skipped: ${t.skipped.map((r) => `${r.file} (${r.why})`).join("; ")}.`), n.join(" ") || "Nothing was added.";
}
const rt = /\.(png|jpe?g|webp|gif)$/i, rn = /\.(stl|3mf|glb|gltf|obj|fbx|blend)$/i, jt = /\.(md|json|txt|ya?ml)$/i;
function Dt(t, n) {
  const a = (o, u, f) => u.filter((b) => f.test(b.name)).map((b) => ({ rel: `${o}/${b.name}`, f: b }));
  if (n === "images") return [...a("inbox", t.files.inbox, rt), ...a("images", t.files.images, rt), ...a("renders", t.files.renders, rt), ...a("refs", t.files.refs, rt)];
  if (n === "meshes") return [...a("mesh", t.files.mesh, rn), ...a("print", t.files.print, /\.3mf$/i), ...a("mesh/attempts", t.attempts, rn)];
  const r = [];
  return t.concept && r.push({ rel: "concept.md", f: { name: "concept.md", size: t.concept.length, mtime: t.stamp } }), t.hasReadme && r.push({ rel: "README.md", f: { name: "README.md", size: 0, mtime: t.stamp } }), [...r, ...a("prompts", t.files.prompts, jt), ...a("print", t.files.print, jt), ...a("publish", t.files.publish, jt)];
}
const on = (t) => new Date(t * 1e3).toLocaleDateString([], { month: "short", day: "numeric" });
function dn({ host: t, model: n, type: a, rows: r, onZoom: o, onOpen: u, onReveal: f, onView: b }) {
  const S = /* @__PURE__ */ new Map();
  for (const k of n.flow.nodes) for (const y of k.files) S.set(y, k.label);
  return r.length ? a === "images" ? /* @__PURE__ */ e("div", { className: "a3d-gallery a3d-gallery-files", children: r.map(({ rel: k, f: y }) => {
    const _ = `${n.dir}/${k}`;
    return /* @__PURE__ */ s("figure", { children: [
      /* @__PURE__ */ e(Ne, { host: t, path: _, mtime: y.mtime, alt: y.name, onClick: () => o({ path: _, mtime: y.mtime, name: k }) }),
      /* @__PURE__ */ s("figcaption", { title: k, children: [
        /* @__PURE__ */ e("span", { className: "a3d-file-folder", children: k.split("/")[0] }),
        " ",
        y.name
      ] }),
      /* @__PURE__ */ s("span", { className: "a3d-fig-actions", children: [
        /* @__PURE__ */ e("span", { className: "a3d-muted", children: S.get(k) ?? on(y.mtime) }),
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: () => f(n, k), children: "Show in Finder" })
      ] })
    ] }, k);
  }) }) : /* @__PURE__ */ s("table", { className: "a3d-filetable", children: [
    /* @__PURE__ */ e("thead", { children: /* @__PURE__ */ s("tr", { children: [
      /* @__PURE__ */ e("th", { children: "File" }),
      /* @__PURE__ */ e("th", { children: "Size" }),
      /* @__PURE__ */ e("th", { children: "Date" }),
      /* @__PURE__ */ e("th", { children: "From attempt" }),
      /* @__PURE__ */ e("th", { children: /* @__PURE__ */ e("span", { className: "a3d-sr", children: "Actions" }) })
    ] }) }),
    /* @__PURE__ */ e("tbody", { children: r.map(({ rel: k, f: y }) => /* @__PURE__ */ s("tr", { children: [
      /* @__PURE__ */ s("td", { children: [
        /* @__PURE__ */ e("span", { className: "a3d-file-folder", children: k.slice(0, k.lastIndexOf("/") + 1) }),
        /* @__PURE__ */ e("strong", { children: y.name }),
        /^mesh\/print\.stl$/.test(k) && /* @__PURE__ */ e("span", { className: "a3d-pill a3d-pill-done", children: "to print" }),
        /^mesh\/raw\./.test(k) && /* @__PURE__ */ e("span", { className: "a3d-pill", children: "as generated" })
      ] }),
      /* @__PURE__ */ e("td", { className: "a3d-num", children: y.size ? un(y.size) : "" }),
      /* @__PURE__ */ e("td", { className: "a3d-num", children: on(y.mtime) }),
      /* @__PURE__ */ e("td", { className: "a3d-muted", children: S.get(k) ?? "" }),
      /* @__PURE__ */ e("td", { children: /* @__PURE__ */ s("span", { className: "a3d-row a3d-row-end", children: [
        b && /\.stl$/i.test(y.name) && k.startsWith("mesh/") && !k.includes("attempts") && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => b(n), children: "3D view" }),
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => u(n, k), children: a === "docs" ? "Open" : /\.(stl|3mf)$/i.test(y.name) ? "Open in slicer" : "Open in app" }),
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => f(n, k), children: "Show in Finder" })
      ] }) })
    ] }, k)) })
  ] }) : /* @__PURE__ */ e("p", { className: "a3d-muted a3d-files-empty", children: a === "images" ? "No images." : a === "meshes" ? "No 3D files." : "No documents." });
}
function Ri({ host: t, scan: n, model: a, nodeFilter: r, importing: o, onClearFilter: u, onSelectModel: f, onZoom: b, onOpen: S, onReveal: k, onView: y, onPick: _, onFiles: D }) {
  const [C, P] = O("images"), [M, B] = O(!1), T = Te(null), [d, p] = O("image"), j = a && r ? a.flow.nodes.find(($) => $.id === r) ?? null : null, m = n.models.filter(($) => $.slug !== a?.slug), v = ($, A) => Dt($, A).length, c = async ($) => {
    await _($) || (p($), setTimeout(() => T.current?.click(), 0));
  }, w = a ? Dt(a, C).filter(($) => !j || j.files.includes($.rel)) : [];
  return /* @__PURE__ */ s("section", { className: "a3d-files-tab", children: [
    /* @__PURE__ */ s("header", { className: "a3d-head", children: [
      /* @__PURE__ */ s("div", { children: [
        /* @__PURE__ */ e("h1", { children: "Files" }),
        /* @__PURE__ */ e("p", { className: "a3d-muted", children: a ? /* @__PURE__ */ e(J, { children: "The selected model first, every other model below." }) : "Pick a model in Models to see its files first." })
      ] }),
      /* @__PURE__ */ e("span", { className: "a3d-seg", role: "group", "aria-label": "File type", children: [["images", "Images"], ["meshes", "3D files"], ["docs", "Documents"]].map(([$, A]) => /* @__PURE__ */ s("button", { type: "button", "aria-pressed": C === $, onClick: () => P($), children: [
        A,
        a ? ` ${v(a, $)}` : ""
      ] }, $)) })
    ] }),
    a && /* @__PURE__ */ s(
      "section",
      {
        className: M ? "a3d-files-current a3d-drop-over" : "a3d-files-current",
        onDragOver: ($) => {
          $.preventDefault(), B(!0);
        },
        onDragLeave: () => B(!1),
        onDrop: ($) => {
          $.preventDefault(), B(!1);
          const A = Array.from($.dataTransfer.files);
          A.length && D(A);
        },
        children: [
          /* @__PURE__ */ s("div", { className: "a3d-files-bar", children: [
            /* @__PURE__ */ e("h3", { children: a.meta.title || a.slug }),
            /* @__PURE__ */ s("span", { className: "a3d-row", children: [
              /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-primary", disabled: o, onClick: () => {
                c("image");
              }, children: "Add image…" }),
              /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-primary", disabled: o, onClick: () => {
                c("mesh");
              }, children: "Add 3D model…" }),
              /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => k(a, ""), children: "Show folder in Finder" })
            ] })
          ] }),
          /* @__PURE__ */ e("p", { className: "a3d-muted a3d-files-hint", children: o ? "Adding files…" : "Or drop files here. Images go to inbox/, a GLB becomes mesh/raw.glb (the previous one is kept in mesh/attempts/), STL goes to mesh/, 3MF to print/." }),
          j && /* @__PURE__ */ s("p", { className: "a3d-banner", children: [
            "Only the files of the attempt “",
            j.label,
            "”.",
            /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: u, children: "Show all files" })
          ] }),
          /* @__PURE__ */ e(dn, { host: t, model: a, type: C, rows: w, onZoom: b, onOpen: S, onReveal: k, onView: y }),
          /* @__PURE__ */ e(
            "input",
            {
              ref: T,
              type: "file",
              multiple: !0,
              hidden: !0,
              accept: (d === "image" ? zt : Kt).map(($) => `.${$}`).join(","),
              onChange: ($) => {
                const A = Array.from($.target.files ?? []);
                $.target.value = "", A.length && D(A);
              }
            }
          )
        ]
      }
    ),
    m.length > 0 && /* @__PURE__ */ s("section", { className: "a3d-files-others", children: [
      /* @__PURE__ */ e("h3", { className: "a3d-files-others-title", children: "Other models" }),
      m.map(($) => /* @__PURE__ */ s("details", { children: [
        /* @__PURE__ */ s("summary", { children: [
          /* @__PURE__ */ e("span", { className: "a3d-files-name", children: $.meta.title || $.slug }),
          /* @__PURE__ */ s("span", { className: "a3d-muted", children: [
            v($, C),
            " ",
            C === "images" ? "images" : C === "meshes" ? "3D files" : "documents"
          ] }),
          /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: (A) => {
            A.preventDefault(), f($.slug);
          }, children: "Select" })
        ] }),
        /* @__PURE__ */ e(dn, { host: t, model: $, type: C, rows: Dt($, C), onZoom: b, onOpen: S, onReveal: k })
      ] }, $.slug))
    ] })
  ] });
}
const Ie = [
  { id: "demand", label: "Demand" },
  { id: "print_fit", label: "Print fit" },
  { id: "differentiation", label: "Stand-out" },
  { id: "ip_safety", label: "IP safety" },
  { id: "ease", label: "Ease" }
], Oi = [
  { label: "Bambu A1 mini", value: "180x180x180" },
  { label: "Bambu A1 / P1 / X1", value: "256x256x256" },
  { label: "Prusa MK4", value: "250x210x220" }
], yn = [
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
    title: "Idea scoring",
    fields: [
      { key: "score_weights", label: "Weights", help: "How much each dimension counts in the Prism ranking (0 = ignore, 5 = most important).", kind: "weights", def: "demand=3,print_fit=3,differentiation=2,ip_safety=2,ease=1" }
    ]
  }
], Ti = yn.flatMap((t) => t.fields), Li = Object.fromEntries(Ti.map((t) => [t.key, t.def]));
function cn(t) {
  const n = (t.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  return n.length === 1 ? [n[0], n[0], n[0]] : n.length >= 3 ? [n[0], n[1], n[2]] : [256, 256, 256];
}
const Ii = (t) => t.join("x");
function vn(t) {
  const n = Object.fromEntries(Ie.map((a) => [a.id, 1]));
  for (const a of t.split(/[,\s]+/)) {
    const [r, o] = a.split("=");
    r in n && o !== void 0 && !Number.isNaN(Number(o)) && (n[r] = Number(o));
  }
  return n;
}
const Mi = (t) => Ie.map((n) => `${n.id}=${t[n.id]}`).join(",");
function Fi(t) {
  const n = {};
  for (const a of t.split(/\r?\n/)) {
    const r = a.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*(?:#.*)?$/);
    r && r[2] !== "" && (n[r[1]] = r[2].trim().replace(/^["']|["']$/g, ""));
  }
  return n;
}
const pn = (t) => `"${t.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
function zi(t, n) {
  let a = t;
  const r = [];
  for (const [o, u] of Object.entries(n)) {
    const f = new RegExp(`^${o}\\s*:.*$`, "m");
    f.test(a) ? a = a.replace(f, () => `${o}: ${pn(u)}`) : r.push(`${o}: ${pn(u)}`);
  }
  if (r.length) {
    const o = (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d+Z$/, "Z");
    a = `${a.replace(/\n*$/, `
`)}
# AI3D Forge values (set from the Nimbalyst panel, ${o})
${r.join(`
`)}
`;
  }
  return a;
}
Object.fromEntries(Ie.map((t) => [t.id, t.label]));
function He(t, n) {
  const a = vn(n ?? ""), r = t.scores ?? {};
  let o = 0, u = 0;
  for (const f of Ie) {
    const b = r[f.id];
    if (typeof b != "number") return null;
    o += a[f.id] * (b - 1) / 4, u += a[f.id];
  }
  return u ? Math.round(100 * o / u) : null;
}
function Ot({ value: t }) {
  return t == null ? /* @__PURE__ */ e("span", { className: "a3d-muted", children: "not scored" }) : /* @__PURE__ */ s("span", { className: "a3d-scorebar", title: `${t} of 100`, children: [
    /* @__PURE__ */ e("span", { className: "a3d-track", children: /* @__PURE__ */ e("i", { style: { width: `${t}%` } }) }),
    /* @__PURE__ */ e("b", { children: t })
  ] });
}
function Ki({ s: t }) {
  const n = new Set(t.estimated ?? []);
  return /* @__PURE__ */ e("dl", { className: "a3d-dims", children: Ie.map((a) => {
    const r = t.scores?.[a.id];
    return /* @__PURE__ */ s("div", { children: [
      /* @__PURE__ */ s("dt", { children: [
        a.label,
        n.has(a.id) ? /* @__PURE__ */ e("span", { className: "a3d-muted", title: "estimated, no source", children: " ~" }) : null
      ] }),
      /* @__PURE__ */ s("dd", { children: [
        /* @__PURE__ */ e("span", { className: "a3d-dimbar", "aria-hidden": "true", children: [1, 2, 3, 4, 5].map((o) => /* @__PURE__ */ e("i", { className: typeof r == "number" && o <= r ? "on" : "" }, o)) }),
        /* @__PURE__ */ e("span", { children: typeof r == "number" ? `${r} / 5` : "–" })
      ] })
    ] }, a.id);
  }) });
}
const Wi = ["animal", "character", "object", "other"];
function Gi({ onCancel: t, onCreate: n }) {
  const [a, r] = O(""), [o, u] = O("animal"), [f, b] = O(""), S = (k) => {
    a.trim() && n(a.trim(), o, f.trim(), k);
  };
  return /* @__PURE__ */ e("div", { className: "a3d-overlay", onClick: t, children: /* @__PURE__ */ s("form", { className: "a3d-dialog a3d-dialog-wide", onClick: (k) => k.stopPropagation(), onSubmit: (k) => {
    k.preventDefault(), S(!0);
  }, children: [
    /* @__PURE__ */ e("h3", { children: "New idea" }),
    /* @__PURE__ */ e("p", { className: "a3d-muted", children: "An animal, a character or a thing you want to turn into a model. It is saved in insights/ at once; preparing it is an agent run." }),
    /* @__PURE__ */ s("label", { children: [
      "Name",
      /* @__PURE__ */ e("input", { autoFocus: !0, value: a, onChange: (k) => r(k.target.value), placeholder: "Axolotl dragon" })
    ] }),
    /* @__PURE__ */ s("label", { children: [
      "Kind",
      /* @__PURE__ */ e("select", { value: o, onChange: (k) => u(k.target.value), children: Wi.map((k) => /* @__PURE__ */ e("option", { children: k }, k)) })
    ] }),
    /* @__PURE__ */ s("label", { children: [
      "What you have in mind",
      /* @__PURE__ */ e("textarea", { rows: 4, value: f, onChange: (k) => b(k.target.value), placeholder: "Chibi axolotl with small dragon wings, flexi, about 12 cm, for kids." })
    ] }),
    /* @__PURE__ */ s("span", { className: "a3d-row a3d-row-end", children: [
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: t, children: "Cancel" }),
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", disabled: !a.trim(), onClick: () => S(!1), children: "Save only" }),
      /* @__PURE__ */ e("button", { type: "submit", className: "a3d-btn a3d-btn-primary", disabled: !a.trim(), children: "Save and prepare (Muse)" })
    ] })
  ] }) });
}
function Vi({ host: t, scan: n, busy: a, selected: r, onSelect: o, onCreate: u, onAgent: f, onDecide: b, onSelectTrend: S, onSelectModel: k, onReveal: y, onOpen: _ }) {
  const [D, C] = O("open"), [P, M] = O(!1), B = n.config.score_weights, T = Le(() => n.ideas.filter((c) => D === "all" || !["no", "modeled"].includes(c.status)).sort((c, w) => (w.updated_at ?? "").localeCompare(c.updated_at ?? "")), [n.ideas, D]), d = n.ideas.find((c) => c.slug === r) ?? T[0] ?? null, p = d?.trend ? n.trends.find((c) => c.slug === d.trend) : null, j = d?.model ? n.models.find((c) => c.slug === d.model) : null, m = (d?._refs ?? []).filter((c) => /\.(png|jpe?g|webp|gif)$/i.test(c)), v = !!d && !j && (d.status === "go" || d.status === "prepared");
  return /* @__PURE__ */ s("section", { className: "a3d-trends", children: [
    /* @__PURE__ */ s("header", { className: "a3d-head", children: [
      /* @__PURE__ */ s("div", { children: [
        /* @__PURE__ */ e("h1", { children: "Insights" }),
        /* @__PURE__ */ e("p", { className: "a3d-muted", children: "Prepare an idea before it becomes a model: what makes it recognisable, references, variants and printability, what already exists, IP risk. Then go, later or no." })
      ] }),
      /* @__PURE__ */ e("span", { className: "a3d-row", children: /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-primary", onClick: () => M(!0), children: "New idea…" }) })
    ] }),
    /* @__PURE__ */ s("div", { className: "a3d-split", children: [
      /* @__PURE__ */ s("aside", { className: "a3d-split-list", children: [
        /* @__PURE__ */ s("span", { className: "a3d-seg a3d-seg-small", role: "group", "aria-label": "Filter", children: [
          /* @__PURE__ */ e("button", { type: "button", "aria-pressed": D === "open", onClick: () => C("open"), children: "Open" }),
          /* @__PURE__ */ e("button", { type: "button", "aria-pressed": D === "all", onClick: () => C("all"), children: "All" })
        ] }),
        T.length === 0 && /* @__PURE__ */ e("p", { className: "a3d-muted", children: "No ideas yet. Add one, or “Prepare” an idea from a trend." }),
        /* @__PURE__ */ e("ul", { children: T.map((c) => /* @__PURE__ */ e("li", { children: /* @__PURE__ */ s("button", { type: "button", className: c.slug === d?.slug ? "a3d-li a3d-li-sel" : "a3d-li", onClick: () => o(c.slug), children: [
          /* @__PURE__ */ s("span", { className: "a3d-li-title", children: [
            c.title,
            " ",
            /* @__PURE__ */ e("span", { className: `a3d-pill a3d-is-${c.status}`, children: c.status })
          ] }),
          /* @__PURE__ */ s("span", { className: "a3d-muted", children: [
            c.subject_kind,
            c.trend ? ` · from ${n.trends.find((w) => w.slug === c.trend)?.title ?? c.trend}` : ""
          ] }),
          /* @__PURE__ */ e(Ot, { value: He(c, B) })
        ] }) }, c.slug)) })
      ] }),
      d ? /* @__PURE__ */ s("article", { className: "a3d-split-detail", children: [
        /* @__PURE__ */ s("header", { className: "a3d-detail-top", children: [
          /* @__PURE__ */ s("div", { children: [
            /* @__PURE__ */ s("h2", { className: "a3d-h2", children: [
              d.title,
              " ",
              /* @__PURE__ */ e("span", { className: `a3d-pill a3d-is-${d.status}`, children: d.status }),
              d.subject_kind && /* @__PURE__ */ e("span", { className: "a3d-pill", children: d.subject_kind })
            ] }),
            /* @__PURE__ */ s("p", { className: "a3d-muted", children: [
              p ? /* @__PURE__ */ s(J, { children: [
                "From trend ",
                /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: () => S(p.slug), children: p.title }),
                " · "
              ] }) : null,
              j ? /* @__PURE__ */ s(J, { children: [
                "Model ",
                /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: () => k(j.slug), children: j.meta.title || j.slug }),
                " · "
              ] }) : null,
              d.decision ? `decided ${d.decision.verdict}${d.decision.reason ? `: ${d.decision.reason}` : ""}` : "no decision yet"
            ] })
          ] }),
          /* @__PURE__ */ s("span", { className: "a3d-row", children: [
            /* @__PURE__ */ e("span", { className: "a3d-muted", children: "Decision" }),
            ["go", "later", "no"].map((c) => /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", "aria-pressed": d.decision?.verdict === c, disabled: d.status === "modeled", onClick: () => b(d, c), children: c === "go" ? "Go" : c === "later" ? "Later" : "No" }, c))
          ] })
        ] }),
        d.description && /* @__PURE__ */ e("p", { className: "a3d-summary", children: d.description }),
        /* @__PURE__ */ s("p", { className: "a3d-row", children: [
          /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-primary", disabled: a, onClick: () => f("prepare", d), children: d.status === "draft" ? "Prepare (Muse)" : "Prepare again (Muse)" }),
          /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", disabled: a, onClick: () => f("score", d), children: "Score (Prism)" }),
          /* @__PURE__ */ e(
            "button",
            {
              type: "button",
              className: "a3d-btn",
              disabled: a || !v,
              onClick: () => f("concept", d),
              title: v ? "Muse creates the model from the brief and links it here" : j ? "already modeled" : "prepare it or decide Go first",
              children: "Create model"
            }
          ),
          d._files.includes("brief.md") && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => _(`${d._dir}/brief.md`), children: "Open brief" }),
          /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => y(d._dir), children: "Show in Finder" })
        ] }),
        /* @__PURE__ */ s("div", { className: "a3d-two", children: [
          /* @__PURE__ */ s("section", { className: "a3d-block", children: [
            /* @__PURE__ */ s("h4", { children: [
              "Scores ",
              /* @__PURE__ */ e(Ot, { value: He(d, B) })
            ] }),
            Object.keys(d.scores ?? {}).length ? /* @__PURE__ */ e(Ki, { s: d }) : /* @__PURE__ */ e("p", { className: "a3d-muted", children: "Not scored yet." }),
            (d.evidence ?? []).length > 0 && /* @__PURE__ */ e("ul", { className: "a3d-evidence", children: d.evidence.map((c, w) => /* @__PURE__ */ e("li", { children: c.url ? /* @__PURE__ */ e("a", { href: c.url, target: "_blank", rel: "noreferrer", children: c.label }) : c.label }, w)) })
          ] }),
          /* @__PURE__ */ s("section", { className: "a3d-block", children: [
            /* @__PURE__ */ e("h4", { children: "Recognisable traits" }),
            (d.traits ?? []).length ? /* @__PURE__ */ e("p", { className: "a3d-chips", children: d.traits.map((c) => /* @__PURE__ */ e("span", { className: "a3d-pill", children: c }, c)) }) : /* @__PURE__ */ e("p", { className: "a3d-muted", children: "Filled by Prepare." }),
            /* @__PURE__ */ e("h4", { children: "IP" }),
            /* @__PURE__ */ s("p", { children: [
              /* @__PURE__ */ e("span", { className: `a3d-pill a3d-risk-${d.ip?.risk ?? "unknown"}`, children: d.ip?.risk ?? "not assessed" }),
              " ",
              d.ip?.notes
            ] })
          ] })
        ] }),
        (d.variants ?? []).length > 0 && /* @__PURE__ */ s("section", { className: "a3d-block", children: [
          /* @__PURE__ */ e("h4", { children: "Variants" }),
          /* @__PURE__ */ s("table", { className: "a3d-filetable", children: [
            /* @__PURE__ */ e("thead", { children: /* @__PURE__ */ s("tr", { children: [
              /* @__PURE__ */ e("th", {}),
              /* @__PURE__ */ e("th", { children: "Type" }),
              /* @__PURE__ */ e("th", { children: "Style" }),
              /* @__PURE__ */ e("th", { children: "Size" }),
              /* @__PURE__ */ e("th", { children: "Printability" }),
              /* @__PURE__ */ e("th", { children: "Notes" })
            ] }) }),
            /* @__PURE__ */ e("tbody", { children: d.variants.map((c) => /* @__PURE__ */ s("tr", { children: [
              /* @__PURE__ */ e("td", { children: d.chosen_variant === c.id ? /* @__PURE__ */ e("span", { className: "a3d-pill a3d-pill-done", children: "chosen" }) : c.id }),
              /* @__PURE__ */ e("td", { children: c.model_type }),
              /* @__PURE__ */ e("td", { children: c.style }),
              /* @__PURE__ */ e("td", { className: "a3d-num", children: c.size_mm ? `${c.size_mm} mm` : "" }),
              /* @__PURE__ */ e("td", { className: "a3d-num", children: c.printability != null ? `${c.printability} / 5` : "" }),
              /* @__PURE__ */ e("td", { children: c.notes })
            ] }, c.id)) })
          ] })
        ] }),
        (m.length > 0 || (d.references ?? []).length > 0) && /* @__PURE__ */ s("section", { className: "a3d-block", children: [
          /* @__PURE__ */ e("h4", { children: "References" }),
          m.length > 0 && /* @__PURE__ */ e("div", { className: "a3d-gallery", children: m.map((c) => /* @__PURE__ */ s("figure", { children: [
            /* @__PURE__ */ e(Ne, { host: t, path: `${d._dir}/refs/${c}`, mtime: d._mtime, alt: c }),
            /* @__PURE__ */ e("figcaption", { children: c })
          ] }, c)) }),
          /* @__PURE__ */ e("ul", { className: "a3d-evidence", children: (d.references ?? []).map((c, w) => /* @__PURE__ */ s("li", { children: [
            c.url ? /* @__PURE__ */ e("a", { href: c.url, target: "_blank", rel: "noreferrer", children: c.title || c.url }) : c.title || c.file,
            c.note ? /* @__PURE__ */ s("span", { className: "a3d-muted", children: [
              " — ",
              c.note
            ] }) : null
          ] }, w)) })
        ] }),
        (d.similar ?? []).length > 0 && /* @__PURE__ */ s("section", { className: "a3d-block", children: [
          /* @__PURE__ */ e("h4", { children: "Already on the market" }),
          /* @__PURE__ */ s("table", { className: "a3d-filetable", children: [
            /* @__PURE__ */ e("thead", { children: /* @__PURE__ */ s("tr", { children: [
              /* @__PURE__ */ e("th", { children: "Model" }),
              /* @__PURE__ */ e("th", { children: "Downloads" }),
              /* @__PURE__ */ e("th", { children: "Price" }),
              /* @__PURE__ */ e("th", { children: "Note" })
            ] }) }),
            /* @__PURE__ */ e("tbody", { children: d.similar.map((c, w) => /* @__PURE__ */ s("tr", { children: [
              /* @__PURE__ */ e("td", { children: c.url ? /* @__PURE__ */ e("a", { href: c.url, target: "_blank", rel: "noreferrer", children: c.title || c.url }) : c.title }),
              /* @__PURE__ */ e("td", { className: "a3d-num", children: c.downloads ?? "" }),
              /* @__PURE__ */ e("td", { className: "a3d-num", children: c.price ?? "" }),
              /* @__PURE__ */ e("td", { children: c.note })
            ] }, w)) })
          ] })
        ] })
      ] }) : /* @__PURE__ */ e("div", { className: "a3d-placeholder", children: "Add an idea to prepare it." })
    ] }),
    P && /* @__PURE__ */ e(Gi, { onCancel: () => M(!1), onCreate: (...c) => {
      M(!1), u(...c);
    } })
  ] });
}
function Nn({ host: t, path: n, mtime: a, title: r }) {
  const [o, u] = O(null), [f, b] = O(null);
  ie(() => {
    let k = !0;
    return b(null), t.exec(`cat ${g(n)}`, { timeout: 2e4, maxBuffer: 3e7 }).then((y) => {
      k && (y.success ? u(y.stdout) : b(y.stderr.trim() || "Could not read the dashboard."));
    }), () => {
      k = !1;
    };
  }, [t, n, a]);
  const S = /dark/i.test(t.theme);
  return f ? /* @__PURE__ */ e("p", { className: "a3d-banner a3d-banner-error", children: f }) : o ? /* @__PURE__ */ e(
    "iframe",
    {
      className: "a3d-dash-frame",
      title: r,
      sandbox: "allow-scripts",
      srcDoc: o.replace('<html lang="en">', `<html lang="en" data-theme="${S ? "dark" : "light"}">`)
    }
  ) : /* @__PURE__ */ e("p", { className: "a3d-muted", children: "Loading the dashboard…" });
}
function Hi({ host: t, scan: n, stepsBySlug: a, selected: r, onSelect: o, onNew: u, onScout: f, onPortfolio: b, onSelectTrend: S }) {
  const [k, y] = O("cards"), _ = n.dashboards.find((d) => d.name === "portfolio.html"), D = n.models, C = (d) => (a[d] ?? []).find((p) => p.state === "active" || p.state === "waiting") ?? null, P = D.map((d) => ({ m: d, s: C(d.slug) })).filter((d) => d.s?.state === "waiting"), B = [
    ...(a[D[0]?.slug ?? ""] ?? []).map((d) => ({ id: d.id, title: d.title, items: D.map((p) => ({ m: p, s: C(p.slug) })).filter((p) => p.s?.id === d.id) })),
    { id: "done", title: "Done", items: D.map((d) => ({ m: d, s: C(d.slug) })).filter((d) => !d.s) }
  ], T = D.filter((d) => (a[d.slug] ?? []).some((p) => p.state === "waiting")).length;
  return /* @__PURE__ */ s("section", { className: "a3d-models-tab", children: [
    /* @__PURE__ */ s("header", { className: "a3d-head", children: [
      /* @__PURE__ */ s("div", { children: [
        /* @__PURE__ */ e("h1", { children: "Models" }),
        /* @__PURE__ */ s("p", { className: "a3d-muted", children: [
          D.length,
          " model",
          D.length === 1 ? "" : "s",
          " in ",
          /* @__PURE__ */ e("code", { children: n.root.startsWith(n.workspace) ? n.root.slice(n.workspace.length + 1) || "." : n.root }),
          T > 0 ? ` · ${T} waiting for you` : "",
          ". Pick one: Flow and Files follow it."
        ] })
      ] }),
      /* @__PURE__ */ s("span", { className: "a3d-row", children: [
        /* @__PURE__ */ s("span", { className: "a3d-seg", role: "group", "aria-label": "View", children: [
          /* @__PURE__ */ e("button", { type: "button", "aria-pressed": k === "cards", onClick: () => y("cards"), children: "Cards" }),
          /* @__PURE__ */ e("button", { type: "button", "aria-pressed": k === "board", onClick: () => y("board"), children: "Board" }),
          /* @__PURE__ */ e("button", { type: "button", "aria-pressed": k === "portfolio", onClick: () => y("portfolio"), children: "Portfolio" })
        ] }),
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: f, children: "Trends" }),
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-primary", onClick: u, children: "New model" })
      ] })
    ] }),
    P.length > 0 && k !== "portfolio" && /* @__PURE__ */ s("section", { className: "a3d-queue", "aria-label": "Waiting for you", children: [
      /* @__PURE__ */ s("h3", { children: [
        "Waiting for you ",
        /* @__PURE__ */ e("span", { className: "a3d-count", children: P.length })
      ] }),
      /* @__PURE__ */ e("ul", { children: P.map(({ m: d, s: p }) => /* @__PURE__ */ e("li", { children: /* @__PURE__ */ s("button", { type: "button", className: "a3d-queue-item", onClick: () => o(d.slug), children: [
        /* @__PURE__ */ e("strong", { children: d.meta.title || d.slug }),
        /* @__PURE__ */ s("span", { className: "a3d-muted", children: [
          "Step ",
          p.n,
          " · ",
          p.title,
          ": ",
          p.hint
        ] })
      ] }) }, d.slug)) })
    ] }),
    k === "board" && /* @__PURE__ */ e("section", { className: "a3d-board", "aria-label": "Board", children: B.map((d) => /* @__PURE__ */ s("div", { className: "a3d-board-col", children: [
      /* @__PURE__ */ s("h4", { children: [
        d.title,
        " ",
        /* @__PURE__ */ e("span", { className: "a3d-count", children: d.items.length })
      ] }),
      d.items.map(({ m: p, s: j }) => /* @__PURE__ */ s("button", { type: "button", className: p.slug === r ? "a3d-board-card a3d-card-selected" : "a3d-board-card", onClick: () => o(p.slug), children: [
        /* @__PURE__ */ e("strong", { children: p.meta.title || p.slug }),
        /* @__PURE__ */ e("span", { className: "a3d-muted", children: j?.state === "waiting" ? "your turn" : p.flow.nodes.some((m) => m.status === "running") ? "running" : j ? "next" : p.meta.status ?? "" })
      ] }, p.slug))
    ] }, d.id)) }),
    k === "portfolio" && /* @__PURE__ */ s("section", { className: "a3d-block", children: [
      /* @__PURE__ */ s("p", { className: "a3d-row", children: [
        /* @__PURE__ */ e("span", { className: "a3d-muted", children: "Charts across every model: pipeline, overhang before and after, size, rounds spent." }),
        /* @__PURE__ */ e("span", { className: "a3d-tabs-spacer" }),
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", disabled: !n.tools.buildInsights, onClick: b, children: _ ? "Rebuild" : "Build" })
      ] }),
      _ ? /* @__PURE__ */ e(Nn, { host: t, path: `${n.root}/_insights/portfolio.html`, mtime: _.mtime, title: "Portfolio" }) : /* @__PURE__ */ e("p", { className: "a3d-muted", children: "Not built yet." })
    ] }),
    k === "cards" && D.length === 0 && /* @__PURE__ */ s("p", { className: "a3d-empty", children: [
      n.rootExists ? "No models yet." : `Folder not found: ${n.root}`,
      /* @__PURE__ */ e("br", {}),
      "Start with Scout to pick a subject, or New model if you already have an idea."
    ] }),
    k === "cards" && /* @__PURE__ */ e("ul", { className: "a3d-cards", children: D.map((d) => {
      const p = a[d.slug] ?? [], j = p.find((A) => A.state === "active" || A.state === "waiting"), m = p.filter((A) => A.state === "done").length, v = ["renders", "images", "inbox"].map((A) => ({ folder: A, f: me(d.files[A])[0] })).find((A) => A.f), c = d.flow.nodes.some((A) => A.status === "running"), w = d.files.mesh.filter((A) => /\.(stl|glb|gltf|obj|fbx)$/i.test(A.name)).length + d.attempts.length + d.files.print.filter((A) => /\.3mf$/i.test(A.name)).length, $ = me(d.files.inbox).length + me(d.files.images).length + me(d.files.renders).length;
      return /* @__PURE__ */ e("li", { children: /* @__PURE__ */ s("button", { type: "button", className: d.slug === r ? "a3d-card a3d-card-selected" : "a3d-card", "aria-pressed": d.slug === r, onClick: () => o(d.slug), children: [
        /* @__PURE__ */ e("span", { className: "a3d-card-thumb", children: v ? /* @__PURE__ */ e(Ne, { host: t, path: `${d.dir}/${v.folder}/${v.f.name}`, mtime: v.f.mtime, alt: "" }) : /* @__PURE__ */ e("span", { className: "a3d-muted", children: "no image yet" }) }),
        /* @__PURE__ */ s("span", { className: "a3d-card-body", children: [
          /* @__PURE__ */ s("span", { className: "a3d-card-title", children: [
            d.meta.title || d.slug,
            c ? /* @__PURE__ */ e("span", { className: "a3d-tag a3d-tag-run", children: "running" }) : j?.state === "waiting" ? /* @__PURE__ */ e("span", { className: "a3d-tag a3d-tag-waiting", children: "your turn" }) : null
          ] }),
          /* @__PURE__ */ e("span", { className: "a3d-muted", children: [d.meta.model_type, d.meta.status].filter(Boolean).join(" · ") || "no metadata" }),
          /* @__PURE__ */ e("span", { className: "a3d-card-step", children: j ? `Step ${j.n} of ${p.length} · ${j.title}` : `${m} of ${p.length} done` }),
          /* @__PURE__ */ e("span", { className: "a3d-progress", "aria-hidden": "true", children: p.map((A) => /* @__PURE__ */ e("i", { className: `a3d-pip a3d-${A.state}` }, A.id)) }),
          d.meta.origin?.trend && /* @__PURE__ */ s("span", { className: "a3d-card-origin", children: [
            "from ",
            /* @__PURE__ */ e(
              "span",
              {
                role: "link",
                tabIndex: 0,
                className: "a3d-link",
                onClick: (A) => {
                  A.stopPropagation(), S(d.meta.origin.trend);
                },
                onKeyDown: (A) => {
                  A.key === "Enter" && (A.stopPropagation(), S(d.meta.origin.trend));
                },
                children: n.trends.find((A) => A.slug === d.meta.origin.trend)?.title ?? d.meta.origin.trend
              }
            )
          ] }),
          /* @__PURE__ */ s("span", { className: "a3d-muted a3d-card-counts", children: [
            $,
            " image",
            $ === 1 ? "" : "s",
            " · ",
            w,
            " 3D file",
            w === 1 ? "" : "s",
            " · ",
            d.flow.nodes.length,
            " attempt",
            d.flow.nodes.length === 1 ? "" : "s"
          ] })
        ] })
      ] }) }, d.slug);
    }) })
  ] });
}
const At = { trend: "Trend", similar: "Similar model", season: "Season" }, Oe = (t) => t ? (/* @__PURE__ */ new Date(`${t.slice(0, 10)}T12:00:00`)).toLocaleDateString([], { month: "short", day: "numeric" }) : "", Tt = (t) => t === 0 ? "today" : t > 0 ? `in ${t} day${t === 1 ? "" : "s"}` : `${-t} day${t === -1 ? "" : "s"} ago`;
function Ui({ events: t, trends: n, onSeason: a }) {
  const r = t.filter((o) => o.days_left >= 0).slice(0, 6);
  return r.length ? /* @__PURE__ */ e("section", { className: "a3d-cal", "aria-label": "Upcoming events", children: r.map((o) => {
    const u = n.find((b) => b.kind === "season" && b.event?.date === o.date && (b.event?.name ?? "").toLowerCase().startsWith(o.name.toLowerCase().slice(0, 8))), f = o.days_to_publish < 0;
    return /* @__PURE__ */ s(
      "button",
      {
        type: "button",
        className: f ? "a3d-cal-item a3d-cal-late" : o.days_to_publish <= 14 ? "a3d-cal-item a3d-cal-soon" : "a3d-cal-item",
        onClick: () => a(o.name),
        title: f ? "The usual publish-by date has passed: only quick, simple models still make it." : "Analyse what to make for this event",
        children: [
          /* @__PURE__ */ e("strong", { children: o.name }),
          /* @__PURE__ */ s("span", { children: [
            Oe(o.date),
            " · ",
            Tt(o.days_left)
          ] }),
          /* @__PURE__ */ e("span", { className: "a3d-cal-pub", children: f ? `publish-by passed ${-o.days_to_publish} d ago` : `publish by ${Oe(o.publish_by)} (${Tt(o.days_to_publish)})` }),
          u && /* @__PURE__ */ e("span", { className: "a3d-pill a3d-pill-done", children: "analysed" })
        ]
      },
      o.id
    );
  }) }) : null;
}
function Ji({ host: t, scan: n, busy: a, apify: r, selected: o, onSelectTrend: u, onAgent: f, onSet: b, onPrepare: S, onCreateModel: k, onSelectModel: y, onSelectIdea: _, onReveal: D, onOpen: C }) {
  const [P, M] = O("all"), [B, T] = O(!1), [d, p] = O(!1), j = Le(() => n.trends.filter((N) => (P === "all" || N.kind === P) && (B || N.status !== "dropped")).sort((N, G) => (G.updated_at ?? "").localeCompare(N.updated_at ?? "")), [n.trends, P, B]), m = n.trends.find((N) => N.slug === o) ?? j[0] ?? null, v = (N) => n.models.filter((G) => G.meta.origin?.trend === N), c = n.config.score_weights, w = !!m?._files.includes("dashboard.html"), $ = m ? [...m.ideas].sort((N, G) => (He(G, c) ?? -1) - (He(N, c) ?? -1)) : [], A = (N) => N.meta.status ?? "concept";
  return /* @__PURE__ */ s("section", { className: "a3d-trends", children: [
    /* @__PURE__ */ s("header", { className: "a3d-head", children: [
      /* @__PURE__ */ s("div", { children: [
        /* @__PURE__ */ e("h1", { children: "Trends" }),
        /* @__PURE__ */ s("p", { className: "a3d-muted", children: [
          "What sells now, what to make like an existing model, what to make for a date. Scout researches; ideas go to Insights or straight to a model.",
          " ",
          /* @__PURE__ */ e("span", { className: r ? "a3d-pill a3d-pill-done" : "a3d-pill", title: r ? `registered in ${r}` : "Not found in the Claude Code config: Scout falls back to web search.", children: r ? "Apify connected" : "Apify not registered" })
        ] })
      ] }),
      /* @__PURE__ */ s("span", { className: "a3d-row", children: [
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-primary", disabled: a, onClick: () => f("trend", null), children: "Analyse trend…" }),
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-primary", disabled: a, onClick: () => f("similar", null), children: "Similar model…" }),
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", disabled: a, onClick: () => f("season", null), children: "Season…" }),
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", disabled: a || !n.trends.some((N) => N.status === "watching"), onClick: () => f("watch", null), children: "Re-check watched" })
      ] })
    ] }),
    /* @__PURE__ */ e(Ui, { events: n.calendar, trends: n.trends, onSeason: (N) => f("season", null, N) }),
    /* @__PURE__ */ s("div", { className: "a3d-split", children: [
      /* @__PURE__ */ s("aside", { className: "a3d-split-list", children: [
        /* @__PURE__ */ e("span", { className: "a3d-seg a3d-seg-small", role: "group", "aria-label": "Kind", children: ["all", "trend", "similar", "season"].map((N) => /* @__PURE__ */ e("button", { type: "button", "aria-pressed": P === N, onClick: () => M(N), children: N === "all" ? "All" : At[N] }, N)) }),
        /* @__PURE__ */ s("label", { className: "a3d-check", children: [
          /* @__PURE__ */ e("input", { type: "checkbox", checked: B, onChange: (N) => T(N.target.checked) }),
          " show dropped"
        ] }),
        j.length === 0 && /* @__PURE__ */ e("p", { className: "a3d-muted", children: "No trends yet. Analyse one, or click an event above." }),
        /* @__PURE__ */ e("ul", { children: j.map((N) => /* @__PURE__ */ e("li", { children: /* @__PURE__ */ s("button", { type: "button", className: N.slug === m?.slug ? "a3d-li a3d-li-sel" : "a3d-li", onClick: () => {
          u(N.slug), p(!1);
        }, children: [
          /* @__PURE__ */ e("span", { className: "a3d-li-title", children: N.title }),
          /* @__PURE__ */ s("span", { className: "a3d-muted", children: [
            At[N.kind],
            " · ",
            N.status,
            " · ",
            N.ideas.length,
            " idea",
            N.ideas.length === 1 ? "" : "s",
            v(N.slug).length ? ` · ${v(N.slug).length} model${v(N.slug).length === 1 ? "" : "s"}` : ""
          ] })
        ] }) }, N.slug)) })
      ] }),
      m ? /* @__PURE__ */ s("article", { className: "a3d-split-detail", children: [
        /* @__PURE__ */ s("header", { className: "a3d-detail-top", children: [
          /* @__PURE__ */ s("div", { children: [
            /* @__PURE__ */ s("h2", { className: "a3d-h2", children: [
              m.title,
              " ",
              /* @__PURE__ */ e("span", { className: "a3d-pill", children: At[m.kind] }),
              m.saturation && /* @__PURE__ */ s("span", { className: `a3d-pill a3d-sat-${m.saturation}`, children: [
                "saturation: ",
                m.saturation
              ] })
            ] }),
            /* @__PURE__ */ s("p", { className: "a3d-muted", children: [
              m.query && m.query !== m.title ? `“${m.query}” · ` : "",
              "updated ",
              Oe(m.updated_at)
            ] })
          ] }),
          /* @__PURE__ */ s("span", { className: "a3d-row", children: [
            /* @__PURE__ */ s("label", { className: "a3d-inline", children: [
              "Status",
              /* @__PURE__ */ e("select", { value: m.status, onChange: (N) => b(m, [`status=${N.target.value}`]), children: ["new", "watching", "used", "dropped"].map((N) => /* @__PURE__ */ e("option", { value: N, children: N }, N)) })
            ] }),
            m.status === "watching" && /* @__PURE__ */ s("label", { className: "a3d-inline", children: [
              "Re-check",
              /* @__PURE__ */ e("input", { type: "date", value: m.recheck_at ?? "", onChange: (N) => b(m, [`recheck_at=${N.target.value}`]) })
            ] })
          ] })
        ] }),
        m.summary ? /* @__PURE__ */ e("p", { className: "a3d-summary", children: m.summary }) : /* @__PURE__ */ e("p", { className: "a3d-muted", children: "No summary yet: Scout writes it when the analysis runs." }),
        m.kind === "season" && m.event?.date && /* @__PURE__ */ s("p", { className: "a3d-banner", children: [
          m.event.name,
          ": ",
          Oe(m.event.date),
          ". Publish by ",
          Oe(m.event.publish_by),
          m.event.publish_by ? ` (${Tt(Math.round((new Date(m.event.publish_by).getTime() - Date.now()) / 864e5))})` : "",
          "."
        ] }),
        m.kind === "similar" && /* @__PURE__ */ s("section", { className: "a3d-block", children: [
          /* @__PURE__ */ e("h4", { children: "Original model" }),
          /* @__PURE__ */ e("p", { children: m.source?.url ? /* @__PURE__ */ e("a", { href: m.source.url, target: "_blank", rel: "noreferrer", children: m.source.title || m.source.url }) : m.source?.title || m.source?.input || "—" }),
          /* @__PURE__ */ e("p", { className: "a3d-muted", children: [m.source?.license && `licence: ${m.source.license}`, m.source?.price != null && `price: ${m.source.price}`, m.source?.downloads != null && `downloads: ${m.source.downloads}`].filter(Boolean).join(" · ") || "Licence, price and downloads not read yet." }),
          m.ip && /* @__PURE__ */ s("div", { className: "a3d-ip", children: [
            /* @__PURE__ */ s("div", { children: [
              /* @__PURE__ */ e("h5", { children: "Can take" }),
              /* @__PURE__ */ e("ul", { children: (m.ip.can_take ?? []).map((N) => /* @__PURE__ */ e("li", { children: N }, N)) })
            ] }),
            /* @__PURE__ */ s("div", { children: [
              /* @__PURE__ */ e("h5", { children: "Must avoid" }),
              /* @__PURE__ */ e("ul", { children: (m.ip.must_avoid ?? []).map((N) => /* @__PURE__ */ e("li", { children: N }, N)) })
            ] }),
            /* @__PURE__ */ s("div", { children: [
              /* @__PURE__ */ e("h5", { children: "Risk" }),
              /* @__PURE__ */ e("span", { className: `a3d-pill a3d-risk-${m.ip.risk ?? "unknown"}`, children: m.ip.risk ?? "not assessed" })
            ] })
          ] })
        ] }),
        /* @__PURE__ */ s("section", { className: "a3d-block", children: [
          /* @__PURE__ */ s("h4", { children: [
            "Ideas ",
            /* @__PURE__ */ e("span", { className: "a3d-count", children: m.ideas.length }),
            /* @__PURE__ */ s("span", { className: "a3d-block-actions", children: [
              /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", disabled: a || !m.ideas.length, onClick: () => f("score", m), children: "Score ideas (Prism)" }),
              w && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", "aria-pressed": d, onClick: () => p((N) => !N), children: "Dashboard" })
            ] })
          ] }),
          d && w && /* @__PURE__ */ e(Nn, { host: t, path: `${m._dir}/dashboard.html`, mtime: m._mtime, title: `${m.title} ideas` }),
          $.length === 0 ? /* @__PURE__ */ e("p", { className: "a3d-muted", children: "No ideas yet." }) : /* @__PURE__ */ s("table", { className: "a3d-filetable a3d-ideas", children: [
            /* @__PURE__ */ e("thead", { children: /* @__PURE__ */ s("tr", { children: [
              /* @__PURE__ */ e("th", { children: "Idea" }),
              /* @__PURE__ */ e("th", { children: "Type" }),
              /* @__PURE__ */ e("th", { children: "Score" }),
              /* @__PURE__ */ e("th", { children: "Status" }),
              /* @__PURE__ */ e("th", { children: /* @__PURE__ */ e("span", { className: "a3d-sr", children: "Actions" }) })
            ] }) }),
            /* @__PURE__ */ e("tbody", { children: $.map((N) => {
              const G = N.model ? n.models.find((te) => te.slug === N.model) : null;
              return /* @__PURE__ */ s("tr", { children: [
                /* @__PURE__ */ s("td", { children: [
                  /* @__PURE__ */ e("strong", { children: N.name }),
                  N.pitch && /* @__PURE__ */ e("div", { className: "a3d-muted", children: N.pitch })
                ] }),
                /* @__PURE__ */ e("td", { children: N.model_type ?? "" }),
                /* @__PURE__ */ e("td", { children: /* @__PURE__ */ e(Ot, { value: He(N, c) }) }),
                /* @__PURE__ */ e("td", { children: N.status ?? "candidate" }),
                /* @__PURE__ */ e("td", { children: /* @__PURE__ */ s("span", { className: "a3d-row a3d-row-end", children: [
                  N.insight ? /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => _(N.insight), children: "Open in Insights" }) : /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => S(m, N), title: "Create it in Insights to prepare before modelling", children: "Prepare" }),
                  G ? /* @__PURE__ */ s("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => y(G.slug), children: [
                    "Model: ",
                    G.meta.title || G.slug
                  ] }) : /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", disabled: a, onClick: () => k(m, N), children: "Create model" })
                ] }) })
              ] }, N.id);
            }) })
          ] })
        ] }),
        m.signals.length > 0 && /* @__PURE__ */ s("section", { className: "a3d-block", children: [
          /* @__PURE__ */ s("h4", { children: [
            "Signals ",
            /* @__PURE__ */ e("span", { className: "a3d-count", children: m.signals.length })
          ] }),
          /* @__PURE__ */ s("table", { className: "a3d-filetable", children: [
            /* @__PURE__ */ e("thead", { children: /* @__PURE__ */ s("tr", { children: [
              /* @__PURE__ */ e("th", { children: "What" }),
              /* @__PURE__ */ e("th", { children: "Value" }),
              /* @__PURE__ */ e("th", { children: "Date" }),
              /* @__PURE__ */ e("th", { children: "Source" })
            ] }) }),
            /* @__PURE__ */ e("tbody", { children: m.signals.map((N, G) => /* @__PURE__ */ s("tr", { children: [
              /* @__PURE__ */ s("td", { children: [
                N.metric,
                N.note && /* @__PURE__ */ e("div", { className: "a3d-muted", children: N.note })
              ] }),
              /* @__PURE__ */ e("td", { className: "a3d-num", children: String(N.value ?? "") }),
              /* @__PURE__ */ e("td", { className: "a3d-num", children: Oe(N.at) }),
              /* @__PURE__ */ e("td", { children: N.url ? /* @__PURE__ */ e("a", { href: N.url, target: "_blank", rel: "noreferrer", children: N.source || "link" }) : N.source })
            ] }, G)) })
          ] })
        ] }),
        /* @__PURE__ */ s("section", { className: "a3d-block", children: [
          /* @__PURE__ */ s("h4", { children: [
            "Models from this trend ",
            /* @__PURE__ */ e("span", { className: "a3d-count", children: v(m.slug).length })
          ] }),
          v(m.slug).length === 0 ? /* @__PURE__ */ e("p", { className: "a3d-muted", children: "None yet. “Create model” on an idea starts one and links it here." }) : /* @__PURE__ */ e("p", { className: "a3d-row", children: v(m.slug).map((N) => /* @__PURE__ */ s("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => y(N.slug), children: [
            N.meta.title || N.slug,
            " · ",
            A(N)
          ] }, N.slug)) })
        ] }),
        /* @__PURE__ */ s("p", { className: "a3d-row", children: [
          /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", disabled: a, onClick: () => f("refresh", m), children: "Refresh signals (Scout)" }),
          m._files.includes("trend.md") && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => C(`${m._dir}/trend.md`), children: "Open report" }),
          /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => C(`${m._dir}/trend.json`), children: "Open trend.json" }),
          /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => D(m._dir), children: "Show in Finder" })
        ] })
      ] }) : /* @__PURE__ */ e("div", { className: "a3d-placeholder", children: "Pick a trend, or start one above." })
    ] })
  ] });
}
function qi({ commands: t, onClose: n }) {
  const [a, r] = O(""), [o, u] = O(0), f = Te(null), b = Le(() => {
    const y = a.toLowerCase().split(/\s+/).filter(Boolean);
    return t.filter((_) => y.every((D) => `${_.title} ${_.hint ?? ""}`.toLowerCase().includes(D)));
  }, [a, t]);
  ie(() => {
    f.current?.focus();
  }, []), ie(() => {
    u(0);
  }, [a]);
  const S = (y) => {
    !y || y.disabled || (n(), y.run());
  };
  return /* @__PURE__ */ e("div", { className: "a3d-overlay a3d-overlay-top", onClick: n, children: /* @__PURE__ */ s("div", { className: "a3d-palette", role: "dialog", "aria-label": "Commands", onClick: (y) => y.stopPropagation(), onKeyDown: (y) => {
    y.key === "ArrowDown" ? (y.preventDefault(), u((_) => Math.min(b.length - 1, _ + 1))) : y.key === "ArrowUp" ? (y.preventDefault(), u((_) => Math.max(0, _ - 1))) : y.key === "Enter" ? (y.preventDefault(), S(b[o])) : y.key === "Escape" && (y.preventDefault(), n());
  }, children: [
    /* @__PURE__ */ e("input", { ref: f, value: a, placeholder: "Type a command…", "aria-label": "Filter commands", onChange: (y) => r(y.target.value) }),
    /* @__PURE__ */ s("ul", { role: "listbox", children: [
      b.length === 0 && /* @__PURE__ */ e("li", { className: "a3d-muted a3d-palette-empty", children: "No command matches." }),
      b.map((y, _) => /* @__PURE__ */ e("li", { role: "option", "aria-selected": _ === o, "aria-disabled": !!y.disabled, children: /* @__PURE__ */ s("button", { type: "button", className: _ === o ? "a3d-cmd a3d-cmd-on" : "a3d-cmd", disabled: !!y.disabled, onMouseEnter: () => u(_), onClick: () => S(y), children: [
        /* @__PURE__ */ e("span", { children: y.title }),
        /* @__PURE__ */ e("span", { className: "a3d-muted", children: y.disabled || y.hint || "" })
      ] }) }, y.id))
    ] })
  ] }) });
}
function kn({ workspace: t, io: n, onSaved: a }) {
  const r = `${t}/_bmad/ai3d/config.yaml`, [o, u] = O(null), [f, b] = O(!1), [S, k] = O({}), [y, _] = O({}), [D, C] = O(null), [P, M] = O(!1), B = z(async () => {
    try {
      const v = await n.read(r), c = { ...Li, ...v ? Fi(v) : {} };
      u(v), k(c), _(c);
    } catch (v) {
      C({ tone: "error", msg: v instanceof Error ? v.message : String(v) });
    } finally {
      b(!0);
    }
  }, [n, r]);
  ie(() => {
    B();
  }, [B]);
  const T = Le(() => Object.keys(S).filter((v) => S[v] !== y[v]), [S, y]), d = (v, c) => {
    C(null), k((w) => ({ ...w, [v]: c }));
  }, p = Le(() => {
    const v = [];
    cn(S.bed_mm ?? "").some(($) => !($ > 0 && $ <= 2e3)) && v.push("Bed size must be between 1 and 2000 mm on each axis.");
    const w = Number(S.overhang_deg);
    return w >= 20 && w <= 75 || v.push("Overhang angle must be between 20 and 75 degrees."), v;
  }, [S]), j = async () => {
    if (!(o === null || p.length)) {
      M(!0);
      try {
        const v = Object.fromEntries(T.map((c) => [c, S[c]]));
        await n.write(r, zi(o, v)), C({ tone: "ok", msg: `Saved ${T.length} setting${T.length === 1 ? "" : "s"}. Agents and scripts use them from their next run.` }), await B(), a?.();
      } catch (v) {
        C({ tone: "error", msg: `Could not save: ${v instanceof Error ? v.message : String(v)}` });
      } finally {
        M(!1);
      }
    }
  }, m = (v) => {
    const c = S[v.key] ?? v.def, w = `a3d-set-${v.key}`;
    switch (v.kind) {
      case "select": {
        const $ = v.options.some((A) => A.value === c) ? v.options : [...v.options, { value: c, label: `${c} (current)` }];
        return /* @__PURE__ */ e("select", { id: w, value: c, onChange: (A) => d(v.key, A.target.value), children: $.map((A) => /* @__PURE__ */ e("option", { value: A.value, children: A.label }, A.value)) });
      }
      case "toggle":
        return /* @__PURE__ */ s("label", { className: "a3d-switch", children: [
          /* @__PURE__ */ e("input", { id: w, type: "checkbox", checked: c === "true", onChange: ($) => d(v.key, $.target.checked ? "true" : "false") }),
          /* @__PURE__ */ e("span", { children: c === "true" ? "On" : "Off" })
        ] });
      case "text":
        return /* @__PURE__ */ e("input", { id: w, value: c, onChange: ($) => d(v.key, $.target.value) });
      case "bed": {
        const $ = cn(c);
        return /* @__PURE__ */ s("div", { className: "a3d-bed", children: [
          /* @__PURE__ */ e("span", { className: "a3d-row", children: ["X", "Y", "Z"].map((A, N) => /* @__PURE__ */ s("label", { className: "a3d-num", children: [
            A,
            /* @__PURE__ */ e("input", { type: "number", min: 1, max: 2e3, value: $[N], onChange: (G) => {
              const te = [...$];
              te[N] = Number(G.target.value), d(v.key, Ii(te));
            } })
          ] }, A)) }),
          /* @__PURE__ */ e("span", { className: "a3d-row", children: Oi.map((A) => /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", "aria-pressed": c === A.value, onClick: () => d(v.key, A.value), children: A.label }, A.value)) })
        ] });
      }
      case "angle":
        return /* @__PURE__ */ s("label", { className: "a3d-slider a3d-slider-angle", children: [
          /* @__PURE__ */ e("input", { id: w, type: "range", min: 20, max: 75, step: 1, value: Number(c) || 45, onChange: ($) => d(v.key, $.target.value) }),
          /* @__PURE__ */ s("output", { children: [
            c,
            "°"
          ] })
        ] });
      case "weights": {
        const $ = vn(c);
        return /* @__PURE__ */ e("div", { className: "a3d-weights", children: Ie.map((A) => /* @__PURE__ */ s("label", { className: "a3d-slider", children: [
          /* @__PURE__ */ e("span", { children: A.label }),
          /* @__PURE__ */ e("input", { type: "range", min: 0, max: 5, step: 1, value: $[A.id], onChange: (N) => d(v.key, Mi({ ...$, [A.id]: Number(N.target.value) })) }),
          /* @__PURE__ */ e("output", { children: $[A.id] })
        ] }, A.id)) });
      }
    }
  };
  return f ? /* @__PURE__ */ s("form", { className: "a3d-settings", onSubmit: (v) => {
    v.preventDefault(), j();
  }, children: [
    o === null && /* @__PURE__ */ s("p", { className: "a3d-banner", children: [
      "No ",
      /* @__PURE__ */ e("code", { children: "_bmad/ai3d/config.yaml" }),
      " in this workspace. Install the AI3D Forge module first; the form shows defaults until then."
    ] }),
    yn.map((v) => /* @__PURE__ */ s("section", { className: "a3d-set-group", children: [
      /* @__PURE__ */ e("h3", { children: v.title }),
      v.fields.map((c) => /* @__PURE__ */ s("div", { className: "a3d-field", children: [
        /* @__PURE__ */ e("label", { htmlFor: `a3d-set-${c.key}`, children: c.label }),
        /* @__PURE__ */ e("div", { className: "a3d-field-control", children: m(c) }),
        /* @__PURE__ */ e("p", { className: "a3d-muted", children: c.help })
      ] }, c.key))
    ] }, v.title)),
    p.map((v) => /* @__PURE__ */ e("p", { className: "a3d-banner a3d-banner-error", children: v }, v)),
    D && /* @__PURE__ */ e("p", { className: D.tone === "error" ? "a3d-banner a3d-banner-error" : "a3d-banner", role: "status", children: D.msg }),
    /* @__PURE__ */ s("span", { className: "a3d-row", children: [
      /* @__PURE__ */ e("button", { type: "submit", className: "a3d-btn a3d-btn-primary", disabled: !T.length || p.length > 0 || o === null || P, children: P ? "Saving…" : T.length ? `Save ${T.length} change${T.length === 1 ? "" : "s"}` : "Saved" }),
      /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", disabled: !T.length, onClick: () => {
        k(y), C(null);
      }, children: "Discard" }),
      /* @__PURE__ */ s("span", { className: "a3d-muted", children: [
        "Writes ",
        r.replace(t + "/", "")
      ] })
    ] })
  ] }) : /* @__PURE__ */ e("p", { className: "a3d-muted", children: "Reading settings…" });
}
const $n = "runs", Zi = 15;
let ke = {}, Lt = null, pt = null, ve = null;
const ht = /* @__PURE__ */ new Set(), It = /* @__PURE__ */ new Set();
function Yi(t) {
  return It.add(t), () => {
    It.delete(t);
  };
}
function Mt() {
  ke = { ...ke }, ht.forEach((t) => t()), Lt?.set($n, ke);
}
function _n(t) {
  pt = t;
}
function Xi() {
  return !!pt;
}
function Qi(t) {
  if (Lt) return;
  Lt = t;
  const n = t.get($n) ?? {};
  for (const a of Object.values(n))
    for (const r of a) r.status === "running" && (r.status = "done");
  ke = { ...n, ...ke }, ht.forEach((a) => a());
}
function es(t) {
  return ht.add(t), () => {
    ht.delete(t);
  };
}
function ts() {
  return ke;
}
function hn() {
  return ve !== null;
}
function ns(t) {
  ve && !ve.sessionId && (ve.sessionId = t, Mt());
}
function is(t, n, a, r, o, u) {
  if (!pt || ve) return null;
  const f = { sessionId: null, step: n, label: a, at: Date.now(), status: "running" };
  return ke[t] = [f, ...ke[t] ?? []].slice(0, Zi), ve = f, Mt(), pt.sendPrompt({ prompt: r, sessionName: o }).then(
    (b) => {
      f.sessionId = b.sessionId, f.status = "done";
    },
    (b) => {
      f.status = "error", f.error = b instanceof Error ? b.message : String(b);
    }
  ).finally(() => {
    ve === f && (ve = null), Mt();
    try {
      u?.(f.status === "error" ? "error" : "done", f.error);
    } catch {
    }
    It.forEach((b) => {
      try {
        b(t, f);
      } catch {
      }
    });
  }), f;
}
const ss = 4e3, ot = "_global";
async function as(t) {
  const n = `python3 - ${g(t.workspacePath)} ${g(bn.modelsRoot)} <<'A3D_SCAN'
${Yn}
A3D_SCAN`, a = await t.exec(n, { timeout: 2e4 });
  if (!a.success) throw new Error(a.stderr.trim() || "Could not scan the models folder (is python3 installed?).");
  return JSON.parse(a.stdout);
}
function ls(t) {
  return {
    read: async (n) => {
      const a = await t.exec(`[ -f ${g(n)} ] && cat ${g(n)}`, { timeout: 1e4 });
      return a.success ? a.stdout : null;
    },
    write: async (n, a) => {
      if (a.includes("A3D_CFG_EOF")) throw new Error("Refusing to write: the text contains the heredoc marker.");
      const r = await t.exec(`cat > ${g(n)} <<'A3D_CFG_EOF'
${a.replace(/\n*$/, `
`)}A3D_CFG_EOF`, { timeout: 1e4 });
      if (!r.success) throw new Error(r.stderr.trim() || "write failed");
    }
  };
}
function Re({ host: t, model: n, folder: a, title: r, onZoom: o, empty: u }) {
  const f = me(n.files[a]);
  return !f.length && !u ? null : /* @__PURE__ */ s("section", { className: "a3d-block", children: [
    /* @__PURE__ */ s("h4", { children: [
      r,
      " ",
      /* @__PURE__ */ e("span", { className: "a3d-count", children: f.length })
    ] }),
    f.length === 0 ? /* @__PURE__ */ e("p", { className: "a3d-muted", children: u }) : /* @__PURE__ */ e("div", { className: "a3d-gallery", children: f.map((b) => {
      const S = `${n.dir}/${a}/${b.name}`;
      return /* @__PURE__ */ s("figure", { children: [
        /* @__PURE__ */ e(Ne, { host: t, path: S, mtime: b.mtime, alt: b.name, onClick: () => o({ path: S, mtime: b.mtime, name: b.name }) }),
        /* @__PURE__ */ e("figcaption", { title: b.name, children: b.name })
      ] }, b.name);
    }) })
  ] });
}
function Et({ title: t, text: n, onOpen: a, copyLabel: r }) {
  const [o, u] = O(!1);
  return n ? /* @__PURE__ */ s("section", { className: "a3d-block", children: [
    /* @__PURE__ */ s("h4", { children: [
      t,
      /* @__PURE__ */ s("span", { className: "a3d-block-actions", children: [
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: async () => {
          await navigator.clipboard.writeText(n), u(!0), setTimeout(() => u(!1), 1500);
        }, children: o ? "Copied" : r ?? "Copy" }),
        a && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: a, children: "Open file" })
      ] })
    ] }),
    /* @__PURE__ */ e("pre", { className: "a3d-text", children: n })
  ] }) : null;
}
function rs({ title: t, model: n, folder: a, files: r, onOpen: o, onExternal: u }) {
  return r.length ? /* @__PURE__ */ s("section", { className: "a3d-block", children: [
    /* @__PURE__ */ e("h4", { children: t }),
    /* @__PURE__ */ e("ul", { className: "a3d-files", children: r.map((f) => {
      const b = `${n.dir}/${a}/${f.name}`, S = /\.(md|json|txt|ya?ml)$/i.test(f.name);
      return /* @__PURE__ */ s("li", { children: [
        /* @__PURE__ */ s("span", { className: "a3d-file-name", children: [
          a,
          "/",
          f.name
        ] }),
        /* @__PURE__ */ e("span", { className: "a3d-muted", children: un(f.size) }),
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => S ? o(b) : u(b), children: S ? "Open" : "Open in app" })
      ] }, f.name);
    }) })
  ] }) : null;
}
function mn({ model: t }) {
  const n = t.analysis, a = n?.after ?? n?.analysis ?? null, r = n?.flexi ?? null;
  if (!a && !r) return null;
  const o = [];
  return a?.overhang_pct != null && o.push(["Overhang", `${a.overhang_pct} %`]), n?.before?.overhang_pct != null && o.push(["Overhang before", `${n.before.overhang_pct} %`]), n?.side_on_bed && o.push(["Side on bed", String(n.side_on_bed)]), n?.cut_mm != null && o.push(["Flat cut", `${n.cut_mm} mm`]), a?.size_mm && o.push(["Size", `${a.size_mm.join(" × ")} mm`]), a?.watertight != null && o.push(["Watertight", a.watertight ? "yes" : "no", a.watertight ? "good" : "bad"]), a?.shells != null && o.push(["Shells", String(a.shells)]), r && (o.push(["Joints", `${r.joints} of ${Math.max(0, (r.segments ?? 1) - 1 + (r.skipped_cuts?.length ?? 0))} cuts`]), o.push(["Joint check", r.ok ? "all held and free" : "failed", r.ok ? "good" : "bad"]), r.clearance_mm != null && o.push(["Clearance", `${r.clearance_mm} mm`])), /* @__PURE__ */ s("section", { className: "a3d-block", children: [
    /* @__PURE__ */ e("h4", { children: "Print analysis" }),
    /* @__PURE__ */ e("dl", { className: "a3d-metrics", children: o.map(([u, f, b]) => /* @__PURE__ */ s("div", { className: b ? `a3d-metric a3d-${b}` : "a3d-metric", children: [
      /* @__PURE__ */ e("dt", { children: u }),
      /* @__PURE__ */ e("dd", { children: f })
    ] }, u)) })
  ] });
}
function os(t) {
  const n = new Date(t);
  return (/* @__PURE__ */ new Date()).toDateString() === n.toDateString() ? n.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : n.toLocaleDateString([], { month: "short", day: "numeric" });
}
function ds({ host: t }) {
  const [n, a] = O(null), [r, o] = O(null), [u, f] = O(null), [b, S] = O(null), [k, y] = O(ot), [_, D] = O(null), [C, P] = O(null), [M, B] = O("models"), [T, d] = O(!1), [p, j] = O(""), [m, v] = O(null), [c, w] = O(null), [$, A] = O(!1), [N, G] = O("graph"), [te, ce] = O(null), [ne, $e] = O(null), [X, fe] = O(null), [Ee, ut] = O(null), [Cn, Ue] = O(null), [_e, Je] = O([]), [qe, Wt] = O(!1), [ft, Ce] = O(!1), [Me, xn] = O(() => t.storage.get("notify") ?? !0), [Gt, Vt] = O(!1), [Z, Sn] = O(null), [Ht, Ut] = O(!1), [gt, Fe] = O(!1), [jn, Jt] = O(null), [Dn, An] = O({}), [Ze, ze] = O(null), qt = Te(""), bt = Te(!1), En = Zn(es, ts), H = z(async () => {
    if (!bt.current) {
      bt.current = !0;
      try {
        const i = await as(t), l = JSON.stringify(i);
        l !== qt.current && (qt.current = l, a(i)), o(null);
      } catch (i) {
        o(i instanceof Error ? i.message : String(i));
      } finally {
        bt.current = !1;
      }
    }
  }, [t]);
  ie(() => {
    Qi(t.storage), H();
    const i = setInterval(() => {
      document.hidden || H();
    }, ss), l = t.onWorkspaceEvent("sessions:refresh-list", (x) => {
      const E = x?.sessionId;
      typeof E == "string" && ns(E);
    });
    return () => {
      clearInterval(i), l();
    };
  }, [t, H]), ie(() => Yi((i, l) => {
    if (!Me) return;
    const x = i === ot ? "" : ` · ${i}`, E = `${l.status === "error" ? "Failed" : "Finished"}: ${l.label}${x}`;
    w(`${E}. ${l.status === "error" ? l.error ?? "" : "Check the agent session for questions."}`);
    try {
      document.hidden && typeof Notification < "u" && Notification.permission === "granted" && new Notification("AI3D Forge", { body: E });
    } catch {
    }
  }), [Me]);
  const Pn = z(() => {
    const i = !Me;
    xn(i), t.storage.set("notify", i);
    try {
      i && typeof Notification < "u" && Notification.permission === "default" && Notification.requestPermission();
    } catch {
    }
    w(i ? "Notifications on: a message when an agent run ends (a system notification when the panel is hidden)." : "Notifications off.");
  }, [Me, t]);
  ie(() => {
    const i = (l) => {
      (l.metaKey || l.ctrlKey) && l.key.toLowerCase() === "k" && (l.preventDefault(), d((x) => !x));
    };
    return window.addEventListener("keydown", i), () => window.removeEventListener("keydown", i);
  }, []), ie(() => {
    if (!m && !C && !ne) return;
    const i = (l) => {
      l.key === "Escape" && (v(null), P(null), $e(null));
    };
    return window.addEventListener("keydown", i), () => window.removeEventListener("keydown", i);
  }, [m, C, ne]);
  const Y = n?.models ?? [], h = Y.find((i) => i.slug === u) ?? null, Ye = Le(() => {
    const i = {};
    if (n) for (const l of n.models) i[l.slug] = ti(l, n);
    return i;
  }, [n]);
  ie(() => {
    n && (u && !Y.some((i) => i.slug === u) ? f(null) : !u && Y.length && (f(Y[0].slug), y(Y[0].slug)));
  }, [n, u, Y]), ie(() => {
    const i = Object.values(Ye).filter((l) => l.some((x) => x.state === "waiting")).length;
    t.setGutterBadge?.(i > 0 ? i : null, { tone: "warning" });
  }, [Ye, t]);
  const se = h ? Ye[h.slug] ?? [] : [], Pe = se.find((i) => i.state === "active" || i.state === "waiting") ?? se[se.length - 1], V = se.find((i) => i.id === b) ?? Pe, ge = hn(), ae = z(async (i) => {
    const l = await t.exec(`${nn()} ${g(i)}`, { timeout: 15e3 });
    l.success || w(`Could not open ${i}: ${l.stderr.trim()}`);
  }, [t]), xe = z(async (i) => {
    if (!n?.tools.flowLog) return i.flow.nodes;
    const l = await t.exec(`python3 ${g(n.tools.flowLog)} list ${g(i.dir)}`, { timeout: 15e3 });
    try {
      return l.success ? JSON.parse(l.stdout).nodes : i.flow.nodes;
    } catch {
      return i.flow.nodes;
    }
  }, [n, t]), K = z(async (i, l, x, E) => {
    if (!n) return;
    if (w(null), A(!1), i.kind === "script") {
      if (i.script === "readme") {
        if (!h || !n.tools.buildReadme) return;
        const F = g(n.tools.buildReadme), U = await t.exec(`python3 ${F} ${g(h.dir)} && python3 ${F} ${g(n.root)} --catalog`, { timeout: 6e4 });
        w(U.success ? "README and catalog rebuilt." : `README build failed: ${U.stderr.trim()}`);
      } else if (i.script === "view" || i.script === "views-all") {
        if (!n.tools.buildViewer) {
          w("The Prism scripts were not found. Update the AI3D Forge module.");
          return;
        }
        const F = i.script === "view" ? h ? [h] : [] : n.models.filter((de) => de.files.mesh.some((Q) => /\.stl$/i.test(Q.name)));
        if (!F.length) {
          w(i.script === "view" ? "Select a model first." : "No model has an STL yet.");
          return;
        }
        w(`Building ${F.length === 1 ? "the 3D view" : `${F.length} 3D views`}…`);
        let U = null;
        const oe = [];
        for (const de of F) {
          const Q = await t.exec(`python3 ${g(n.tools.buildViewer)} ${g(de.dir)}`, { timeout: 12e4, maxBuffer: 2e7 });
          if (!Q.success) {
            oe.push(`${de.slug}: ${Q.stderr.trim().split(`
`).pop()}`);
            continue;
          }
          try {
            U = JSON.parse(Q.stdout.trim().split(`
`).pop() ?? "{}");
          } catch {
            U = null;
          }
        }
        F.length === 1 && U?.view && await ae(U.view), w(oe.length ? `3D view failed: ${oe.join("; ")}` : F.length === 1 ? `3D view built (${U?.mb ?? "?"} MB) and opened in your browser.${U?.note ? " " + U.note : ""}` : `${F.length} 3D views built. Open one from its model.`);
      } else if (i.script === "portfolio") {
        if (!n.tools.buildInsights) {
          w("The Prism scripts were not found. Update the AI3D Forge module.");
          return;
        }
        w("Building the portfolio dashboard…");
        const F = await t.exec(`python3 ${g(n.tools.buildInsights)} portfolio ${g(n.root)}`, { timeout: 6e4 });
        w(F.success ? "Portfolio dashboard built." : `Portfolio build failed: ${F.stderr.trim()}`), F.success && B("insights");
      }
      H();
      return;
    }
    if (i.kind === "form") {
      if (i.form === "print-log") Ce(!0);
      else if (h && n.tools.printLog) {
        const F = await t.exec(`python3 ${g(n.tools.printLog)} skip ${g(h.dir)} --reason ${g("skipped from the panel")}`, { timeout: 15e3 });
        w(F.success ? "Test print skipped for this model. Log a print later if you make one." : `Could not save: ${F.stderr.trim()}`), H();
      }
      return;
    }
    if (i.kind !== "agent") return;
    if (!Xi()) {
      w("The AI service is not available to this extension. Check its AI permission in Settings.");
      return;
    }
    const R = h && l ? h.slug : ot, I = h && l ? `AI3D · ${h.slug} · ${i.label}` : `AI3D · ${i.label}`;
    if (hn()) {
      w("Another step is still starting. Wait for it to finish its first turn.");
      return;
    }
    let L;
    const re = n.tools.flowLog;
    if (h && l && re && ii(i)) {
      const F = await xe(h), U = E?.parent !== void 0 ? E.parent : Ve(F, l.id), oe = De(F, l.id).filter((Ge) => !Ge.inferred).length + 1, de = Math.max(
        0,
        ...h.files.prompts.map((Ge) => Number(/^image-v(\d+)\.md$/.exec(Ge.name)?.[1] ?? 0)),
        ...F.map((Ge) => Number(/^Image prompt v(\d+)/.exec(Ge.label)?.[1] ?? 0))
      ) + 1, Q = l.id === "image" ? `Image prompt v${de}` : `${l.title} · try ${oe}`, qn = [
        `python3 ${g(re)} add ${g(h.dir)} --step ${l.id} --label ${g(Q)} --status running`,
        U ? `--parent ${g(U)}` : "",
        E?.description ? `--description ${g(E.description)}` : "",
        `--settings-json ${g(JSON.stringify(E?.settings ?? {}))}`
      ].filter(Boolean).join(" "), Qt = await t.exec(qn, { timeout: 15e3 });
      if (Qt.success)
        try {
          L = { node: JSON.parse(Qt.stdout.trim().split(`
`).pop() ?? ""), flowLog: re }, ce(L.node.id);
        } catch {
        }
      L ? H() : w("The flow node could not be created; the step runs without it.");
    }
    const q = L && h && re ? (F, U) => {
      const oe = F === "error" ? ` --outcome ${g(`Run failed: ${U ?? "unknown error"}`)}` : "";
      t.exec(`python3 ${g(re)} settle ${g(h.dir)} ${g(L.node.id)} --status ${F === "error" ? "error" : "open"}${oe}`, { timeout: 15e3 }).then(() => H());
    } : void 0;
    if (!is(R, l?.id ?? "global", i.label, ai(i, l ? h : null, n, x, L), I, q)) {
      w("Another step is still starting. Wait for it to finish its first turn."), q?.("error", "not started");
      return;
    }
    y(R), D(null);
  }, [n, h, t, H, ae, xe]), Se = z((i, l) => {
    if (h) {
      if (i === "print") {
        Ce(!0);
        return;
      }
      dt[i]?.length && $e({
        step: i,
        parent: l?.parent !== void 0 ? l.parent : Ve(h.flow.nodes, i),
        settings: l?.settings ?? {},
        description: l?.description ?? ""
      });
    }
  }, [h]), wt = z(async (i, l) => {
    if (!h || !n?.tools.flowLog) return;
    const x = await t.exec(`python3 ${g(n.tools.flowLog)} update ${g(h.dir)} ${g(i.id)} --verdict ${l}`, { timeout: 15e3 });
    x.success || w(`Could not save the verdict: ${x.stderr.trim()}`), H();
  }, [h, n, t, H]), yt = z(async (i) => {
    if (!h || !n?.tools.flowLog) return !1;
    const l = await t.exec(`python3 ${g(n.tools.flowLog)} ${i}`, { timeout: 15e3 });
    return l.success || w(`Could not save: ${l.stderr.trim().split(`
`).pop()}`), H(), l.success;
  }, [h, n, t, H]), Bn = z((i) => {
    Je((l) => l.includes(i.id) ? l.filter((x) => x !== i.id) : [...l, i.id].slice(-2));
  }, []), Rn = z(async (i, l) => {
    if (!h || !n?.tools.buildViewer) {
      w("The Prism scripts were not found.");
      return;
    }
    const x = `${h.dir}/view/compare-${i.id}.html`, E = await t.exec(`python3 ${g(n.tools.buildViewer)} ${g(h.dir)} --stl ${g(`${h.dir}/${l}`)} --out ${g(x)}`, { timeout: 12e4, maxBuffer: 2e7 });
    if (!E.success) {
      w(`3D view failed: ${E.stderr.trim().split(`
`).pop()}`);
      return;
    }
    await ae(x);
  }, [h, n, t, ae]), On = z(async (i) => {
    if (Ce(!1), !h || !n?.tools.printLog) {
      w("print_log.py was not found: update the module.");
      return;
    }
    const l = h;
    w("Saving the test print…");
    const x = [...i.photoPaths];
    try {
      for (const L of i.photoFiles) x.push(await wn(t, l.dir, L));
    } catch (L) {
      w(`Photo upload failed: ${L instanceof Error ? L.message : String(L)}`);
      return;
    }
    const E = [
      `add ${g(l.dir)} --result ${i.result}`,
      `--printer ${g(i.printer)}`,
      `--filament ${g(i.filament)}`,
      `--settings ${g(i.settings)}`,
      `--change ${g(i.change)}`,
      `--notes ${g(i.notes)}`,
      x.length ? `--photos ${g(x.join(","))}` : ""
    ].filter(Boolean).join(" "), R = await t.exec(`python3 ${g(n.tools.printLog)} ${E}`, { timeout: 3e4 });
    if (t.exec(`rm -rf ${g(`${l.dir}/.import-tmp`)}`, { timeout: 1e4 }), !R.success) {
      w(`Could not save: ${R.stderr.trim().split(`
`).pop()}`);
      return;
    }
    let I = {};
    try {
      I = JSON.parse(R.stdout.trim().split(`
`).pop() ?? "{}");
    } catch {
    }
    if (n.tools.flowLog) {
      const L = await xe(l), re = De(L, "print").filter((F) => !F.inferred).length + 1, q = ["print/print-log.md", ...I.photos ?? []].join(","), he = JSON.stringify(Object.fromEntries(Object.entries({ printer: i.printer, filament: i.filament, settings: i.settings }).filter(([, F]) => F)));
      if (await t.exec([
        `python3 ${g(n.tools.flowLog)} add ${g(l.dir)} --step print --agent you --label ${g(`Test print ${re}`)} --status done`,
        `--outcome ${g(`${i.result}${i.change ? `; change: ${i.change}` : ""}`)}`,
        `--files ${g(q)}`,
        `--settings-json ${g(he)}`,
        Ve(L, "print") ? `--parent ${g(Ve(L, "print"))}` : ""
      ].filter(Boolean).join(" "), { timeout: 15e3 }), i.result !== "issues") {
        const F = await t.exec(`python3 ${g(n.tools.flowLog)} list ${g(l.dir)}`, { timeout: 15e3 });
        try {
          const U = JSON.parse(F.stdout).nodes.filter((de) => de.step === "print" && !de.inferred), oe = U[U.length - 1];
          oe && await t.exec(`python3 ${g(n.tools.flowLog)} update ${g(l.dir)} ${g(oe.id)} --verdict ${i.result === "ok" ? "accepted" : "rejected"}`, { timeout: 15e3 });
        } catch {
        }
      }
    }
    w(`Test print saved (${i.result}).${i.result === "fail" ? " Run the Blender step again with the change, or go back to the mesh." : ""}`), H();
  }, [h, n, t, H, xe]), Zt = z((i) => {
    if (!h) return;
    const l = `${h.dir}/${i}`;
    /\.(md|json|txt|ya?ml)$/i.test(i) ? t.openFile(l) : ae(l);
  }, [h, t, ae]), be = z((i, l) => {
    f(i), S(null), ce(null), fe(null), y(i), D(null), w(null), l && B(l);
  }, []), vt = z(async (i, l) => {
    const x = l ? `${i.dir}/${l}` : i.dir, E = await t.exec(l ? xt(x) : `${nn()} ${g(x)}`, { timeout: 15e3 });
    E.success || w(`Could not show ${x}: ${E.stderr.trim()}`);
  }, [t]), Tn = z((i, l) => {
    const x = `${i.dir}/${l}`;
    /\.(md|json|txt|ya?ml)$/i.test(l) ? t.openFile(x) : ae(x);
  }, [t, ae]), Xe = z(async (i) => {
    Vt(!0);
    try {
      const l = await i;
      w(Bi(l));
      const x = n?.tools.flowLog;
      if (h && x)
        for (const E of l.placed) {
          if (!E.archived) continue;
          const R = E.file, I = [...h.flow.nodes].reverse().find((L) => !L.inferred && L.files.includes(R));
          I && await t.exec(`python3 ${g(x)} update ${g(h.dir)} ${g(I.id)} --move-file ${g(`${R}=${E.archived}`)}`, { timeout: 15e3 });
        }
    } catch (l) {
      w(`Could not add the files: ${l instanceof Error ? l.message : String(l)}`);
    }
    Vt(!1), H();
  }, [H, n, h, t]), Qe = z(async (i) => {
    if (!h) return !0;
    const l = await St(t, i);
    return l === null ? !1 : (l.length && await Xe(Ei(t, h.dir, i, l)), !0);
  }, [h, t, Xe]), Ln = z((i) => {
    if (!h) return;
    const l = { image: [], mesh: [] }, x = [];
    for (const R of i) {
      const I = Di(R.name);
      I ? l[I].push(R) : x.push(R.name);
    }
    const E = (async () => {
      const R = { placed: [], skipped: x.map((I) => ({ file: I, why: "not an image or a 3D file" })) };
      for (const I of ["image", "mesh"]) {
        if (!l[I].length) continue;
        const L = await Pi(t, h.dir, I, l[I]);
        R.placed.push(...L.placed), R.skipped.push(...L.skipped);
      }
      return R;
    })();
    Xe(E);
  }, [h, t, Xe]), Yt = n?.config.blender_bin ?? "auto", Ke = z(async () => {
    Ut(!0);
    try {
      Sn(await yi(t, Yt));
    } catch (i) {
      w(`Blender check failed: ${i instanceof Error ? i.message : String(i)}`);
    }
    Ut(!1);
  }, [t, Yt]), Xt = !!n;
  ie(() => {
    Xt && Ke();
  }, [Xt, Ke]);
  const In = z(() => {
    n?.tools.blenderGuide ? t.openFile(n.tools.blenderGuide) : w("The setup guide is in the module: skills/ai3d-kiln/references/blender-setup.md");
  }, [n, t]), et = z(async (i, l = {}, x = "") => {
    if (!h || !n) return;
    if (!n.tools.kilnRun || !Z?.bin) {
      Fe(!0);
      return;
    }
    const E = h, R = n.tools.flowLog;
    Jt(i), w(null);
    let I = null;
    if ((i === "prep" || i === "flexi") && R) {
      const q = await xe(E), he = De(q, "blender").filter((Q) => Q.verdict !== "rejected" && Q.status !== "error"), F = i === "flexi" && he.length ? he[he.length - 1].id : Ve(q, "blender"), U = `${i === "prep" ? "Quick prep" : "Flexi (script)"} · try ${De(q, "blender").filter((Q) => !Q.inferred).length + 1}`, oe = Object.fromEntries(Object.entries(l).filter(([, Q]) => Q !== "")), de = await t.exec([
        `python3 ${g(R)} add ${g(E.dir)} --step blender --agent kiln_run --label ${g(U)} --status running`,
        F ? `--parent ${g(F)}` : "",
        x ? `--description ${g(x)}` : "",
        `--settings-json ${g(JSON.stringify(oe))}`
      ].filter(Boolean).join(" "), { timeout: 15e3 });
      try {
        I = de.success ? JSON.parse(de.stdout.trim().split(`
`).pop() ?? "").id : null;
      } catch {
        I = null;
      }
      H();
    }
    const L = await vi(t, Z.bin, n.tools.kilnRun, i, E.dir, l);
    if (I && R) {
      const q = (L.files ?? []).join(",");
      await t.exec([
        `python3 ${g(R)} update ${g(E.dir)} ${g(I)} --status ${L.crashed ? "error" : "done"}`,
        !L.ok && !L.crashed ? "--verdict rejected" : "",
        `--outcome ${g(Bt(L))}`,
        q ? `--files ${g(q)}` : ""
      ].filter(Boolean).join(" "), { timeout: 15e3 });
    }
    if (R && typeof L.archived == "string" && L.archived) {
      const q = [...await xe(E)].reverse().find((he) => !he.inferred && he.id !== I && he.files.includes("mesh/print.stl"));
      q && await t.exec(`python3 ${g(R)} update ${g(E.dir)} ${g(q.id)} --move-file ${g(`mesh/print.stl=${L.archived}`)}`, { timeout: 15e3 });
    }
    An((q) => ({ ...q, [E.slug]: L }));
    const re = Array.isArray(L.archived) ? L.archived.join(", ") : L.archived;
    w(`${i}: ${Bt(L)}${re ? ` Previous file kept as ${re}.` : ""}`), Jt(null), H();
  }, [h, n, Z, t, H, xe]), Nt = z(async (i) => {
    const l = await Ni(t, Z?.bin ?? null, i && h ? `${h.dir}/${i}` : "");
    l.success ? w(i ? `Opening ${i} in Blender…` : "Opening Blender…") : w(`Could not open Blender: ${l.stderr.trim()}`);
  }, [t, Z, h]), pe = z((i) => n && i.startsWith(n.workspace) ? i.slice(n.workspace.length + 1) || "." : i, [n]), We = (i, l) => ({ kind: "agent", label: i, skill: "ai3d-scout", trigger: l }), Be = z(async (i) => {
    if (!n?.tools.trendLib)
      return w("trend_lib.py was not found: update the AI3D Forge module."), null;
    const l = await t.exec(`python3 ${g(n.tools.trendLib)} ${i}`, { timeout: 2e4 });
    if (!l.success)
      return w(`Could not save: ${l.stderr.trim().split(`
`).pop()}`), null;
    H();
    try {
      return JSON.parse(l.stdout.trim().split(`
`).pop() ?? "null");
    } catch {
      return null;
    }
  }, [n, t, H]), Mn = z((i, l, x) => {
    if (!n) return;
    if (i === "trend" || i === "similar" || i === "season") {
      P(i), j(x ?? "");
      return;
    }
    if (i === "watch") {
      K(We("Re-check watched trends", "*watch"), null, `Trends folder: \`${pe(n.trendsRoot)}\`.`);
      return;
    }
    if (!l) return;
    const E = `Trend: \`${pe(l._dir)}/trend.json\` (${l.title}).`;
    i === "score" && K({ kind: "agent", label: `Score ideas: ${l.title}`, skill: "ai3d-prism", trigger: "*score" }, null, `trend ${l.slug}. ${E}`), i === "refresh" && K(
      We(`Refresh: ${l.title}`, l.kind === "similar" ? "*similar" : l.kind === "season" ? "*season" : "*trend"),
      null,
      `Refresh the existing trend ${l.slug}: add new dated signals (keep the old ones), update summary and ideas. ${E}`
    );
  }, [n, K, pe]), Fn = z(async (i, l) => {
    if (!n) return;
    const x = await Be(`new insight ${g(n.ideasRoot)} --title ${g(l.name)} --subject-kind other --trend ${g(i.slug)} --idea ${g(l.id)} --trends-dir ${g(n.trendsRoot)}`);
    x?.slug && (Ue(x.slug), B("insights"), w(`“${l.name}” is in Insights now. Prepare runs Muse.`));
  }, [n, Be]), tt = z((i) => n?.tools.trendLib ? `After the model folder exists, link it: \`python3 ${n.tools.trendLib} link <model dir> ${i} --trends-dir ${n.trendsRoot} --insights-dir ${n.ideasRoot}\`.` : "", [n]), zn = z((i, l) => {
    n && K(
      { kind: "agent", label: `New model: ${l.name}`, skill: "ai3d-muse", trigger: "*concept" },
      null,
      `Idea \`${l.id}\` (${l.name}${l.pitch ? `: ${l.pitch}` : ""}${l.model_type ? `, ${l.model_type}` : ""}) from trend \`${pe(i._dir)}/trend.json\`. ${tt(`--trend ${i.slug} --idea ${l.id}`)}`
    );
  }, [n, K, pe, tt]), Kn = z((i, l) => {
    const x = `Insight: \`${pe(l._dir)}/insight.json\` (${l.title}).`;
    i === "prepare" && K({ kind: "agent", label: `Prepare: ${l.title}`, skill: "ai3d-muse", trigger: "*prepare" }, null, `${l.slug}. ${x}`), i === "score" && K({ kind: "agent", label: `Score: ${l.title}`, skill: "ai3d-prism", trigger: "*score" }, null, `insight ${l.slug}. ${x}`), i === "concept" && K(
      { kind: "agent", label: `New model: ${l.title}`, skill: "ai3d-muse", trigger: "*concept" },
      null,
      `From the prepared insight ${l.slug}: use its brief.md and chosen variant. ${x} ${tt(`--insight ${l.slug}`)}`
    );
  }, [K, pe, tt]), Wn = z(async (i, l, x, E) => {
    if (!n) return;
    const R = await Be(`new insight ${g(n.ideasRoot)} --title ${g(i)} --subject-kind ${g(l)} --description ${g(x)}`);
    R?.slug && (Ue(R.slug), E && K(
      { kind: "agent", label: `Prepare: ${i}`, skill: "ai3d-muse", trigger: "*prepare" },
      null,
      `${R.slug}. Insight: \`${pe(R.dir)}/insight.json\` (${i}).`
    ));
  }, [n, Be, K, pe]), Gn = z(async () => {
    const i = await St(t, "image");
    if (i === null) {
      w("The file dialog is not available here: paste a link, a path or a name.");
      return;
    }
    i.length && j((l) => [l.trim(), ...i].filter(Boolean).join(" "));
  }, [t]), Vn = () => {
    const i = p.trim();
    if (!i) return;
    C === "new" && K({ kind: "agent", label: "New model", skill: "ai3d-muse", trigger: "*concept" }, null, i), C === "score" && K({ kind: "agent", label: `Score ideas: ${i}`, skill: "ai3d-prism", trigger: "*score" }, null, i), C === "blender" && K({ kind: "agent", label: `Blender: ${i.slice(0, 40)}`, skill: "ai3d-kiln", trigger: "*run" }, se.find((x) => x.id === "blender") ?? null, i);
    const l = n ? `Trends folder: \`${pe(n.trendsRoot)}\`.` : "";
    C === "trend" && K(We(`Trend: ${i.slice(0, 40)}`, "*trend"), null, `${i}. ${l}`), C === "similar" && K(We(`Similar: ${i.slice(0, 40)}`, "*similar"), null, `${i}. ${l}`), C === "season" && K(We(`Season: ${i.slice(0, 40)}`, "*season"), null, `${i}. ${l}`), C === "scout" && K({ kind: "agent", label: `Scout: ${i}`, skill: "ai3d-scout", trigger: "*scout" }, null, i), P(null), j("");
  }, nt = En[k] ?? [], le = nt.find((i) => i.at === _) ?? nt[0] ?? null, kt = t.components?.SessionTranscript, Hn = (i) => {
    const l = i.primary;
    if (!l) return /* @__PURE__ */ e("p", { className: "a3d-done-line", children: "Step complete." });
    if (i.state === "locked") {
      const x = se.find((E) => E.state === "active" || E.state === "waiting");
      return /* @__PURE__ */ s("p", { className: "a3d-muted", children: [
        "Finish step ",
        x?.n,
        " (",
        x?.title,
        ") first."
      ] });
    }
    return l.kind === "human" ? /* @__PURE__ */ s("div", { className: "a3d-your-turn", children: [
      /* @__PURE__ */ e("strong", { children: "Your turn" }),
      /* @__PURE__ */ e("span", { children: l.label }),
      /* @__PURE__ */ s("span", { className: "a3d-row", children: [
        l.copy && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-primary", onClick: async () => {
          await navigator.clipboard.writeText(l.copy), w("Copied to clipboard.");
        }, children: l.copyLabel ?? "Copy" }),
        l.folder === "print" && h && /* @__PURE__ */ s(J, { children: [
          /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-primary", onClick: () => Ce(!0), children: "Log a test print…" }),
          /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => {
            K({ kind: "form", label: "Skip", form: "print-skip" }, i);
          }, children: "Skip" })
        ] }),
        l.folder && h && (l.folder === "inbox" || l.folder === "mesh") && /* @__PURE__ */ e(
          "button",
          {
            type: "button",
            className: "a3d-btn a3d-btn-primary",
            disabled: Gt,
            onClick: async () => {
              await Qe(l.folder === "inbox" ? "image" : "mesh") || (B("files"), w("Use “Add…” here, or drop the file onto this page."));
            },
            children: l.folder === "inbox" ? "Add image…" : "Add 3D model…"
          }
        ),
        l.folder && h && l.folder !== "print" && /* @__PURE__ */ s("button", { type: "button", className: "a3d-btn", onClick: () => ae(`${h.dir}/${l.folder}`), children: [
          "Open ",
          l.folder,
          "/ folder"
        ] })
      ] })
    ] }) : /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-primary a3d-btn-large", disabled: ge, onClick: () => K(l, i), children: l.kind === "agent" ? `Run: ${l.label}` : l.label });
  }, Un = (i, l) => {
    const x = (R) => t.openFile(R), E = (R, I, L) => /* @__PURE__ */ e(rs, { title: R, model: i, folder: I, files: i.files[I].filter(L ?? (() => !0)), onOpen: x, onExternal: ae });
    switch (l.id) {
      case "concept":
        return /* @__PURE__ */ s(J, { children: [
          /* @__PURE__ */ e(Et, { title: "concept.md", text: i.concept, onOpen: () => x(`${i.dir}/concept.md`) }),
          /* @__PURE__ */ e(Re, { host: t, model: i, folder: "refs", title: "References", onZoom: v })
        ] });
      case "image":
        return /* @__PURE__ */ s(J, { children: [
          /* @__PURE__ */ e(Re, { host: t, model: i, folder: "inbox", title: "Inbox", onZoom: v, empty: "Empty. Generated images go here." }),
          /* @__PURE__ */ e(Re, { host: t, model: i, folder: "images", title: "Accepted", onZoom: v }),
          i.imagePrompt && /* @__PURE__ */ e(Et, { title: `Latest prompt — ${i.imagePrompt.name}`, text: i.imagePrompt.text, copyLabel: "Copy prompt", onOpen: () => x(`${i.dir}/prompts/${i.imagePrompt.name}`) }),
          E("Prompt history", "prompts", (R) => /^image-v\d+\.md$|^prompt-log\.md$/.test(R.name))
        ] });
      case "mesh":
        return /* @__PURE__ */ s(J, { children: [
          /* @__PURE__ */ e(Et, { title: "3D spec — 3d-prompt.md", text: i.prompt3d, copyLabel: "Copy spec", onOpen: () => x(`${i.dir}/prompts/3d-prompt.md`) }),
          E("Mesh files", "mesh"),
          /* @__PURE__ */ e(Re, { host: t, model: i, folder: "images", title: "Source image", onZoom: v })
        ] });
      case "blender":
        return /* @__PURE__ */ s(J, { children: [
          /* @__PURE__ */ e(Re, { host: t, model: i, folder: "renders", title: "Renders", onZoom: v, empty: "No renders yet. Kiln saves them here." }),
          i.files.mesh.some((R) => /\.stl$/i.test(R.name)) && /* @__PURE__ */ s("section", { className: "a3d-block", children: [
            /* @__PURE__ */ e("h4", { children: "Interactive view" }),
            /* @__PURE__ */ s("p", { className: "a3d-muted", children: [
              "Orbit the model, shade overhangs in red, cut it at any height and check the bed fit.",
              i.view ? i.view.stale ? " The view is older than the model files: rebuild it." : " The view is up to date." : " Not built yet."
            ] }),
            /* @__PURE__ */ e("p", { className: "a3d-row", children: /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-primary", disabled: !n?.tools.buildViewer, onClick: () => K({ kind: "script", label: "3D view", script: "view" }, null), children: i.view ? "Rebuild and open" : "Build and open" }) })
          ] }),
          /* @__PURE__ */ e(
            Si,
            {
              model: i,
              status: Z,
              kilnRun: n?.tools.kilnRun ?? null,
              busy: jn,
              last: Dn[i.slug] ?? null,
              onRun: (R) => {
                et(R);
              },
              onPrep: () => ze("prep"),
              onFlexi: () => ze("flexi"),
              onOpen: (R) => {
                Nt(R);
              },
              onCommand: () => {
                P("blender"), j("");
              },
              onSetup: () => Fe(!0)
            }
          ),
          /* @__PURE__ */ e(mn, { model: i }),
          E("Mesh files", "mesh"),
          E("Logs", "print", (R) => /kiln-log|analysis/.test(R.name))
        ] });
      case "print":
        return /* @__PURE__ */ s(J, { children: [
          i.printPhotos.length > 0 && /* @__PURE__ */ s("section", { className: "a3d-block", children: [
            /* @__PURE__ */ s("h4", { children: [
              "Photos ",
              /* @__PURE__ */ e("span", { className: "a3d-count", children: i.printPhotos.length })
            ] }),
            /* @__PURE__ */ e("div", { className: "a3d-gallery", children: me(i.printPhotos).map((R) => {
              const I = `${i.dir}/print/photos/${R.name}`;
              return /* @__PURE__ */ s("figure", { children: [
                /* @__PURE__ */ e(Ne, { host: t, path: I, mtime: R.mtime, alt: R.name, onClick: () => v({ path: I, mtime: R.mtime, name: R.name }) }),
                /* @__PURE__ */ e("figcaption", { children: R.name })
              ] }, R.name);
            }) })
          ] }),
          i.printLog.length > 0 ? /* @__PURE__ */ s("section", { className: "a3d-block", children: [
            /* @__PURE__ */ s("h4", { children: [
              "Test prints ",
              /* @__PURE__ */ s("span", { className: "a3d-block-actions", children: [
                /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => Ce(!0), children: "Log another…" }),
                /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => x(`${i.dir}/print/print-log.md`), children: "Open log" })
              ] })
            ] }),
            /* @__PURE__ */ s("table", { className: "a3d-filetable", children: [
              /* @__PURE__ */ e("thead", { children: /* @__PURE__ */ s("tr", { children: [
                /* @__PURE__ */ e("th", { children: "Date" }),
                /* @__PURE__ */ e("th", { children: "Result" }),
                /* @__PURE__ */ e("th", { children: "Printer · filament" }),
                /* @__PURE__ */ e("th", { children: "Change next time" })
              ] }) }),
              /* @__PURE__ */ e("tbody", { children: [...i.printLog].reverse().map((R, I) => /* @__PURE__ */ s("tr", { children: [
                /* @__PURE__ */ e("td", { className: "a3d-num", children: R.at.slice(0, 10) }),
                /* @__PURE__ */ e("td", { children: R.skipped ? /* @__PURE__ */ e("span", { className: "a3d-pill", children: "skipped" }) : /* @__PURE__ */ e("span", { className: `a3d-pill a3d-pr-${R.result}`, children: R.result }) }),
                /* @__PURE__ */ s("td", { children: [
                  [R.printer, R.filament].filter(Boolean).join(" · "),
                  R.settings && /* @__PURE__ */ e("div", { className: "a3d-muted", children: R.settings })
                ] }),
                /* @__PURE__ */ e("td", { children: R.change ?? R.reason })
              ] }, I)) })
            ] })
          ] }) : /* @__PURE__ */ e("p", { className: "a3d-muted", children: "No test print logged yet." }),
          E("3D files", "mesh", (R) => /\.stl$/i.test(R.name))
        ] });
      case "validate":
        return /* @__PURE__ */ s(J, { children: [
          /* @__PURE__ */ e(mn, { model: i }),
          E("Validation and slicing", "print")
        ] });
      default:
        return /* @__PURE__ */ s(J, { children: [
          i.hasReadme && /* @__PURE__ */ s("section", { className: "a3d-block", children: [
            /* @__PURE__ */ e("h4", { children: "README" }),
            /* @__PURE__ */ s("p", { className: "a3d-row", children: [
              /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => x(`${i.dir}/README.md`), children: "Open README.md" }),
              /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => n && x(`${n.root}/README.md`), children: "Open catalog" })
            ] })
          ] }),
          /* @__PURE__ */ e(Re, { host: t, model: i, folder: "renders", title: "Images used in the README", onZoom: v }),
          E("Listings", "publish")
        ] });
    }
  }, it = h?.files.mesh.find((i) => i.name === "print.stl") ?? h?.files.mesh.find((i) => i.name === "clean.stl"), Jn = [
    { id: "view", title: "Build 3D view of the selected model", hint: h?.slug, disabled: it ? n?.tools.buildViewer ? !1 : "Prism not installed" : "needs an STL", run: () => {
      K({ kind: "script", label: "3D view", script: "view" }, null);
    } },
    { id: "views-all", title: "Rebuild every 3D view", disabled: n?.tools.buildViewer ? !1 : "Prism not installed", run: () => {
      K({ kind: "script", label: "All views", script: "views-all" }, null);
    } },
    { id: "portfolio", title: "Build the portfolio dashboard", disabled: n?.tools.buildInsights ? !1 : "Prism not installed", run: () => {
      K({ kind: "script", label: "Portfolio", script: "portfolio" }, null);
    } },
    { id: "new", title: "New model…", hint: "agent run", run: () => {
      B("flow"), P("new"), j("");
    } },
    { id: "readme", title: "Rebuild README and catalog (no agent)", hint: h?.slug, disabled: h ? n?.tools.buildReadme ? !1 : "script not found" : "select a model", run: () => {
      K({ kind: "script", label: "README", script: "readme" }, null);
    } },
    { id: "attempt", title: "New attempt on the current step…", hint: V ? V.title : void 0, disabled: !h || !V ? "select a model" : n?.tools.flowLog ? !1 : "flow_log.py not found", run: () => {
      V && (B("flow"), Se(V.id));
    } },
    { id: "graph", title: "Show the flow graph", run: () => {
      B("flow"), G("graph");
    } },
    { id: "add-image", title: "Add image to the selected model…", hint: h?.slug, disabled: h ? !1 : "select a model", run: () => {
      B("files"), Qe("image");
    } },
    { id: "add-mesh", title: "Add 3D model to the selected model…", hint: h?.slug, disabled: h ? !1 : "select a model", run: () => {
      B("files"), Qe("mesh");
    } },
    { id: "reveal", title: "Show the model folder in Finder", hint: h?.slug, disabled: h ? !1 : "select a model", run: () => h && void vt(h, "") },
    { id: "bl-status", title: "Blender: status and setup", hint: Z?.version ?? void 0, run: () => {
      Fe(!0), Ke();
    } },
    { id: "bl-analyze", title: "Blender: analyze the mesh (no agent)", hint: h?.slug, disabled: h ? Z?.bin ? !1 : "Blender not found" : "select a model", run: () => {
      B("flow"), S("blender"), et("analyze");
    } },
    { id: "bl-prep", title: "Blender: quick prep… (no agent)", hint: h?.slug, disabled: h ? Z?.bin ? !1 : "Blender not found" : "select a model", run: () => {
      B("flow"), S("blender"), ze("prep");
    } },
    { id: "bl-render", title: "Blender: render previews (no agent)", hint: h?.slug, disabled: h ? Z?.bin ? !1 : "Blender not found" : "select a model", run: () => {
      B("flow"), S("blender"), et("render");
    } },
    { id: "bl-command", title: "Blender command… (Kiln agent)", hint: h?.slug, disabled: h ? !1 : "select a model", run: () => {
      P("blender"), j("");
    } },
    { id: "bl-open", title: "Open the model in Blender", hint: h?.slug, disabled: h ? Z?.bin ? !1 : "Blender not found" : "select a model", run: () => {
      const i = h?.files.mesh.find((l) => l.name === "work.blend") ?? h?.files.mesh.find((l) => l.name === "print.stl") ?? h?.files.mesh.find((l) => /^raw\./.test(l.name));
      Nt(i ? `mesh/${i.name}` : null);
    } },
    { id: "tr-trend", title: "Analyse a trend…", hint: "Scout", run: () => {
      B("trends"), P("trend"), j("");
    } },
    { id: "tr-similar", title: "Similar model (photo, link or name)…", hint: "Scout", run: () => {
      B("trends"), P("similar"), j("");
    } },
    { id: "tr-season", title: "Season or event…", hint: "Scout", run: () => {
      B("trends"), P("season"), j("");
    } },
    { id: "in-new", title: "New idea… (Insights)", run: () => B("insights") },
    { id: "tab-trends", title: "Go to Trends", run: () => B("trends") },
    { id: "tab-insights", title: "Go to Insights", run: () => B("insights") },
    { id: "print-log", title: "Log a test print…", hint: h?.slug, disabled: h ? n?.tools.printLog ? !1 : "print_log.py not found" : "select a model", run: () => Ce(!0) },
    { id: "archived", title: qe ? "Hide archived branches" : "Show archived branches", run: () => Wt((i) => !i) },
    { id: "notify", title: Me ? "Turn notifications off" : "Turn notifications on", run: Pn },
    { id: "keys", title: "Keyboard shortcuts", run: () => w("Shortcuts: 1–6 tabs · Alt+↑/↓ previous / next model · in Flow: G graph or steps, N new attempt on the current step, A / R accept or reject the selected attempt · Cmd/Ctrl+K commands.") },
    { id: "tab-models", title: "Go to Models", run: () => B("models") },
    { id: "tab-files", title: "Go to Files", run: () => B("files") },
    { id: "tab-flow", title: "Go to Flow", run: () => B("flow") },
    { id: "tab-settings", title: "Go to Settings", run: () => B("settings") },
    { id: "folder", title: "Open the models folder", disabled: n ? !1 : "still reading", run: () => n && void ae(n.root) },
    ...Y.map((i) => ({ id: `m-${i.slug}`, title: `Open model: ${i.meta.title || i.slug}`, hint: i.meta.status, run: () => be(i.slug, "flow") }))
  ];
  return ie(() => {
    const i = (l) => {
      if (T || C || ne || ft || Ze || gt || m) return;
      const x = l.target;
      if (x && (x.tagName === "INPUT" || x.tagName === "TEXTAREA" || x.tagName === "SELECT" || x.isContentEditable)) return;
      if (l.altKey && (l.key === "ArrowDown" || l.key === "ArrowUp") && Y.length) {
        l.preventDefault();
        const I = Math.max(0, Y.findIndex((re) => re.slug === u)), L = Y[(I + (l.key === "ArrowDown" ? 1 : Y.length - 1)) % Y.length];
        be(L.slug);
        return;
      }
      if (l.metaKey || l.ctrlKey || l.altKey) return;
      const E = l.key.toLowerCase(), R = ["models", "flow", "files", "trends", "insights", "settings"];
      if (/^[1-6]$/.test(E)) {
        B(R[Number(E) - 1]);
        return;
      }
      if (!(M !== "flow" || !h)) {
        if (E === "g") G((I) => I === "graph" ? "steps" : "graph");
        else if (E === "n" && V && n?.tools.flowLog && dt[V.id]?.length) Se(V.id);
        else if ((E === "a" || E === "r") && te) {
          const I = h.flow.nodes.find((L) => L.id === te);
          I && !I.inferred && wt(I, E === "a" ? "accepted" : "rejected");
        }
      }
    };
    return window.addEventListener("keydown", i), () => window.removeEventListener("keydown", i);
  }, [T, C, ne, ft, Ze, gt, m, Y, u, be, M, h, V, n, Se, te, wt]), /* @__PURE__ */ s("div", { className: "a3d", children: [
    /* @__PURE__ */ s("main", { className: "a3d-main", children: [
      /* @__PURE__ */ s("div", { className: "a3d-tabs", role: "tablist", children: [
        [["models", "Models"], ["flow", "Flow"], ["files", "Files"], ["trends", "Trends"], ["insights", "Insights"], ["settings", "Settings"]].map(([i, l]) => /* @__PURE__ */ e("button", { type: "button", role: "tab", "aria-selected": M === i, className: "a3d-tab", onClick: () => B(i), children: l }, i)),
        /* @__PURE__ */ e("span", { className: "a3d-tabs-spacer" }),
        Y.length > 0 && /* @__PURE__ */ s("label", { className: "a3d-switch", children: [
          /* @__PURE__ */ e("span", { className: "a3d-muted", children: "Model" }),
          /* @__PURE__ */ e("select", { "aria-label": "Selected model", value: u ?? "", onChange: (i) => be(i.target.value), children: Y.map((i) => /* @__PURE__ */ e("option", { value: i.slug, children: i.meta.title || i.slug }, i.slug)) })
        ] }),
        /* @__PURE__ */ e($i, { status: Z, checking: Ht, onClick: () => {
          Fe(!0), Ke();
        } }),
        /* @__PURE__ */ s("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => d(!0), title: "Run a command", children: [
          "Commands ",
          /* @__PURE__ */ s("kbd", { children: [
            /Mac/i.test(navigator.platform) ? "⌘" : "Ctrl",
            "K"
          ] })
        ] })
      ] }),
      r && /* @__PURE__ */ e("div", { className: "a3d-banner a3d-banner-error", children: r }),
      n && !n.installed && !n.tools.kilnLib && /* @__PURE__ */ e("div", { className: "a3d-banner", children: "The AI3D Forge module was not found in this workspace. Install it so the agents exist: see the module README." }),
      c && /* @__PURE__ */ s("div", { className: "a3d-banner", role: "status", children: [
        c,
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: () => w(null), children: "Dismiss" })
      ] }),
      M === "models" && (n ? /* @__PURE__ */ e(
        Hi,
        {
          host: t,
          scan: n,
          stepsBySlug: Ye,
          selected: u,
          onSelect: (i) => be(i, "flow"),
          onNew: () => {
            P("new"), j("");
          },
          onScout: () => B("trends"),
          onSelectTrend: (i) => {
            ut(i), B("trends");
          },
          onPortfolio: () => {
            K({ kind: "script", label: "Portfolio", script: "portfolio" }, null);
          }
        }
      ) : /* @__PURE__ */ e("div", { className: "a3d-placeholder", children: r ? "" : "Reading models…" })),
      M === "files" && n && /* @__PURE__ */ e(
        Ri,
        {
          host: t,
          scan: n,
          model: h,
          nodeFilter: X,
          importing: Gt,
          onClearFilter: () => fe(null),
          onSelectModel: (i) => be(i),
          onZoom: v,
          onOpen: Tn,
          onReveal: vt,
          onView: () => {
            K({ kind: "script", label: "3D view", script: "view" }, null);
          },
          onPick: Qe,
          onFiles: Ln
        }
      ),
      M === "trends" && n && /* @__PURE__ */ e(
        Ji,
        {
          host: t,
          scan: n,
          busy: ge,
          selected: Ee,
          onSelectTrend: ut,
          apify: Z ? (Z.servers ?? []).find((i) => i.forSessions && i.name.toLowerCase().includes((n.config.scrape_mcp || "apify").toLowerCase()))?.where ?? null : void 0,
          onAgent: Mn,
          onSet: (i, l) => {
            Be(`set ${g(i._dir)} ${l.map(g).join(" ")}`);
          },
          onPrepare: (i, l) => {
            Fn(i, l);
          },
          onCreateModel: zn,
          onSelectModel: (i) => be(i, "flow"),
          onSelectIdea: (i) => {
            Ue(i), B("insights");
          },
          onReveal: (i) => {
            t.exec(xt(i), { timeout: 15e3 });
          },
          onOpen: (i) => {
            t.openFile(i);
          }
        }
      ),
      M === "insights" && n && /* @__PURE__ */ e(
        Vi,
        {
          host: t,
          scan: n,
          busy: ge,
          selected: Cn,
          onSelect: Ue,
          onCreate: (...i) => {
            Wn(...i);
          },
          onAgent: Kn,
          onDecide: (i, l) => {
            Be(`decide ${g(i._dir)} ${l}`);
          },
          onSelectTrend: (i) => {
            ut(i), B("trends");
          },
          onSelectModel: (i) => be(i, "flow"),
          onReveal: (i) => {
            t.exec(xt(i), { timeout: 15e3 });
          },
          onOpen: (i) => {
            t.openFile(i);
          }
        }
      ),
      M === "settings" && /* @__PURE__ */ s("section", { className: "a3d-settings-wrap", children: [
        /* @__PURE__ */ e("h1", { children: "Settings" }),
        /* @__PURE__ */ s("p", { className: "a3d-muted", children: [
          "Module settings live in ",
          /* @__PURE__ */ e("code", { children: "_bmad/ai3d/config.yaml" }),
          ", so agents, scripts and this panel always agree. The folder override is in Nimbalyst’s extension settings."
        ] }),
        /* @__PURE__ */ e(kn, { workspace: t.workspacePath, io: ls(t), onSaved: () => {
          H();
        } })
      ] }),
      M === "flow" && (h ? /* @__PURE__ */ s(J, { children: [
        /* @__PURE__ */ s("header", { className: "a3d-head", children: [
          /* @__PURE__ */ s("div", { children: [
            /* @__PURE__ */ e("h1", { children: h.meta.title || h.slug }),
            /* @__PURE__ */ e("p", { className: "a3d-muted", children: [h.meta.model_type, h.meta.status, h.meta.summary || h.meta.subject].filter(Boolean).join(" · ") })
          ] }),
          /* @__PURE__ */ s("span", { className: "a3d-row", children: [
            /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => {
              fe(null), B("files");
            }, children: "Files" }),
            /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => vt(h, ""), children: "Show in Finder" }),
            h.hasReadme && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => t.openFile(`${h.dir}/README.md`), children: "README" }),
            it && /* @__PURE__ */ s(
              "button",
              {
                type: "button",
                className: "a3d-btn a3d-btn-primary",
                disabled: !n?.tools.buildViewer,
                onClick: () => K({ kind: "script", label: "3D view", script: "view" }, null),
                title: n?.tools.buildViewer ? "Build the interactive view and open it in your browser" : "Prism scripts not found in this workspace",
                children: [
                  "3D view",
                  h.view?.stale ? " (outdated)" : ""
                ]
              }
            ),
            it && /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => ae(`${h.dir}/mesh/${it.name}`), children: "Open STL in slicer" })
          ] })
        ] }),
        /* @__PURE__ */ s("div", { className: "a3d-flowbar", children: [
          /* @__PURE__ */ e("p", { className: "a3d-now", children: Pe ? /* @__PURE__ */ s(J, { children: [
            "Now: ",
            /* @__PURE__ */ s("strong", { children: [
              "step ",
              Pe.n,
              " of ",
              se.length,
              ", ",
              Pe.title
            ] }),
            " · ",
            Pe.state === "waiting" ? "your turn" : Pe.state === "done" ? "everything is done" : "next up"
          ] }) : null }),
          (() => {
            const i = h.flow.nodes.filter((x) => x.cost).reduce((x, E) => (x[E.cost.service] = (x[E.cost.service] ?? 0) + E.cost.credits, x), {}), l = h.flow.nodes.length - gn(h.flow.nodes, !1).length;
            return /* @__PURE__ */ s("span", { className: "a3d-row a3d-flowmeta", children: [
              Object.keys(i).length > 0 && /* @__PURE__ */ s("span", { className: "a3d-muted", title: "Sum of the costs recorded on attempts", children: [
                "Cost: ",
                Object.entries(i).map(([x, E]) => `${Math.round(E * 100) / 100} ${x}`).join(" · ")
              ] }),
              _e.length > 0 && /* @__PURE__ */ s("span", { className: "a3d-pill", children: [
                _e.length === 1 ? "pick one more to compare" : "comparing 2",
                " ",
                /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: () => Je([]), children: "clear" })
              ] }),
              l > 0 && /* @__PURE__ */ s("label", { className: "a3d-check", children: [
                /* @__PURE__ */ e("input", { type: "checkbox", checked: qe, onChange: (x) => Wt(x.target.checked) }),
                " show archived (",
                l,
                ")"
              ] })
            ] });
          })(),
          /* @__PURE__ */ s("span", { className: "a3d-seg", role: "group", "aria-label": "Flow view", children: [
            /* @__PURE__ */ e("button", { type: "button", "aria-pressed": N === "graph", onClick: () => G("graph"), children: "Graph" }),
            /* @__PURE__ */ e("button", { type: "button", "aria-pressed": N === "steps", onClick: () => G("steps"), children: "Steps" })
          ] })
        ] }),
        N === "graph" && /* @__PURE__ */ s(J, { children: [
          _e.length === 2 && (() => {
            const i = h.flow.nodes.find((x) => x.id === _e[0]), l = h.flow.nodes.find((x) => x.id === _e[1]);
            return i && l ? /* @__PURE__ */ e(
              gi,
              {
                host: t,
                model: h,
                a: i,
                b: l,
                onClose: () => Je([]),
                onSwap: () => Je(([x, E]) => [E, x]),
                onView3d: (x, E) => {
                  Rn(x, E);
                },
                onOpen: Zt
              }
            ) : null;
          })(),
          /* @__PURE__ */ e(
            hi,
            {
              model: h,
              steps: se,
              selectedNode: te,
              selectedStep: V?.id ?? null,
              compare: _e,
              showArchived: qe,
              onSelectNode: (i) => {
                ce(i);
                const l = h.flow.nodes.find((x) => x.id === i);
                l && S(l.step), A(!1);
              },
              onSelectStep: (i) => {
                ce(null), S(i), A(!1);
              },
              onNew: (i) => Se(i)
            }
          ),
          (() => {
            const i = te ? h.flow.nodes.find((l) => l.id === te) : null;
            return i ? /* @__PURE__ */ e(
              mi,
              {
                model: h,
                node: i,
                busy: ge || !n?.tools.flowLog,
                canEdit: !!n?.tools.flowLog,
                inCompare: _e.includes(i.id),
                onCompare: Bn,
                onArchive: (l, x) => {
                  yt(`update ${g(h.dir)} ${g(l.id)} --archived ${x ? "yes" : "no"}`).then(() => {
                    x && !qe && ce(null);
                  });
                },
                onNote: (l, x) => {
                  yt(`note ${g(h.dir)} ${g(l.id)} ${g(x)}`);
                },
                onCost: (l, x, E) => {
                  yt(`update ${g(h.dir)} ${g(l.id)} --cost ${g(`${x}:${E}`)}`);
                },
                onSelectNode: (l) => {
                  ce(l);
                  const x = h.flow.nodes.find((E) => E.id === l);
                  x && S(x.step);
                },
                onRerun: (l) => Se(l.step, { parent: oi(l), settings: l.settings, description: "" }),
                onNext: (l) => Se(se[Ae(l.step) + 1]?.id ?? l.step, { parent: l.id }),
                onVerdict: wt,
                onOpen: Zt,
                onFiles: (l) => {
                  fe(l.id), B("files");
                }
              },
              i.id
            ) : null;
          })()
        ] }),
        N === "steps" && /* @__PURE__ */ e("ol", { className: "a3d-flow", children: se.map((i) => /* @__PURE__ */ e("li", { className: `a3d-step a3d-${i.state}${V?.id === i.id ? " a3d-step-selected" : ""}`, children: /* @__PURE__ */ s("button", { type: "button", onClick: () => {
          S(i.id), A(!1);
        }, children: [
          /* @__PURE__ */ s("span", { className: "a3d-step-top", children: [
            /* @__PURE__ */ e("span", { className: "a3d-step-n", children: i.state === "done" ? "✓" : i.n }),
            /* @__PURE__ */ e("span", { className: "a3d-step-title", children: i.title })
          ] }),
          /* @__PURE__ */ e("span", { className: "a3d-step-thumb", children: i.thumb ? /* @__PURE__ */ e(Ne, { host: t, path: `${h.dir}/${i.thumb}`, mtime: h.stamp, alt: "" }) : /* @__PURE__ */ e("span", { className: "a3d-step-agent", children: i.agent }) }),
          /* @__PURE__ */ e("span", { className: "a3d-step-result", children: i.result }),
          /* @__PURE__ */ e("span", { className: "a3d-step-state", children: i.state === "done" ? "Done" : i.state === "active" ? "Next" : i.state === "waiting" ? "Your turn" : "Locked" })
        ] }) }, i.id)) }),
        V && /* @__PURE__ */ s("section", { className: "a3d-detail", children: [
          /* @__PURE__ */ s("div", { className: "a3d-detail-head", children: [
            /* @__PURE__ */ s("div", { children: [
              /* @__PURE__ */ s("h3", { children: [
                "Step ",
                V.n,
                " · ",
                V.title,
                " ",
                /* @__PURE__ */ s("span", { className: "a3d-muted", children: [
                  "— ",
                  V.agent
                ] })
              ] }),
              /* @__PURE__ */ e("p", { children: V.hint })
            ] }),
            /* @__PURE__ */ s("div", { className: "a3d-detail-actions", children: [
              Hn(V),
              V.state !== "locked" && n?.tools.flowLog && (dt[V.id]?.length ?? 0) > 0 && /* @__PURE__ */ e(
                "button",
                {
                  type: "button",
                  className: "a3d-btn",
                  disabled: ge,
                  onClick: () => Se(V.id),
                  title: "Run this step again with its own settings and description",
                  children: "New attempt…"
                }
              ),
              V.state !== "locked" && V.more.length > 0 && /* @__PURE__ */ s("div", { className: "a3d-more", children: [
                /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", "aria-expanded": $, onClick: () => A((i) => !i), children: "Other actions" }),
                $ && /* @__PURE__ */ e("div", { className: "a3d-menu", children: V.more.map((i) => /* @__PURE__ */ e("button", { type: "button", disabled: ge && i.kind === "agent", onClick: () => K(i, V), children: i.label }, i.label)) })
              ] })
            ] })
          ] }),
          /* @__PURE__ */ e("div", { className: "a3d-results", children: Un(h, V) })
        ] })
      ] }) : /* @__PURE__ */ e("div", { className: "a3d-placeholder", children: n ? /* @__PURE__ */ s(J, { children: [
        "No model selected. ",
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-link", onClick: () => B("models"), children: "Open Models" })
      ] }) : r ? "" : "Reading models…" }))
    ] }),
    /* @__PURE__ */ s("aside", { className: "a3d-session", children: [
      /* @__PURE__ */ s("header", { children: [
        /* @__PURE__ */ e("h2", { children: "Agent session" }),
        nt.length > 0 && /* @__PURE__ */ e("select", { "aria-label": "Run", value: le?.at ?? "", onChange: (i) => D(Number(i.target.value)), children: nt.map((i) => /* @__PURE__ */ s("option", { value: i.at, children: [
          os(i.at),
          " · ",
          i.label,
          i.status === "running" ? " (running)" : i.status === "error" ? " (failed)" : ""
        ] }, i.at)) })
      ] }),
      /* @__PURE__ */ s("div", { className: "a3d-session-body", children: [
        !le && /* @__PURE__ */ e("p", { className: "a3d-empty", children: "Run a step and its agent session appears here. Answer verdict questions in this pane." }),
        le?.status === "error" && /* @__PURE__ */ e("p", { className: "a3d-banner a3d-banner-error", children: le.error }),
        le && !le.sessionId && le.status === "running" && /* @__PURE__ */ e("p", { className: "a3d-empty", children: "Starting the session…" }),
        le?.sessionId && kt && /* @__PURE__ */ e(kt, { sessionId: le.sessionId }, le.sessionId),
        le?.sessionId && !kt && /* @__PURE__ */ s("p", { className: "a3d-empty", children: [
          "This Nimbalyst version cannot embed transcripts in a panel. Open the session “AI3D · ",
          k === ot ? "" : `${k} · `,
          le.label,
          "” from the session list."
        ] })
      ] })
    ] }),
    C && /* @__PURE__ */ e("div", { className: "a3d-overlay", onClick: () => P(null), children: /* @__PURE__ */ s("form", { className: "a3d-dialog", onClick: (i) => i.stopPropagation(), onSubmit: (i) => {
      i.preventDefault(), Vn();
    }, children: [
      /* @__PURE__ */ e("h3", { children: C === "new" ? "New model" : C === "score" ? "Score ideas" : C === "blender" ? `Blender command · ${h?.meta.title || h?.slug || ""}` : C === "trend" ? "Analyse a trend" : C === "similar" ? "Similar model" : C === "season" ? "Season or event" : "Scout a category" }),
      /* @__PURE__ */ e("label", { htmlFor: "a3d-dialog-input", children: C === "trend" ? "Topic or category, for example “flexi dragons” or “desk organisers”. Scout collects dated signals (Apify when connected) and curates ideas." : C === "similar" ? "A link to the model (MakerWorld, Printables, Etsy…), its name, or a photo. Scout explains why it works, the licence and IP split, and proposes original models in the same niche." : C === "season" ? "Event, for example “St Nicholas Day”, “Christmas”, “New Year”. Scout checks the publish-by date and what sold last year." : C === "blender" ? "One instruction for Kiln to do in your open Blender, for example “show the underside and measure the thinnest leg”." : C === "new" ? "Describe the model: subject, style, size, static or flexi." : C === "score" ? "Category with a Scout shortlist to score, for example “lizards”." : "Category to research, for example “lizards” or “owls”." }),
      C === "new" || C === "blender" || C === "similar" || C === "trend" ? /* @__PURE__ */ e("textarea", { id: "a3d-dialog-input", autoFocus: !0, rows: 5, value: p, onChange: (i) => j(i.target.value) }) : /* @__PURE__ */ e("input", { id: "a3d-dialog-input", autoFocus: !0, list: C === "score" ? "a3d-shortlist-names" : C === "season" ? "a3d-events" : void 0, value: p, onChange: (i) => j(i.target.value) }),
      C === "similar" && /* @__PURE__ */ s("p", { className: "a3d-row", children: [
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn a3d-btn-small", onClick: () => {
          Gn();
        }, children: "Choose photo…" }),
        /* @__PURE__ */ e("span", { className: "a3d-muted a3d-small", children: "adds the file path; Scout copies it into the trend’s refs/" })
      ] }),
      C === "season" && /* @__PURE__ */ e("datalist", { id: "a3d-events", children: (n?.calendar ?? []).map((i) => /* @__PURE__ */ e("option", { value: i.name }, i.id)) }),
      C === "score" && /* @__PURE__ */ e("datalist", { id: "a3d-shortlist-names", children: (n?.shortlists ?? []).map((i) => /* @__PURE__ */ e("option", { value: i.name.replace(/\.md$/, "") }, i.name)) }),
      /* @__PURE__ */ s("span", { className: "a3d-row a3d-row-end", children: [
        /* @__PURE__ */ e("button", { type: "button", className: "a3d-btn", onClick: () => P(null), children: "Cancel" }),
        /* @__PURE__ */ e("button", { type: "submit", className: "a3d-btn a3d-btn-primary", disabled: !p.trim() || ge, children: C === "new" ? "Run: write concept" : C === "score" ? "Run: score" : C === "blender" ? "Run in Blender (Kiln)" : C === "trend" || C === "similar" || C === "season" ? "Run: Scout" : "Run: scout" })
      ] })
    ] }) }),
    ne && h && /* @__PURE__ */ e(
      pi,
      {
        model: h,
        initial: ne,
        busy: ge,
        stepTitle: (i) => se.find((l) => l.id === i)?.title ?? i,
        onCancel: () => $e(null),
        onRun: (i, l) => {
          $e(null);
          const x = se.find((E) => E.id === l.step) ?? null;
          K(i, x, void 0, l);
        }
      },
      `${ne.step}-${ne.parent}`
    ),
    gt && /* @__PURE__ */ e(
      _i,
      {
        status: Z,
        checking: Ht,
        kilnInstalled: !!n?.tools.kilnRun,
        guide: !!n?.tools.blenderGuide,
        onCheck: () => {
          Ke();
        },
        onGuide: In,
        onLaunch: () => {
          Nt(null);
        },
        onClose: () => Fe(!1)
      }
    ),
    Ze && h && /* @__PURE__ */ e(
      xi,
      {
        cmd: Ze,
        model: h,
        onCancel: () => ze(null),
        onRun: (i) => {
          ze(null), S("blender"), et(i.cmd, i.opts, i.description);
        }
      }
    ),
    ft && h && /* @__PURE__ */ e(
      bi,
      {
        model: h,
        last: [...h.printLog].reverse().find((i) => !i.skipped) ?? null,
        onPickPhotos: () => St(t, "image"),
        onCancel: () => Ce(!1),
        onSave: (i) => {
          On(i);
        }
      }
    ),
    T && /* @__PURE__ */ e(qi, { commands: Jn, onClose: () => d(!1) }),
    m && /* @__PURE__ */ e("div", { className: "a3d-overlay", onClick: () => v(null), children: /* @__PURE__ */ s("figure", { className: "a3d-zoom", children: [
      /* @__PURE__ */ e(Ne, { host: t, path: m.path, mtime: m.mtime, alt: m.name }),
      /* @__PURE__ */ e("figcaption", { children: m.name })
    ] }) })
  ] });
}
let mt = null;
async function ms(t) {
  _n(t.services.ai ?? null), bn.modelsRoot = t.services.configuration?.get("modelsRoot", "") ?? "";
  const n = t.services.filesystem;
  mt = {
    read: async (a) => await n.fileExists(a) ? n.readFile(a) : null,
    write: (a, r) => n.writeFile(a, r)
  };
}
async function us() {
  _n(null), mt = null;
}
const fs = {
  forge: { component: ds }
};
function cs({ workspacePath: t }) {
  return t ? mt ? /* @__PURE__ */ s("div", { className: "a3d a3d-settings-page", children: [
    /* @__PURE__ */ e("h2", { children: "AI3D Forge" }),
    /* @__PURE__ */ e(kn, { workspace: t, io: mt })
  ] }) : /* @__PURE__ */ e("p", { className: "a3d-muted", children: "The extension is still starting. Reopen this page in a moment." }) : /* @__PURE__ */ e("p", { className: "a3d-muted", children: "Open a project to edit its AI3D Forge settings." });
}
const gs = { Ai3dSettings: cs };
export {
  ms as activate,
  us as deactivate,
  fs as panels,
  gs as settingsPanel
};
//# sourceMappingURL=index.js.map
