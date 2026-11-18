// PC health for /ping: uptime, CPU (sampled over half a second), memory, disk of the home drive.

import fs from "node:fs";
import os from "node:os";
import type { HostInfo } from "./commands.js";

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.irq + c.times.idle;
  }
  return { idle, total };
}

export async function getHostInfo(supervisorStartedAt: number): Promise<HostInfo> {
  const a = cpuTimes();
  await new Promise((r) => setTimeout(r, 500));
  const b = cpuTimes();
  const total = b.total - a.total;
  const cpuPercent = total > 0 ? (1 - (b.idle - a.idle) / total) * 100 : 0;
  const gb = (n: number) => n / 1024 ** 3;
  let diskFreeGb: number | undefined;
  let diskTotalGb: number | undefined;
  try {
    const s = fs.statfsSync(os.homedir());
    diskFreeGb = gb(s.bavail * s.bsize);
    diskTotalGb = gb(s.blocks * s.bsize);
  } catch {}
  return {
    hostname: os.hostname(),
    uptimeSec: os.uptime(),
    supervisorUptimeSec: (Date.now() - supervisorStartedAt) / 1000,
    cpuPercent,
    memUsedGb: gb(os.totalmem() - os.freemem()),
    memTotalGb: gb(os.totalmem()),
    diskFreeGb,
    diskTotalGb,
  };
}
