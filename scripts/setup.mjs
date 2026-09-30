import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run this script with npm run setup.");
const root = fileURLToPath(new URL("../", import.meta.url));
for (const directory of [".", "integrations/pi", "integrations/tree-sitter", "integrations/mcp"]) {
  console.log(`Installing locked dependencies: ${directory}`);
  const result = spawnSync(process.execPath, [npmCli, "ci", "--ignore-scripts", "--prefix", directory], {
    cwd: root,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
