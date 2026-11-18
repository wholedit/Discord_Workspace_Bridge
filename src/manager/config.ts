// Manager bot settings: its own bot token (in .env) and where it lives (#control channel, owner).
// The manager bot never talks to Claude; it only controls the supervisor's workspace processes.

import fs from "node:fs";
import path from "node:path";
import { homeDir } from "../workspaces.js";

export type ManagerConfig = {
  botId: string;
  botName: string;
  guildId: string;
  channelId: string; // #control: alerts are posted here
  channelName: string;
  ownerId: string; // the only Discord user who may use the commands
};

export const managerDir = () => path.join(homeDir(), "manager");
const configFile = () => path.join(managerDir(), "manager.json");
const envFile = () => path.join(managerDir(), ".env");

export function loadManager(): ManagerConfig | null {
  try {
    return JSON.parse(fs.readFileSync(configFile(), "utf8"));
  } catch {
    return null;
  }
}

export function readManagerToken(): string | null {
  try {
    const m = fs.readFileSync(envFile(), "utf8").match(/^MANAGER_BOT_TOKEN=(.+)$/m);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

export function saveManager(cfg: ManagerConfig, token: string) {
  fs.mkdirSync(managerDir(), { recursive: true });
  fs.writeFileSync(envFile(), `MANAGER_BOT_TOKEN=${token}\n`, { mode: 0o600 });
  fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2));
}

export function removeManager() {
  fs.rmSync(managerDir(), { recursive: true, force: true });
}
