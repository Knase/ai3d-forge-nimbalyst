import type { ExtensionContext, SettingsPanelProps } from '@nimbalyst/extension-sdk';
import { ForgePanel } from './Panel';
import { SettingsForm } from './SettingsForm';
import type { ConfigIO } from './config';
import { setAi } from './runs';
import { settings } from './settings';
import './styles.css';

let fsIo: ConfigIO | null = null;

export async function activate(context: ExtensionContext) {
  setAi(context.services.ai ?? null);
  settings.modelsRoot = context.services.configuration?.get<string>('modelsRoot', '') ?? '';
  const fs = context.services.filesystem;
  fsIo = {
    read: async (p) => ((await fs.fileExists(p)) ? fs.readFile(p) : null),
    write: (p, t) => fs.writeFile(p, t),
  };
}

export async function deactivate() {
  setAi(null);
  fsIo = null;
}

export const panels = {
  forge: { component: ForgePanel },
};

/** The same settings form, shown in Nimbalyst's Settings screen (project scope). */
function Ai3dSettings({ workspacePath }: SettingsPanelProps) {
  if (!workspacePath) return <p className="a3d-muted">Open a project to edit its AI3D Forge settings.</p>;
  if (!fsIo) return <p className="a3d-muted">The extension is still starting. Reopen this page in a moment.</p>;
  return (
    <div className="a3d a3d-settings-page">
      <h2>AI3D Forge</h2>
      <SettingsForm workspace={workspacePath} io={fsIo} />
    </div>
  );
}

export const settingsPanel = { Ai3dSettings };
