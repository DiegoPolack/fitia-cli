import { chmod } from "node:fs/promises";

// Windows runs the Bun shebang through its generated command shim.
if (process.platform !== "win32") {
  for (const path of process.argv.slice(2)) await chmod(path, 0o755);
}
