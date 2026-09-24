const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

function findMacBrowser(home = os.homedir(), exists = fs.existsSync) {
  const names = ["Google Chrome", "Microsoft Edge", "Brave Browser", "Chromium"];
  for (const name of names) {
    for (const base of ["/Applications", path.join(home, "Applications")]) {
      const exe = path.join(base, `${name}.app`, "Contents", "MacOS", name);
      if (exists(exe)) return exe;
    }
  }
  return null;
}

module.exports = { findMacBrowser };
