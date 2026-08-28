# Multi window example

Four windows over one shared state, with a table of five thousand rows.

```bash
npm install
npm run gate:example
```

## What each window shows

| Window | Shows |
| --- | --- |
| Table | A synchronous read on the render path. Five thousand rows in shared memory, only the visible ones decoded. |
| Editor | Writes as intents, and a demonstration that the read on the next line returns the old value. |
| Arena | What this window can see about its own position, and time travel over the retained versions. |
| Plugin | The trust model opt out. Named `untrusted-plugin`, so it never receives the buffer and has no synchronous read at all. |

## The parts worth reading

**`renderer/owner.html`.** Every write any window can request is declared in one object.
That is what makes the write surface reviewable, and it is why a window sends the name of an
operation rather than a recipe: functions cannot cross a process boundary.

**`renderer/table.html`.** `store.get()` on the render path, with no `await` and no
replicated copy of the rows in this window. Only the visible slice is decoded, because the
view is lazy. Scroll it and watch the version counter keep moving while another window
writes.

**`renderer/editor.html`.** Dispatches a write, reads immediately, and prints both values. It
prints the old one, which is the contract. Then it awaits and prints the new one.

**`renderer/stats.html`.** A debug panel with its own reader, because a reader owns one epoch
slot and pinning a past version through the render reader would suspend the pin the render is
using. Watch `headroom` fall if you scroll the table hard while the writer runs.

**`renderer/untrusted.html`.** The asynchronous tier. There is no `get` on this object at
all, so code written for it cannot accidentally be moved to a synchronous read.

## Things to try

1. Open the table and the editor side by side. Type in the editor and watch the table update
   without either window replicating anything.
2. Click "Bump every score" in the table. That is one commit touching five thousand rows, so
   it is the slow case rather than the fast one, and the version counter shows it.
3. Reload the table window. It reattaches, gets the buffer again, and the row it was showing
   is still there. Its old reader slot is reaped by the liveness detector.
4. Close the plugin window and reopen the application. The state is rehydrated from disk.
