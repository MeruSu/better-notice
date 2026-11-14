# AGENTS.md — read this before touching Better Notice

This file is for AI coding agents. It says what this plugin already does, so you
do not rebuild it, and what will break the host if you get it wrong.

- Package: `dsh-better-notice` · version `5.2.0` · MIT
- Host: DeepSeek Harness (DSH) Web UI
- One command to install: `dsh plugin --profile <profile> add dsh-better-notice`
- One-page summary for scrapers: [llms.txt](llms.txt) · human docs: [README.md](README.md)

---

## 1. What is already implemented (do not duplicate)

**Problem it solves.** DSH's session list is a flat time-ordered column. With
many sessions you cannot tell which one is waiting for approval, which one just
finished, which one failed.

**Five surfaces, one state per session:**

| Surface | What you see | Where the code lives |
|---|---|---|
| Conversation tab row | one tab seat per hot session; click switches to it | `mountTabSeats` (`client.js:5582`) |
| Left session sidebar | one glyph before each row title, optionally animated | `createSidebarAdapter` / `sidebarStateOf` (`client.js:2993` / `2955`) |
| Window top bar (**Windows desktop**, new in v5) | a row of session pills in the 40 px title strip, next to the tab row | `mountTopbar` (`client.js:6248`) |
| On state change | a sound and/or a popout picture | `createSoundPlayer` (`client.js:4977`) · `mountPopout` (`client.js:4422`) |
| On state change (**opt-in**) | a full-screen amber ring, drawn by a separate process | `createRingPlayer` (`client.js:5080`) · `serveRing` (`index.js:167`) |

**Who is drawn where** (`buildSeatPlan()` takes a `surface` argument): `error` /
`pending` / `completed` go to the window top bar, `pinned` / `idle` go to the tab
row, `running` goes to neither. The two seat surfaces coexist — turning the band
on does **not** hide the tab row, it narrows it to the categories it owns. The
sidebar is independent and shows all six.

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

The two functions that decide this are `classify()` (`client.js:2082-2140`) and
`sidebarStateOf()` (`client.js:2955-2991`). They share the same order but apply
different extra conditions (the sidebar has an error TTL and honours
`completionUnread`). Change both, or you get two different answers for the same
session on two surfaces.

**Default display order** (`CATEGORY_ORDER`, `client.js:185`):
`error 10 · pending 10 · pinned 60 · completed 20 · running 30 · idle 50`.

**Hard row cap:** `PLAN_MAX_ROWS = 37` (`client.js:292`). Rows past it are cut
from the tail — the priority head always survives. `plan.overflow` reports how
many were dropped.

**Settings are never overwritten.** `sanitizeSettings()` (`client.js:1192`) is
pure and falls back per field, never wholesale. Unknown keys go to
`PRESERVED_KEY` (`client.js:169`) and come back on the next read; out-of-range
values come back too (`outOfRangeOf`, `client.js:1692`); the last five writes
are kept as a rolling backup ring under `BACKUP_KEY` (`client.js:171`,
`BACKUP_LIMIT = 5`). There is deliberately **no `SETTINGS_VERSION` bump** for
cosmetic changes — a version bump means writing a migration, and a wrong
migration silently wipes user data.

**One exception: our own factory presets are ours.** A stored value that still
equals a default an earlier release shipped — `💤` for the idle glyph,
`blink`/`none` motion, `motionTarget: 'glyph'`, frequency `1`, sound off — is
not a user choice, so it follows the current default (`LEGACY_VALUES`,
`client.js:214`). A value the user actually picked is recorded in `choices`
(`client.js:1967`, written by `writeSettings()` from the incoming patch
only) and the preset rule never touches it; `resetSettings()` clears the map.

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
  version,                                              // "5.2.0"
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
- `topbar()` → read-only probe: `{ mounted, mode, titleMode, left, leftSource,
  measured, reserve, currentId, capacity, chips }`.
- `export(opts)` → session list as `md` | `txt` | `json`; explicit `ids` win over
  `scope`; a bare call works (it merges the live state first).
- There is **no** `settings.defaults` on this object (`window.__HOTLIST_SETTINGS__`
  is the one that has `defaults()`).

Global settings keys: `maxSeats` (1–12, no auto mode in the UI), `pinned.maxSeats` (0–12, default 3),
`collect.completedTtlMs` (1–1440 min), `collect.recentWindowMinutes`
(UI 1–120, storage/API 0–120, default 17), `sound.volume` (0–100),
`positions.{tab,sidebar,topbar}` (all three are real now; `topbar` defaults to
`true` and only draws on Windows), `scope` (`workspace` | `all` | `smart`),
`takeOverStatusDot`.

Top bar keys: `topbar.{mode, titleMode, maxSeats, previewInWeb, rightReservePx,
chipWidthPct, customScope}`. `titleMode` ∈ `text` | `icon` | `custom` (old names
`unified` / `two` / `smart` / `auto` are aliased); `chipWidthPct` is a
**percentage** `-30…+30`, `0` = unchanged; `customScope` applies only in `custom`
mode. All three title modes strip the emoji already in the session title, so a
name never renders two emoji.

---

## 4. Layout of the repo

```
client.js              web half — everything the UI does (single file, ~6.1k lines)
index.js               host half — registers /hotlist-sound and /hotlist-ring
cordis.patch.yml       one insert line that mounts the plugin
package.json           name / version / files / dsh.{bundle,client}
locale/{en,zh}.json    display name + description the host plugin list reads
icon.svg               plugin-list icon (SVG, under the host's 256 KiB cap)
assets/                error|pending|completed × 4 webp tiers + 6 svg fallbacks
assets/sounds/         attention.wav, complete.wav (+ their manifest)
docs/ARCHITECTURE.md   layering, state model, settings schema, line-number index
docs/EXTENDING.md      API surface + how to extend without breaking data
docs/TESTING.md        the 109 test groups, each with its source line
test/classify.test.mjs the whole self-test (pure node, no browser)
tools/attn-ring/       the full-screen ring script — SHIPS in the npm package
tools/meru-tts/        optional TTS helper; repo only, NOT in the package (~1.6 MB)
```

## 5. Verify before you say it works

```bash
node --check client.js
node --check index.js
node --check test/classify.test.mjs
node test/classify.test.mjs      # expect: PASS — 109 groups
```

`node --check` alone is not enough: a deleted-but-still-referenced constant is
syntactically valid and only fails in the browser. Grep for every identifier you
remove.

### 5.1 If `sh` dies on Windows, it is the sandbox — not git

On Windows, confined agent sandboxes (read-only and workspace-write) block
**named pipes**. MSYS2/Cygwin `sh` starts itself through a signal pipe, so it
fails immediately:

```
1 [main] sh (1076) C:\Git\usr\bin\sh.exe: *** fatal error - couldn't create
signal pipe, Win32 error 5
```

`Win32 error 5` is "access denied", not a broken install. What breaks and what
does not:

- **Breaks** (forks `sh`): `git clone`, `git filter-repo`, `git filter-branch`,
  `git submodule`, and npm lifecycle scripts.
- **Still works** (in-process): `git log`, `git add`, `git commit`, `git diff`,
  `git rev-parse`, `node`, `python`.

Two consequences worth remembering:

1. Rewriting history has to be done with `python` plus git plumbing
   (`cat-file` → rebuild the commit → `hash-object -w` → `update-ref`) when
   `filter-repo` cannot spawn a shell. Verify afterwards that the tree is
   byte-identical: the old and new commits must share the same `^{tree}`.
2. **Sub-agents cannot escape this.** They are pinned to workspace-write and
   their approval prompts are auto-rejected, so `sh` is permanently unavailable
   to them. Only the lead agent can retry with `danger-full-access`, which lifts
   the pipe block — the identical `sh -c "echo hi"` then prints `hi`. Route
   shell-forking work to the lead instead of retrying.

Git may not be under `C:\Program Files\Git`. Ask the tool itself:
`git --exec-path`.

## 6. Known limits — do not file these as bugs

1. Text animation only works on the left sidebar. Tab-seat labels are rendered by
   the host; their CSS cannot be animated from here.
2. The window top bar is **Windows-only and needs the desktop shell** (it lives in
   the 40 px strip that `html[data-windows-titlebar]` marks). In a browser the band
   stays down unless `topbar.previewInWeb` is on. macOS is not supported and will
   not be. The band and the tab row **coexist**: each category owns one surface
   (§1), so a session is never drawn twice — the tab row is not hidden, it is
   narrowed to `pinned` / `idle`.
3. `.mp3` / `.wav` cannot be served by the package-asset route (see 2.3).
4. Static asset routes are unauthenticated (see 2.3).
5. On desktop the top 40 px of the window is the window-drag region; never give
   an overlay a background there.
6. `settings.pins` is dead weight kept for read compatibility only — pinning now
   comes from the host's `pinnedSessionIds`.
7. **The full-screen ring is Windows-only.** It is a WPF window started by PowerShell
   (`tools/attn-ring/Show-AttnRing.ps1`); on other platforms the switches save but
   nothing rises. It covers the primary screen only (`-Scope Primary`), and all three
   switches ship off — default silence is the point of that feature.
8. `hideNativeDot`, `shortcuts.*` and `overlay.size` still exist as fields but
   have no settings-page row. Their behaviour is unchanged; only the UI is gone.

## 7. Bundled artwork is a placeholder, and that is on purpose

Only the three states that pop a picture by default ship raster art, and it is
**animated WebP**: `error` and `pending` use the button-smack clip, `completed`
uses the wave clip. The other three fall back to a packaged SVG and then to an
emoji glyph. The clips are the reason `assets/*.webp` totals ~1.6 MB — a 500 px
10-frame clip does not compress to a still's size, and dropping frames makes the
motion look broken. `error`/`pending`/`completed` each need four tiers named
`<category>-<tier>.webp` for 64 / 320 / 780 / 1560; `780` and `1560` hold the same
500 px animation because the source has no more resolution, `320` is downscaled,
and `64` is a still from frame 0 (settings thumbnail only).

The author intends to publish the full artwork-generation workflow as a skill in
this repository in a later release. If a user wants custom art and does not know
how to produce it, they can wait for that, or drop their own square transparent
PNG in through Settings → per category → popout image → upload.
