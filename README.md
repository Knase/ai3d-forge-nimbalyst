# AI3D Forge — Nimbalyst extension

A fullscreen panel that shows every model as a seven-step flow, with the result of each step, and runs each
step's agent in a Nimbalyst session. Version 0.8.0 (module 2.0.0).

```
Concept → Image → 3D mesh → Blender → Validate → Test print → Publish
 Muse     Lumen    Chisel    Kiln      Anvil      Anvil / you   Herald
```

## What you see
The selected model is the context: the **Model** switcher in the tab bar sets it, and Flow and Files follow it. When
the model has branches, a **Branch** switcher appears next to it; Flow, Files and every button work in that branch.

- **Branches** (v0.8): one column per branch in the graph (click its header to work in it; ★ is the primary).
  **+ New branch…** above the graph and **New branch from here…** on any attempt: start with another image (accepted
  or into inbox/ for review), a link, a 3D file, a brief, or the same inputs; pick where it grows from and its first
  step. Every step before it is copied from the parent branch; from there the branch has its own files to the end.
  **Make primary ★**, **Mark as variant** (own README and listing), **Archive branch**, **Branch folder**. A model
  from before branches shows "move them now" (`flow_log.py migrate-branches`); the first new branch does it anyway.
- **Help** tab (v0.8): where the selected model and branch stand and the next move with what its button runs; your
  turn across models; **Status of all models** (`status.py`, no agent); **Ask Compass** (`ai3d-help` agent); the step
  guide with optimisation tips; the table of every button and the exact command it runs (filterable).
- **Run command…** on each step (v0.8, also ⋯ next to the main button): any agent command of the step, your own
  instruction (saved as the attempt's description for commands that make an attempt), tips for the step, and the
  exact prompt that will be sent. **Tips** toggles the step's guide under the step header.
- Every button has a tooltip with what it runs: the agent skill and command, or the shell command.
- **v0.11:** idle outside AI3D projects. In a project without the module the panel shows one short screen and does
  nothing (no agents, no Blender check, one look a minute); **Turn off in this project** (also in Settings) stops even
  that, per project. The gutter icon itself is Nimbalyst's: disable the extension in its extension settings to remove
  it everywhere.
- **v0.10:** a warning with the exact update command when the project's skills are older than the panel; Help →
  **Setup check** (Python, skills version, config keys, folders, Blender, Blender MCP, Apify) with the fix for each
  line; headings and branch colours follow the host's dark theme.
- **v0.9:** *New attempt* asks first what should be different (with ready phrases), then shows the step's options as
  real controls (“agent decides” unless you choose); where it continues from, model, reasoning, an own option and the
  prompt are under More. *Insights* shows an idea as four stages (Prepare, Score, Decide, Model) with Create model
  available at any stage, and a References block: Find on the web (Muse), Add link, Add picture. *New model…* and
  *Concept from this…* on any picture in Files make a concept from pictures, a link and words, as a new model or a
  branch. Several agent runs can be in flight at once: “N running” in the tab bar lists them (show session / forget).
- **Model and reasoning** (v0.8): each step shows which model and reasoning its agent runs use; Run command… and New
  attempt… have Model and Reasoning pickers for one run; Settings → Agent runs sets the defaults per step.
- **Views** (v0.8): Image → Other actions → Prepare views (Lumen `*views`), then **Add views…** puts the pictures in
  `inbox/views/`, Review views files them in `images/views/`; both galleries show on the Image step.
- **Models**: a **Waiting for you** list (every model whose next move is yours, with what to do), three views:
  Cards, **Board** (one column per step, where each model stands) and Portfolio. One card per model (preview, type, status, current step, counts of images / 3D files / attempts,
  "your turn" or "running"). Click a card to select it and open its Flow. New model, Scout and Portfolio are here.
- **Files**: Images / 3D files (STL, 3MF, GLB, earlier attempts) / Documents. The selected model first, every other
  model in a collapsed section below. Each file shows which attempt made it; from a graph node, **Show files** filters
  to that attempt. **Add image…** / **Add 3D model…** open the system file dialog and put the file where the pipeline
  expects it (image → `inbox/`, GLB → `mesh/raw.glb` with the previous one kept in `mesh/attempts/`, STL → `mesh/`,
  3MF → `print/`); dropping files on the page does the same. **Show in Finder** selects the file in Finder.
  The same Add buttons appear on "your turn" steps.
- **Flow** (top), two views of the same model:
  - **Graph**: six rows (the steps), one box per attempt, arrows from the attempt each one grew from. The blue line
    is the path the model took, "you are here" marks the current attempt, and the current step is marked ▶ in the row
    label. A box shows its label, settings and outcome; ✓ / ✗ is the verdict, a dashed box is a branch you left, grey
    means rebuilt from files (models made before the graph existed). Click a box for its settings, description,
    outcome and files, then **Run again with changes…** (same step, settings prefilled), **Continue from here…**
    (next step, branching from it) or set the verdict. **+ New attempt** in any row opens the same dialog.
  - **Steps**: one card per step — done, next, your turn, or locked — with the step's result on the card.
- **Step detail**: one main button for the next move, "Other actions" for the rest, and the step's results:
  inbox and accepted images, the latest prompt with a Copy button, renders, print analysis numbers, files.
- **Agent session** (right): the live transcript of the run. Verdict questions are answered here.

- **Blender** (chip in the tab bar): green = Blender found and a Blender MCP registered for Claude Code, amber = Blender
  only, red = not found. Click for the details (version, running, where the MCP is registered, Kiln scripts), the
  setup guide and Open Blender.
- **Blender step → Blender quick tools** (background Blender, no agent, no tokens): Analyze (size, watertight, overhang,
  table of bed sides), Quick prep… (size, side, cut, voxel + description → new attempt in the graph), Flexi…
  (segments, clearance… → new attempt), Render previews, Clearance coupon, Open in Blender (work.blend, print.stl,
  raw mesh), and **Blender command…**, which sends one instruction to the Kiln agent for your open Blender.
- **Trends**: Analyse trend…, Similar model… (link, name or photo), Season…, Re-check watched (all Scout runs). A
  calendar strip of the next events with their publish-by dates (red when it has passed); click one to analyse it.
  Per trend: summary, saturation, signals with sources and dates, the original model with licence and IP split
  (similar), ideas ranked by score with **Prepare** (creates it in Insights, no agent) and **Create model** (Muse,
  linked back), the Prism dashboard inline, models that came from it, status new / watching / used / dropped.
- **Insights**: New idea… (saved at once; Prepare runs Muse), per idea: status, Go / Later / No, five score bars,
  recognisable traits, IP risk, variants with printability, reference images, similar models, brief, Create model.
- **Models → Portfolio**: the Prism portfolio dashboard (moved here from the old Insights tab).
- **Settings**: the module config (`_bmad/ai3d/config.yaml`): image backend, 3D service, bed size, overhang angle,
  idea-score weights. Also available as a project page in Nimbalyst's Settings.
- **3D view** button (header) builds and opens the interactive view of the model's STL.
- **Commands** (`Ctrl/Cmd+K`): build 3D view, rebuild all, portfolio, score ideas, new attempt, scout, new model, open model…

- **Flow graph extras**: per attempt a cost (service + credits, summed in the flow bar), dated notes (✎ on the box),
  **Compare** (pick two: settings that differ are highlighted; each STL opens in the 3D view), **Archive branch**
  (hides the attempt and everything that grew from it; "show archived" brings it back).
- **Test print** step (6 of 7): Log a test print… (result, printer, filament, settings, what to change, photos copied
  into `print/photos/`) or Skip; the log, photos and earlier prints are shown in the step.
- **Notifications**: a message in the panel when an agent run ends, and a system notification when the panel is
  hidden (Commands → Turn notifications on/off).
- **Keyboard**: 1–7 tabs · Alt+↑/↓ previous / next model · in Flow: G graph or steps, N new attempt, B new branch,
  C run command on the step, T tips, A / R accept or reject the selected attempt · Cmd/Ctrl+K commands.

## How a step moves
- **Run** starts a new Nimbalyst session with the right skill, action and model already in the prompt.
- **Your turn** steps (generate in Gemini, run Tripo3D) show Copy prompt and Open folder. Drop the file in
  the folder and the card flips to the next action within a few seconds — the panel re-reads the folder every 4 s.
- Steps after the current one are locked until the current one has its files. Finished steps stay runnable.
- "Rebuild README (no agent)" runs `build-readme.py` directly and spends no tokens.
- **Attempts.** Starting an agent step creates a node first (`flow.json`, status running) and the prompt names it, so the
  agent updates that node instead of adding another. When the turn ends the panel sets it to waiting (or failed). The
  settings and description from **New attempt…** go into the prompt as "use exactly these". The graph needs
  `skills/ai3d-forge/scripts/flow_log.py`; without it the panel falls back to the plain step cards.

## Requirements
- Nimbalyst desktop with Claude Code enabled; this extension needs the `filesystem` and `ai` permissions.
- The AI3D Forge skills installed for Claude Code in the same workspace
  (`npx bmad-method install --custom-source ./ai3d --tools claude-code`).
- `python3` on the PATH Nimbalyst sees (used to read the models folder).
- For the Blender step: a Blender MCP server available to the agent sessions.

## Install
A built bundle is in `dist/`. In Nimbalyst: Settings → Application → Advanced → enable **Extension Dev
Tools**, then ask the agent: *"Install the extension in `ai3d/nimbalyst-extension`"* (it uses
`extension_install`). To change the code: `npm install && npm run build && npm run validate`, then
`extension_reload`.

Models folder: `models_folder` from `_bmad/ai3d/config.yaml`, else `_bmad-output/ai3d/`. Override it in the
extension's `modelsRoot` setting.

## Verified / not verified
- Built against `@nimbalyst/extension-sdk` 0.7.2; passes the SDK's `validateExtensionBundle`; type-checks.
- The panel was driven in a headless browser with a mock host that ran the real shell commands against a
  demo workspace: folder scan, step states, image loading, copy, run, live transcript, README rebuild,
  live update after dropping a file, narrow layout.
- v0.3: the graph, attempt dialog, verdicts, branching, node creation and settle were driven the same way
  (real `flow_log.py` against demo models, including models with no `flow.json`).
- v0.4: Models, Files, import (file input with chunked upload, archive of the previous raw mesh) and the migration
  script were driven the same way. The macOS file dialog (`osascript choose file`) and `open -R` could not be run
  in the Linux test host: **unverified on a Mac**.
- v0.5: Blender status, quick tools (real `kiln_run.py` on Blender 5.3's bpy through a stand-in executable), the
  attempt nodes they create, Open in Blender and Blender command were driven the same way. The macOS Blender app,
  `open -a Blender` and `pgrep` on a Mac: **unverified**.
- v0.6: Trends and Insights with sample data and the real `trend_lib.py`: calendar, lists, details, dashboard,
  Prepare, decisions, status changes, and the Scout / Muse / Prism prompts. Live Scout runs with Apify: **not tested**.
- v0.7: board, waiting list, compare (with 3D views of archived STLs), notes, cost, archive, the test print log with a
  photo, and the keyboard shortcuts were driven the same way. System notifications (`Notification` in the Nimbalyst
  window): **unverified**.
- v0.8: branches (create from an image file and from an attempt with the same inputs, lanes, switcher, promote,
  variant), Run command… with the prompt preview, Tips, the Help tab with the real `status.py`, and the migration were
  driven the same way; the scripts' self-tests cover branches, migration and status. The system file dialog in New
  branch (Choose…) is the same `osascript` call as Add image: **unverified on a Mac**.
- **Not run inside Nimbalyst.** These depend on host behaviour read from its source, not observed:
  - whether a dropped file exposes its path (if not, the panel uploads the bytes through the shell, slow for large meshes);
  - the Insights iframe (`srcDoc`, `sandbox="allow-scripts"`) and the `settingsRoutes` Settings page;
  - the transcript appears during the first turn via the internal `sessions:refresh-list` event; if that
    event changes, it appears when the turn ends instead;
  - images load with `file://` URLs, with a shell `base64` fallback;
  - only one run can be starting at a time, because the SDK's `sendPrompt` returns the session only when
    its first turn ends.
