"""Place files the user picked into the right folder of a model. Run by the Nimbalyst panel:
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
