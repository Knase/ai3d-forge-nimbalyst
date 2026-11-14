import type { BlenderStatus } from './blender';
import type { Scan } from './types';
import { EXPECTED_MODULE, older, PANEL_VERSION } from './version';

export interface Check { name: string; state: 'ok' | 'warn' | 'missing'; detail: string; fix?: string }

/** The shell command that brings the project's skills up to this panel's version, when a copy of the module is found. */
export function updateCommand(scan: Scan): string | null {
  const n = scan.module?.newer;
  return n && !older(n.version, EXPECTED_MODULE) ? `cd '${scan.workspace}' && bash '${n.path}/scripts/update.sh'` : null;
}

/** What the installed skills lack for this panel (empty: up to date). */
export function missingFeatures(scan: Scan): string[] {
  const f = scan.features;
  if (!f) return [];
  return [!f.branches ? 'branches' : '', !f.help ? 'Help and status' : '', !f.views ? 'views for multi-view 3D' : '', !f.webRefs ? 'references from the web' : ''].filter(Boolean);
}

export function outdated(scan: Scan) {
  if (!scan.installed && !scan.tools.flowLog) return false; // not installed at all: a different message
  return missingFeatures(scan).length > 0 || (!!scan.module?.version && older(scan.module.version, EXPECTED_MODULE));
}

/** Everything the pipeline needs, with what is wrong and how to fix it. */
export function healthChecks(scan: Scan, blender: BlenderStatus | null): Check[] {
  const cmd = updateCommand(scan);
  const update = cmd ? `Run in a terminal: ${cmd}` : 'Unpack the new module and run: bash <ai3d>/scripts/update.sh from the project root.';
  const lacks = missingFeatures(scan);
  const v = scan.module?.version;
  const servers = blender?.servers ?? [];
  const scrape = (scan.config.scrape_mcp || 'apify').toLowerCase();
  const apify = servers.find((s) => s.forSessions && s.name.toLowerCase().includes(scrape));
  const bmcp = (blender?.mcp ?? []).find((m) => m.forSessions);
  const cfgMissing = ['models_folder', 'trends_folder', 'insights_folder', 'step_models', 'step_effort'].filter((k) => !scan.config[k]);
  return [
    { name: 'Python 3', state: scan.python ? 'ok' : 'missing', detail: scan.python ? `python3 ${scan.python}` : 'not found', fix: 'Install Python 3 (brew install python).' },
    { name: 'AI3D Forge skills', state: !scan.installed && !scan.tools.flowLog ? 'missing' : outdated(scan) ? 'warn' : 'ok',
      detail: !scan.installed && !scan.tools.flowLog ? 'not installed in this project' : `installed ${v ?? 'version unknown'} · panel ${PANEL_VERSION} is built for ${EXPECTED_MODULE}${lacks.length ? ` · missing: ${lacks.join(', ')}` : ''}`,
      fix: update },
    { name: 'Module config', state: cfgMissing.length ? 'warn' : 'ok', detail: cfgMissing.length ? `missing keys: ${cfgMissing.join(', ')} (defaults are used)` : scan.configPath.replace(`${scan.workspace}/`, ''),
      fix: 'Run: python3 .claude/skills/ai3d-setup/scripts/merge-config.py (update.sh does it).' },
    { name: 'Models folder', state: scan.rootExists ? 'ok' : 'warn', detail: scan.rootExists ? `${scan.root.replace(`${scan.workspace}/`, '')} · ${scan.models.length} models` : `${scan.root} does not exist yet`,
      fix: 'It is created with the first model (Models → New model…).' },
    { name: 'Branch layout', state: scan.models.some((m) => !m.migrated) ? 'warn' : 'ok',
      detail: scan.models.some((m) => !m.migrated) ? `${scan.models.filter((m) => !m.migrated).length} model(s) keep their files in the model folder` : 'every model has branches/',
      fix: 'Works as it is; the first new branch moves the files, or run scripts/migrate-content.sh.' },
    { name: 'Blender', state: blender?.bin ? 'ok' : 'warn', detail: blender ? (blender.bin ? `${blender.version ?? 'found'} · ${blender.bin}` : 'not found') : 'not checked yet',
      fix: 'Install Blender 5.1+ or set blender_bin in Settings. Needed for the quick tools and for Kiln.' },
    { name: 'Blender MCP', state: bmcp ? 'ok' : 'warn', detail: bmcp ? `registered in ${bmcp.where}` : 'not registered for Claude Code sessions',
      fix: 'claude mcp add --scope project blender -- uv --directory "$HOME/blender_mcp/mcp" run blender-mcp (guide: Blender chip → Setup guide). Needed for Kiln *optimize, *flexi, *run.' },
    { name: 'Scrape MCP (Apify)', state: apify ? 'ok' : 'warn', detail: apify ? `registered in ${apify.where}` : `“${scrape}” not registered: Scout and Muse use plain web search`,
      fix: 'claude mcp add --scope project --transport http apify "https://mcp.apify.com?tools=actors,docs,apify/rag-web-browser", then /mcp → authenticate.' },
  ];
}
