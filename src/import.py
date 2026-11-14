"""Place files the user picked into the right folder of a model. Run by the Nimbalyst panel:
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
