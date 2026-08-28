/**
 * Spike 03 driver. Requires the addon to be built first:
 *   npx node-gyp configure build
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let addon;
try {
  addon = require("./build/Release/cage.node");
} catch (error) {
  console.error("the addon is not built. Run: npx node-gyp configure build");
  console.error(error.message);
  process.exit(2);
}

const buffer = addon.wrap();
const view = new Int32Array(buffer);

const sentinel = view[0];
console.log(`first read:  0x${sentinel.toString(16)} (expected 0x5eed)`);

addon.pokeNative(0xD00D);
const after = view[0];
console.log(`second read: 0x${after.toString(16)} (0xd00d means it aliases)`);

const aliases = after === 0xD00D;
console.log(
  aliases
    ? "\nresult: the buffer aliases the mapped region, the addon route is open"
    : "\nresult: the buffer is a copy, the V8 cage closed the addon route",
);
console.log("expected on Electron 21 and later, and on recent Node: a copy");
process.exit(aliases ? 1 : 0);
