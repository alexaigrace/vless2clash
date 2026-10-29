import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const nodeModulesBin = path.join(projectRoot, "node_modules", ".bin");
const commands = [
  ["node", ["server/local.mjs"]],
  [path.join(nodeModulesBin, "vite"), ["--host", "127.0.0.1"]],
];
const children = [];
let stopping = false;

function stopAll(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  const timeout = setTimeout(() => {
    for (const child of children) {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }, 3000);
  timeout.unref();
  process.exitCode = exitCode;
}

for (const [command, args] of commands) {
  const child = spawn(command, args, {
    cwd: projectRoot,
    stdio: "inherit",
    env: process.env,
  });
  children.push(child);
  child.on("error", (error) => {
    console.error(`Could not start ${command}: ${error.message}`);
    stopAll(1);
  });
  child.on("exit", (code, signal) => {
    if (!stopping) {
      console.error(`${command} stopped (${signal ?? code ?? "unknown"}); stopping dev services.`);
      stopAll(code || 1);
    }
  });
}

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));
