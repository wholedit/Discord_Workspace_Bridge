import { loadWorkspaces, removeStateDir, saveWorkspaces } from "./workspaces.js";

export function removeWorkspace(name: string, opts: { quiet?: boolean } = {}) {
  const list = loadWorkspaces();
  if (!list.some((w) => w.name === name)) {
    if (!opts.quiet) console.log(`No workspace named "${name}".`);
    return false;
  }
  saveWorkspaces(list.filter((w) => w.name !== name));
  removeStateDir(name); // deletes this bot's saved token and access rules
  if (!opts.quiet) console.log(`Removed "${name}". The bot itself still exists in the Discord Developer Portal; delete it there if you no longer need it.`);
  return true;
}
