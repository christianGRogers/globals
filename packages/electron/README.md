# @globals/electron

The Electron integration for [Globals](https://github.com/christianGRogers/globals): a hidden
owner window that owns the arena, a bootstrap handshake that hands each window its buffer
before the first render, window lifecycle handling, and persistence.

Full guide: [docs/electron.md](../../docs/electron.md).

## Three entry points

```ts
// Main process, at module scope
import { prepare } from "@globals/electron";
prepare();

// Main process, after app ready
import { GlobalsHost, preloadPath } from "@globals/electron";
const host = await GlobalsHost.start({ root, ownerPage: "owner.html" });
host.attach(window, { name: "main-window" });

// Hidden owner window
import { startOwner } from "@globals/electron";
const runtime = startOwner({ initial, operations });

// Any UI window
import { connect } from "@globals/electron/renderer";
const store = await connect();
store.get();  // synchronous
```

## Requirements

- Electron 28 or newer, for ES modules in the main process.
- `sandbox: true` and `contextIsolation: true`. The design is built for them, not despite
  them.
- The application served over the custom protocol, so every response carries COOP and COEP.
  Cross origin isolation is what makes `SharedArrayBuffer` transferable, and it cannot be set
  on `file://`.

## The trust boundary

Every window that maps the arena can write to it. Give any window rendering content you do
not control the asynchronous tier:

```ts
startOwner({ asyncOnly: (name) => name.startsWith("untrusted-") });
```

Read [docs/trust-model.md](../../docs/trust-model.md) before adopting this.
