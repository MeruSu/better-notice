# AGENTS.md — read this before touching Better Notice

This file is for AI coding agents. It says what this plugin already does, so you
do not rebuild it, and what will break the host if you get it wrong.

- Package: `@merusu/dsh-better-notice` · version `4.6.1` · MIT
- Host: DeepSeek Harness (DSH) Web UI
- One command to install: `dsh plugin --profile <profile> add @merusu/dsh-better-notice`
- One-page summary for scrapers: [llms.txt](llms.txt) · human docs: [README.md](README.md)

---

## 1. What is already implemented (do not duplicate)

**Problem it solves.** DSH's session list is a flat time-ordered column. With
many sessions you cannot tell which one is waiting for approval, which one just
finished, which one failed.

**Three surfaces, one state per session:**

| Surface | What you see | Where the code lives |
|---|---|---|
| Conversation tab row | one tab seat per hot session; click switches to it | `mountTabSeats` (`client.js:4183`) |
| Left session sidebar | one glyph before each row title, optionally animated | `createSidebarAdapter` / `sidebarStateOf` (`client.js:1861` / `1838`) |
| On state change | a sound and/or a popout picture | `createSoundPlayer` (`client.js:3698`) · `mountPopout` (`client.js:3143`) |

**Six states, judged in this order — highest wins, a session belongs to exactly one:**

```
error  >  pending  >  completed  >  running  >  pinned  >  idle
```

| State | Meaning | Default popout | Default sound |
|---|---|---|---|
| `error` | the agent run failed | yes | `attention.wav` |
| `pending` | waiting for you: approval / question / plan review | yes | `attention.wav` |
| `completed` | this plugin saw it finish (rejection and interruption count too); 7 min retention | yes | `complete.wav` |
| `running` | working, including "child agent running while parent idles" | no | — |
| `pinned` | pinned **in the host's own UI** — read from `pinnedSessionIds`, never stored by this plugin | no | — |
| `idle` | active within the global recent window | no | — |

The two functions that decide this are `classify()` (`client.js:1477-1532`) and
`sidebarStateOf()` (`client.js:1838-1859`). They share the same order but apply
different extra conditions (the sidebar has an error TTL and honours
`completionUnread`). Change both, or you get two different answers for the same
session on two surfaces.

**Default display order** (`CATEGORY_ORDER`, `client.js:123`):
`error 10 · pending 10 · pinned 15 · completed 20 · running 30 · idle 50`.

**Hard row cap:** `PLAN_MAX_ROWS = 37` (`client.js:178`). Rows past it are cut
from the tail — the priority head always survives. `plan.overflow` reports how
many were dropped.

**Settings are never overwritten.** `sanitizeSettings()` (`client.js:764`) is
pure and falls back per field, never wholesale. Unknown keys go to
`PRESERVED_KEY` (`client.js:107`) and come back on the next read; out-of-range
values come back too (`outOfRangeOf`, `client.js:1135`); the last five writes
are kept as a rolling backup ring under `BACKUP_KEY` (`client.js:109`,
`BACKUP_LIMIT = 5`). There is deliberately **no `SETTINGS_VERSION` bump** for
cosmetic changes — a version bump means writing a migration, and a wrong
migration silently wipes user data.

---

## 2. Three constraints that break the host if you violate them

### 2.1 Callbacks handed to the host must be thunks

```js
// correct
label: () => t('settings.nav')
// fatal — the host calls `label()` directly
label: t('settings.nav')
```

The host calls `label()` (`dsh-client-shortcuts/lib/client.js:1190` and
`:1249`). A string there throws inside `refreshLabels()`, which takes down
`uiWorkspace`, and the whole page boots to `Failed to load plugins` with ~20
pending entries. This happened in 4.3.0. A unit test could not catch it because
the test stub never invoked `label()` — if the host will call a callback you
pass in, **the stub must actually call it**.

### 2.2 Package name, module id and bundle entry must all match

`window.__ModuleLoader__.load({ id })` in `client.js` must equal
`package.json`'s `name`, and that same name must be the entry in the profile's
`dsh.profile.bundles`. A mismatch loads the module without registering it, and
nothing visible happens.

### 2.3 Audio cannot go through the package-asset route

The host's package-asset route serves images only
(`dsh-client-modules/lib/index.js:12-19`: `.svg .png .webp .jpg .jpeg`).
Anything else returns 404. Sounds are therefore served by a prefix route this
plugin registers on the host web server:

```js
ctx.inject(['webServer'], (c) => c.effect(() =>
  c.webServer.register({ kind: 'prefix', path: '/hotlist-sound', resource: serveSound }),
  'hotlist: bundled sound cues'));
```

Playback URL is `/hotlist-sound/<name>.wav`. Those static routes are **not
authenticated** — publish public assets only, never user data.

---

## 3. Public API (what an agent should use instead of editing code)

```js
window.__HOTLIST__ = {
  version,                                              // "4.6.1"
  settings: { get, set, reset, subscribe, backups, restore },
  assets:   { add, list, clear, preview },
};
```

- `settings.get()` → the whole live settings object.
- `settings.set(patch)` → shallow merge **per level**. `{glyph:{size:24}}`
  silently drops `glyph.value` and `glyph.motion`. Always send the full
  sub-object you mean.
- `settings.subscribe(fn)` → called on every change; returns an unsubscribe.
- `settings.backups()` → `[{at, version}]`, newest first (5 max).
- `settings.restore(index)` → `{ok, at?}`. Recovery path after a bad write.
- `assets.add(category, kind, {name, dataUrl})` → `{ok, bytes?, reason?}`;
  `kind` ∈ `glyph | popout | sound`; `reason` ∈ `invalid | full | refused | budget`.
- `assets.list(category, kind)` → `[{name, bytes}]`.
- `assets.clear(category, kind)` → boolean.
- `assets.preview(category)` → plays the sound for that category now
  (bypasses the cold-start gate and the 1500 ms throttle).
- There is **no** `settings.defaults`.

Global settings keys: `maxSeats` (1–12), `pinned.maxSeats` (0–12, default 3),
`collect.completedTtlMs` (1–1440 min), `collect.recentWindowMinutes`
(UI 1–36, storage/API 0–120), `sound.volume` (0–100),
`positions.{tab,sidebar,topbar}`, `takeOverStatusDot`.

---

## 4. Layout of the repo

```
client.js              web half — everything the UI does (single file, ~4.7k lines)
index.js               host half — registers the /hotlist-sound prefix route
cordis.patch.yml       one insert line that mounts the plugin
package.json           name / version / files / dsh.{bundle,client}
assets/                error|pending|completed × 4 webp tiers + 6 svg fallbacks
assets/sounds/         attention.wav, complete.wav (+ their manifest)
docs/ARCHITECTURE.md   layering, state model, settings schema, line-number index
docs/EXTENDING.md      API surface + how to extend without breaking data
docs/TESTING.md        the 62 test groups, each with its source line
test/classify.test.mjs the whole self-test (pure node, no browser)
tools/meru-tts/        optional TTS helper for making your own sound cues
```

## 5. Verify before you say it works

```bash
node --check client.js
node --check index.js
node --check test/classify.test.mjs
node test/classify.test.mjs      # expect: PASS — 62 groups
```

`node --check` alone is not enough: a deleted-but-still-referenced constant is
syntactically valid and only fails in the browser. Grep for every identifier you
remove.

## 6. Known limits — do not file these as bugs

1. Text animation only works on the left sidebar. Tab-seat labels are rendered by
   the host; their CSS cannot be animated from here.
2. The `positions.topbar` switch exists but is disabled — the topbar surface is
   not implemented.
3. `.mp3` / `.wav` cannot be served by the package-asset route (see 2.3).
4. Static asset routes are unauthenticated (see 2.3).
5. On desktop the top 40 px of the window is the window-drag region; never give
   an overlay a background there.
6. `settings.pins` is dead weight kept for read compatibility only — pinning now
   comes from the host's `pinnedSessionIds`.
7. `hideNativeDot`, `shortcuts.*` and `overlay.size` still exist as fields but
   have no settings-page row. Their behaviour is unchanged; only the UI is gone.

## 7. Bundled artwork is a placeholder, and that is on purpose

Only the three states that pop a picture by default ship raster art:
`error` and `pending` use **red Meru**, `completed` uses **blue Lan**. The other
three fall back to a packaged SVG and then to an emoji glyph — which is why the
package ships 700 KB instead of 1.6 MB.

The author intends to publish the full artwork-generation workflow as a skill in
this repository in a later release. If a user wants custom art and does not know
how to produce it, they can wait for that, or drop their own square transparent
PNG in through Settings → per category → popout image → upload.
