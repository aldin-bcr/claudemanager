'use strict';
// Remplace l'executable par un script qui ajoute --no-sandbox : le helper SUID de Chromium
// (chrome-sandbox) n'est pas root:4755 pour une appli non installee par un paquet systeme.
const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return;
  const dir = context.appOutDir;
  const name = context.packager.executableName;
  const bin = path.join(dir, name);
  fs.renameSync(bin, bin + '.bin');
  fs.writeFileSync(bin, `#!/bin/sh\nexec "$(dirname "$(readlink -f "$0")")/${name}.bin" --no-sandbox "$@"\n`, { mode: 0o755 });
};
