import { readFileSync, writeFileSync, chmodSync } from "fs";
const path = "dist/cli.mjs";
const content = readFileSync(path, "utf8");
if (!content.startsWith("#!")) {
  writeFileSync(path, "#!/usr/bin/env node\n" + content);
}
chmodSync(path, 0o755);
console.log("shebang added →", path);
