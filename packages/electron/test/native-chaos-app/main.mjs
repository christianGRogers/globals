/**
 * Window lifecycle chaos over the native transport.
 *
 * The owner lives in the main process and commits at a steady rate the whole time, while
 * windows are reloaded, renderer-crashed, and destroyed-and-recreated at random. The old
 * topology failed this test by construction: one window's death took the owner with it.
 * Here the checks are that the owner never notices, that every surviving or resurrected
 * window is current again by the end, and that no window ever observed an inconsistent
 * commit or a version that went backwards while the storm ran.
 *
 * Consistency is checked the way the core soak does it: every commit carries a counter and
 * a checksum derived from it, read together from one snapshot, so any mixture of two
 * commits is caught by arithmetic rather than by luck.
 *
 *   npm run gate:chaos:native
 */
import { app, BrowserWindow, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFile, unlink } from "node:fs/promises";
import { parseArgs } from "node:util";

import { startNativeOwner } from "../../dist/src/native/owner.js";

const here = dirname(fileURLToPath(import.meta.url));

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    report: { type: "string", default: join(here, "chaos-result.json") },
    seconds: { type: "string", default: "20" },
    windows: { type: "string", default: "4" },
  },
  strict: false,
  allowPositionals: true,
});
const seconds = Number(values.seconds);
const windowCount = Number(values.windows);

const regionPath = join(app.getPath("temp"), `globals-native-chaos-${process.pid}.region`);
const rendererLog = [];
const events = { reloads: 0, crashes: 0, recreations: 0, rendererGone: 0 };
// Latest stats per window boot: a reload or recreation starts a new boot, and keeping every
// boot's last report means a violation seen by a window that later died still fails the run.
const statsByBoot = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function report(checks, verdict) {
  await writeFile(
    String(values.report),
    JSON.stringify(
      {
        electron: process.versions.electron,
        chromium: process.versions.chrome,
        platform: process.platform,
        arch: process.arch,
        at: new Date().toISOString(),
        seconds,
        windows: windowCount,
        events,
        observations: Object.fromEntries(statsByBoot),
        rendererLog: rendererLog.slice(-100),
        checks,
        verdict,
      },
      null,
      2,
    ),
  );
  await unlink(regionPath).catch(() => {});
}

function makeWindow(name) {
  const window = new BrowserWindow({
    show: false,
    width: 500,
    height: 400,
    webPreferences: {
      preload: join(here, "preload.mjs"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--chaos-name=${name}`],
    },
  });
  window.webContents.on("console-message", (_e, _l, message, line, source) => {
    rendererLog.push(`[${name}] ${message} (${source}:${line})`);
  });
  window.webContents.on("render-process-gone", (_e, details) => {
    events.rendererGone += 1;
    rendererLog.push(`[${name}] renderer gone: ${details.reason}`);
  });
  // The storm can destroy a window before its load settles; that is the point, not an error.
  window.loadFile(join(here, "page.html")).catch(() => {});
  return window;
}

async function main() {
  const watchdog = setTimeout(() => {
    void report(
      [{ name: "the run reached a verdict", pass: false, detail: "timed out" }],
      "FAIL",
    ).then(() => app.exit(1));
  }, (seconds + 40) * 1000);
  watchdog.unref?.();

  const owner = await startNativeOwner({
    regionPath,
    initial: { counter: 0, checksum: 0, pad: Array.from({ length: 64 }, () => 0) },
    operations: {},
  });

  // The writer: a commit every five milliseconds for the whole run, so every disruption
  // lands while a write is near. The checksum is what readers validate.
  let writing = true;
  const writer = (async () => {
    while (writing) {
      await owner.update((draft) => {
        draft.counter += 1;
        draft.checksum = (draft.counter * 2654435761) % 0x7fffffff;
        draft.pad[draft.counter % 64] = draft.counter;
      });
      await sleep(5);
    }
  })();

  const lastReportAt = new Map();
  ipcMain.on("chaos:stats", (_event, stats) => {
    statsByBoot.set(`${stats.window}#${stats.boot}`, stats);
    lastReportAt.set(stats.window, Date.now());
  });

  const names = Array.from({ length: windowCount }, (_u, i) => `chaos-${i}`);
  const windows = new Map(names.map((name) => [name, makeWindow(name)]));

  // The healing sweep, keyed on report liveness rather than isCrashed(): Linux does not
  // always register a forced crash, so a dead window can look healthy to every renderer
  // state API while saying nothing. A window that has not reported for a while gets
  // reloaded, whatever the platform thinks happened to it, and the verdict then measures
  // recovery rather than scheduling luck.
  const sweepStart = Date.now();
  const sweep = setInterval(() => {
    for (const [name, window] of windows) {
      if (window.isDestroyed()) continue;
      const seen = lastReportAt.get(name) ?? sweepStart;
      if (Date.now() - seen > 2500) {
        lastReportAt.set(name, Date.now());
        window.webContents.reload();
      }
    }
  }, 1000);

  // Let every window connect before the storm starts.
  await sleep(2500);
  const versionAtStart = owner.version();

  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    await sleep(400 + Math.random() * 500);
    const name = names[Math.floor(Math.random() * names.length)];
    const window = windows.get(name);
    if (window === undefined || window.isDestroyed()) continue;
    const action = Math.floor(Math.random() * 3);
    if (action === 0) {
      events.reloads += 1;
      window.webContents.reload();
    } else if (action === 1) {
      events.crashes += 1;
      window.webContents.forcefullyCrashRenderer();
      // A crashed renderer stays gone until something reloads it.
      setTimeout(() => {
        if (!window.isDestroyed()) window.webContents.reload();
      }, 300);
    } else {
      events.recreations += 1;
      window.destroy();
      windows.set(name, makeWindow(name));
    }
  }

  // Quiet period: the storm is over, the writer keeps going, and every window must find
  // its way back before the verdict. Coming back means observing a version committed
  // after the storm ended, which is a fact about recovery rather than about how fast the
  // writer moved between two progress reports.
  const versionAtQuietStart = owner.version();
  await sleep(5000);
  clearInterval(sweep);
  writing = false;
  await writer;

  const boots = [...statsByBoot.values()];
  const latestByWindow = new Map();
  for (const b of boots) {
    const held = latestByWindow.get(b.window);
    if (held === undefined || b.at > held.at) latestByWindow.set(b.window, b);
  }

  const disruptions = events.reloads + events.crashes + events.recreations;
  const totalReads = boots.reduce((sum, b) => sum + b.reads, 0);
  const violations = boots.reduce((sum, b) => sum + b.violations, 0);
  const regressions = boots.reduce((sum, b) => sum + b.regressions, 0);
  const readerPids = new Set(boots.map((b) => b.pid));

  const checks = [
    {
      // The floor asserts continuity, not throughput: a loaded CI virtual machine commits
      // slowly, and what must be impossible is the owner stopping, not the machine being
      // busy. Twenty per second across a storm is continuity.
      name: "the owner survived the storm and never stopped committing",
      pass: versionAtQuietStart - versionAtStart > seconds * 20,
      detail: `${versionAtQuietStart - versionAtStart} commits across the storm`,
    },
    {
      // rendererGone is recorded but not required: Linux does not reliably emit
      // render-process-gone for a forced renderer crash, and the crash count plus the
      // came-back check below are the evidence that the kills were real and survived.
      name: "the storm was real: windows were reloaded, crashed, and recreated",
      pass:
        disruptions >= Math.max(6, seconds / 2) &&
        events.reloads >= 1 &&
        events.crashes >= 1 &&
        events.recreations >= 1,
      detail: JSON.stringify(events),
    },
    {
      name: "no boot of any window ever read an inconsistent commit",
      pass: boots.length > 0 && violations === 0,
      detail: `${violations} violations in ${totalReads} reads across ${boots.length} boots`,
    },
    {
      name: "no boot ever saw the version go backwards",
      pass: regressions === 0,
      detail: `${regressions} regressions`,
    },
    {
      name: "every window came back and read past the storm",
      pass:
        latestByWindow.size === windowCount &&
        [...latestByWindow.values()].every((b) => b.lastVersion >= versionAtQuietStart),
      detail: [...latestByWindow.values()]
        .map((b) => `${b.window}#${b.boot} at ${b.lastVersion}, quiet began at ${versionAtQuietStart}`)
        .join(", "),
    },
    {
      name: "resurrected windows are new OS processes, none of them the owner",
      pass:
        !readerPids.has(process.pid) &&
        readerPids.size > windowCount,
      detail: `owner ${process.pid}, ${readerPids.size} distinct reader pids for ${windowCount} windows`,
    },
    {
      name: "reads happened at scale",
      pass: totalReads > windowCount * seconds * 20,
      detail: `${totalReads} reads`,
    },
  ];

  const failed = checks.filter((c) => !c.pass);
  clearTimeout(watchdog);
  await report(checks, failed.length === 0 ? "PASS" : "FAIL");
  owner.close();
  app.exit(failed.length === 0 ? 0 : 1);
}

app.whenReady().then(() => {
  main().catch(async (error) => {
    await report(
      [{ name: "the run completed", pass: false, detail: `${error.name}: ${error.message}` }],
      "FAIL",
    );
    app.exit(1);
  });
});
