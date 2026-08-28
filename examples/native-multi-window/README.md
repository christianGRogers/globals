# The example application

Three windows, two tiers, one owner in the main process.

- **table** and **editor** run with the sandbox off and context isolation on. Their preload
  maps the region and exposes a page API designed around the bridge cost: `view()` returns
  everything a render needs in one crossing, `select(path)` reads one path synchronously,
  and the editor demonstrates the contract on screen, showing the value on the line after a
  write and again after the await.
- **stats** keeps its sandbox and loads the shipped `preload-async.cjs`. It has no
  synchronous read to call; everything it shows arrived by request, and it refreshes off the
  same commit notification the shared tier gets.

```bash
npm run gate:example
```

The trade on display is the one the trust model leads with: the windows that read shared
memory synchronously are the windows that run without the Chromium sandbox.
