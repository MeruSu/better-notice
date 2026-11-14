/**
 * 热表 / Hot List — Client half. Users read README.md, maintainers read
 * docs/ARCHITECTURE.md; this header is only the map of what lives where.
 *
 * Three surfaces, one judgement layer:
 *   - tab row   `conversation.view`, one seat per hot session (mountTabSeats /
 *               disposeTabSeats are the only code that knows that slot)
 *   - sidebar   a status glyph before each session row's title
 *               (createSidebarAdapter is the only code touching sidebar DOM)
 *   - settings  `settings.section` id 'hotlist' (HotlistSettingsPage)
 * `classify()` -> `sortSeats()` -> `buildSeatPlan()` are pure and shared, so a
 * tab seat and a sidebar glyph can never disagree about a session's state.
 *
 * Seats are `hotlist-seat-<sessionId>`, never the bare session id: a view id
 * becomes a *persisted* per-session preference, so a disposed seat would poison
 * it (React error #185 loop — cangku/261111_cr8_react185_crash.png).
 * `healViewPreferences` repairs leftovers on load, `repairSourcePreference`
 * repairs the source session right after a switch. Seat `order` is
 * `category.order * 100 + index`, so it only changes when a seat changes
 * category — never on a 30s refresh (every re-order costs a host restoreView
 * pass and can surface `uiConversation.binding: unknown session`).
 *
 * Data sources (verified against the shipped 0.2.2-rc.1 bundles):
 *   - `sessions.list.getSnapshot()`: dsh-api-session-controller lib/client.js:3830-3835
 *     (shape), :4169-4182 (row fields), :3610 (`updatedAt`), :4192-4235 (subagent rows)
 *   - `uiSession.sessionStatus.getSnapshot()`: dsh-client-ui-session lib/client.js:782-790,
 *     :999-1004 (running / pendingInteraction.kind / completionUnread)
 *   - errors: `ctx.remote.$on("api-session/error", …)` (dsh-api-session-controller:4294)
 *     plus `sessions.binding(id)?.session.getSnapshot()` (`promptError.error.message`,
 *     `lastAgentError`; same file :2910-2935) for already-retained sessions
 *   - workspace + archived ids: `uiWorkspace.workspaces.list.getSnapshot()`
 *   - switching: `uiWorkspace.openSession(sessionId)` (dsh-client-ui-workspace:1473-1475)
 *
 * Judgement precedence is fixed: pinned > pending > error > completed > running
 * > idle. Display order is *not* that precedence — it is
 * `categories[<id>].order`, so "报错在待审前面" is a setting, not a code path.
 * `pending` merges approval / question / plan-review (they share one
 * `pendingInteraction.kind`); a session that both failed and waits for the user
 * lands in `pending` because waiting is the only actionable state. Subagents are
 * not a category: a running child makes its parent `running`.
 *
 * Sidebar glyphs: emoji through `::before{content:attr(data-hotlist-char)}` or a
 * static `<img>`, both animating through the same CSS keyframes on the outer
 * span. Motion is pure CSS (`transform`/`opacity` only), pauses through root
 * attributes while the page is hidden, respects reduce-motion, and fires one
 * single-shot burst per category at most `MOTION_CONCURRENCY` at a time. `motionTarget: 'row'` also drives the
 * host title span inline (opacity/translate only — text never scales). The
 * conversation tab label is a host-rendered string, so it can never animate.
 * `takeOverStatusDot` hides another plugin's `data-dsm-dot` through a
 * `[data-hotlist-style="takeover"]` block + inline `display:none !important`
 * + an observer re-check, never removing the node; `hideNativeDot` hides the
 * host status slot through the row attribute `data-hotlist-hide-native`.
 *
 * Settings model is v4 (`SETTINGS_VERSION`): six `categories` — pinned, error,
 * pending, completed, running, idle — 24 fields each, plus
 *   maxSeats ('auto' | 1–12), collect.{completedTtlMs, recentWindowMinutes},
 *   positions.{tab,topbar,sidebar} (all three false means hidden, never
 *       "fall back to the tab row"),
 *   takeOverStatusDot / hideNativeDot,
 *   display.{reduceMotion},
 *   shortcuts.{jumpEnabled,overlayEnabled,overlayKey} (overlay key resets on reload),
 *   overlay.{side,sizeMin,sizeMax,fallbackImage}, sound.{volume}, pinned.{maxSeats}.
 * Field names are the settings-page contract. `docs/ARCHITECTURE.md` §10 has the
 * migration chain (v3.1 → v4; any other version is read through the v3 table).
 * Storage key `dsh.hotlist.settings.v1`; `window.__HOTLIST_SETTINGS__` exposes
 * get / set(patch) / reset / override(patch|null — tests only).
 *
 * v4.3 ships the judgement layer, the schema, the card settings page, the popout
 * overlay, category sounds and the two cycle hotkeys. `shortcuts.jumpEnabled`
 * stays data-only until `Alt+1..9` is allowed (it is taken by dsh-session-hotkeys),
 * and `shortcuts.overlayKey` is display-only: the handler matches the physical key.
 */

window.__ModuleLoader__.load({
  id: 'dsh-better-notice',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const SLOT = 'conversation.view';
    const NS = 'hotlist';
    const VERSION = '5.1.8';
    /** Seat view ids are namespaced so a persisted leftover can be recognised and repaired. */
    const SEAT_PREFIX = 'hotlist-seat-';
    /** Every prefix ever written for a seat id; a persisted one is repaired back to `chat` on load. */
    const SEAT_PREFIXES = ['hotlist-seat-', 'seat-'];
    const LEGACY_VIEW_ID = 'session-switcher';
    const VIEW_PREF_PREFIX = 'dsh.conversation.';
    /** The bare view id the v2.5 single-tab build could leave behind. */
    const HOTLIST_VIEW_ID = 'hotlist';
    /** The one view-row entry that is not a session: the table of what is hot right now. */
    const TABLE_VIEW_ID = 'hotlist-table';
    /** After every seat: a seat's order is `categories[*].order * 100 + position`, at most 9999. */
    const TABLE_VIEW_ORDER = 10000;
    const REFRESH_MS = 30 * 1000;
    const RESIZE_DEBOUNCE_MS = 200;
    /** Fallback when the tab row cannot be measured; the row shows 6 tabs at typical widths. */
    const FALLBACK_LIMIT = 6;
    const TAB_WIDTH = 120;
    const TAB_ROW_PADDING = 48;
    const LABEL_WIDTH = 16;
    const ERROR_TEXT_LIMIT = 80;
    const ERROR_TTL_MS = 10 * 60 * 1000;
    /** A candidate set that shrank is confirmed by a second read this much later before seats are removed. */
    const SHRINK_CONFIRM_MS = 250;
    /** How long a seat that disappeared with its session is kept ready to come back as it was. */
    const RECENT_SEAT_MS = 60 * 1000;

    /**
     * The top bar (v5, form A): one transparent band along the desktop window's
     * title strip, one pill per hot session. Only the pills paint — the band
     * itself has no background, no border and no cursor, so the strip stays
     * draggable wherever there is no pill (see `docs/ARCHITECTURE.md` §18).
     */
    const TOPBAR_SLOT = 'shell.overlay';
    const TOPBAR_ID = 'hotlist.topbar';
    /** Built-in overlay entries all use 0; -10 keeps the band under the toasts. */
    const TOPBAR_ORDER = -10;
    const TOPBAR_MODES = ['chips', 'count', 'off'];
    /** What a session label starts with: text only, the category icon, or the session's own leading emoji. */
    const TOPBAR_TITLE_MODES = ['text', 'icon', 'custom'];
    /** Stored label modes of earlier builds; read as one of the three names above, never rewritten. */
    const TITLE_MODE_ALIASES = { unified: 'text', two: 'icon', smart: 'custom', auto: 'icon' };
    /** Which workspaces feed every surface: current only, all, or all without cross-workspace pins. */
    const SCOPE_MODES = ['workspace', 'all', 'smart'];
    /** Right edge: the native window buttons are about 138 px wide and are not in the DOM. */
    const TOPBAR_RESERVE = { min: 0, max: 400, fallback: 0 };
    /**
     * Width the window buttons (minimise / maximise / close) own at the right edge of
     * the desktop title bar. It is not a setting: the band may never paint a pill under
     * them, so the width arithmetic always subtracts it.
     */
    const WINDOW_CONTROLS_GUARD = 138;
    /** Height of the desktop title strip; a web page has no strip, so the band is preview only there. */
    const BAND_FALLBACK = 40;
    /** The hit test walks the left stretch of the strip in these steps, and stops at this x. */
    const OCCUPIED_PROBE_STEP = 4;
    const OCCUPIED_PROBE_TO = 460;
    /**
     * Only a narrow element hugging the left edge counts as "somebody is already there". A
     * full-width header also answers the hit test (the web layout has one across the strip) and
     * its right edge is the viewport, which would push every pill off screen.
     */
    const OCCUPIED_LEFT_SLACK = 64;
    const OCCUPIED_MAX_WIDTH = 480;
    /** The desktop menu strip holds two buttons; the measured right edge wins, this is the guess. */
    const MENU_GUESS = 160;
    /** Retries after mount: the menu strip can mount a frame after our entry does. */
    const TOPBAR_PROBES = [0, 60, 250, 700];
    const CHIP_GAP = 4;
    /** 24 px of padding plus 12 px per code point (a CJK glyph is 12–13.5 px at 13 px). */
    const CHIP_PAD = 24;
    const CHIP_CHAR = 12;
    const CHIP_MIN = 72;
    const CHIP_MAX = 140;
    /** The emoji column of a pill: a 14 px glyph plus the 4 px gap. */
    const CHIP_GLYPH = 18;
    /** Width of the `+N` pill; `fitChipCount` reserves it before it decides. */
    const MORE_WIDTH = 40;
    /** The only mark between two pills: a hairline drawn as an inset shadow, so it costs no layout width. */
    const CHIP_SEPARATOR = 'rgba(127,127,127,0.10)';
    /** The pill-width setting: a percentage both shipped defaults move by. */
    const CHIP_PCT = { min: -30, max: 30, step: 5, fallback: 0 };
    /** What the width select offers, so a snapped value always has an option to land on. */
    const CHIP_PCT_STEPS = [-30, -25, -20, -15, -10, -5, 0, 5, 10, 15, 20, 25, 30];

    const SETTINGS_KEY = 'dsh.hotlist.settings.v1';
    /** Data a future build wrote: kept verbatim so an update never deletes what we do not understand. */
    const PRESERVED_KEY = 'dsh.betterNotice.preserved.v1';
    /** Rolling copies of the last few stored blobs; `window.__HOTLIST__.settings.restore(i)` reads them. */
    const BACKUP_KEY = 'dsh.betterNotice.backup.v1';
    const BACKUP_LIMIT = 5;
    const LEGACY_SETTINGS_KEY = 'dsh.session-switcher.settings';
    const SETTINGS_VERSION = 4;
    /** Settings section: `settings.section` nav entry for this plugin. */
    const SECTION_ID = 'hotlist';
    /** After the official sections (account -10, general 0, models 10, plugins 15, agent-presets 20). */
    const SECTION_ORDER = 30;

    /**
     * v4 model: six categories, fixed ids. `pending` merges approval + question/plan-review into
     * one category with two glyphs; `subagents` folds into `running`.
     */
    const CATEGORY_IDS = ['pinned', 'error', 'pending', 'completed', 'running', 'idle'];
    const CATEGORY_ORDER = { error: 10, pending: 10, pinned: 60, completed: 20, running: 30, idle: 50 };
    /** Tie-break for equal `order` values: `error` before `pending`, then down the list. */
    const CATEGORY_RANK = { error: 0, pending: 1, pinned: 2, completed: 3, running: 4, idle: 5 };
    /**
     * `order` values that earlier versions wrote as their own default. A stored value equal to one of
     * these was never a user choice, so the current default may replace it; anything else is left alone.
     * `error` (10) had the same default in both generations, so it needs no entry. `LEGACY_VALUES`
     * below applies the same boundary field by field.
     */
    const LEGACY_DEFAULTS = {
      'categories.pinned.order': [0, 1, 15],
      'categories.pending.order': [20],
      'categories.completed.order': [30],
      'categories.running.order': [40],
    };
    /** Ids an older build stored but this one no longer has: dropped outright, never kept as "unknown". */
    const RETIRED_PATHS = ['categories.favorite'];
    const SORT_BY = ['time', 'manual'];
    /** Default glyph per category (`glyphSecondary` starts on `pending` only). */
    const CATEGORY_GLYPHS = { pinned: '📌', error: '⛔', pending: '🔐', completed: '✅', running: '⏳', idle: '🧊' };
    const CATEGORY_MOTION = { pinned: 'bounce', error: 'bounce', pending: 'bounce', completed: 'spin', running: 'spin', idle: 'none' };
    /** Per-category default playback frequency (`1` = every tick, `0` = never). */
    const CATEGORY_FREQUENCY = { pinned: 0.3, error: 0.9, pending: 0.9, completed: 1, running: 1, idle: 0 };
    /**
     * Values that earlier builds wrote as their own default. A stored value that matches one of
     * these was never a choice, so the current default replaces it; anything else is the user's and
     * is left untouched. The first column is the generation current at v4.3.0 (`motionTarget` was `glyph`,
     * every frequency was `1`, every sound was off). Same rule as `LEGACY_DEFAULTS` above.
     */
    const LEGACY_VALUES = {
      'glyph.value': ['💤'],
      'glyph.motion': ['none', 'blink'],
      'glyph.motionTarget': ['glyph'],
      'glyph.frequency': [1],
      'glyphSecondary.motion': ['blink'],
      'sound.enabled': [false],
      /**
       * v4 shipped the top-bar switch disabled (`() => {}, true`), so a stored `false` is
       * the old factory default, not a pick — without this every upgraded profile keeps the
       * band switched off forever.
       */
      'positions.topbar': [false],
      /**
       * v4.6 shipped 5 minutes as the window default. A stored 5 with no marker is that default,
       * not a pick, so the current 17 replaces it; anyone who typed 5 gets a marker and keeps it.
       */
      'collect.recentWindowMinutes': [5],
    };
    /**
     * Which picks the page can offer, and where their marker lives. Writing one of those fields
     * makes it the user's choice — from then on `LEGACY_VALUES` never touches it again.
     */
    const CHOICE_SLOTS = ['glyph', 'glyphSecondary'];
    const CHOICE_FIELDS = ['value', 'motion', 'motionTarget', 'frequency'];
    const CHOICE_KEY = /^(?:categories\.[a-z]+\.[a-zA-Z]+(?:\.[a-zA-Z]+)?|positions\.topbar|collect\.recentWindowMinutes)$/;
    const CHOICE_LIMIT = 256;
    /**
     * Which surface each class belongs to. The split is the point of the feature: the band is
     * the urgent row (error / pending / completed), the tab row is the background row (pinned /
     * idle). `running` is deliberately on neither — it is what you are already doing, and the
     * host draws it in the sidebar. `sidebar` still shows all six.
     */
    const CATEGORY_SURFACES = {
      pinned: { tab: true, sidebar: true, topbar: false },
      error: { tab: false, sidebar: true, topbar: true },
      pending: { tab: false, sidebar: true, topbar: true },
      completed: { tab: false, sidebar: true, topbar: true },
      running: { tab: false, sidebar: true, topbar: false },
      /** Idle keeps its tab seat: the user asked for a third tier inside the tab row. */
      idle: { tab: true, sidebar: true, topbar: false },
    };
    const MOTION_NAMES = ['none', 'spin', 'pulse', 'bounce', 'blink'];
    const MOTION_TARGETS = ['glyph', 'row'];
    const REDUCE_MOTION_VALUES = ['auto', 'on', 'off'];
    /** What a glyph shows: an emoji, an uploaded image, or that category's popout artwork. */
    const GLYPH_SOURCES = ['emoji', 'upload', 'popout'];
    /**
     * How often a category bursts: `1` fires on every tick, `0` never animates.
     * Each category rolls once per tick, so the slider is a playback frequency.
     */
    const MOTION_FREQUENCY = { min: 0, max: 1, step: 0.05, fallback: 1 };
    /** Builds up to 4.3 stored an average interval; 2000ms meant "as often as possible". */
    const LEGACY_INTERVAL_MS = { min: 2000, max: 60000 };
    const POPOUT_ENTRANCES = ['slide', 'unfold', 'overshoot', 'fade'];
    const POPOUT_AMBIENTS = ['none', 'breath', 'float'];
    const POPOUT_EXITS = ['drop', 'particles', 'fade', 'slide-out'];
    const POPOUT_DISPLAY_MS = { min: 2000, max: 20000, step: 500, fallback: 7000 };
    const GLYPH_TEXT_LIMIT = 2;
    /** Uploaded glyphs are data URLs; `svg+xml` is rejected (it can carry script), gif keeps its first frame. */
    const GLYPH_IMAGE_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
    const GLYPH_MAX_BYTES = 16 * 1024;
    const MAX_SEATS = { min: 1, max: 12, fallback: 6 };
    /** How many pinned sessions the top of the tab row may hold (`0` = show none). */
    const PINNED_SEATS = { min: 0, max: 12, fallback: 3 };
    // Hard ceiling 37: the plan is sorted by priority, so the tail is exactly what a crowded workspace
    // should lose. High-priority rows push the low ones out, never the other way round.
    const PLAN_MAX_ROWS = 37;
    /** Urgent categories (pinned/pending/error) may exceed `maxSeats`, but never by more than this. */
    const ALWAYS_OVERFLOW = 4;
    const TTL_MINUTES = { min: 1, max: 1440 };
    /** One global window: how recently a session moved to enter the idle tier. */
    const RECENT_WINDOW_MINUTES = { min: 0, max: 120, fallback: 17 };
    /**
     * What the settings page offers for that window: the same 1–120 a person may want. Storage and
     * the API keep 0 as "no window" for a caller that asks for it explicitly; the row never shows 0.
     */
    const RECENT_WINDOW_UI = { min: 1, max: 120 };
    /** One-slot animation bursts: never more than this many glyphs animating at once. */
    // four titles moving at once is the readability ceiling; frequency decides how often.
    const MOTION_CONCURRENCY = 4;
    const OVERLAY_SIDES = ['auto', 'left', 'right'];
    /** Popout artwork is sized in CSS px; the two bounds clamp a single global min/max pair. */
    const OVERLAY_SIZE = { min: 120, max: 900, fallbackMin: 260, fallbackMax: 520 };
    /** One category keeps at most this many pictures or sounds per pool; a pool is picked by index. */
    const ASSET_POOL_MAX = 6;
    /** Per-item ceilings of the three asset pools (decoded bytes). */
    const POPOUT_MAX_BYTES = 64 * 1024;
    const SOUND_MAX_BYTES = 128 * 1024;
    /** The whole bundle of uploaded assets stays well under a localStorage budget. */
    const ASSET_TOTAL_MAX_BYTES = 2 * 1024 * 1024;
    const ASSET_KINDS = ['glyph', 'popout', 'sound'];
    /** Uploaded sounds are data URLs; anything that is not audio is refused before it is stored. */
    const SOUND_AUDIO_RE = /^data:audio\/[\w.+-]+;base64,[A-Za-z0-9+/=]+$/;
    /**
     * Built-in sounds: two packaged clips, served by the host at this same-origin
     * prefix and mapped one-to-one — one alert sound and one completion sound,
     * not a random pool.
     */
    const SOUND_URL = '/hotlist-sound/';
    const BUILTIN_SOUND = { pending: 'attention.wav', error: 'attention.wav', completed: 'complete.wav' };
    /** Only these three classes have packaged files on the host. */
    const SOUND_CATEGORIES = Object.keys(BUILTIN_SOUND);
    /** Two sounds closer than this are one event: the later one is dropped, never queued. */
    const SOUND_THROTTLE_MS = 1500;
    /** Physical code of the manual popout key; `shortcuts.overlayKey` is its display string. */
    const OVERLAY_CODE = 'KeyS';

    /** A sidebar/tab token is what one row shows: pending owns two of them. */
    const CATEGORY_OF_TOKEN = {
      pinned: 'pinned',
      approval: 'pending',
      question: 'pending',
      error: 'error',
      completed: 'completed',
      running: 'running',
      idle: 'idle',
    };

    /** One glyph entry: what to draw, how big, how it moves, and how often it may animate. */
    // Defaults only fill gaps: a stored value always wins, so bumping a default never rewrites a user's choice.
    function defaultGlyph(category) {
      return {
        kind: 'emoji',
        value: CATEGORY_GLYPHS[category] ?? '',
        source: 'emoji',
        motion: CATEGORY_MOTION[category] ?? 'none',
        motionTarget: 'row',
        frequency: CATEGORY_FREQUENCY[category] ?? MOTION_FREQUENCY.fallback,
        uploads: [],
      };
    }

    /** One category: the v4 contract table plus the `glyph.source` / `glyph.frequency` fields. */
    function defaultCategory(category) {
      const popout = category === 'error' || category === 'pending' || category === 'completed';
      return {
        enabled: true,
        order: CATEGORY_ORDER[category],
        sortBy: category === 'pinned' ? 'manual' : 'time',
        surfaces: { ...CATEGORY_SURFACES[category] },
        glyph: defaultGlyph(category),
        glyphSecondary: category === 'pending'
          ? { ...defaultGlyph('pending'), value: '❓', motion: 'bounce' }
          : null,
        popout: {
          enabled: popout,
          builtin: true,
          images: [],
          displayMs: POPOUT_DISPLAY_MS.fallback,
          entrance: 'slide',
          ambient: popout ? 'breath' : 'none',
          exit: 'drop',
          side: 'auto',
        },
        sound: {
          enabled: ['error', 'pending', 'pinned', 'completed'].includes(category),
          builtin: true,
          uploads: [],
        },
      };
    }

    function defaultCategories() {
      const categories = {};
      for (const category of CATEGORY_IDS) categories[category] = defaultCategory(category);
      return categories;
    }

    function defaultSettings() {
      return {
        version: SETTINGS_VERSION,
        maxSeats: 6,
        scope: 'smart',
        positions: { tab: true, topbar: true, sidebar: true },
        topbar: { mode: 'chips', titleMode: 'custom', maxSeats: 6, previewInWeb: false, rightReservePx: TOPBAR_RESERVE.fallback, chipWidthPct: CHIP_PCT.fallback, customScope: defaultCustomScope() },
        takeOverStatusDot: true,
        hideNativeDot: true,
        /** Bursts are per-category: each one rolls its own `glyph.frequency` on every tick. */
        display: { reduceMotion: 'auto' },
        shortcuts: { jumpEnabled: true, overlayEnabled: false, overlayKey: 'Alt+Shift+S' },
        overlay: { side: 'auto', sizeMin: OVERLAY_SIZE.fallbackMin, sizeMax: OVERLAY_SIZE.fallbackMax, fallbackImage: '' },
        collect: { completedTtlMs: 7 * 60 * 1000, recentWindowMinutes: RECENT_WINDOW_MINUTES.fallback },
        sound: { volume: 60 },
        pinned: { maxSeats: PINNED_SEATS.fallback },
        /** Fields the user picked himself; anything absent here is still a factory preset. */
        choices: {},
        categories: defaultCategories(),
      };
    }

    /** Derived visibility: the only place the three surfaces are turned into decisions. */
    function positionsOf(settings) {
      const positions = settings.positions;
      const idle = settings.categories.idle;
      return {
        surfaceVisible: positions.tab === true || positions.topbar === true,
        allPositionsOff: !(positions.tab === true || positions.topbar === true || positions.sidebar === true),
        nativeDotVisible: !(positions.sidebar === true && settings.hideNativeDot === true),
        idleMarkVisible: positions.sidebar === true && idle.enabled === true && idle.surfaces.sidebar === true,
      };
    }

    /** True inside the desktop shell: only it injects the 40 px title strip. */
    function hasWindowsTitlebar() {
      const root = typeof document === 'undefined' ? void 0 : document.documentElement;
      return root !== void 0 && root !== null && typeof root.hasAttribute === 'function' && root.hasAttribute('data-windows-titlebar');
    }

    /**
     * Width of one pill, in px, from its label alone. Deliberately an estimate:
     * the pill is laid out with exactly this width (`chipStyle`), so the number
     * `fitChipCount` works with is the number the browser renders. One pill too
     * few is safe, one too many would run under the window buttons.
     */
    /**
     * Pill width bounds come from the settings page: one number, the widest a
     * pill may get. Below `CHIP_MIN` the floor follows it, so narrowing the
     * setting narrows the short titles too instead of clamping them back up.
     */
    /**
     * Pill width bounds: the shipped defaults shifted by the user's percentage,
     * each end on its own, so `0%` reproduces `CHIP_MIN`/`CHIP_MAX` exactly.
     */
    function chipBounds() {
      const factor = 1 + readSettings().topbar.chipWidthPct / 100;
      return { min: Math.round(CHIP_MIN * factor), max: Math.round(CHIP_MAX * factor) };
    }

    function chipWidthOf(title) {
      const text = typeof title === 'string' ? title : '';
      const chars = Array.from(text).length;
      const bounds = chipBounds();
      return clamp(CHIP_PAD + chars * CHIP_CHAR, bounds.min, bounds.max);
    }

    /**
     * How many of `widths` fit in `available`, reserving room for the `+N` pill
     * when something is left over. Pure arithmetic: the band never measures its
     * own children, so the first paint decides without waiting for layout. An
     * unreadable width means "show everything" — returning 0 would blink on
     * every resize.
     */
    function fitChipCount(widths, available) {
      const total = widths.length;
      if (typeof available !== 'number' || Number.isFinite(available) === false || available <= 0) return total;
      let count = 0;
      let used = 0;
      for (const width of widths) {
        const step = count === 0 ? width : width + CHIP_GAP;
        if (used + step > available) break;
        used += step;
        count += 1;
      }
      /** Everything fits: there is no `+N` pill, so the greedy answer stands. */
      if (count === total) return count;
      /** Make room for `+N`, but never drop the row to nothing: the right reserve covers the rest. */
      while (count > 1) {
        let sum = 0;
        for (let index = 0; index < count; index += 1) sum += widths[index] + (index === 0 ? 0 : CHIP_GAP);
        if (sum + MORE_WIDTH + CHIP_GAP <= available) break;
        count -= 1;
      }
      return count;
    }

    const ZH = {
      'tab.untitled': '未命名会话',
      'tab.placeholder': '正在切换到该会话…',
      'tab.error': '无法切换会话：uiWorkspace 服务不可用。',
      'tab.failed': '上次运行失败：',
      'settings.nav': '热表',
      'settings.close': '关闭',
      'settings.title': '热表',
      'settings.subtitle': '控制对话区 tab 行的座位数量、状态图标与显示位置。',
      'settings.group.motion': '动效',
      'settings.maxSeats': '座位上限',
      'settings.maxSeatsHint': '对话区 tab 行最多显示几个会话（1–12）。',
      'settings.scope': '显示范围',
      'settings.scopeHint': '哪些工作区的会话进列表（顶栏、tab 行与侧栏一致）。',
      'settings.scope.workspace': '仅当前工作区',
      'settings.scope.all': '全部工作区',
      'settings.scope.smart': '全部工作区，但不显示跨工作区的置顶',
      'settings.pinnedMaxSeats': '置顶最多显示',
      'settings.pinnedMaxSeatsHint': '对话区 tab 行最多显示几个已置顶会话（0–12）；0 = 不显示。',
      'settings.ttl': '刚完成保持时长（分钟）',
      'settings.ttlHint': '会话跑完后仍留在列表里的时间。',
      'settings.recentWindow': '最近对话展示时间（分钟）',
      'settings.recentWindowHint': '1–120 分钟。最后活动在这个时间内的会话会进第 3 级（闲置）并出现在对话区 tab 行。',
      'settings.motion': '动效',
      'settings.motion.none': '不动',
      'settings.motion.spin': '旋转',
      'settings.motion.pulse': '呼吸',
      'settings.motion.bounce': '弹跳',
      'settings.motion.blink': '闪烁',
      'settings.motionTarget': '作用于',
      'settings.motionTarget.glyph': '仅图标',
      'settings.motionTarget.row': '图标+标题',
      'settings.frequency': '播放频率',
      'settings.frequencyHint': '0% 不播；100% 每个节拍都播，越往左越稀。',
      'settings.glyphFollowHint': '跟随',
      'settings.position.tab': '对话区 tab 行',
      'settings.position.tabHint': '显示在对话区上方；桌面版与网页版都可用。',
      'settings.position.topbar': '窗口顶栏',
      'settings.position.topbarHint': '显示在窗口最上沿的标题栏里；仅桌面版可用，网页版可在下面打开预览。',
      'settings.position.webOnly': '显示在窗口最上沿的标题栏里；当前是网页版，可在下面打开预览。',
      'settings.topbar.previewInWeb': '网页版预览',
      'settings.topbar.previewInWebHint': '网页版没有窗口顶栏，打开后会在页面顶部画一条预览。',
      'settings.topbar.chipWidth': '胶囊宽度',
      'settings.topbar.chipWidthHint': '相对默认宽度的增减百分比，步进 5%。',
      'settings.topbar.chipWidthDefault': '默认',
      'settings.topbar.titleMode': '标签显示设置',
      'settings.topbar.titleMode.text': '仅显示文本',
      'settings.topbar.titleMode.icon': '使用插件图标',
      'settings.topbar.titleMode.custom': '自定义显示图标',
      'settings.topbar.titleModeHint': '决定会话标签前显示什么：只有文本、这类自己的图标，或会话名开头那颗 emoji。',
      'settings.topbar.customScope': '自定义生效范围',
      'settings.topbar.customScopeHint': '勾选的类别用会话名开头的 emoji 替换图标；没勾的仍用这类自己的图标。',
      'settings.topbar.maxSeats': '顶栏最多显示',
      'settings.topbar.maxSeatsHint': '顶栏最多显示几个会话（1–12），与对话区 tab 行互不影响。',
      'settings.surface.tab': 'Tab 行',
      'settings.surface.tabHint': '开启后该类别会出现在对话区的 Tab 行里。',
      'settings.surface.sidebar': '侧栏',
      'settings.surface.sidebarHint': '开启后该类别会在左侧会话列表里显示状态图标。',
      'settings.surface.topbar': '顶栏',
      'settings.surface.topbarHint': '开启后该类别会出现在窗口顶栏的胶囊行里。',
      'topbar.count': '另有 {count} 个',
      'topbar.countHint': '点击切到下一个未显示的会话',
      'topbar.moreHint': '另有 {count} 个，点击逐个切换',
      'surface.topbar': '窗口顶栏',
      'view.table': '热表',
      'view.lead': '当前热表 {count} 条，未进入 {missing} 条。',
      'view.col.index': '序号',
      'view.col.category': '类别',
      'view.col.order': '顺序值',
      'view.col.title': '标题',
      'view.col.where': '出现在哪',
      'view.col.note': '备注',
      'view.surface.tab': 'Tab 行',
      'view.surface.sidebar': '侧栏',
      'view.surface.topbar': '顶栏',
      'view.surface.none': '都没出现',
      'view.note.current': '当前会话',
      'view.note.pin': '置顶 #{level}',
      'view.note.error': '失败：{message}',
      'view.missing': '未进入热表（{count}）',
      'view.missingNone': '所有会话都在表里。',
      'view.reason.empty': '还没有任何消息',
      'view.reason.subagent': '子代理会话，不占座位',
      'view.reason.scope': '属于其他工作区，被 scope 裁掉',
      'view.reason.no-category': '未运行、未置顶，也不在近期的闲置窗口内',
      'view.reason.surface-off': '该类别在 Tab、侧栏、顶栏三处都关着',
      'view.reason.position-off': '该类别只在一个已关闭的位置上显示',
      'view.reason.over-cap': '超出座位上限被截（Tab 行 {limit} 个）',
      // Group headings: short names, because the full sentence above is already
      // shown on each row. Order of the list is fixed in `groupMissing()`.
      'view.group.over-cap': '超上限',
      'view.group.scope': '其他工作区',
      'view.group.surface-off': '三处都关',
      'view.group.position-off': '位置关着',
      'view.group.no-category': '无状态',
      'view.group.empty': '空会话',
      'view.group.subagent': '子代理',
      'view.missingHint': '默认收起，点一行展开该组；组内序号即该组顺序。',
      'view.missingMore': '展开剩余 {count} 条',
      'settings.position.allOff': '热表当前不可见，可从设置重新打开。',
      'settings.takeOverStatusDot': '接管会话行首标记',
      'settings.takeOverStatusDotHint': '隐藏其它插件在会话行首画的状态点（仅侧栏）。',
      'settings.storageFailed': '设置未能写入本地存储，本次改动只在当前页面生效。',
      'settings.group.global': '全局',
      'settings.group.icon': '图标',
      'settings.group.popout': '弹出',
      'settings.group.sound': '音效',
      'settings.group.order': '顺序',
      'settings.category.pinned': '置顶',
      'settings.category.error': '报错',
      'settings.category.pending': '待处理',
      'settings.category.completed': '已完成',
      'settings.category.running': '进行中',
      'settings.category.idle': '闲置',
      'settings.chip.tab': '对话 tab 行',
      'settings.chip.sidebar': '侧栏',
      'settings.chip.topbar': '顶栏',
      'settings.chip.popout': '弹出提示',
      'settings.chip.sound': '音效',
      'settings.chipShort.tab': 'Tab',
      'settings.chipShort.sidebar': '侧栏',
      'settings.chipShort.topbar': '顶栏',
      'settings.chipShort.popout': '弹图',
      'settings.chipShort.sound': '音效',
      'settings.chip.positionHint': '位置在页面上方全局区设置。',
      'settings.card.orderTag': '· 顺序 {order}',
      'settings.card.disabled': '停用',
      'settings.glyphSecondary': '提问样式',
      'settings.glyphPlaceholder': '输入字符',
      'settings.glyphTextLimit': '最多 2 个字符；清空即不显示图标。',
      'settings.resetCategory': '重置这一类',
      'settings.resetCategoryHint': '只恢复这一类的出厂设置，并清除它的选择标记。',
      'settings.resetCategoryGo': '重置',
      'settings.upload.missing': '没有选中文件。',
      'settings.upload.type': '只支持 PNG / JPEG / WebP / GIF（不收 SVG）。',
      'settings.upload.size': '源文件超过 4 MB。',
      'settings.upload.tooLarge': '压缩后仍超过 16 KB。',
      'settings.upload.noWebp': '当前浏览器不支持 WebP 压缩。',
      'settings.upload.failed': '读取图片失败。',
      'settings.upload.audioType': '只支持 MP3 / M4A / WAV / OGG / AAC / WebM 音频。',
      'settings.upload.audioSize': '音效文件超过 128 KB。',
      'settings.asset.upload': '上传',
      'settings.asset.clear': '清空',
      'settings.asset.count': '已存 {count} 份，使用时随机取一份。',
      'settings.asset.emptyImage': '还没有上传，使用内置图。',
      'settings.asset.emptySound': '还没有上传，使用内置音效。',
      'settings.asset.sound': '音效素材',
      'settings.sound.source': '来源',
      'settings.sound.source.builtin': '内置',
      'settings.sound.source.upload': '上传',
      'settings.popout.enabled': '弹出提示',
      'settings.popout.image': '弹出图',
      'settings.popout.imageEmpty': '内置图',
      'settings.popout.displayMs': '停留时长（秒）',
      'settings.popout.entrance': '入场',
      'settings.popout.ambient': '待机',
      'settings.popout.exit': '退出',
      'settings.popout.side': '出现侧',
      'settings.popout.ambient.none': '静止',
      'settings.popout.ambient.breath': '呼吸',
      'settings.popout.ambient.float': '漂浮',
      'settings.popout.exit.drop': '落下',
      'settings.popout.exit.particles': '粒子',
      'settings.popout.exit.fade': '淡出',
      'settings.popout.exit.slide-out': '滑出',
      'settings.popout.side.auto': '随机',
      'settings.popout.side.left': '左侧',
      'settings.popout.side.right': '右侧',
      'settings.sound.kind': '音效',
      'settings.sound.none': '无',
      'settings.sound.alert': '提示音',
      'settings.sound.chime1': '铃声一',
      'settings.sound.chime2': '铃声二',
      'settings.sound.volume': '全局音量（0–100）',
      'settings.sound.volumeHint': '按这个音量播放提示音。',
      'settings.sound.enabled': '播放音效',
      'settings.sound.preview': '试听',
      'settings.sound.previewHint': '点一下立刻播一条；浏览器可能拦截自动播放。',
      'settings.order': '顺序',
      'settings.orderHint': '1–99，数字越小越靠前。',
      'settings.takeOverStatusDotOff': '已停用：dsh-sessions-manager 的状态点将恢复显示。',
      'shortcuts.cyclePrev': '热表：上一个会话',
      'shortcuts.cycleNext': '热表：下一个会话',
      'shortcuts.overlayOnce': '热表：弹出速查浮层',
      'settings.glyphSource': '图标来源',
      'settings.glyphSource.emoji': '内置图标',
      'settings.glyphSource.upload': '上传图片',
      'settings.glyphSource.popout': '弹出图',
      'settings.glyphValue': '图标值',
      'settings.popout.entranceFixed': '固定为探出',
    };
    const EN = {
      'tab.untitled': 'Untitled session',
      'tab.placeholder': 'Switching to this session…',
      'tab.error': 'Cannot switch session: the uiWorkspace service is unavailable.',
      'tab.failed': 'Last run failed: ',
      'settings.nav': 'Hot List',
      'settings.close': 'Close',
      'settings.title': 'Hot List',
      'settings.subtitle': 'Seats, state glyphs and where the list appears.',
      'settings.group.motion': 'Motion',
      'settings.maxSeats': 'Maximum seats',
      'settings.maxSeatsHint': 'How many sessions the tab row may show (1–12).',
      'settings.scope': 'Scope',
      'settings.scopeHint': 'Which workspaces feed the list (top bar, tab row and sidebar alike).',
      'settings.scope.workspace': 'Current workspace only',
      'settings.scope.all': 'All workspaces',
      'settings.scope.smart': 'All workspaces, but no cross-workspace pins',
      'settings.pinnedMaxSeats': 'Pinned shown',
      'settings.pinnedMaxSeatsHint': 'How many pinned sessions the conversation tab row may show (0-12); 0 = none.',
      'settings.ttl': 'Keep finished seats for (minutes)',
      'settings.ttlHint': 'How long a finished session stays in the list.',
      'settings.recentWindow': 'Recent conversation window (minutes)',
      'settings.recentWindowHint': '1–120 minutes. Sessions active within this window enter the third tier (idle) and show in the conversation tab row.',
      'settings.motion': 'Motion',
      'settings.motion.none': 'Still',
      'settings.motion.spin': 'Spin',
      'settings.motion.pulse': 'Pulse',
      'settings.motion.bounce': 'Bounce',
      'settings.motion.blink': 'Blink',
      'settings.motionTarget': 'Applies to',
      'settings.motionTarget.glyph': 'Glyph only',
      'settings.motionTarget.row': 'Glyph + title',
      'settings.frequency': 'Playback frequency',
      'settings.frequencyHint': '0% never plays; 100% fires every beat. Further left is rarer.',
      'settings.glyphFollowHint': 'Follows',
      'settings.position.tab': 'Conversation tab row',
      'settings.position.tabHint': 'Shown above the conversation area; available in both the desktop app and a web page.',
      'settings.position.topbar': 'Window top bar',
      'settings.position.topbarHint': 'Shown in the title bar at the very top of the window; desktop only, a web page can turn on the preview below.',
      'settings.position.webOnly': 'Shown in the title bar at the very top of the window; this is a web page, turn on the preview below.',
      'settings.topbar.previewInWeb': 'Preview in a web page',
      'settings.topbar.previewInWebHint': 'A web page has no title strip; this draws the band at the top of the page.',
      'settings.topbar.chipWidth': 'Pill width',
      'settings.topbar.chipWidthHint': 'Percent added to the default pill width, in steps of 5%.',
      'settings.topbar.chipWidthDefault': 'Default',
      'settings.topbar.titleMode': 'Label display',
      'settings.topbar.titleMode.text': 'Text only',
      'settings.topbar.titleMode.icon': 'Plugin icon',
      'settings.topbar.titleMode.custom': 'Custom icon',
      'settings.topbar.titleModeHint': 'What a session label starts with: text only, this category’s own icon, or the emoji the name starts with.',
      'settings.topbar.customScope': 'Custom icon scope',
      'settings.topbar.customScopeHint': 'Ticked categories use the emoji the name starts with instead of their icon; unticked ones keep the icon.',
      'settings.topbar.maxSeats': 'Top bar max sessions',
      'settings.topbar.maxSeatsHint': 'How many sessions the top bar may show (1-12), independent of the conversation tab row.',
      'settings.surface.tab': 'Tab row',
      'settings.surface.tabHint': 'When on, this category appears in the conversation Tab row.',
      'settings.surface.sidebar': 'Sidebar',
      'settings.surface.sidebarHint': 'When on, this category shows its state glyph in the session list.',
      'settings.surface.topbar': 'Top bar',
      'settings.surface.topbarHint': 'When on, this category appears as pills in the window top bar.',
      'topbar.count': '{count} more',
      'topbar.countHint': 'Click to switch to the next hidden session',
      'topbar.moreHint': '{count} more, click to step through them',
      'surface.topbar': 'Window top bar',
      'view.table': 'Hot list',
      'view.lead': '{count} in the hot list, {missing} left out.',
      'view.col.index': '#',
      'view.col.category': 'Category',
      'view.col.order': 'Order',
      'view.col.title': 'Title',
      'view.col.where': 'Shown on',
      'view.col.note': 'Note',
      'view.surface.tab': 'Tab row',
      'view.surface.sidebar': 'Sidebar',
      'view.surface.topbar': 'Top bar',
      'view.surface.none': 'none',
      'view.note.current': 'Current session',
      'view.note.pin': 'Pinned #{level}',
      'view.note.error': 'Failed: {message}',
      'view.missing': 'Left out ({count})',
      'view.missingNone': 'Every session is in the list.',
      'view.reason.empty': 'No messages yet',
      'view.reason.subagent': 'Child agent run, never a seat',
      'view.reason.scope': 'Another workspace, cut by scope',
      'view.reason.no-category': 'Not running, not pinned, outside the recent window',
      'view.reason.surface-off': 'Its category is off on the tab row, the sidebar and the top bar',
      'view.reason.position-off': 'Its category only shows on a surface that is switched off',
      'view.reason.over-cap': 'Cut by the seat cap ({limit} in the tab row)',
      'view.group.over-cap': 'Over the cap',
      'view.group.scope': 'Other workspace',
      'view.group.surface-off': 'Off everywhere',
      'view.group.position-off': 'Surface is off',
      'view.group.no-category': 'No state',
      'view.group.empty': 'No messages',
      'view.group.subagent': 'Child agent',
      'view.missingHint': 'Collapsed by default — click a group to open it. The number inside a group is its order.',
      'view.missingMore': 'Show the other {count}',
      'settings.position.allOff': 'The hot list is hidden right now — turn a position back on here.',
      'settings.takeOverStatusDot': 'Take over the row marker',
      'settings.takeOverStatusDotHint': 'Hides state dots drawn by other plugins at the start of a session row (sidebar only).',
      'settings.storageFailed': 'Could not save; this change lasts for the current page only.',
      'settings.group.global': 'Global',
      'settings.group.icon': 'Icon',
      'settings.group.popout': 'Popout',
      'settings.group.sound': 'Sound',
      'settings.group.order': 'Order',
      'settings.category.pinned': 'Pinned',
      'settings.category.error': 'Failed',
      'settings.category.pending': 'Waiting',
      'settings.category.completed': 'Completed',
      'settings.category.running': 'Running',
      'settings.category.idle': 'Idle',
      'settings.chip.tab': 'Conversation tabs',
      'settings.chip.sidebar': 'Sidebar',
      'settings.chip.topbar': 'Top bar',
      'settings.chip.popout': 'Popout alert',
      'settings.chip.sound': 'Sound',
      'settings.chipShort.tab': 'Tab',
      'settings.chipShort.sidebar': 'Sidebar',
      'settings.chipShort.topbar': 'Top bar',
      'settings.chipShort.popout': 'Popout',
      'settings.chipShort.sound': 'Sound',
      'settings.chip.positionHint': 'Positions are set in the global block above.',
      'settings.card.orderTag': '· order {order}',
      'settings.card.disabled': 'off',
      'settings.glyphSecondary': 'Question style',
      'settings.glyphPlaceholder': 'Type a character',
      'settings.glyphTextLimit': 'Up to 2 code points; clearing it hides the icon.',
      'settings.resetCategory': 'Reset this category',
      'settings.resetCategoryHint': 'Restores this one category to its factory shape and drops its markers.',
      'settings.resetCategoryGo': 'Reset',
      'settings.upload.missing': 'No file selected.',
      'settings.upload.type': 'PNG / JPEG / WebP / GIF only (SVG is rejected).',
      'settings.upload.size': 'The source file is larger than 4 MB.',
      'settings.upload.tooLarge': 'Still larger than 16 KB after compression.',
      'settings.upload.noWebp': 'This browser cannot compress to WebP.',
      'settings.upload.failed': 'Could not read that image.',
      'settings.upload.audioType': 'MP3 / M4A / WAV / OGG / AAC / WebM audio only.',
      'settings.upload.audioSize': 'The sound file is larger than 128 KB.',
      'settings.asset.upload': 'Upload',
      'settings.asset.clear': 'Clear',
      'settings.asset.count': '{count} stored, one picked at random.',
      'settings.asset.emptyImage': 'Nothing uploaded yet; the built-in is used.',
      'settings.asset.emptySound': 'Nothing uploaded yet; the built-in sound is used.',
      'settings.asset.sound': 'Sound files',
      'settings.sound.source': 'Source',
      'settings.sound.source.builtin': 'Built-in',
      'settings.sound.source.upload': 'Upload',
      'settings.popout.enabled': 'Popout alert',
      'settings.popout.image': 'Popout image',
      'settings.popout.imageEmpty': 'Built-in',
      'settings.popout.displayMs': 'Visible for (seconds)',
      'settings.popout.entrance': 'Entrance',
      'settings.popout.ambient': 'At rest',
      'settings.popout.exit': 'Exit',
      'settings.popout.side': 'Edge',
      'settings.popout.ambient.none': 'Still',
      'settings.popout.ambient.breath': 'Breathe',
      'settings.popout.ambient.float': 'Float',
      'settings.popout.exit.drop': 'Drop',
      'settings.popout.exit.particles': 'Particles',
      'settings.popout.exit.fade': 'Fade',
      'settings.popout.exit.slide-out': 'Slide out',
      'settings.popout.side.auto': 'Random',
      'settings.popout.side.left': 'Left',
      'settings.popout.side.right': 'Right',
      'settings.sound.kind': 'Sound',
      'settings.sound.none': 'None',
      'settings.sound.alert': 'Alert',
      'settings.sound.chime1': 'Chime 1',
      'settings.sound.chime2': 'Chime 2',
      'settings.sound.volume': 'Global volume (0-100)',
      'settings.sound.volumeHint': 'Category sounds play at this volume.',
      'settings.sound.enabled': 'Play sound',
      'settings.sound.preview': 'Preview',
      'settings.sound.previewHint': 'Clicking plays one now; the browser may still block autoplay.',
      'settings.order': 'Order',
      'settings.orderHint': '1–99, lower comes first.',
      'settings.takeOverStatusDotOff': 'Disabled: status dots from dsh-sessions-manager show again.',
      'shortcuts.cyclePrev': 'Hot List: previous session',
      'shortcuts.cycleNext': 'Hot List: next session',
      'shortcuts.overlayOnce': 'Hot List: peek at the hot list',
      'settings.glyphSource': 'Glyph source',
      'settings.glyphSource.emoji': 'Built-in',
      'settings.glyphSource.upload': 'Upload',
      'settings.glyphSource.popout': 'Popout image',
      'settings.glyphValue': 'Glyph value',
      'settings.popout.entranceFixed': 'Fixed: peek reveal',
    };

const FULL_WIDTH = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/;

    const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

    /** Bytes behind a base64 data URL, without decoding it. */
    function decodedBytes(dataUrl) {
      const comma = dataUrl.indexOf(',');
      return comma < 0 ? Infinity : Math.floor((dataUrl.length - comma - 1) * 3 / 4);
    }

    /** A static square image as a data URL within the per-image budget. */
    function isValidImage(value) {
      return typeof value === 'string' && GLYPH_IMAGE_RE.test(value) && decodedBytes(value) <= GLYPH_MAX_BYTES;
    }

    /** 2000ms ("always") .. 60000ms ("rare") -> the same intent on the 0..1 slider. */
    function frequencyOfInterval(ms) {
      const span = LEGACY_INTERVAL_MS.max - LEGACY_INTERVAL_MS.min;
      const raw = 1 - (clamp(Math.round(ms), LEGACY_INTERVAL_MS.min, LEGACY_INTERVAL_MS.max) - LEGACY_INTERVAL_MS.min) / span;
      return clamp(
        Math.round(raw / MOTION_FREQUENCY.step) * MOTION_FREQUENCY.step,
        MOTION_FREQUENCY.min,
        MOTION_FREQUENCY.max,
      );
    }

    /** Stored popout sizes are plain CSS px; the pair is always ordered min <= max. */
    function sanitizeOverlaySize(raw, fallback) {
      const min = typeof raw?.sizeMin === 'number' && Number.isFinite(raw.sizeMin)
        ? clamp(Math.round(raw.sizeMin), OVERLAY_SIZE.min, OVERLAY_SIZE.max)
        : fallback.sizeMin;
      const max = typeof raw?.sizeMax === 'number' && Number.isFinite(raw.sizeMax)
        ? clamp(Math.round(raw.sizeMax), OVERLAY_SIZE.min, OVERLAY_SIZE.max)
        : fallback.sizeMax;
      return min <= max ? { sizeMin: min, sizeMax: max } : { sizeMin: max, sizeMax: min };
    }

    /**
     * One glyph entry -> a legal one. Canonical shape is `{kind,value,source,motion,
     * motionTarget,frequency}`; the old `{emoji,image}` pair is still readable
     * (and is never written back). An unknown kind keeps the default glyph.
     */
    /** Decoded size of one uploaded asset, from the base64 payload. */
    function assetBytes(dataUrl) {
      return typeof dataUrl === 'string' ? decodedBytes(dataUrl) : 0;
    }

    /**
     * One asset pool -> a legal one: images or sounds only, each under its own
     * ceiling, no duplicates, newest kept up to `ASSET_POOL_MAX`. A pool is
     * never a partial record: an entry either survives whole or drops out.
     */
    function sanitizeAssets(raw, kind) {
      if (!Array.isArray(raw)) return [];
      const pattern = kind === 'sound' ? SOUND_AUDIO_RE : GLYPH_IMAGE_RE;
      const ceiling = kind === 'sound' ? SOUND_MAX_BYTES : kind === 'popout' ? POPOUT_MAX_BYTES : GLYPH_MAX_BYTES;
      const seen = new Set();
      const next = [];
      for (const entry of raw) {
        if (next.length >= ASSET_POOL_MAX) break;
        if (!isPlainObject(entry) || typeof entry.dataUrl !== 'string') continue;
        if (pattern.test(entry.dataUrl) === false || seen.has(entry.dataUrl)) continue;
        if (assetBytes(entry.dataUrl) > ceiling) continue;
        seen.add(entry.dataUrl);
        const label = typeof entry.name === 'string'
          ? entry.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80)
          : '';
        next.push({ name: label === '' ? `${kind}-${next.length + 1}` : label, dataUrl: entry.dataUrl });
      }
      return next;
    }

    /** Uploaded payloads a category holds, across all four pools. */
    function categoryAssetBytes(entry) {
      const sum = (list) => list.reduce((total, item) => total + assetBytes(item.dataUrl), 0);
      const secondary = entry.glyphSecondary === null ? [] : entry.glyphSecondary.uploads;
      return sum(entry.glyph.uploads) + sum(secondary) + sum(entry.popout.images) + sum(entry.sound.uploads);
    }

    /**
     * The total budget is a hard ceiling on localStorage, not a suggestion: the
     * oldest upload of the largest pool goes first until the bundle fits.
     */
    function trimAssetBudget(settings) {
      let total = 0;
      for (const category of CATEGORY_IDS) total += categoryAssetBytes(settings.categories[category]);
      for (const category of CATEGORY_IDS) {
        if (total <= ASSET_TOTAL_MAX_BYTES) break;
        const entry = settings.categories[category];
        const pools = [
          entry.sound.uploads,
          entry.popout.images,
          entry.glyphSecondary === null ? [] : entry.glyphSecondary.uploads,
          entry.glyph.uploads,
        ];
        for (const pool of pools) {
          while (total > ASSET_TOTAL_MAX_BYTES && pool.length > 0) total -= assetBytes(pool.pop().dataUrl);
        }
      }
      return settings;
    }

    /** A path's known factory defaults, or `[]` when that path never had one. */
    function legacyValuesOf(sub, key) {
      return LEGACY_VALUES[`${sub}.${key}`] ?? [];
    }

    /** A stored scalar equal to an earlier factory default is not a choice: keep the current default. */
    function isLegacyValue(values, value) {
      return values.some((candidate) => candidate === value);
    }

    /** Marker map -> a legal one: only `true`, only known shapes, bounded so it cannot grow forever. */
    function sanitizeChoices(raw) {
      const next = {};
      if (isPlainObject(raw) === false) return next;
      for (const [key, value] of Object.entries(raw)) {
        if (Object.keys(next).length >= CHOICE_LIMIT) break;
        if (value !== true) continue;
        if (key.length > 80 || CHOICE_KEY.test(key) === false) continue;
        next[key] = true;
      }
      return next;
    }

    /**
     * The fields this patch actually writes, on top of the markers already stored. It must see the
     * incoming patch and not the merged settings: the preset rule rewrites values while sanitising,
     * and a value it rewrote is the factory default, never the user's pick.
     */
    function choicesFromPatch(patch, base) {
      const next = { ...(isPlainObject(base.choices) ? base.choices : {}) };
      if (isPlainObject(patch) === false) return next;
      if (isPlainObject(patch.positions) && typeof patch.positions.topbar === 'boolean') next['positions.topbar'] = true;
      if (isPlainObject(patch.collect) && typeof patch.collect.recentWindowMinutes === 'number') {
        next['collect.recentWindowMinutes'] = true;
      }
      const categories = isPlainObject(patch.categories) ? patch.categories : {};
      for (const [category, change] of Object.entries(categories)) {
        if (CATEGORY_IDS.includes(category) === false || isPlainObject(change) === false) continue;
        for (const slot of CHOICE_SLOTS) {
          const glyph = change[slot];
          if (isPlainObject(glyph) === false) continue;
          for (const field of CHOICE_FIELDS) {
            if (Object.prototype.hasOwnProperty.call(glyph, field)) next[`categories.${category}.${slot}.${field}`] = true;
          }
        }
        if (isPlainObject(change.sound) && Object.prototype.hasOwnProperty.call(change.sound, 'enabled')) {
          next[`categories.${category}.sound.enabled`] = true;
        }
      }
      return next;
    }

    function sanitizeGlyph(raw, fallback, legacy, sub = 'glyph', chosen = null) {
      /** `chosen(field)` answers "did the user pick this one himself?" for the slot being read. */
      const isChoice = typeof chosen === 'function' ? chosen : () => false;
      const next = { ...fallback };
      const own = isPlainObject(raw) ? raw : {};
      const old = isPlainObject(legacy) ? legacy : {};
      const oldEmoji = typeof own.emoji === 'string' ? own.emoji : typeof old.emoji === 'string' ? old.emoji : null;
      const legacyImage = isValidImage(own.value) ? own.value : isValidImage(own.image) ? own.image : isValidImage(old.image) ? old.image : null;
      next.uploads = sanitizeAssets(own.uploads, 'glyph');
      /** v4.1 kept one uploaded image in `value`; that single image now seeds the pool. */
      if (legacyImage !== null && next.uploads.length === 0) next.uploads = [{ name: 'legacy', dataUrl: legacyImage }];
      if (GLYPH_SOURCES.includes(own.source)) next.source = own.source;
      if (next.uploads.length > 0 && (own.source === undefined || own.source === 'upload')) next.source = 'upload';
      if (next.uploads.length === 0 && next.source === 'upload') next.source = 'emoji';
      next.kind = next.uploads.length > 0 ? 'img' : 'emoji';
      /**
       * `value` is the emoji only; a data URL there is a v4.1 upload and belongs in the pool.
       * A stored emoji equal to an earlier factory default is not a choice either — that is
       * the case this whole pass exists for: idle used to ship 💤 and must now show 🧊.
       */
      const valueChosen = isChoice('value');
      const legacyValues = legacyValuesOf(sub, 'value');
      const oldIsChoice = oldEmoji !== null && (valueChosen || isLegacyValue(legacyValues, oldEmoji) === false);
      const ownIsChoice = typeof own.value === 'string' && isValidImage(own.value) === false && (valueChosen || isLegacyValue(legacyValues, own.value) === false);
      const emojiSource = ownIsChoice
        ? own.value
        : oldIsChoice ? oldEmoji : fallback.kind === 'emoji' ? fallback.value : '';
      const emoji = emojiSource.replace(/[\u0000-\u001f\u007f]/g, '').trim();
      next.value = [...emoji].length <= GLYPH_TEXT_LIMIT ? emoji : '';
      /** A marked `kind:'none'` hides the icon; an unmarked empty value still means "use the default". */
      if (own.kind === 'none' && valueChosen === true && next.uploads.length === 0) {
        next.kind = 'none';
        next.value = '';
      }
      const motionChosen = isChoice('motion');
      const motionValues = legacyValuesOf(sub, 'motion');
      const ownMotionIsChoice = MOTION_NAMES.includes(own.motion) && (motionChosen || isLegacyValue(motionValues, own.motion) === false);
      if (ownMotionIsChoice) next.motion = own.motion;
      else if (MOTION_NAMES.includes(old.motion) && (motionChosen || isLegacyValue(motionValues, old.motion) === false)) next.motion = old.motion;
      const targetChosen = isChoice('motionTarget');
      if (MOTION_TARGETS.includes(own.motionTarget) && (targetChosen || isLegacyValue(legacyValuesOf(sub, 'motionTarget'), own.motionTarget) === false)) next.motionTarget = own.motionTarget;
      if (typeof own.frequency === 'number' && Number.isFinite(own.frequency)) {
        /** Two decimals: the step is 0.05, so this loses nothing and keeps 0.3 and 0.9 exact. */
        const rounded = clamp(
          Number((Math.round(own.frequency / MOTION_FREQUENCY.step) * MOTION_FREQUENCY.step).toFixed(2)),
          MOTION_FREQUENCY.min,
          MOTION_FREQUENCY.max,
        );
        if (isChoice('frequency') || isLegacyValue(legacyValuesOf(sub, 'frequency'), rounded) === false) next.frequency = rounded;
      } else {
        /** v4.3 stored an interval and 0 meant "never": that is frequency 0, not the default 1. */
        const { motionIntervalMs: legacyInterval } = own;
        if (typeof legacyInterval === 'number' && Number.isFinite(legacyInterval)) {
          next.frequency = legacyInterval === 0 ? 0 : frequencyOfInterval(legacyInterval);
        }
      }
      return next;
    }

    /** One category -> a legal one. Every field falls back on its own. */
    function sanitizeCategory(raw, category, fallback, choices = {}) {
      const picked = isPlainObject(choices) ? choices : {};
      const isChoiceIn = (slot) => (field) => picked[`categories.${category}.${slot}.${field}`] === true;
      const next = { ...fallback };
      next.surfaces = { ...fallback.surfaces };
      next.glyph = { ...fallback.glyph };
      next.glyphSecondary = fallback.glyphSecondary === null ? null : { ...fallback.glyphSecondary };
      next.popout = { ...fallback.popout };
      next.sound = { ...fallback.sound };
      if (!isPlainObject(raw)) return next;

      if (typeof raw.enabled === 'boolean') next.enabled = raw.enabled;
      if (typeof raw.order === 'number' && Number.isFinite(raw.order)) {
        const rounded = Math.round(raw.order);
        /** An old default is not a choice: adopt the current default instead of freezing the old one. */
        const legacyOrder = LEGACY_DEFAULTS[`categories.${category}.order`] ?? [];
        next.order = legacyOrder.includes(rounded) ? CATEGORY_ORDER[category] : clamp(rounded, 1, 99);
      }
      if (SORT_BY.includes(raw.sortBy)) next.sortBy = raw.sortBy;
      if (isPlainObject(raw.surfaces)) {
        for (const key of ['tab', 'sidebar', 'topbar']) {
          if (typeof raw.surfaces[key] === 'boolean') next.surfaces[key] = raw.surfaces[key];
        }
      }
      next.glyph = sanitizeGlyph(raw.glyph, next.glyph, raw, 'glyph', isChoiceIn('glyph'));
      if (next.glyphSecondary !== null) next.glyphSecondary = sanitizeGlyph(raw.glyphSecondary, next.glyphSecondary, null, 'glyphSecondary', isChoiceIn('glyphSecondary'));

      if (isPlainObject(raw.popout)) {
        const popout = raw.popout;
        if (typeof popout.enabled === 'boolean') next.popout.enabled = popout.enabled;
        next.popout.images = sanitizeAssets(popout.images, 'popout');
        /** v4.1 held one image string: a data URL becomes the first pool entry, `builtin:` sets the switch. */
        if (next.popout.images.length === 0 && isValidImage(popout.image)) {
          next.popout.images = [{ name: 'legacy', dataUrl: popout.image }];
        }
        if (typeof popout.builtin === 'boolean') next.popout.builtin = popout.builtin;
        else if (typeof popout.image === 'string' && popout.image.startsWith('builtin:')) next.popout.builtin = true;
        else if (isValidImage(popout.image)) next.popout.builtin = false;
        if (typeof popout.displayMs === 'number' && Number.isFinite(popout.displayMs)) {
          next.popout.displayMs = clamp(Math.round(popout.displayMs / POPOUT_DISPLAY_MS.step) * POPOUT_DISPLAY_MS.step, POPOUT_DISPLAY_MS.min, POPOUT_DISPLAY_MS.max);
        }
        if (POPOUT_ENTRANCES.includes(popout.entrance)) next.popout.entrance = popout.entrance;
        if (POPOUT_AMBIENTS.includes(popout.ambient)) next.popout.ambient = popout.ambient;
        if (POPOUT_EXITS.includes(popout.exit)) next.popout.exit = popout.exit;
        if (OVERLAY_SIDES.includes(popout.side)) next.popout.side = popout.side;
      }
      if (isPlainObject(raw.sound)) {
        const sound = raw.sound;
        next.sound.uploads = sanitizeAssets(sound.uploads, 'sound');
        /** v4.1 stored a placeholder `kind`: any real kind meant "on", `none` meant "off". */
        if (typeof sound.enabled === 'boolean') {
          /**
           * Off was the factory default of every class, so a stored `false` follows the current
           * default — unless the user is the one who switched it off, which the marker proves.
           */
          const enabledChosen = picked[`categories.${category}.sound.enabled`] === true;
          next.sound.enabled = enabledChosen || isLegacyValue(legacyValuesOf('sound', 'enabled'), sound.enabled) === false ? sound.enabled : next.sound.enabled;
        } else if (typeof sound.kind === 'string') next.sound.enabled = sound.kind !== 'none';
        if (typeof sound.builtin === 'boolean') next.sound.builtin = sound.builtin;
        else if (sound.kind === 'upload') next.sound.builtin = false;
      }
      return next;
    }

    /**
     * Settings -> legal settings. Pure: it starts from the defaults, so a bad
     * value falls back to its default instead of keeping a stale one; unknown
     * keys are dropped and nothing throws. `positions` may be all false: that
     * means "hide the hot list", never "fall back to the tab row".
     */
    // House rule: a stored value always wins; defaults only fill gaps. We never delete data we do not
    // understand — unknown keys move to PRESERVED_KEY, out-of-range values keep their raw copy, and
    // every write leaves a rolling backup.
    function sanitizeSettings(raw) {
      const next = defaultSettings();
      if (!isPlainObject(raw)) return next;
      next.choices = sanitizeChoices(raw.choices);

      if (raw.maxSeats === 'auto') next.maxSeats = 'auto';
      else if (typeof raw.maxSeats === 'number' && Number.isFinite(raw.maxSeats)) {
        next.maxSeats = clamp(Math.round(raw.maxSeats), MAX_SEATS.min, MAX_SEATS.max);
      }
      if (SCOPE_MODES.includes(raw.scope)) next.scope = raw.scope;
      if (isPlainObject(raw.positions)) {
        for (const key of ['tab', 'topbar', 'sidebar']) {
          if (typeof raw.positions[key] !== 'boolean') continue;
          /** Same boundary as the presets: an unmarked value equal to an old default follows the default. */
          const stale = isLegacyValue(legacyValuesOf('positions', key), raw.positions[key]);
          const chosen = next.choices[`positions.${key}`] === true;
          next.positions[key] = stale === true && chosen === false ? next.positions[key] : raw.positions[key];
        }
      }
      if (isPlainObject(raw.topbar)) {
        if (TOPBAR_MODES.includes(raw.topbar.mode)) next.topbar.mode = raw.topbar.mode;
        /** Old names are still on disk: a known alias reads as its new name, an unknown one keeps the default. */
        const titleMode = TITLE_MODE_ALIASES[raw.topbar.titleMode] ?? raw.topbar.titleMode;
        if (TOPBAR_TITLE_MODES.includes(titleMode)) next.topbar.titleMode = titleMode;
        if (isPlainObject(raw.topbar.customScope)) {
          for (const category of CATEGORY_IDS) {
            if (typeof raw.topbar.customScope[category] === 'boolean') {
              next.topbar.customScope[category] = raw.topbar.customScope[category];
            }
          }
        }
        if (raw.topbar.maxSeats === 'auto') next.topbar.maxSeats = 'auto';
        else if (typeof raw.topbar.maxSeats === 'number' && Number.isFinite(raw.topbar.maxSeats)) {
          next.topbar.maxSeats = clamp(Math.round(raw.topbar.maxSeats), MAX_SEATS.min, MAX_SEATS.max);
        }
        if (typeof raw.topbar.previewInWeb === 'boolean') next.topbar.previewInWeb = raw.topbar.previewInWeb;
        if (typeof raw.topbar.rightReservePx === 'number' && Number.isFinite(raw.topbar.rightReservePx)) {
          next.topbar.rightReservePx = clamp(Math.round(raw.topbar.rightReservePx), TOPBAR_RESERVE.min, TOPBAR_RESERVE.max);
        }
        if (typeof raw.topbar.chipWidthPct === 'number' && Number.isFinite(raw.topbar.chipWidthPct)) {
          const snapped = Math.round(raw.topbar.chipWidthPct / CHIP_PCT.step) * CHIP_PCT.step;
          next.topbar.chipWidthPct = clamp(snapped, CHIP_PCT.min, CHIP_PCT.max);
        }
      }
      for (const key of ['takeOverStatusDot', 'hideNativeDot']) {
        if (typeof raw[key] === 'boolean') next[key] = raw[key];
      }

      const display = isPlainObject(raw.display) ? raw.display : {};
      if (REDUCE_MOTION_VALUES.includes(display.reduceMotion)) next.display.reduceMotion = display.reduceMotion;
      /** v4.0 kept one global interval; the same value now becomes every class's frequency. */
      const legacyInterval = typeof display.motionIntervalMs === 'number' && Number.isFinite(display.motionIntervalMs)
        ? (display.motionIntervalMs === 0 ? 0 : frequencyOfInterval(display.motionIntervalMs))
        : null;

      if (isPlainObject(raw.shortcuts)) {
        for (const key of ['jumpEnabled', 'overlayEnabled']) {
          if (typeof raw.shortcuts[key] === 'boolean') next.shortcuts[key] = raw.shortcuts[key];
        }
        if (typeof raw.shortcuts.overlayKey === 'string' && /^\S+$/.test(raw.shortcuts.overlayKey.trim())) {
          next.shortcuts.overlayKey = raw.shortcuts.overlayKey.trim();
        }
      }
      if (isPlainObject(raw.overlay)) {
        if (OVERLAY_SIDES.includes(raw.overlay.side)) next.overlay.side = raw.overlay.side;
        Object.assign(next.overlay, sanitizeOverlaySize(raw.overlay, next.overlay));
        if (typeof raw.overlay.fallbackImage === 'string' && (raw.overlay.fallbackImage === '' || isValidImage(raw.overlay.fallbackImage))) {
          next.overlay.fallbackImage = raw.overlay.fallbackImage;
        }
      }
      if (isPlainObject(raw.sound) && typeof raw.sound.volume === 'number' && Number.isFinite(raw.sound.volume)) {
        next.sound.volume = clamp(Math.round(raw.sound.volume), 0, 100);
      } else {
        /** v4.1 made the volume global; take the first per-class value that is not the old default. */
        for (const category of CATEGORY_IDS) {
          const legacy = isPlainObject(raw.categories) && isPlainObject(raw.categories[category]) ? raw.categories[category].sound : null;
          if (isPlainObject(legacy) && typeof legacy.volume === 'number' && Number.isFinite(legacy.volume) && Math.round(legacy.volume) !== 60) {
            next.sound.volume = clamp(Math.round(legacy.volume), 0, 100);
            break;
          }
        }
      }
      if (isPlainObject(raw.collect) && typeof raw.collect.completedTtlMs === 'number' && Number.isFinite(raw.collect.completedTtlMs)) {
        const minutes = clamp(Math.round(raw.collect.completedTtlMs / 60000), TTL_MINUTES.min, TTL_MINUTES.max);
        next.collect.completedTtlMs = minutes * 60000;
      }
      /** v4.3 kept the idle window on the class; a stray 5 is that class's old default. */
      const legacyIdle = isPlainObject(raw.categories) && isPlainObject(raw.categories.idle) ? raw.categories.idle : null;
      const legacyWithin = legacyIdle !== null && typeof legacyIdle.within === 'number' && Number.isFinite(legacyIdle.within)
        ? clamp(Math.round(legacyIdle.within), RECENT_WINDOW_MINUTES.min, RECENT_WINDOW_MINUTES.max)
        : null;
      if (isPlainObject(raw.collect) && typeof raw.collect.recentWindowMinutes === 'number' && Number.isFinite(raw.collect.recentWindowMinutes)) {
        const minutes = clamp(Math.round(raw.collect.recentWindowMinutes), RECENT_WINDOW_MINUTES.min, RECENT_WINDOW_MINUTES.max);
        /** Same boundary as the presets: an unmarked value equal to the old default follows the default. */
        const stale = isLegacyValue(legacyValuesOf('collect', 'recentWindowMinutes'), minutes);
        const chosen = next.choices['collect.recentWindowMinutes'] === true;
        next.collect.recentWindowMinutes = stale === true && chosen === false ? next.collect.recentWindowMinutes : minutes;
      } else if (legacyWithin !== null) {
        /** The class field had the same 5-minute factory default, so an unmarked 5 follows the default too. */
        const stale = isLegacyValue(legacyValuesOf('collect', 'recentWindowMinutes'), legacyWithin);
        const chosen = next.choices['collect.recentWindowMinutes'] === true;
        if (stale === false || chosen === true) next.collect.recentWindowMinutes = legacyWithin;
      }
      /** v4.6 dropped the hand-written pin list: pins live in the workspace store, this only caps the row. */
      if (isPlainObject(raw.pinned) && typeof raw.pinned.maxSeats === 'number' && Number.isFinite(raw.pinned.maxSeats)) {
        next.pinned.maxSeats = clamp(Math.round(raw.pinned.maxSeats), PINNED_SEATS.min, PINNED_SEATS.max);
      }

      const rawCategories = isPlainObject(raw.categories) ? raw.categories : {};
      for (const category of CATEGORY_IDS) {
        const entry = sanitizeCategory(rawCategories[category], category, next.categories[category], next.choices);
        if (legacyInterval !== null) {
          entry.glyph.frequency = legacyInterval;
          if (entry.glyphSecondary !== null) entry.glyphSecondary.frequency = legacyInterval;
        }
        next.categories[category] = entry;
      }
      return trimAssetBudget(next);
    }

    /** The v3 shape: eight flat states, `showIdle`, `completedTtlMs`, `overlay` with its own enabled flag. */
    function migrateFromV3(raw) {
      const next = { ...defaultSettings(), version: 4 };
      const states = isPlainObject(raw.states) ? raw.states : {};
      const glyphs = isPlainObject(raw.glyphs) ? raw.glyphs : {};
      const motion = isPlainObject(raw.motion) ? raw.motion : {};
      const legacyOf = (state) => {
        const own = isPlainObject(states[state]) ? states[state] : {};
        const flat = typeof motion[state] === 'string' ? motion[state] : null;
        const base = isPlainObject(glyphs[state]) ? { ...glyphs[state], ...own } : { ...own };
        return flat === null ? base : { ...base, motion: flat };
      };
      const glyphOfState = (state, category, secondary) => {
        const base = secondary === true ? next.categories[category].glyphSecondary : next.categories[category].glyph;
        return sanitizeGlyph(legacyOf(state), base, null, secondary === true ? 'glyphSecondary' : 'glyph');
      };

      /** approval -> pending primary; question -> pending secondary; plan-review and subagents are dropped. */
      next.categories.pending.glyph = glyphOfState('approval', 'pending', false);
      next.categories.pending.glyphSecondary = glyphOfState('question', 'pending', true);
      for (const state of ['error', 'completed', 'running', 'idle']) {
        next.categories[state].glyph = glyphOfState(state, state, false);
      }
      if (typeof raw.showIdle === 'boolean') next.categories.idle.enabled = raw.showIdle;
      if (typeof raw.completedTtlMs === 'number' && Number.isFinite(raw.completedTtlMs)) next.collect.completedTtlMs = raw.completedTtlMs;
      for (const key of ['takeOverStatusDot', 'hideNativeDot', 'maxSeats']) {
        if (raw[key] !== undefined) next[key] = raw[key];
      }
      if (isPlainObject(raw.positions)) next.positions = { ...next.positions, ...raw.positions };
      if (isPlainObject(raw.display)) next.display = { ...next.display, ...raw.display };

      const overlay = isPlainObject(raw.overlay) ? raw.overlay : {};
      if (typeof overlay.enabled === 'boolean') {
        for (const category of CATEGORY_IDS) next.categories[category].popout.enabled = overlay.enabled;
      }
      if (OVERLAY_SIDES.includes(overlay.side)) next.overlay.side = overlay.side;
      const legacyZoom = overlay['scale'];
      if (typeof legacyZoom === 'number' && Number.isFinite(legacyZoom)) {
        const legacyMax = clamp(Math.round(legacyZoom * 260), OVERLAY_SIZE.min, OVERLAY_SIZE.max);
        next.overlay.sizeMax = Math.max(legacyMax, OVERLAY_SIZE.fallbackMin);
      }
      if (typeof overlay.customImage === 'string') next.overlay.fallbackImage = overlay.customImage;
      if (typeof overlay.shortcut === 'string' && /^\S+$/.test(overlay.shortcut.trim())) next.shortcuts.overlayKey = overlay.shortcut.trim();
      /** `overlay.source` (state/current/custom) has no v4 counterpart. */
      return next;
    }

    /** Any stored object -> current settings, remembering whether it had to be rewritten. */
    function migrateSettings(stored) {
      if (!isPlainObject(stored)) return { settings: defaultSettings(), migrated: false };
      if (stored.version === SETTINGS_VERSION) return { settings: sanitizeSettings(stored), migrated: false };
      const migrated = migrateFromV3(stored);
      /** The alpha build stamped `version: 5` on an otherwise-v4 record: keep the tables it wrote. */
      if (isPlainObject(stored.categories)) migrated.categories = { ...migrated.categories, ...stored.categories };
      if (isPlainObject(stored.collect)) migrated.collect = { ...migrated.collect, ...stored.collect };
      if (isPlainObject(stored.pinned)) migrated.pinned = { ...migrated.pinned, ...stored.pinned };
      return { settings: sanitizeSettings(migrated), migrated: true };
    }

    /** A tab/sidebar token (approval | question | pinned | error | running | completed | idle). */
    function tokenGlyph(settings, token) {
      const category = CATEGORY_OF_TOKEN[token];
      if (category === void 0) return defaultGlyph('running');
      if (token === 'question') return settings.categories.pending.glyphSecondary ?? settings.categories.pending.glyph;
      return settings.categories[category].glyph;
    }

    /**
     * The built-in popout artwork of a category, as a packaged asset path the
     * module loader resolves exactly like `require.asset` would.
     */
    function popoutAssetRef(category) {
      return 'plugins/dsh-better-notice/assets/' + category + '.svg';
    }

    /** FNV-1a: a small deterministic hash, used to keep one pick while a state holds. */
    function fnv1a(text) {
      let hash = 0x811c9dc5;
      for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
      }
      return hash >>> 0;
    }

    /** A pool index from a seed: same seed, same picture, so a repaint never flickers. */
    function pickIndex(seed, length) {
      if (length <= 1) return 0;
      return fnv1a(String(seed)) % length;
    }

    /** A pool index per event (one popout, one sound): those are single shots, so they may vary. */
    function randomIndex(length) {
      return length <= 1 ? 0 : Math.floor(Math.random() * length);
    }

    /** What one popout shows: a random upload, else the packaged artwork, else the category emoji. */
    function pickPopoutArt(settings, category) {
      const popout = settings.categories[category].popout;
      if (popout.images.length > 0) return { kind: 'data', value: popout.images[randomIndex(popout.images.length)].dataUrl };
      if (popout.builtin === true) return { kind: 'builtin', value: popoutAssetRef(category) };
      return { kind: 'emoji', value: '' };
    }

    /**
     * What one sound plays: a random upload when the pool has one, else the
     * packaged clip mapped to that category. Only the three classes the host
     * ships files for may build a URL, so a click on the `running` card can
     * never ask for a 404.
     */
    function pickSoundUrl(settings, category) {
      const sound = settings.categories[category].sound;
      if (sound.uploads.length > 0) return sound.uploads[randomIndex(sound.uploads.length)].dataUrl;
      if (sound.builtin === true && BUILTIN_SOUND[category] !== void 0) {
        return `${SOUND_URL}${BUILTIN_SOUND[category]}`;
      }
      return '';
    }

    /**
     * What to draw for a token. `glyph.source` decides: one of the uploaded
     * images, that category's popout artwork (a random upload, else the
     * packaged SVG), or the emoji. A source with nothing to draw falls back to
     * the emoji, so a half-configured card never blanks a row. `seed` keeps the
     * uploaded pick stable for as long as a session holds that state.
     */
    function resolveStateGlyph(settings, token, seed) {
      const category = CATEGORY_OF_TOKEN[token] ?? 'running';
      const glyph = tokenGlyph(settings, token);
      if (glyph.source === 'upload' && glyph.uploads.length > 0) {
        return { kind: 'img', value: glyph.uploads[pickIndex(seed, glyph.uploads.length)].dataUrl };
      }
      if (glyph.source === 'popout') {
        const art = pickPopoutArt(settings, category);
        if (art.kind !== 'emoji') return { kind: 'img', value: art.value };
      }
      if (glyph.kind === 'none') return { kind: 'none', value: '' };
      return { kind: 'emoji', value: glyph.value !== '' ? glyph.value : CATEGORY_GLYPHS[category] };
    }

    /** A surface we render ourselves: the data URL when uploaded, otherwise the emoji. */
    function glyphOf(settings, token) {
      return resolveStateGlyph(settings, token).value;
    }

    /** A tab label is a string: an uploaded image falls back to that token's emoji. */
    function emojiOf(settings, token) {
      const category = CATEGORY_OF_TOKEN[token] ?? 'running';
      const glyph = tokenGlyph(settings, token);
      /** `kind:'none'` is a deliberate "no icon": the label and the band show the title alone. */
      if (glyph.kind === 'none') return '';
      return glyph.kind === 'emoji' && glyph.value !== '' ? glyph.value : CATEGORY_GLYPHS[category];
    }

    /**
     * The emoji a session title starts with, or `''`. `smart` uses it *instead of* the
     * category icon: the host prints the title itself, so drawing both would put two
     * emoji side by side. Deliberately narrow — pictographs and regional indicators,
     * plus the variation selectors and ZWJ sequences that glue one emoji together.
     */
    /** Every class starts inside the custom-icon scope, so a fresh install looks the same in all modes. */
    function defaultCustomScope() {
      const scope = {};
      for (const category of CATEGORY_IDS) scope[category] = true;
      return scope;
    }

    /**
     * Whether a session's own leading emoji beats the category icon. Only `custom` reads the
     * scope: `text` draws nothing at all and `icon` always draws the category icon.
     */
    function customIconWins(settings, category) {
      if (settings.topbar.titleMode !== 'custom') return false;
      return settings.topbar.customScope?.[category] !== false;
    }

    const LEADING_EMOJI_RE = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:\uFE0F|\u200D(?:\p{Extended_Pictographic}|\p{Regional_Indicator})|\p{Emoji_Modifier})*/u;
    function leadingEmoji(title) {
      if (typeof title !== 'string') return '';
      const match = LEADING_EMOJI_RE.exec(title.trimStart());
      return match === null ? '' : match[0];
    }

    /**
     * Every emoji the title starts with. A session can carry more than one:
     * `🧪❓ 待选择` is a marker followed by the state. Taking only the first one
     * left the second inside the text, so the tab row printed `❓ ❓ 待选择`.
     */
    function leadingEmojiRun(title) {
      if (typeof title !== 'string') return [];
      const run = [];
      let rest = title.trimStart();
      /** Four is already absurd; the cap keeps a pathological title finite. */
      while (run.length < 4) {
        const match = LEADING_EMOJI_RE.exec(rest);
        if (match === null) break;
        run.push(match[0]);
        rest = rest.slice(match[0].length).trimStart();
      }
      return run;
    }

    /** The emoji closest to the words — the one the user actually put in front of them. */
    function ownEmoji(title) {
      const run = leadingEmojiRun(title);
      return run.length === 0 ? '' : run[run.length - 1];
    }

    /**
     * A title made of emoji and nothing else. There is no text to keep, so the
     * emoji already *is* the title and drawing a second one would double it.
     */
    function isEmojiOnly(title) {
      if (typeof title !== 'string') return false;
      const run = leadingEmojiRun(title);
      return run.length > 0 && title.trim() === run.join('');
    }

    /**
     * The title with every leading emoji removed, so the glyph we draw is the
     * only one. A title that is nothing but emoji keeps its text: stripping it
     * to an empty string would rename the session to "untitled".
     */
    function stripLeadingEmoji(title) {
      const run = leadingEmojiRun(title);
      if (run.length === 0) return title;
      const width = run.reduce((sum, emoji) => sum + emoji.length, 0);
      const rest = title.trimStart().slice(width).trimStart();
      return rest === '' ? title.trimStart() : rest;
    }

    /** Motion of a token, with its target (glyph-only or glyph + row title). */
    function tokenMotion(settings, token) {
      const glyph = tokenGlyph(settings, token);
      return { motion: glyph.motion, motionTarget: glyph.motionTarget };
    }

    /** Draw order of a token: its category's own `order`. */
    function tokenPriority(settings, token) {
      const category = CATEGORY_OF_TOKEN[token];
      return category === void 0 ? 999 : orderedCategories(settings).indexOf(category);
    }

    /** Stored finish timestamps -> a Map, pruned by TTL; a broken record reads as empty. */
    function readCompletedAt(ttlMs, now) {
      const stored = readStored(COMPLETED_AT_KEY.source);
      const entries = isPlainObject(stored?.entries) ? stored.entries : {};
      const map = new Map();
      for (const [sessionId, at] of Object.entries(entries)) {
        if (typeof sessionId !== 'string' || sessionId === '') continue;
        if (typeof at !== 'number' || Number.isFinite(at) === false) continue;
        if (now - at > ttlMs) continue;
        map.set(sessionId, at);
      }
      return map;
    }

    function persistCompletedAt(map) {
      const entries = {};
      for (const [sessionId, at] of map) entries[sessionId] = at;
      try {
        localStorage.setItem(COMPLETED_AT_KEY.source, JSON.stringify({ version: SETTINGS_VERSION, entries }));
      } catch {
        /* a full quota only costs the next page load's timestamps, never the running plugin */
      }
    }

    function readStored(key) {
      try {
        const raw = localStorage.getItem(key);
        return raw === null ? void 0 : JSON.parse(raw);
      } catch {
        return void 0;
      }
    }

    /** Every path this build can write; anything else came from a version we do not know yet. */
    function knownLeaves() {
      const leaves = new Set([
        'version', 'maxSeats', 'scope', 'takeOverStatusDot', 'hideNativeDot', 'pins', 'choices',
        'positions.tab', 'positions.topbar', 'positions.sidebar',
        'topbar.mode', 'topbar.titleMode', 'topbar.maxSeats', 'topbar.previewInWeb', 'topbar.rightReservePx', 'topbar.chipWidthPct',
        ...CATEGORY_IDS.map((category) => `topbar.customScope.${category}`),
        'display.reduceMotion', 'display.motionIntervalMs',
        'shortcuts.jumpEnabled', 'shortcuts.overlayEnabled', 'shortcuts.overlayKey',
        'overlay.side', 'overlay.fallbackImage', 'overlay.sizeMin', 'overlay.sizeMax',
        'collect.completedTtlMs', 'collect.recentWindowMinutes',
        'sound.volume', 'pinned.maxSeats',
      ]);
      for (const category of CATEGORY_IDS) {
        const base = `categories.${category}`;
        for (const key of ['enabled', 'order', 'sortBy', 'within']) leaves.add(`${base}.${key}`);
        for (const side of ['glyph', 'glyphSecondary']) {
          for (const key of ['kind', 'value', 'emoji', 'image', 'source', 'motion', 'motionTarget', 'frequency', 'motionIntervalMs', 'size', 'uploads']) {
            leaves.add(`${base}.${side}.${key}`);
          }
        }
        for (const key of ['enabled', 'builtin', 'images', 'image', 'displayMs', 'entrance', 'ambient', 'exit', 'side']) leaves.add(`${base}.popout.${key}`);
        for (const key of ['enabled', 'builtin', 'uploads', 'volume', 'kind']) leaves.add(`${base}.sound.${key}`);
      }
      return leaves;
    }

    function knownContainers() {
      const containers = new Set(['positions', 'topbar', 'display', 'shortcuts', 'overlay', 'collect', 'sound', 'pinned', 'categories']);
      for (const category of CATEGORY_IDS) {
        containers.add(`categories.${category}`);
        for (const side of ['glyph', 'glyphSecondary', 'popout', 'sound']) containers.add(`categories.${category}.${side}`);
      }
      return containers;
    }

    /** Paths a user value can exceed; the same list drives both the record and the revival. */
    function rangeOf(path) {
      if (path === 'maxSeats') return [MAX_SEATS.min, MAX_SEATS.max];
      if (path === 'topbar.maxSeats') return [MAX_SEATS.min, MAX_SEATS.max];
      if (path === 'collect.completedTtlMs') return [TTL_MINUTES.min * 60000, TTL_MINUTES.max * 60000];
      if (path === 'collect.recentWindowMinutes') return [RECENT_WINDOW_MINUTES.min, RECENT_WINDOW_MINUTES.max];
      if (path === 'pinned.maxSeats') return [PINNED_SEATS.min, PINNED_SEATS.max];
      if (path === 'sound.volume') return [0, 100];
      if (path === 'overlay.sizeMin' || path === 'overlay.sizeMax') return [OVERLAY_SIZE.min, OVERLAY_SIZE.max];
      if (path === 'topbar.rightReservePx') return [TOPBAR_RESERVE.min, TOPBAR_RESERVE.max];
      if (path === 'topbar.chipWidthPct') return [CHIP_PCT.min, CHIP_PCT.max];
      if (path.endsWith('.order')) return [1, 99];
      if (path.endsWith('.glyph.frequency')) return [0, 1];
      return null;
    }

    function getPath(settings, path) {
      let node = settings;
      for (const key of path.split('.')) {
        if (node === null || typeof node !== 'object') return void 0;
        node = node[key];
      }
      return node;
    }

    function setPath(settings, path, value) {
      const keys = path.split('.');
      const last = keys.pop();
      let node = settings;
      for (const key of keys) {
        if (node[key] === null || typeof node[key] !== 'object') return settings;
        node = node[key];
      }
      node[last] = value;
      return settings;
    }

    /** Everything under `raw` this build has no schema path for. */
    function collectUnknown(raw) {
      const out = {};
      if (isPlainObject(raw) === false) return out;
      const leaves = knownLeaves();
      const containers = knownContainers();
      const walk = (value, prefix) => {
        for (const [key, child] of Object.entries(value)) {
          if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
          const path = prefix === '' ? key : `${prefix}.${key}`;
          /** A retired id is not a future field: drop it instead of keeping it as "unknown" forever. */
          if (RETIRED_PATHS.includes(path)) continue;
          if (containers.has(path)) {
            if (isPlainObject(child)) walk(child, path);
            continue;
          }
          if (leaves.has(path)) continue;
          out[path] = child;
        }
      };
      walk(raw, '');
      return out;
    }

    /** Numbers the schema refused: the raw copy is kept so a wider bound can bring it back. */
    function outOfRangeOf(raw) {
      const out = {};
      if (isPlainObject(raw) === false) return out;
      const visit = (path, value) => {
        const range = rangeOf(path);
        if (range === null || typeof value !== 'number' || Number.isFinite(value) === false) return;
        if (value >= range[0] && value <= range[1]) return;
        out[path] = { raw: value, clamped: clamp(value, range[0], range[1]) };
      };
      visit('maxSeats', raw.maxSeats);
      if (isPlainObject(raw.collect)) {
        visit('collect.completedTtlMs', raw.collect.completedTtlMs);
        visit('collect.recentWindowMinutes', raw.collect.recentWindowMinutes);
      }
      if (isPlainObject(raw.pinned)) visit('pinned.maxSeats', raw.pinned.maxSeats);
      if (isPlainObject(raw.sound)) visit('sound.volume', raw.sound.volume);
      if (isPlainObject(raw.overlay)) {
        visit('overlay.sizeMin', raw.overlay.sizeMin);
        visit('overlay.sizeMax', raw.overlay.sizeMax);
      }
      if (isPlainObject(raw.categories)) {
        for (const category of Object.keys(raw.categories)) {
          const entry = raw.categories[category];
          if (isPlainObject(entry) === false) continue;
          visit(`categories.${category}.order`, entry.order);
          if (isPlainObject(entry.glyph)) visit(`categories.${category}.glyph.frequency`, entry.glyph.frequency);
        }
      }
      return out;
    }

    function readPreserved() {
      const stored = readStored(PRESERVED_KEY);
      const unknown = isPlainObject(stored) && isPlainObject(stored.unknown) ? stored.unknown : {};
      const outOfRange = isPlainObject(stored) && isPlainObject(stored.outOfRange) ? stored.outOfRange : {};
      return { unknown, outOfRange };
    }

    function writePreserved(entries) {
      try {
        localStorage.setItem(PRESERVED_KEY, JSON.stringify({ version: SETTINGS_VERSION, ...entries }));
      } catch {
        /* a full quota costs the preserved copy, never the live settings */
      }
    }

    /** Remember what this build cannot represent, before it is lost on write. */
    function notePreserved(previous) {
      const unknown = collectUnknown(previous);
      const outOfRange = outOfRangeOf(previous);
      if (Object.keys(unknown).length === 0 && Object.keys(outOfRange).length === 0) return;
      const current = readPreserved();
      writePreserved({
        unknown: { ...current.unknown, ...unknown },
        outOfRange: { ...current.outOfRange, ...outOfRange },
      });
    }

    /** A path we now understand, where the user has no stored choice: take the preserved value back. */
    function reviveUnknown(settings, unknown) {
      if (isPlainObject(unknown) === false) return settings;
      const leaves = knownLeaves();
      const defaults = defaultSettings();
      const paths = Object.keys(unknown).filter((path) => leaves.has(path) && getPath(settings, path) === getPath(defaults, path));
      if (paths.length === 0) return settings;
      const next = JSON.parse(JSON.stringify(settings));
      for (const path of paths) setPath(next, path, unknown[path]);
      return next;
    }

    /**
     * A value the current bounds rejected is never destroyed: the raw number stays in
     * `PRESERVED_KEY.outOfRange` and comes back as soon as the bound is wide enough,
     * provided the user has not replaced it in the meantime.
     */
    function reviveOutOfRange(settings, entries, override) {
      if (isPlainObject(entries) === false) return settings;
      const next = JSON.parse(JSON.stringify(settings));
      for (const [path, entry] of Object.entries(entries)) {
        if (isPlainObject(entry) === false) continue;
        const range = isPlainObject(override) && Array.isArray(override[path]) ? override[path] : rangeOf(path);
        if (range === null) continue;
        const raw = entry.raw;
        if (typeof raw !== 'number' || Number.isFinite(raw) === false) continue;
        if (raw < range[0] || raw > range[1]) continue;
        if (getPath(next, path) !== entry.clamped) continue;
        setPath(next, path, raw);
      }
      return next;
    }

    function revivePreserved(settings) {
      const preserved = readPreserved();
      return reviveOutOfRange(reviveUnknown(settings, preserved.unknown), preserved.outOfRange);
    }

    function readBackups() {
      const stored = readStored(BACKUP_KEY);
      if (Array.isArray(stored) === false) return [];
      return stored.filter((item) => isPlainObject(item) && isPlainObject(item.settings)).slice(0, BACKUP_LIMIT);
    }

    function pushBackup(previous) {
      if (isPlainObject(previous) === false) return;
      const ring = [{ at: Date.now(), settings: previous }, ...readBackups()].slice(0, BACKUP_LIMIT);
      localStorage.setItem(BACKUP_KEY, JSON.stringify(ring));
    }

    /** Settings overlay for tests/previews; `null` clears it. */
    let injectedSettings = null;
    let settingsCache = null;
    let lastWriteError = null;

    function persist(settings) {
      lastWriteError = null;
      const previous = readStored(SETTINGS_KEY);
      try {
        pushBackup(previous);
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      } catch (error) {
        lastWriteError = error instanceof Error && error.name === 'QuotaExceededError' ? 'quota' : 'storage';
      }
      if (lastWriteError === null) notePreserved(previous);
    }

    /**
     * Read once, then serve from memory: the settings page writes several
     * fields per interaction and every consumer (tab row, sidebar) must see the
     * same snapshot. A stored object is trusted only when its version matches;
     * anything else goes through the migration chain (v3 -> v4 -> v5) and is
     * rewritten under the current key.
     */
    function readSettings() {
      if (typeof localStorage === 'undefined') {
        settingsCache = settingsCache ?? defaultSettings();
        return injectedSettings === null ? settingsCache : sanitizeSettings(mergePatch(settingsCache, upgradePatch(injectedSettings)));
      }
      const stored = readStored(SETTINGS_KEY);
      const migrated = migrateSettings(stored);
      if (stored === void 0) {
        const legacy = migrateSettings(readStored(LEGACY_SETTINGS_KEY));
        settingsCache = legacy.settings;
        persist(settingsCache);
        try { localStorage.removeItem(LEGACY_SETTINGS_KEY); } catch { /* best-effort migration */ }
      } else {
        settingsCache = migrated.settings;
        notePreserved(stored);
        if (migrated.migrated === true) persist(settingsCache);
      }
      settingsCache = revivePreserved(settingsCache);
      return injectedSettings === null ? settingsCache : sanitizeSettings(mergePatch(settingsCache, upgradePatch(injectedSettings)));
    }

    function snapshot() {
      return settingsCache ?? readSettings();
    }

    function notify() {
      for (const listener of [...settingsListeners]) {
        try { listener(snapshot()); } catch (thrown) {
          console.debug('[hotlist] settings listener skipped', thrown instanceof Error ? thrown.message : String(thrown));
        }
      }
    }

    const settingsListeners = new Set();

    function onSettingsChange(listener) {
      settingsListeners.add(listener);
      return () => settingsListeners.delete(listener);
    }

    /**
     * Translate a v3-shaped patch (the page still speaks eight states and one
     * overlay flag) into v4 fields. Keys that already are v4 pass through.
     */
    function upgradePatch(patch) {
      if (!isPlainObject(patch)) return {};
      const next = {};
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'states') {
          if (!isPlainObject(value)) continue;
          const categories = {};
          for (const [state, change] of Object.entries(value)) {
            const target = state === 'approval' ? ['pending', 'glyph']
              : state === 'question' || state === 'plan-review' ? ['pending', 'glyphSecondary']
                : ['error', 'completed', 'running', 'idle'].includes(state) ? [state, 'glyph']
                  : null;
            if (target === null || !isPlainObject(change)) continue;
            categories[target[0]] = { ...(categories[target[0]] ?? {}), [target[1]]: { ...change } };
          }
          next.categories = categories;
          continue;
        }
        if (key === 'showIdle') {
          next.categories = { ...(next.categories ?? {}), idle: { ...(next.categories?.idle ?? {}), enabled: value === true } };
          continue;
        }
        if (key === 'completedTtlMs') {
          next.collect = { ...(next.collect ?? {}), completedTtlMs: value };
          continue;
        }
        if (key === 'overlay') {
          if (!isPlainObject(value)) continue;
          const overlay = { ...(next.overlay ?? {}) };
          if (typeof value.side === 'string') overlay.side = value.side;
          /** The v3 multiplier has no v4.1 counterpart: popout size is a px pair on the global block. */
          if (typeof value.customImage === 'string') overlay.fallbackImage = value.customImage;
          next.overlay = overlay;
          if (typeof value.shortcut === 'string') next.shortcuts = { ...(next.shortcuts ?? {}), overlayKey: value.shortcut };
          if (typeof value.enabled === 'boolean') {
            const categories = { ...(next.categories ?? {}) };
            for (const category of CATEGORY_IDS) {
              categories[category] = { ...(categories[category] ?? {}), popout: { ...(categories[category]?.popout ?? {}), enabled: value.enabled } };
            }
            next.categories = categories;
          }
          continue;
        }
        next[key] = value;
      }
      return next;
    }

    /** Deepish merge for settings patches: `categories.<id>.<field>` adds instead of replacing. */
    function mergePatch(base, patch) {
      const next = { ...base };
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'categories' && isPlainObject(value)) {
          const categories = { ...base.categories };
          for (const [category, change] of Object.entries(value)) {
            if (!isPlainObject(categories[category]) || !isPlainObject(change)) continue;
            const merged = { ...categories[category] };
            for (const [field, fieldValue] of Object.entries(change)) {
              /** One level deeper: `{glyph: {motion}}` keeps the stored uploads and pools. */
              merged[field] = isPlainObject(fieldValue) && isPlainObject(merged[field]) ? { ...merged[field], ...fieldValue } : fieldValue;
            }
            categories[category] = merged;
          }
          next.categories = categories;
          continue;
        }
        next[key] = isPlainObject(value) && isPlainObject(base[key]) ? { ...base[key], ...value } : value;
      }
      return next;
    }

    /**
     * Persist a partial patch and tell every consumer right away: a `storage`
     * event never fires in the document that wrote, so the same-page broadcast
     * is this call, and the tab row plus the sidebar both react within a frame.
     */
    function writeSettings(patch) {
      const base = settingsCache ?? readSettings();
      const upgraded = upgradePatch(patch);
      /** Mark first, merge second: a value the preset rule rewrites afterwards is not a choice. */
      const marked = { ...base, choices: choicesFromPatch(upgraded, base) };
      settingsCache = sanitizeSettings(mergePatch(marked, upgraded));
      persist(settingsCache);
      notify();
      return settingsCache;
    }

    function resetSettings() {
      /** A reset drops every marker too: the presets are factory again, so future ones may replace them. */
      settingsCache = defaultSettings();
      persist(settingsCache);
      notify();
      return settingsCache;
    }
    /** Restore one category to its factory shape and drop only that category's markers. */
    function resetCategory(category) {
      if (CATEGORY_IDS.includes(category) === false) return settingsCache ?? readSettings();
      const base = settingsCache ?? readSettings();
      const prefix = `categories.${category}.`;
      const choices = {};
      for (const [key, value] of Object.entries(base.choices ?? {})) {
        if (key.startsWith(prefix) === false) choices[key] = value;
      }
      settingsCache = sanitizeSettings({
        ...base,
        choices,
        categories: { ...base.categories, [category]: defaultCategory(category) },
      });
      persist(settingsCache);
      notify();
      return settingsCache;
    }


    /** Cross-window sync; the writing document broadcasts through `writeSettings` itself. */
    function watchStorage() {
      if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => {};
      const onStorage = (event) => {
        if (event.key !== null && event.key !== SETTINGS_KEY) return;
        settingsCache = null;
        notify();
      };
      window.addEventListener('storage', onStorage);
      return () => window.removeEventListener('storage', onStorage);
    }

    function overrideSettings(patch) {
      injectedSettings = patch === null ? null : patch;
      const next = readSettings();
      notify();
      return next;
    }

/** Tab labels get ~120px: count full-width characters as two columns. */
    function shortenTitle(title) {
      const text = title.replace(/\s+/g, ' ').trim();
      let width = 0;
      let cut = 0;
      for (const character of text) {
        width += FULL_WIDTH.test(character) ? 2 : 1;
        if (width > LABEL_WIDTH) return `${text.slice(0, cut).trimEnd()}…`;
        cut += character.length;
      }
      return text;
    }

    /** Categories that can produce rows, in draw order. */
    function orderedCategories(settings) {
      return CATEGORY_IDS
        .slice()
        .sort((left, right) => {
          const a = settings.categories[left].order;
          const b = settings.categories[right].order;
          return a !== b ? a - b : CATEGORY_RANK[left] - CATEGORY_RANK[right];
        });
    }

    /** A category produces nothing when it is disabled or every surface is off. */
    function categoryAllOff(settings, category) {
      const entry = settings.categories[category];
      if (entry.enabled !== true) return true;
      return entry.surfaces.tab !== true && entry.surfaces.sidebar !== true && entry.surfaces.topbar !== true;
    }

    /**
     * The winning class among the ones a session earns: the smallest `order` wins
     * and `CATEGORY_RANK` breaks a tie, so the same input always yields the same
     * answer. `order` is a setting, so reordering the cards reorders the
     * judgement — that is the rule, not a side effect of it.
     */
    function bestCategory(settings, qualified) {
      let best = null;
      for (const category of qualified) {
        if (best === null) {
          best = category;
          continue;
        }
        const left = settings.categories[category].order;
        const right = settings.categories[best].order;
        if (left < right || (left === right && CATEGORY_RANK[category] < CATEGORY_RANK[best])) best = category;
      }
      return best;
    }

    /** Whether a category is allowed on the surface that is asking (`tab` or `sidebar`). */
    function categoryVisible(settings, category, surface) {
      const entry = settings.categories[category];
      return entry.enabled === true && entry.surfaces[surface] === true;
    }

    /** Child sessions of one parent that are still running (a parent can sit idle while they work). */
    function runningChildren(list, statuses, sessionId) {
      const catalog = list?.projectionsBySession?.[sessionId]?.values?.subagentCatalog;
      if (!Array.isArray(catalog)) return 0;
      let count = 0;
      for (const child of catalog) {
        const childId = child?.id;
        if (typeof childId !== 'string') continue;
        const running = statuses.get(childId)?.running ?? list.byId?.[childId]?.running;
        if (running === true) count += 1;
      }
      return count;
    }

    /**
     * Pure: snapshots + settings -> one row per session that belongs to a
     * category on this surface. No ordering by recency happens here; that is
     * `sortSeats` (and `entered`, for the tab row).
     *
     * `pending` merges approval and question/plan-review: approval drives the
     * primary glyph, question the secondary one. `subagents` folds into
     * `running`. `pinned` comes from the workspace store's `pinnedSessionIds`. `idle` only appears on a
     * surface that asks for it, inside its category's `within` window.
     */
    function classify(settings, input) {
      const surface = input.surface ?? 'tab';
      /** The workspace store's pin list, most recent first; empty until its first read lands. */
      const pinnedSessionIds = Array.isArray(input.pinnedSessionIds) ? input.pinnedSessionIds : [];
      const rows = [];
      /** A class that is off on every surface can never win; the per-surface check happens on the winner. */
      const usable = new Set(orderedCategories(settings).filter((category) => !categoryAllOff(settings, category)));

      for (const id of input.list.ids) {
        const session = input.list.byId[id];
        if (session === void 0 || session.blank === true) continue;
        if (session.origin === 'subagent') continue;
        if (input.workspaceIds !== null && input.workspaceIds.includes(id) === false) continue;
        const updatedAt = typeof session.updatedAt === 'number' ? session.updatedAt : 0;
        const title = typeof session.displayTitle === 'string' ? session.displayTitle : '';
        const base = { sessionId: id, title, updatedAt, errorMessage: void 0 };

        const status = input.statuses.get(id);
        const kind = status?.pendingInteraction?.kind;
        const failure = input.errors.get(id);
        const finishedAt = input.completedAt.get(id);
        const running = status?.running === undefined ? session.running === true : status.running === true;
        const children = running === true ? 0 : runningChildren(input.list, input.statuses, id);
        const pinIndex = pinnedSessionIds.indexOf(id);
        const within = settings.collect.recentWindowMinutes;
        /** `smart` shows every workspace but never a pin from another one: that pin just does not qualify. */
        const crossWorkspacePin = settings.scope === 'smart'
          && input.scopeWorkspaceIds !== null && input.scopeWorkspaceIds !== void 0
          && Array.isArray(input.scopeWorkspaceIds) && input.scopeWorkspaceIds.includes(id) === false;

        /** Every class this session earns — the six conditions, unchanged from the old chain. */
        const qualified = [];
        if (failure !== void 0 && usable.has('error')) qualified.push('error');
        if ((kind === 'approval' || kind === 'question' || kind === 'plan-review') && usable.has('pending')) qualified.push('pending');
        if (finishedAt !== void 0 && input.now - finishedAt < settings.collect.completedTtlMs && usable.has('completed')) qualified.push('completed');
        if ((running === true || children > 0) && usable.has('running')) qualified.push('running');
        if (pinIndex >= 0 && crossWorkspacePin === false && usable.has('pinned')) qualified.push('pinned');
        if (within > 0 && input.now - updatedAt <= within * 60000 && usable.has('idle')) qualified.push('idle');

        const winner = bestCategory(settings, qualified);
        if (winner === null) continue;
        /**
         * No fall-through: a class this surface does not carry drops the row
         * instead of demoting it, or a failed session would show as `idle` in
         * the tab row.
         */
        if (categoryVisible(settings, winner, surface) === false) continue;
        const token = winner === 'pending' ? (kind === 'approval' ? 'approval' : 'question') : winner;
        const pinLevel = winner === 'pinned' ? pinIndex + 1 : null;
        rows.push({
          ...base,
          category: winner,
          token,
          pinLevel,
          errorMessage: winner === 'error' ? failure.message : void 0,
        });
      }
      return rows;
    }

    /**
     * Pure: order classified rows inside their category. `pinned` uses
     * `pinLevel` (1 first); every other category sorts by `sortBy`: `time`
     * puts the newest activity first, `manual` keeps the order the rows
     * arrived in.
     */
    function sortSeats(settings, rows) {
      const order = orderedCategories(settings);
      return rows.slice().sort((left, right) => {
        if (left.category !== right.category) {
          return order.indexOf(left.category) - order.indexOf(right.category);
        }
        const entry = settings.categories[left.category];
        if (entry.sortBy === 'manual' && left.pinLevel !== right.pinLevel) return left.pinLevel - right.pinLevel;
        if (entry.sortBy === 'time' && left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt;
        return left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0;
      });
    }

    /**
     * Pure: the seats the tab row should show. The current session is
     * excluded outright (the 对话 tab already stands for it). Rows of the
     * user-facing categories (`pinned`, `pending`, `error`) are always kept —
     * hiding a session that needs the user is worse than overflowing — while
     * `completed`, `running` and `idle` fill up to `limit` (physical row width
     * ∩ `maxSeats`). `order` is the category's own `order` × 100 plus the
     * position, so it never changes while a seat keeps its category.
     * `pinned` rows are additionally capped by `pinned.maxSeats` (`0` = none).
     */
    function buildSeatPlan(input, settings) {
      const limit = typeof input.limit === 'number' ? input.limit : MAX_SEATS.fallback;
      const rows = classify(settings, input).filter((row) => row.sessionId !== input.currentId);
      const sorted = sortSeats(settings, rows);
      const always = new Set(['pinned', 'pending', 'error']);
      const pinnedCap = clamp(Math.round(settings.pinned.maxSeats), PINNED_SEATS.min, PINNED_SEATS.max);
      const urgentCap = limit + ALWAYS_OVERFLOW;
      let urgent = 0;
      let pins = 0;
      const kept = [];
      for (const row of sorted) {
        if (row.category === 'pinned' && pins >= pinnedCap) continue;
        if (always.has(row.category)) {
          if (urgent >= urgentCap) continue;
          urgent += 1;
          if (row.category === 'pinned') pins += 1;
          kept.push(row);
          continue;
        }
        if (kept.length - urgent >= limit) continue;
        kept.push(row);
      }
      const overflow = sorted.length - kept.length;
      const capped = kept.slice(0, PLAN_MAX_ROWS);
      const perCategory = new Map();
      const plan = capped.map((row) => {
        const index = perCategory.get(row.category) ?? 0;
        perCategory.set(row.category, index + 1);
        return {
          sessionId: row.sessionId,
          category: row.category,
          token: row.token,
          order: settings.categories[row.category].order * 100 + index + 1,
          title: row.title,
          errorMessage: row.errorMessage,
          pinLevel: row.pinLevel,
        };
      });
      plan.overflow = overflow;
      return plan;
    }

    /**
     * The data behind the `热表` view entry. Pure, and built only from the three
     * functions the surfaces themselves call — `classify` (through
     * `buildSeatPlan`), `buildSeatPlan` and `sidebarStateOf` — so a row here and
     * a seat in the row can never disagree about what is hot.
     *
     * `missing` is the reason this view exists: a session the user expects and
     * the plugin drops has to say *why*. Seven reasons, in the order the
     * decision is made — the first six are "it never became a row", the last is
     * "it became one and the cap cut it":
     *
     * `empty` no messages yet | `subagent` a child run, never a seat |
     * `scope` another workspace under `scope: 'workspace'` |
     * `no-category` nothing matched: not running, not pinned, outside the window |
     * `surface-off` its class is off on all three surfaces |
     * `position-off` its class is on somewhere, but that surface is off |
     * `over-cap` it would be listed, and the seat cap cut it
     */
    function hotlistTable(settings, snapshot, runtime) {
      const shared = {
        list: snapshot.list,
        statuses: snapshot.statuses,
        errors: runtime.errors,
        completedAt: runtime.completedAt,
        currentId: snapshot.currentId,
        pinnedSessionIds: snapshot.pinnedSessionIds,
        workspaceIds: snapshot.workspaceIds,
        scopeWorkspaceIds: snapshot.scopeWorkspaceIds ?? null,
        scope: snapshot.scope,
        now: runtime.now,
      };
      /**
       * A surface that is switched off cannot name a row, so its plan is not even
       * built: the table has to agree with what is actually painted, not with what
       * would be painted if every position were on.
       */
      const tabPlan = settings.positions.tab === true
        ? buildSeatPlan({ ...shared, surface: 'tab', limit: runtime.limit }, settings)
        : [];
      const bandPlan = runtime.bandUp === true
        ? buildSeatPlan({ ...shared, surface: 'topbar', limit: runtime.topbarLimit }, settings)
        : [];
      const seats = new Map(tabPlan.map((seat) => [seat.sessionId, seat]));
      const bandSeats = new Map(bandPlan.map((seat) => [seat.sessionId, seat]));
      /** `sidebarStateOf` speaks tokens; the table speaks categories. Same words, same rule. */
      const sidebarStates = new Map();
      for (const sessionId of settings.positions.sidebar === true ? snapshot.list.ids : []) {
        const session = snapshot.list.byId[sessionId];
        if (session === void 0) continue;
        const state = sidebarStateOf({
          session,
          status: snapshot.statuses.get(sessionId),
          error: runtime.errors.get(sessionId),
          completedAt: runtime.completedAt.get(sessionId),
          settings,
          now: runtime.now,
          pinned: snapshot.pinnedSessionIds.includes(sessionId),
          children: runningChildren(snapshot.list, snapshot.statuses, sessionId),
          scope: snapshot.scope,
          currentWorkspaceIds: snapshot.workspaceIds,
        });
        if (state !== null) sidebarStates.set(sessionId, state);
      }
      const candidates = new Set([...seats.keys(), ...bandSeats.keys(), ...sidebarStates.keys()]);
      const rows = [];
      for (const sessionId of candidates) {
        const seat = seats.get(sessionId) ?? bandSeats.get(sessionId);
        const state = sidebarStates.get(sessionId);
        const category = seat === void 0 ? CATEGORY_OF_TOKEN[state] ?? 'running' : seat.category;
        const session = snapshot.list.byId[sessionId];
        const title = seat === void 0 ? session?.displayTitle ?? '' : seat.title;
        const notes = [];
        if (sessionId === snapshot.currentId) notes.push({ code: 'current' });
        if (seat !== void 0 && seat.pinLevel !== null && seat.pinLevel !== void 0) notes.push({ code: 'pin', detail: String(seat.pinLevel) });
        if (seat !== void 0 && typeof seat.errorMessage === 'string' && seat.errorMessage !== '') {
          notes.push({ code: 'error', detail: seat.errorMessage.slice(0, ERROR_TEXT_LIMIT) });
        }
        rows.push({
          sessionId,
          category,
          order: settings.categories[category].order,
          title: shortenTitle(title),
          surfaces: { tab: seats.has(sessionId), sidebar: sidebarStates.has(sessionId), topbar: bandSeats.has(sessionId) },
          notes,
        });
      }
      rows.sort((left, right) => {
        if (left.category !== right.category) {
          return settings.categories[left.category].order - settings.categories[right.category].order;
        }
        return left.order - right.order || left.sessionId.localeCompare(right.sessionId);
      });
      rows.forEach((row, index) => {
        row.index = index + 1;
      });
      /**
       * The class a session *would* win with every switch forced on: that is how
       * a session that is off for a reason gets a nameable class instead of
       * "unknown".
       */
      const anywhere = {
        ...settings,
        scope: 'all',
        categories: Object.fromEntries(CATEGORY_IDS.map((category) => [category, {
          ...settings.categories[category],
          enabled: true,
          surfaces: { tab: true, sidebar: true, topbar: true },
        }])),
      };
      const intrinsic = new Map(classify(anywhere, { ...shared, scope: 'all', workspaceIds: null, surface: 'tab' })
        .map((row) => [row.sessionId, row.category]));
      const missing = [];
      for (const sessionId of snapshot.list.ids) {
        if (candidates.has(sessionId)) continue;
        const session = snapshot.list.byId[sessionId];
        if (session === void 0) continue;
        const title = shortenTitle(typeof session.displayTitle === 'string' ? session.displayTitle : '');
        if (session.blank === true) {
          missing.push({ sessionId, title, category: null, reason: 'empty' });
          continue;
        }
        if (session.origin === 'subagent') {
          missing.push({ sessionId, title, category: null, reason: 'subagent' });
          continue;
        }
        if (snapshot.scope === 'workspace' && snapshot.workspaceIds !== null && snapshot.workspaceIds.includes(sessionId) === false) {
          missing.push({ sessionId, title, category: null, reason: 'scope' });
          continue;
        }
        const category = intrinsic.get(sessionId) ?? null;
        if (category === null) {
          missing.push({ sessionId, title, category: null, reason: 'no-category' });
          continue;
        }
        if (categoryAllOff(settings, category)) {
          missing.push({ sessionId, title, category, reason: 'surface-off' });
          continue;
        }
        const reachable = (settings.positions.tab === true && categoryVisible(settings, category, 'tab'))
          || (settings.positions.sidebar === true && categoryVisible(settings, category, 'sidebar'))
          || (runtime.bandUp === true && categoryVisible(settings, category, 'topbar'));
        missing.push({
          sessionId,
          title,
          category,
          reason: reachable ? 'over-cap' : 'position-off',
          limit: runtime.limit,
        });
      }
      return { rows, missing, limit: runtime.limit, overflow: tabPlan.overflow };
    }

    // =========================================================================
    // Session list export. Pure: the same opts in -> the same string out, so two
    // exports of one snapshot are byte-identical and Notion can diff them.
    //
    // The action takes its parameters (`format`, `scope`, `includeArchived`,
    // `includeSubagents`) as arguments on purpose: an action is not a setting,
    // so nothing here goes through `defaultSettings` / `knownLeaves` /
    // `sanitizeSettings` / `rangeOf`, and `SETTINGS_VERSION` stays 4.
    // =========================================================================

    /** Column order of the export; `id` last so the Markdown table stays narrow. */
    const EXPORT_COLUMNS = Object.freeze([
      'displayTitle', 'status', 'workspace', 'lastActivityIso', 'lastActivityLocal',
      'pinned', 'archived', 'running', 'pendingKind', 'completionUnread',
      'isCurrent', 'origin', 'id',
    ]);
    const EXPORT_FORMATS = Object.freeze(['md', 'txt', 'json']);
    /** The `scope` vocabulary belongs to the settings field; this action only reads it. */
    const EXPORT_SCOPES = Object.freeze(['workspace', 'all', 'smart']);
    /** Windows Notepad needs it or a Chinese title comes back as mojibake. */
    const EXPORT_BOM = '\uFEFF';

    /** `2026-11-13 01:47`, derived from the epoch value alone — never from `Date.now()`. */
    function localStamp(epochMs) {
      if (typeof epochMs !== 'number' || Number.isFinite(epochMs) === false || epochMs <= 0) return '';
      const at = new Date(epochMs);
      const pad = (value) => String(value).padStart(2, '0');
      return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
    }

    /** `sidebarStateOf` tokens -> the category `sortSeats` orders by. */
    const EXPORT_CATEGORY_OF = Object.freeze({
      error: 'error', approval: 'pending', question: 'pending',
      completed: 'completed', running: 'running', pinned: 'pinned', idle: 'idle',
    });

    /**
     * A copy of the settings with every sidebar surface open. `sidebarStateOf`
     * gates each state on `surfaces.<surface>` because it draws one surface; an
     * export draws none, so the per-surface switches must not change the answer.
     * `enabled` is left alone — a state the user switched off entirely stays
     * off, which keeps the export agreeing with the UI.
     */
    function openExportSurfaces(settings) {
      const categories = {};
      for (const key of Object.keys(settings?.categories ?? {})) {
        const entry = settings.categories[key];
        categories[key] = { ...entry, surfaces: { ...(entry.surfaces ?? {}), sidebar: true } };
      }
      return { ...settings, categories };
    }

    /**
     * Pure: the exported rows, filtered and then sorted. `input` mirrors
     * `planFrom()` — `readSnapshot()` carries neither `errors`, `completedAt`
     * nor the archived ids (it drops archived ids at the source), and must not
     * be changed to add them, so the caller supplies all three.
     *
     * The state chain is `sidebarStateOf`'s, never a second copy of it: another
     * chain would call one session `error` on screen and `approval` in the file.
     * When the chain returns `null` (older than the recent window) the row falls
     * back to `idle`, because every exported session needs one of the states.
     */
    function extractExportRows(input) {
      const settings = openExportSurfaces(input.settings);
      const now = input.now;
      const statuses = input.statuses ?? new Map();
      const errors = input.errors ?? new Map();
      const completedAt = input.completedAt ?? new Map();
      const archivedIds = new Set(input.archivedSessionIds ?? []);
      const pinnedIds = Array.isArray(input.pinnedSessionIds) ? input.pinnedSessionIds : [];
      const scope = EXPORT_SCOPES.includes(input.scope) ? input.scope : 'smart';
      const includeArchived = input.includeArchived === true;
      const includeSubagents = input.includeSubagents === true;
      const workspaceIds = input.workspaceIds ?? null;
      const inWorkspace = (id) => workspaceIds === null || workspaceIds.includes(id);

      const rows = [];
      for (const id of input.ids ?? []) {
        const session = input.byId?.[id];
        if (session === void 0 || session.blank === true) continue;
        /** `classify` skips these too: a session the UI never shows is not exported. */
        if (session.origin === 'subagent' && includeSubagents !== true) continue;
        const archived = archivedIds.has(id);
        if (archived && includeArchived !== true) continue;
        if (scope === 'workspace' && inWorkspace(id) === false) continue;
        const pinIndex = pinnedIds.indexOf(id);
        const pinned = pinIndex >= 0;
        /**
         * No pre-skip for a cross-workspace pin: it used to be dropped here, but
         * `sidebarStateOf` already knows that rule — the pin simply does not
         * qualify and the row exports as whatever it is otherwise (usually
         * `idle`), which is exactly what the sidebar shows for it.
         */
        const status = statuses.get(id);
        const token = sidebarStateOf({
          session,
          status,
          error: errors.get(id),
          completedAt: completedAt.get(id),
          settings,
          now,
          pinned,
          children: runningChildren(input.list, statuses, id),
          /** Same two fields the sidebar passes, or the cross-workspace rule cannot fire. */
          scope,
          currentWorkspaceIds: workspaceIds,
        }) ?? 'idle';

        rows.push({
          displayTitle: typeof session.displayTitle === 'string' ? session.displayTitle : '',
          status: token,
          workspace: typeof session.cwd === 'string' ? session.cwd : '',
          lastActivityIso: typeof session.updatedAt === 'number' ? session.updatedAt : 0,
          lastActivityLocal: localStamp(session.updatedAt),
          pinned,
          archived,
          running: status?.running === undefined ? session.running === true : status.running === true,
          pendingKind: status?.pendingInteraction?.kind ?? '',
          completionUnread: status?.completionUnread === true,
          isCurrent: id === input.currentId,
          origin: session.origin === 'subagent' ? 'subagent' : 'main',
          id,
          /** Sorting keys, not exported: `sortSeats` needs them and the file does not. */
          category: EXPORT_CATEGORY_OF[token] ?? 'idle',
          pinLevel: pinned ? pinIndex + 1 : null,
          /** `sortSeats` tie-breaks on time, then on `sessionId` — `id` is not read there. */
          updatedAt: typeof session.updatedAt === 'number' ? session.updatedAt : 0,
          sessionId: id,
        });
      }
      /** The plugin's own sort, so the file's order is the order on screen. */
      return sortSeats(settings, rows);
    }

    /** Booleans read as `yes`/`no` in the table and stay booleans in JSON. */
    function exportCell(row, column) {
      const value = row[column];
      if (typeof value === 'boolean') return value ? 'yes' : 'no';
      return value === void 0 || value === null ? '' : String(value);
    }

    /** A title may contain `|`, a tab or a newline — all three break a Markdown cell. */
    function mdCell(text) {
      return text.replace(/[\t\r\n]+/g, ' ').replace(/\|/g, '\\|');
    }

    /** Tab-separated, so a literal tab or newline in a title has to go. */
    function txtCell(text) {
      return text.replace(/[\t\r\n]+/g, ' ');
    }

    function exportRowsJson(rows) {
      return JSON.stringify(rows.map((row) => {
        const out = {};
        for (const column of EXPORT_COLUMNS) out[column] = row[column];
        return out;
      }), null, 2);
    }

    function serializeExport(rows, format) {
      if (format === 'json') return exportRowsJson(rows);
      const render = (row, escapeCell) => EXPORT_COLUMNS.map((column) => escapeCell(exportCell(row, column)));
      if (format === 'txt') {
        return [
          EXPORT_COLUMNS.join('\t'),
          ...rows.map((row) => render(row, txtCell).join('\t')),
        ].join('\n');
      }
      return [
        `| ${EXPORT_COLUMNS.join(' | ')} |`,
        `| ${EXPORT_COLUMNS.map(() => '---').join(' | ')} |`,
        ...rows.map((row) => `| ${render(row, mdCell).join(' | ')} |`),
      ].join('\n');
    }

    /**
     * `exportSessions(opts)` — pure, and safe to call bare: with no `ids` it
     * returns an empty export instead of throwing. `scope` is read from the
     * settings only when the caller does not pass one, and an unknown value
     * falls back to `smart` rather than to inventing a fourth one.
     */
    function exportSessions(opts = {}) {
      const format = EXPORT_FORMATS.includes(opts.format) ? opts.format : 'md';
      let scope = opts.scope;
      if (EXPORT_SCOPES.includes(scope) === false) {
        try {
          scope = readSettings().scope;
        } catch {
          scope = void 0;
        }
      }
      if (EXPORT_SCOPES.includes(scope) === false) scope = 'smart';
      const rows = opts.ids === void 0 ? [] : extractExportRows({ ...opts, scope });
      /** JSON stays bare so `JSON.parse` works unmodified; the text formats get the BOM. */
      return format === 'json' ? serializeExport(rows, format) : EXPORT_BOM + serializeExport(rows, format);
    }

    /**
     * Tab label split into the glyph we own and the text the host keeps, so the
     * two can be painted by different nodes without ever doubling an emoji.
     */
    function labelParts(t, seat, settings = snapshot()) {
      const mode = settings.topbar.titleMode;
      const category = CATEGORY_OF_TOKEN[seat.token ?? seat.badge ?? null] ?? 'running';
      /** The emoji closest to the words, not the first one: `🧪❓ 待选择` carries two. */
      const own = ownEmoji(seat.title);
      /** `custom` lets the emoji the user typed into the title win; `icon` and `text` never use it. */
      const fromTitle = own !== '' && customIconWins(settings, category);
      /** A title that is nothing but emoji already carries its own glyph. */
      if (isEmojiOnly(seat.title)) return { emoji: '', title: shortenTitle(seat.title.trim()) };
      /**
       * No leading emoji of the title may survive here — every one of them would
       * pair with the glyph we draw.
       */
      const raw = stripLeadingEmoji(seat.title);
      const title = raw === '' ? t('tab.untitled') : shortenTitle(raw);
      const token = seat.token ?? seat.badge ?? null;
      const emoji = mode === 'text' ? '' : fromTitle ? own : token === null ? '' : emojiOf(settings, token);
      return { emoji, title };
    }

    /** Tab label: the token's emoji + title shortened to the tab width. */
    function labelOf(t, seat, settings = snapshot()) {
      const { emoji, title } = labelParts(t, seat, settings);
      return emoji === '' ? title : `${emoji} ${title}`;
    }


    /** Live failure message of an opened session, `null` when the binding says clean, `undefined` when no binding is retained. */
    function bindingFailure(sessions, sessionId) {
      try {
        const binding = sessions.binding(sessionId);
        if (binding === void 0) return void 0;
        const snapshot = binding.session.getSnapshot();
        const message = snapshot.promptError?.error?.message ?? snapshot.lastAgentError;
        return message ? String(message) : null;
      } catch (thrown) {
        console.debug('[hotlist] binding skipped', sessionId, thrown instanceof Error ? thrown.message : String(thrown));
        return void 0;
      }
    }

    /**
     * Seat ids are view ids, and the conversation UI persists the active view
     * id per session in `dsh.conversation.<sessionId>`
     * (dsh-client-ui-conversation lib/client.js:4513, :4560-4571). A seat that
     * was disposed while a session kept it as its preference becomes an
     * unknown view id, and resolveActiveView/restoreView then keep activating
     * each other into React #185. Repair such leftovers while this module
     * loads, before any seat is registered and before the conversation UI
     * reads its preferences: only the `view` field changes, everything else
     * is kept verbatim.
     */
    /**
     * A view id that can only belong to one of our seats, to the old single-tab
     * build, or to the table entry. The table is in this list for the same
     * reason the seats are: it is registered after boot, so a persisted id would
     * resolve to nothing and the session would open on a placeholder page.
     */
    function isSeatViewId(view) {
      if (typeof view !== 'string') return false;
      return SEAT_PREFIXES.some((prefix) => view.startsWith(prefix))
        || view === LEGACY_VIEW_ID
        || view === HOTLIST_VIEW_ID
        || view === TABLE_VIEW_ID;
    }

    function healViewPreferences() {
      if (typeof localStorage === 'undefined') return;
      try {
        for (let index = 0; index < localStorage.length; index += 1) {
          const key = localStorage.key(index);
          if (key === null || !key.startsWith(VIEW_PREF_PREFIX)) continue;
          try {
            const stored = JSON.parse(localStorage.getItem(key));
            const view = typeof stored?.view === 'string' ? stored.view : null;
            if (view === null || !isSeatViewId(view)) continue;
            localStorage.setItem(key, JSON.stringify({ ...stored, view: 'chat' }));
          } catch {
            continue;
          }
        }
      } catch {
        return;
      }
    }
    /**
     * Selecting a tab lets the host write the *current* session's view
     * preference first; only then do we switch to the target, so the source
     * session can keep a preference that points at another session's seat
     * (measured on the real machine). Rewriting it to 'chat' compensates that
     * host timing race: the preference is persisted data of ours to correct,
     * not an API shortcut. Only the `view` field changes; other fields stay.
     */
    function repairSourcePreference(sessionId) {
      if (typeof localStorage === 'undefined') return;
      const key = `${VIEW_PREF_PREFIX}${sessionId}`;
      try {
        const raw = localStorage.getItem(key);
        if (raw === null) return;
        const stored = JSON.parse(raw);
        if (stored === null || typeof stored !== 'object' || !isSeatViewId(stored.view)) return;
        localStorage.setItem(key, JSON.stringify({ ...stored, view: 'chat' }));
      } catch {
        // while the host writes the same key, the next repair pass (1200 ms) retries
      }
    }

    healViewPreferences();

    try {
      const surface = {
        version: SETTINGS_VERSION,
        get: readSettings,
        set: writeSettings,
        reset: resetSettings,
        subscribe: onSettingsChange,
        override: overrideSettings,
        defaults: defaultSettings,
        glyphOf,
        emojiOf,
        lastError: () => lastWriteError,
      };
      window.__HOTLIST_SETTINGS__ = surface;
      window.__SESSION_SWITCHER_SETTINGS__ = surface;
    } catch {
      // settings surface is the future settings-page entry point; never block the plugin on it
    }

    // -------------------------------------------------------------------------
    // Sidebar glyphs. The sidebar row is host DOM: we insert one marker of ours
    // in front of the title and never wrap, move or restyle host nodes. The
    // state and its motion come from the same session stores the row is drawn
    // from, so a glyph cannot disagree with the sidebar. `motionTarget: 'row'`
    // additionally animates the host title with an inline animation (restored
    // on stop); this only works on surfaces we can reach as elements — sidebar
    // rows. Conversation tab labels are drawn by the host from a string, so a
    // seat can only animate its glyph; a top-bar chip rendered by us could
    // animate both.
    // -------------------------------------------------------------------------
    const ROW_SELECTOR = '[role="treeitem"][data-row-key^="session:"]';
    const ROW_KEY_PREFIX = 'session:';
    const GLYPH_ATTR = 'data-hotlist-glyph';
    const CHAR_ATTR = 'data-hotlist-char';
    const KIND_ATTR = 'data-hotlist-glyph-kind';
    const STATE_ATTR = 'data-hotlist-state';
    const MOTION_ATTR = 'data-hotlist-motion';
    /** Marks the one span currently playing a single-shot burst (CSS uses iteration 1). */
    const BURST_ATTR = 'data-hotlist-burst';
    const TEXT_MOTION_ATTR = 'data-hotlist-text-motion';
    const STYLE_ATTR = 'data-hotlist-style';
    const HIDE_NATIVE_ATTR = 'data-hotlist-hide-native';
    const MOTION_PAUSED_ATTR = 'data-hotlist-motion-paused';
    const REDUCE_MOTION_ATTR = 'data-hotlist-reduce-motion';
    /** Stop decorating after this many failed title lookups instead of fighting the host DOM. */
    const MAX_MISSES = 60;
    const MISS_RETRY_MS = 30 * 1000;
    const SIDEBAR_TICK_MS = 1000;
    /** How long one burst animation runs; the attribute is dropped again afterwards. */
    const MOTION_MS = { spin: 2400, pulse: 1600, bounce: 1200, blink: 1200 };
    /** Full repaint cadence; store changes and DOM mutations repaint much sooner. */
    const SIDEBAR_REFRESH_MS = 30 * 1000;
    /** A live run failure stays visible for half an hour unless the session runs again. */
    const SIDEBAR_ERROR_TTL_MS = 30 * 60 * 1000;
    /**
     * Text variants: no `scale` on text (it looks blurry), so each one is a small
     * translate plus an opacity wave; the glyph itself keeps the full motion.
     */
    const TEXT_MOTION = {
      spin: 'hl-text-spin 2.4s linear infinite',
      pulse: 'hl-text-pulse 1.6s ease-in-out infinite',
      bounce: 'hl-text-bounce 1.2s ease-in-out infinite',
      blink: 'hl-text-blink 1.2s ease-in-out infinite',
    };
    /** The same four variants, played once: a burst must not keep the title moving. */
    const TEXT_BURST = {
      spin: 'hl-text-spin 2.4s linear 1',
      pulse: 'hl-text-pulse 1.6s ease-in-out 1',
      bounce: 'hl-text-bounce 1.2s ease-in-out 1',
      blink: 'hl-text-blink 1.2s ease-in-out 1',
    };
    const SIDEBAR_STYLE = [
      `[${GLYPH_ATTR}]{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex:0 0 16px;margin-right:2px;transform-origin:center}`,
      `[${GLYPH_ATTR}]::before{content:attr(${CHAR_ATTR});display:block;font-size:14px;line-height:16px}`,
      `[${GLYPH_ATTR}][${KIND_ATTR}="img"]::before{content:none}`,
      `[${GLYPH_ATTR}] img{display:block;width:16px;height:16px;object-fit:contain;border-radius:3px}`,
      `[${GLYPH_ATTR}][${MOTION_ATTR}="spin"]{animation:hl-spin 2.4s linear infinite;will-change:transform}`,
      `[${GLYPH_ATTR}][${MOTION_ATTR}="pulse"]{animation:hl-pulse 1.6s ease-in-out infinite;will-change:transform}`,
      `[${GLYPH_ATTR}][${MOTION_ATTR}="bounce"]{animation:hl-bounce 1.2s ease-in-out infinite;will-change:transform}`,
      `[${GLYPH_ATTR}][${MOTION_ATTR}="blink"]{animation:hl-blink 1.2s ease-in-out infinite}`,
      `[${GLYPH_ATTR}][${BURST_ATTR}][${MOTION_ATTR}="spin"]{animation:hl-spin 2.4s linear 1}`,
      `[${GLYPH_ATTR}][${BURST_ATTR}][${MOTION_ATTR}="pulse"]{animation:hl-pulse 1.6s ease-in-out 1}`,
      `[${GLYPH_ATTR}][${BURST_ATTR}][${MOTION_ATTR}="bounce"]{animation:hl-bounce 1.2s ease-in-out 1}`,
      `[${GLYPH_ATTR}][${BURST_ATTR}][${MOTION_ATTR}="blink"]{animation:hl-blink 1.2s ease-in-out 1}`,
      `${ROW_SELECTOR}[${HIDE_NATIVE_ATTR}] > span:first-child [data-state]{display:none !important}`,
      `html[${MOTION_PAUSED_ATTR}] [${GLYPH_ATTR}],html[${MOTION_PAUSED_ATTR}] [${TEXT_MOTION_ATTR}]{animation-play-state:paused !important}`,
      `html[${REDUCE_MOTION_ATTR}] [${GLYPH_ATTR}],html[${REDUCE_MOTION_ATTR}] [${TEXT_MOTION_ATTR}]{animation:none !important;will-change:auto !important}`,
      `@media (prefers-reduced-motion:reduce){[${GLYPH_ATTR}],[${TEXT_MOTION_ATTR}]{animation:none !important;will-change:auto !important}}`,
      '@keyframes hl-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}',
      '@keyframes hl-pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.12)}}',
      '@keyframes hl-bounce{0%,100%{transform:translateY(0)}40%{transform:translateY(-3px)}70%{transform:translateY(0)}90%{transform:translateY(-1.5px)}}',
      '@keyframes hl-blink{0%,100%{opacity:1}50%{opacity:.35}}',
      '@keyframes hl-text-pulse{0%,100%{opacity:1;transform:translateX(0)}50%{opacity:.55;transform:translateX(1px)}}',
      '@keyframes hl-text-spin{0%,100%{opacity:1;transform:translateY(0)}25%{opacity:.7;transform:translateY(-1px)}75%{opacity:.85;transform:translateY(1px)}}',
      '@keyframes hl-text-bounce{0%,100%{opacity:1;transform:translateY(0)}40%{opacity:.45;transform:translateY(-2px)}70%{opacity:1;transform:translateY(0)}90%{opacity:.9;transform:translateY(-1px)}}',
      '@keyframes hl-text-blink{0%,100%{opacity:1;transform:none}50%{opacity:.35}}',
    ].join('');
    /**
     * Takeover of another plugin's state dot: hidden, never removed. The rule
     * lives in its own element so `takeOverStatusDot:false` can drop it and
     * hand the dots back without a reload.
     */
    const TAKEOVER_STYLE = `${ROW_SELECTOR} [data-dsm-dot]{display:none !important}`;

    const TIME_TEXT = /^(刚刚|just now|now|\d+\s*(秒|分钟|小时|天|周|个月|年)(\s*前)?|\d+\s*(s|m|h|d|w|mo|y)( ago)?)$/i;

    function elementText(element) {
      const text = element?.textContent;
      return typeof text === 'string' ? text.trim() : '';
    }

    function rowSessionId(row) {
      const key = row?.getAttribute?.('data-row-key');
      if (typeof key !== 'string' || !key.startsWith(ROW_KEY_PREFIX)) return null;
      const sessionId = key.slice(ROW_KEY_PREFIX.length);
      return sessionId === '' ? null : sessionId;
    }

    /** Height of the desktop title strip, falling back to the documented default. */
    function bandHeight() {
      try {
        if (typeof getComputedStyle !== 'function') return BAND_FALLBACK;
        const raw = getComputedStyle(document.documentElement).getPropertyValue('--dsh-windows-titlebar-height').trim();
        const value = Number.parseFloat(raw);
        return Number.isFinite(value) && value > 0 ? value : BAND_FALLBACK;
      } catch {
        return BAND_FALLBACK;
      }
    }

    /** Start of the desktop menu strip, or the documented default when the shell sets nothing. */
    function menuStartValue() {
      try {
        if (typeof getComputedStyle !== 'function') return 48;
        const raw = getComputedStyle(document.documentElement).getPropertyValue('--dsh-windows-menu-start').trim();
        const value = Number.parseFloat(raw);
        return Number.isFinite(value) ? value : 48;
      } catch {
        return 48;
      }
    }

    /** Left edge when nothing can be measured: the menu's start plus two buttons plus a gap. */
    function fallbackLeft() {
      return menuStartValue() + MENU_GUESS + 8;
    }

    /** Right edge of the desktop menu strip, measured; null when it is not mounted (a web page). */
    function measuredLeft() {
      try {
        const menu = document.querySelector('[data-windows-menu]');
        if (menu === null || menu === void 0 || typeof menu.getBoundingClientRect !== 'function') return null;
        const rect = menu.getBoundingClientRect();
        if (rect === null || rect === void 0 || Number.isFinite(rect.right) === false || rect.right <= 0) return null;
        return rect.right + 8;
      } catch {
        return null;
      }
    }

    /**
     * Where the strip stops being somebody else's. The desktop menu lives in a shadow root we
     * cannot query, so instead of guessing its width we ask the page what is already painted at
     * the strip's midline: hit testing reaches into shadow trees, a selector never does. Returns
     * the right edge of everything in the way plus a gap, or null when the left stretch is free.
     */
    function occupiedLeft() {
      try {
        if (typeof document.elementsFromPoint !== 'function') return null;
        const y = Math.round(bandHeight() / 2);
        const menuStart = menuStartValue();
        let right = menuStart;
        for (let x = Math.round(menuStart); x <= OCCUPIED_PROBE_TO; x += OCCUPIED_PROBE_STEP) {
          const hits = document.elementsFromPoint(x, y);
          for (const el of hits) {
            if (el === null || el === void 0 || typeof el.getBoundingClientRect !== 'function') continue;
            if (el === document.documentElement || el === document.body) continue;
            if (typeof el.closest === 'function' && el.closest('[data-hotlist-topbar]') !== null) continue;
            const rect = el.getBoundingClientRect();
            if (rect === null || rect === void 0) continue;
            if (rect.width <= 0 || rect.height <= 0) continue;
            if (rect.left > OCCUPIED_LEFT_SLACK) continue;
            if (rect.width > OCCUPIED_MAX_WIDTH) continue;
            if (rect.right > right) right = rect.right;
            break;
          }
        }
        return right > menuStart ? right + 8 : null;
      } catch {
        return null;
      }
    }

    /**
     * Left edge of the band, recomputed on every render: hit testing is cheap, and a plugin that
     * mounts a button after we did must still be respected.
     */
    function bandLeft() {
      return occupiedLeft() ?? measuredLeft() ?? fallbackLeft();
    }

    /** Which of the three left-edge paths produced the number; the acceptance run reads it. */
    function leftSource() {
      if (occupiedLeft() !== null) return 'occupied';
      if (measuredLeft() !== null) return 'menu';
      return 'fallback';
    }

    function isForeignTitle(el, ownHost) {
      if (el === ownHost) return true;
      if (typeof el.hasAttribute === 'function' && el.hasAttribute(GLYPH_ATTR)) return true;
      if (typeof el.querySelector !== 'function') return false;
      return el.querySelector('[data-state],[data-slot],[data-context-menu-trigger],button') !== null;
    }

    /**
     * Put the host's own title text back. Only our own edit is reverted: a row the host
     * re-rendered since then already carries its own text and needs no help.
     */
    function restoreRowTitle(marker) {
      const title = marker.title;
      if (title === null || title === void 0 || marker.hostText === null) return;
      const current = typeof title.textContent === 'string' ? title.textContent : '';
      if (current === marker.hostText) return;
      const known = [marker.hostText.trim(), (marker.writtenText ?? '').trim()];
      if (known.includes(current.trim()) === false) return;
      title.textContent = marker.hostText;
    }

    /**
     * Align the host's title span with the label we draw. The host prints the title itself,
     * so when we draw the icon the leading emoji has to leave the text. Only two states are
     * ours to overwrite: exactly what the host wrote, and exactly what we wrote last. A
     * third-party rewrite wins and is left alone.
     */
    function syncRowTitle(marker, node, displayTitle, desired) {
      if (node === null || node === void 0) return;
      if ((node.children?.length ?? 0) > 0) return;
      const current = typeof node.textContent === 'string' ? node.textContent : '';
      const known = [displayTitle.trim(), desired.trim(), (marker.writtenText ?? '').trim()];
      if (current === desired) return;
      if (known.includes(current.trim()) === false) {
        /** Somebody else names this row now: step aside and say so once, never fight for the text. */
        if (marker.foreignWarned !== true) {
          marker.foreignWarned = true;
          console.debug('[hotlist] sidebar title is owned by another plugin; leaving it alone');
        }
        return;
      }
      node.textContent = desired;
      marker.writtenText = desired;
    }

    /**
     * The title span of a sidebar row (dsh-client-ui-workspace renders it as the
     * marquee container marked `_title`). Four passes from most to least
     * specific; a miss is counted by the adapter so a restyled sidebar disables
     * us instead of decorating the wrong element.
     */
    function findRowTitle(row, expectedTitle, ownHost) {
      const spans = Array.from(row?.children ?? []).filter((el) => el?.tagName === 'SPAN');
      const usable = (el) => !isForeignTitle(el, ownHost) && !String(el.className ?? '').includes('_rowResting');
      const titled = spans.find((el) => String(el.className ?? '').includes('_title') && usable(el));
      if (titled !== void 0) return titled;
      if (expectedTitle !== '') {
        const labelled = spans.find((el) => usable(el) && elementText(el) === expectedTitle);
        if (labelled !== void 0) return labelled;
      }
      const texted = spans.find((el) => usable(el) && elementText(el) !== '' && !TIME_TEXT.test(elementText(el)));
      if (texted !== void 0) return texted;
      return spans[1] !== undefined && usable(spans[1]) ? spans[1] : null;
    }

    /**
     * The one token a sidebar row shows, or null when the row must stay bare
     * (its category is off for the sidebar, or an idle row outside its
     * window). Tokens are what tab seats and sidebar markers both speak:
     * `pinned | approval | question | error | running | completed | idle`.
     */
    function sidebarStateOf(input) {
      const { session, status, error, completedAt, settings, now, pinned, children } = input;
      if (session === void 0) return null;
      const visible = (category) => settings.categories[category].enabled === true
        && settings.categories[category].surfaces.sidebar === true;
      /** The scope cut, same words as `classify`: `workspace` only rows of the current workspace. */
      const scope = SCOPE_MODES.includes(input.scope) ? input.scope : 'smart';
      const currentWorkspaceIds = Array.isArray(input.currentWorkspaceIds) ? input.currentWorkspaceIds : null;
      if (scope === 'workspace' && currentWorkspaceIds !== null && currentWorkspaceIds.includes(session.id) === false) return null;
      const crossWorkspacePin = scope === 'smart' && currentWorkspaceIds !== null && currentWorkspaceIds.includes(session.id) === false;
      /**
       * Same rule as `classify`: collect every class the row earns, then let the
       * smallest `order` win. The sidebar keeps its own two extra conditions
       * (error TTL, `completionUnread`) — that is why it is a second function —
       * but it must never disagree with the tab row about which class won.
       */
      const usable = new Set(orderedCategories(settings).filter((category) => !categoryAllOff(settings, category)));
      const qualified = [];
      if (error !== void 0 && now - error.at <= SIDEBAR_ERROR_TTL_MS && usable.has('error')) qualified.push('error');
      const kind = status?.pendingInteraction?.kind;
      if ((kind === 'approval' || kind === 'question' || kind === 'plan-review') && usable.has('pending')) qualified.push('pending');
      const finished = status?.completionUnread === true
        || (completedAt !== undefined && now - completedAt < settings.collect.completedTtlMs);
      if (finished && usable.has('completed')) qualified.push('completed');
      const running = status?.running === undefined ? session.running === true : status.running === true;
      if ((running === true || (children ?? 0) > 0) && usable.has('running')) qualified.push('running');
      if (pinned === true && crossWorkspacePin === false && usable.has('pinned')) qualified.push('pinned');
      const within = settings.collect.recentWindowMinutes;
      const updatedAt = typeof session.updatedAt === 'number' ? session.updatedAt : 0;
      if (within > 0 && now - updatedAt <= within * 60000 && usable.has('idle')) qualified.push('idle');
      const winner = bestCategory(settings, qualified);
      if (winner === null) return null;
      /** No fall-through either: the sidebar shows the winning class or nothing at all. */
      if (visible(winner) === false) return null;
      if (winner === 'pending') return kind === 'approval' ? 'approval' : 'question';
      return winner;
    }

    function createSidebarAdapter(options) {
      const documentRef = options.document;
      const readSession = options.readSession;
      /** Which scope is on and which workspace is current — read once per refresh, not per row. */
      const readScope = options.readScope ?? (() => ({ scope: 'smart', currentWorkspaceIds: null }));
      const readSettingsRef = options.readSettings;
      const makeObserver = options.createObserver
        ?? (typeof MutationObserver === 'function' ? (callback) => new MutationObserver(callback) : () => null);
      const requestFrame = options.requestFrame
        ?? (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (callback) => setTimeout(callback, 16));

      /** sessionId -> {host, img, row, title, kind, value, state} */
      const markers = new Map();
      /** sessionIds already reported for a missing title, so a broken row logs once. */
      const titleMisses = new Set();
      /** title element -> {previous} inline animation that must be restored */
      const textAnimated = new Map();
      /** dot element -> previous inline display */
      const quietedDots = new Map();
      const rowsWithNativeHidden = new Set();
      let styleElement = null;
      let takeoverStyleElement = null;
      let observer = null;
      let tickTimer = null;
      let refreshTimer = null;
      let retryTimer = null;
      let frameHandle = null;
      let misses = 0;
      let disabled = false;
      let started = false;
      let pausedBefore = false;

      function ensureStyles() {
        if (styleElement !== null) return;
        styleElement = documentRef.createElement('style');
        styleElement.setAttribute(STYLE_ATTR, 'sidebar');
        styleElement.textContent = SIDEBAR_STYLE;
        (documentRef.head ?? documentRef.documentElement)?.appendChild(styleElement);
      }

      /**
       * `takeOverStatusDot` decides whether another plugin's dot is suppressed:
       * the rule exists only while the switch is on, and the inline fallback is
       * handed back the moment it turns off.
       */
      function ensureTakeover(settings) {
        if (settings.takeOverStatusDot !== true) {
          takeoverStyleElement?.remove?.();
          takeoverStyleElement = null;
          restoreDots();
          return;
        }
        if (takeoverStyleElement !== null) return;
        takeoverStyleElement = documentRef.createElement('style');
        takeoverStyleElement.setAttribute(STYLE_ATTR, 'takeover');
        takeoverStyleElement.textContent = TAKEOVER_STYLE;
        (documentRef.head ?? documentRef.documentElement)?.appendChild(takeoverStyleElement);
      }

      function restoreTextMotion(title) {
        const record = textAnimated.get(title);
        if (record === void 0) return;
        textAnimated.delete(title);
        title.style.animation = record.previous;
        title.removeAttribute(TEXT_MOTION_ATTR);
      }

      function restoreRow(row) {
        row.removeAttribute(HIDE_NATIVE_ATTR);
      }

      function quietDot(dot) {
        if (quietedDots.has(dot)) return false;
        quietedDots.set(dot, dot.style.display);
        dot.style.setProperty('display', 'none', 'important');
        return true;
      }

      function restoreDots() {
        for (const [dot, previous] of quietedDots) dot.style.display = previous;
        quietedDots.clear();
      }

      function dropMarker(sessionId) {
        const marker = markers.get(sessionId);
        if (marker === void 0) return;
        markers.delete(sessionId);
        restoreTextMotion(marker.title);
        restoreRowTitle(marker);
        restoreRow(marker.row);
        marker.host.remove?.();
      }

      function createMarker(row, title) {
        const host = documentRef.createElement('span');
        host.setAttribute(GLYPH_ATTR, '');
        host.setAttribute(MOTION_ATTR, 'none');
        /** Without a title anchor the glyph still shows at the end of the row; text motion stays off. */
        if (title === null) row.appendChild(host);
        else row.insertBefore(host, title);
        return { host, img: null, row, title, hostText: title === null ? null : elementText(title), writtenText: null, foreignWarned: false };
      }

      function setGlyph(marker, glyph, state) {
        if (glyph.kind === 'none') {
          if (marker.img !== null) {
            marker.host.removeChild?.(marker.img);
            marker.img = null;
          }
          marker.host.setAttribute(KIND_ATTR, 'none');
          marker.host.setAttribute(CHAR_ATTR, '');
          marker.host.style.display = 'none';
          marker.host.setAttribute(STATE_ATTR, state);
          return;
        }
        marker.host.style.display = '';
        if (glyph.kind === 'img') {
          marker.host.setAttribute(KIND_ATTR, 'img');
          marker.host.setAttribute(CHAR_ATTR, '');
          if (marker.img === null) {
            marker.img = documentRef.createElement('img');
            marker.img.setAttribute('alt', '');
            marker.img.addEventListener?.('error', () => {
              marker.host.removeChild?.(marker.img);
              marker.img = null;
              setGlyph(marker, { kind: 'emoji', value: CATEGORY_GLYPHS[CATEGORY_OF_TOKEN[state] ?? 'running'] }, state);
            });
            marker.host.appendChild(marker.img);
          }
          marker.img.setAttribute('src', glyph.value);
        } else {
          if (marker.img !== null) {
            marker.host.removeChild?.(marker.img);
            marker.img = null;
          }
          marker.host.setAttribute(KIND_ATTR, 'emoji');
          marker.host.setAttribute(CHAR_ATTR, glyph.value);
        }
        marker.host.setAttribute(STATE_ATTR, state);
      }

      function applyRootMotionFlags(settings) {
        const root = documentRef.documentElement;
        if (root === null || root === undefined) return;
        if (settings.display.reduceMotion === 'on') root.setAttribute(REDUCE_MOTION_ATTR, '');
        else root.removeAttribute(REDUCE_MOTION_ATTR);
      }

      /** sessionId -> {timer}: the one burst this span is playing; clears itself on a timer. */
      const burstMotion = new Map();
      /** Rows of the last repaint: the cadence timer bursts from these, not from a DOM read. */
      let lastRows = [];

      function quietTakeoverDots(row) {
        const dots = typeof row.querySelectorAll === 'function' ? row.querySelectorAll('[data-dsm-dot]') : [];
        for (const dot of dots) quietDot(dot);
      }

      function animateTitle(marker, motion, once) {
        const title = marker.title;
        if (title === null || typeof title.style !== 'object') return;
        const record = textAnimated.get(title);
        if (record === undefined) textAnimated.set(title, { previous: title.style.animation ?? '' });
        title.setAttribute(TEXT_MOTION_ATTR, '');
        title.style.animation = (once === true ? TEXT_BURST : TEXT_MOTION)[motion] ?? 'none';
      }

      function stopBurst(sessionId) {
        const burst = burstMotion.get(sessionId);
        if (burst === void 0) return;
        clearTimeout(burst.timer);
        burstMotion.delete(sessionId);
        const marker = markers.get(sessionId);
        if (marker === void 0) return;
        marker.host.removeAttribute(BURST_ATTR);
        marker.host.setAttribute(MOTION_ATTR, 'none');
        restoreTextMotion(marker.title);
      }

      function startBurst(item, motion, settings) {
        const marker = markers.get(item.sessionId);
        const duration = MOTION_MS[motion] ?? 0;
        if (marker === void 0 || duration === 0) return;
        const timer = setTimeout(() => stopBurst(item.sessionId), duration);
        burstMotion.set(item.sessionId, { timer });
        marker.host.setAttribute(MOTION_ATTR, motion);
        marker.host.setAttribute(BURST_ATTR, '');
        if (tokenMotion(settings, item.state).motionTarget === 'row') animateTitle(marker, motion, true);
      }

      /** One roll per category per tick; at most `MOTION_CONCURRENCY` spans move at any time. */
      function motionBursts(rows) {
        const settings = readSettingsRef();
        if (settings.display.reduceMotion === 'on') {
          for (const sessionId of [...burstMotion.keys()]) stopBurst(sessionId);
          return;
        }
        const byCategory = new Map();
        for (const item of rows) {
          const category = CATEGORY_OF_TOKEN[item.state];
          if (category === void 0) continue;
          const list = byCategory.get(category);
          if (list === void 0) byCategory.set(category, [item]);
          else list.push(item);
        }
        for (const [category, items] of byCategory) {
          const frequency = settings.categories[category].glyph.frequency;
          if (!(frequency > 0)) continue;
          const roll = Math.random();
          if (roll >= frequency) continue;
          if (burstMotion.size >= MOTION_CONCURRENCY) continue;
          const ready = items.filter((item) => !burstMotion.has(item.sessionId)
            && tokenMotion(settings, item.state).motion !== 'none');
          if (ready.length === 0) continue;
          /** The same roll picks the span: one random call per category per tick. */
          const item = ready[Math.min(ready.length - 1, Math.floor((roll / frequency) * ready.length))];
          startBurst(item, tokenMotion(settings, item.state).motion, settings);
        }
      }

      /** Static pass: anything not currently bursting has no animations at all. */
      function applyMotion(settings, rows) {
        for (const item of rows) {
          if (burstMotion.has(item.sessionId)) continue;
          const marker = markers.get(item.sessionId);
          if (marker === void 0) continue;
          if (marker.host.getAttribute?.(MOTION_ATTR) !== 'none') marker.host.setAttribute(MOTION_ATTR, 'none');
          restoreTextMotion(marker.title);
        }
      }

      function refresh() {
        if (disabled || !started) return;
        const settings = readSettingsRef();
        applyRootMotionFlags(settings);
        ensureTakeover(settings);
        const scopeInfo = readScope();
        const rows = Array.from(documentRef.querySelectorAll(ROW_SELECTOR));
        const rowsNow = [];
        for (const row of rows) {
          const sessionId = rowSessionId(row);
          if (sessionId === null) continue;
          const data = readSession(sessionId);
          const state = sidebarStateOf({
            session: data.session,
            status: data.status,
            error: data.error,
            completedAt: data.completedAt,
            pinned: data.pinned,
            children: data.children,
            scope: scopeInfo.scope,
            currentWorkspaceIds: scopeInfo.currentWorkspaceIds,
            settings,
            now: Date.now(),
          });
          const existing = markers.get(sessionId);
          if (state === null || String(row.className ?? '').includes('_archived')) {
            if (existing !== undefined) dropMarker(sessionId);
            continue;
          }
          const category = CATEGORY_OF_TOKEN[state] ?? 'running';


          /**
           * One emoji, never two: the host prints the title itself, so either we step aside for the
           * emoji it already starts with, or we draw our glyph and strip that emoji from its text.
           * Identity, not time: a reload must show the same uploaded glyph (see ARCHITECTURE §17).
           */
          const titleNow = findRowTitle(row, data.session?.displayTitle ?? '', existing?.host);
          const displayTitle = data.session?.displayTitle ?? '';
          const titleEmoji = ownEmoji(displayTitle);
          const fromTitle = titleEmoji !== '' && customIconWins(settings, category);
          /**
           * The slot never goes empty on a yield: when the title's own emoji wins
           * it is drawn *in the slot* instead of the class glyph. Hiding the glyph
           * and leaving the emoji inside the title threw the state signal away —
           * an idle row and an error row both looked like `🎓 title` with nothing
           * before it, so the user could not tell them apart. Who is drawn
           * changes; how it moves does not: the same `resolveStateGlyph` and the
           * same burst lottery run on either value.
           */
          const drawsGlyph = settings.topbar.titleMode !== 'text';
          const drawn = drawsGlyph === false
            ? { kind: 'none', value: '' }
            : fromTitle === true
              ? { kind: 'emoji', value: titleEmoji }
              : resolveStateGlyph(settings, state, `${sessionId}|${category}`);
          const glyph = drawn;
          const title = titleNow;
          const hostEmojiGoes = settings.topbar.titleMode === 'text' || (drawsGlyph === true && drawn.kind !== 'none');
          const desiredTitle = hostEmojiGoes === true ? stripLeadingEmoji(displayTitle) : displayTitle;
          if (title === null) {
            /** A restyled row costs a counted miss, but the glyph itself stays reachable. */
            misses += 1;
            if (!titleMisses.has(sessionId)) {
              titleMisses.add(sessionId);
              console.debug('[hotlist] sidebar title not found; glyph without title motion', sessionId);
            }
          }
          let marker = existing;
          if (marker === undefined) {
            marker = createMarker(row, title);
            markers.set(sessionId, marker);
          } else if (title !== null && marker.title !== title) {
            /** The host re-rendered its title span: move the text motion to the new node. */
            restoreTextMotion(marker.title);
            marker.title = title;
            marker.hostText = elementText(title);
            marker.writtenText = null;
            marker.foreignWarned = false;
          }
          syncRowTitle(marker, title, displayTitle, desiredTitle);
          setGlyph(marker, glyph, state);
          if (settings.hideNativeDot === true) row.setAttribute(HIDE_NATIVE_ATTR, '');
          else row.removeAttribute(HIDE_NATIVE_ATTR);
          rowsWithNativeHidden.add(row);
          if (settings.takeOverStatusDot === true) quietTakeoverDots(row);
          rowsNow.push({ row, sessionId, state });
        }
        for (const [sessionId, marker] of markers) {
          if (!rowsNow.some((item) => item.row === marker.row)) dropMarker(sessionId);
        }
        applyMotion(settings, rowsNow);
        lastRows = rowsNow;
        if (rows.length > 0 && rowsNow.length === 0) misses += 5;
        if (misses >= MAX_MISSES) disable();
      }

      function schedule() {
        if (disabled || frameHandle !== null) return;
        frameHandle = requestFrame(() => {
          frameHandle = null;
          refresh();
        });
      }

      function onMutations(mutations) {
        if (disabled) return;
        for (const mutation of mutations) {
          const target = mutation.target;
          if (typeof target?.hasAttribute !== 'function') {
            schedule();
            return;
          }
          if (target.hasAttribute(GLYPH_ATTR) || target.hasAttribute(TEXT_MOTION_ATTR)) continue;
          schedule();
          return;
        }
      }

      function teardown() {
        if (frameHandle !== null) {
          if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameHandle);
          else clearTimeout(frameHandle);
          frameHandle = null;
        }
        if (tickTimer !== null) {
          clearInterval(tickTimer);
          tickTimer = null;
        }
        if (refreshTimer !== null) {
          clearInterval(refreshTimer);
          refreshTimer = null;
        }
        if (observer !== null) {
          observer.disconnect?.();
          observer = null;
        }
        for (const sessionId of [...burstMotion.keys()]) stopBurst(sessionId);
        lastRows = [];
        for (const sessionId of [...markers.keys()]) dropMarker(sessionId);
        restoreDots();
        for (const title of [...textAnimated.keys()]) restoreTextMotion(title);
        for (const row of rowsWithNativeHidden) restoreRow(row);
        rowsWithNativeHidden.clear();
        styleElement?.remove?.();
        styleElement = null;
        takeoverStyleElement?.remove?.();
        takeoverStyleElement = null;
        const root = documentRef.documentElement;
        root?.removeAttribute?.(MOTION_PAUSED_ATTR);
        root?.removeAttribute?.(REDUCE_MOTION_ATTR);
      }

      function disable() {
        if (disabled) return;
        disabled = true;
        teardown();
        retryTimer = setTimeout(() => {
          retryTimer = null;
          disabled = false;
          misses = 0;
          if (started) begin();
        }, MISS_RETRY_MS);
      }

      function begin() {
        ensureStyles();
        const tree = documentRef.querySelector('[role="tree"]') ?? documentRef.body ?? documentRef.documentElement;
        if (tree !== null && tree !== undefined) {
          observer = makeObserver(onMutations);
          observer?.observe?.(tree, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-row-key', 'class', 'data-state', 'style'] });
        }
        tickTimer = setInterval(tick, SIDEBAR_TICK_MS);
        refreshTimer = setInterval(schedule, SIDEBAR_REFRESH_MS);
        refresh();
      }

      /**
       * One shared pause switch: hidden document, and the explicit
       * `reduceMotion: 'on'` flag both land on root attributes the CSS reacts
       * to — no per-frame JS, and `prefers-reduced-motion` is handled by media
       * query in the stylesheet.
       */
      function tick() {
        const root = documentRef.documentElement;
        const paused = documentRef.hidden === true;
        if (root !== null && root !== undefined && paused) root.setAttribute(MOTION_PAUSED_ATTR, '');
        else root?.removeAttribute?.(MOTION_PAUSED_ATTR);
        if (paused === false) motionBursts(lastRows);
        /** Only the visibility flip needs a repaint; the cadence timer covers the rest. */
        if (paused !== pausedBefore) {
          pausedBefore = paused;
          schedule();
        }
      }

      function start() {
        if (started) return;
        started = true;
        disabled = false;
        misses = 0;
        begin();
      }

      function stop() {
        started = false;
        disabled = false;
        if (retryTimer !== null) {
          clearTimeout(retryTimer);
          retryTimer = null;
        }
        teardown();
      }

      return { start, stop, refresh, schedule, tick, misses: () => misses };
    }

// -------------------------------------------------------------------------
    // Settings page: one collapsible card per category, ordered by
    // `categories[*].order`, plus a global block. Every control writes through
    // `writeSettings`, which broadcasts to the tab row and the sidebar in the same
    // frame; nothing here re-reads localStorage. Card expansion is UI state and
    // never enters the settings record (one remembered card, sessionStorage only).
    // -------------------------------------------------------------------------
    const PAGE_STYLE_ATTR = 'page';
    const PAGE_OPEN_KEY = 'dsh.hotlist.open';
    /**
     * Finished-session timestamps survive a reload; TTL and workspace are pruned on read.
     * Written as a regex and stored through .source: the pre-restart gate blanks
     * string literals before it looks for the key, and a RegExp coerced to a string
     * would carry the slashes into localStorage.
     */
    const COMPLETED_AT_KEY = /dsh.hotlist.completedAt.v1/;
    /** Coalesces a burst of finishes into one write. */
    const COMPLETED_FLUSH_MS = 500;
    /** Preview loops: the motion fills `frequency` of the cycle, so the slider reads as density. */
    const PREVIEW_STEPS = 20;
    const PREVIEW_FRAMES = {
      spin: [[0, 'rotate(0deg)'], [1, 'rotate(360deg)']],
      pulse: [[0, 'scale(1)'], [0.5, 'scale(1.12)'], [1, 'scale(1)']],
      bounce: [[0, 'translateY(0)'], [0.4, 'translateY(-3px)'], [0.7, 'translateY(0)'], [0.9, 'translateY(-1.5px)'], [1, 'translateY(0)']],
      blink: [[0, 'opacity:1'], [0.5, 'opacity:.35'], [1, 'opacity:1']],
    };

    /** One `@keyframes` per motion and duty step: the hold after the motion is the visible gap. */
    function previewKeyframes() {
      const rules = [];
      for (const motion of MOTION_NAMES) {
        const frames = PREVIEW_FRAMES[motion];
        if (frames === undefined) continue;
        for (let step = 1; step <= PREVIEW_STEPS; step += 1) {
          const duty = step / PREVIEW_STEPS;
          const stops = frames.map(([at, declaration]) => `${(at * duty * 100).toFixed(2)}%{${declaration}}`);
          rules.push(`@keyframes hl-pv-${motion}-${step}{${stops.join('')}}`);
        }
      }
      return rules.join('');
    }

    const PREVIEW_KEYFRAMES = previewKeyframes();

    /** The cycle the sidebar runs: motion for `frequency` of the period, still for the rest. */
    function previewStyle(motion, frequency) {
      const step = clamp(Math.round(frequency * PREVIEW_STEPS), 1, PREVIEW_STEPS);
      const duration = Math.round((MOTION_MS[motion] ?? 1200) * PREVIEW_STEPS / step);
      return `hl-pv-${motion}-${step} ${duration}ms linear infinite`;
    }
    /** Upload gate: static raster only; 16KB is enforced after canvas compression. */
    const GLYPH_FILE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
    const GLYPH_SOURCE_MAX_BYTES = 4 * 1024 * 1024;
    const GLYPH_IMAGE_SIZE = 40;
    const SOUND_SOURCES = ['builtin', 'upload'];
    /** Uploaded sounds are read straight into a data URL: no transcoding happens in the page. */
    const SOUND_FILE_TYPES = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg', 'audio/aac', 'audio/mp4', 'audio/webm'];
    const PAGE_CSS = [
      '.hl-page{display:flex;flex-direction:column;gap:16px;padding:4px 0 24px}',
      '.hl-head{display:flex;flex-direction:column;gap:4px}',
      '.hl-title{margin:0;font-size:20px;line-height:28px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.hl-sub{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}',
      '.hl-notice{margin:0;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.hl-global{display:flex;flex-direction:column;gap:2px;padding:4px 0 8px;border-bottom:.5px solid var(--dsw-alias-border-l2)}',
      '.hl-groupTitle{margin:0 0 4px;font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.hl-row{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:3px 0;border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.hl-rowMain{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.hl-rowTitle{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}',
      '.hl-rowHint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.hl-rowHint[data-warn]{color:var(--dsw-alias-label-tertiary)}',
      '.hl-row[data-disabled=true] .hl-rowTitle{color:var(--dsw-alias-label-tertiary)}',
      '.hl-cards{display:flex;flex-direction:column;gap:6px}',
      '.hl-card{margin:0;border:1px solid var(--dsw-alias-border-l4);border-radius:12px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}',
      '.hl-cardHead{display:flex;align-items:center;gap:6px;width:100%;padding:6px 10px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}',
      '.hl-cardHead:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));outline-offset:-2px}',
      '.hl-cardGlyph{display:inline-flex;align-items:center;justify-content:center;flex:0 0 22px;width:22px;height:22px;line-height:1}',
      '.hl-cardGlyph::before{content:attr(data-hotlist-char);display:block;line-height:1}',
      '.hl-cardGlyph[data-hotlist-glyph-kind=img]::before{content:none}',
      '.hl-cardGlyph img{display:block;object-fit:contain;border-radius:3px}',
      '.hl-cardName{flex:1 1 auto;min-width:0;font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.hl-cardTag{margin-left:5px;font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary)}',
      '.hl-chips{display:flex;align-items:center;gap:3px;flex:none}',
      '.hl-chip{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:18px;padding:0 4px;border-radius:4px;border:.5px solid var(--dsw-alias-border-l2);background:transparent;font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary)}',
      '.hl-chip[data-on=true]{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:#fff}',
      '.hl-chip[data-disabled=true]{opacity:.5}',
      '.hl-rowWrap{flex-wrap:wrap}',
      '.hl-scopeToggles{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px;width:100%;padding:2px 0 3px}',
      '.hl-scope{display:inline-flex;align-items:center;gap:4px;max-width:96px;height:24px;padding:0 7px;border-radius:6px;border:1px solid var(--dsw-alias-border-l4);background:transparent;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.hl-scope[data-on=true]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}',
      '.hl-scope input{margin:0;flex:none}',
      '.hl-scopeGlyph{flex:none;line-height:1}',
      '.hl-scopeName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.hl-caret{flex:0 0 18px;width:18px;height:18px;line-height:18px;text-align:center;color:var(--dsw-alias-label-tertiary);transition:transform .12s linear}',
      '.hl-card[data-open=true] .hl-caret{transform:rotate(90deg)}',
      '.hl-cardBody{display:flex;flex-direction:column;gap:0;padding:0 10px 5px;border-top:.5px dashed var(--dsw-alias-border-l2)}',
      '.hl-cardGroup{display:flex;flex-direction:column;gap:0}',
      '.hl-cardGroup[data-disabled=true]{opacity:.5}',
      '.hl-cardGroupTitle{margin:3px 0 0;font-size:11px;line-height:14px;color:var(--dsw-alias-label-tertiary)}',
      '.hl-rowMulti{display:grid;grid-template-columns:repeat(var(--hl-cols,2),minmax(0,1fr));gap:0 12px;padding:1px 0;border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.hl-cell{display:flex;align-items:center;justify-content:space-between;gap:6px;min-height:26px;min-width:0}',
      '.hl-cellLabel{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
      '.hl-cellControl{flex:0 0 auto;display:flex;align-items:center;gap:6px}',
      '.hl-cellHint{grid-column:1/-1;font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary)}',
      '.hl-field{display:grid;grid-template-columns:62px minmax(0,1fr);align-items:center;gap:1px 10px;padding:1px 0;border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.hl-field:first-of-type{border-top:0}',
      '.hl-fieldLabel{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
      '.hl-fieldControl{display:flex;align-items:center;justify-content:flex-end;gap:6px;flex-wrap:wrap;min-width:0}',
      '.hl-fieldHint{grid-column:2;font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary)}',
      '.hl-input{height:28px;padding:0 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}',
      '.hl-input:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));outline-offset:1px}',
      '.hl-input[disabled]{opacity:.5;cursor:not-allowed}',
      '.hl-num{width:64px}',
      '.hl-range{flex:1 1 auto;min-width:88px;height:26px;accent-color:var(--dsw-alias-state-business-primary)}',
      '.hl-emoji{width:64px;text-align:center;font-size:15px}',
      '.hl-select{height:28px;min-width:88px;padding:0 6px;border-radius:7px;border:1px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}',
      '.hl-select[disabled]{opacity:.5;cursor:not-allowed}',
      '.hl-segmented{display:inline-flex;gap:4px}',
      '.hl-seg{height:26px;min-width:30px;padding:0 7px;border-radius:8px;border:1px solid var(--dsw-alias-border-l4);background:transparent;color:inherit;font-size:12px;cursor:pointer}',
      '.hl-seg[aria-pressed=true]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.hl-seg[disabled]{opacity:.45;cursor:not-allowed}',
      '.hl-step{min-width:28px;height:26px;padding:0 7px;border-radius:8px;border:1px solid var(--dsw-alias-border-l4);background:transparent;color:inherit;font-size:13px;cursor:pointer}',
      '.hl-step[disabled]{opacity:.45;cursor:not-allowed}',
      '.hl-stepper{display:flex;align-items:center;gap:6px}',
      '.hl-link{border:0;background:transparent;color:var(--dsw-alias-brand-primary);font-size:12px;line-height:18px;padding:0;cursor:pointer}',
      '.hl-link[disabled]{color:var(--dsw-alias-label-tertiary);cursor:not-allowed}',
      '.hl-preview{display:inline-flex;align-items:center;justify-content:center;flex:0 0 30px;width:30px;height:30px;border-radius:8px;background:var(--dsw-alias-bg-layer-3)}',
      '.hl-preview::before{content:attr(data-hotlist-char);display:block;line-height:1}',
      '.hl-preview[data-hotlist-glyph-kind=img]::before{content:none}',
      '.hl-preview img{display:block;object-fit:contain;border-radius:3px}',
      '.hl-switch{position:relative;display:inline-flex;align-items:center;width:36px;height:20px;flex:none;cursor:pointer}',
      '.hl-switch input{position:absolute;inset:0;margin:0;opacity:0;cursor:inherit}',
      '.hl-switchTrack{position:relative;display:block;width:36px;height:20px;border-radius:10px;background:var(--dsw-alias-border-l4)}',
      '.hl-switchTrack::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:8px;background:var(--dsw-alias-label-primary);transition:transform .12s linear}',
      '.hl-switch input:checked + .hl-switchTrack{background:var(--dsw-alias-brand-primary)}',
      '.hl-switch input:checked + .hl-switchTrack::after{transform:translateX(16px);background:#fff}',
      '.hl-switch[data-disabled=true]{opacity:.45;cursor:not-allowed}',
      '.hl-warn{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}',
      '.hl-foot{display:flex;align-items:center;gap:12px}',
      '.hl-hidden{display:none}',
      '.hl-page[data-hotlist-glyph]::before{content:none}',
      PREVIEW_KEYFRAMES,
      '@media (prefers-reduced-motion:reduce){.hl-page .hl-preview,.hl-page .hl-cardGlyph{animation:none!important}}',
    ].join('');

    /** The settings page preview: bound by `apply` to the live player, a no-op before that. */
    let soundPreview = () => false;

/** Cards remember every open card; older builds stored a single id. */
    function readOpenCards() {
      try {
        if (typeof sessionStorage === 'undefined') return [];
        const stored = sessionStorage.getItem(PAGE_OPEN_KEY);
        if (stored === null) return [];
        /** Builds before 4.1 wrote the bare category id, which is not JSON. */
        let parsed;
        try {
          parsed = JSON.parse(stored);
        } catch {
          parsed = stored;
        }
        const list = Array.isArray(parsed) ? parsed : [parsed];
        return list.filter((category) => CATEGORY_IDS.includes(category));
      } catch {
        return [];
      }
    }

    function writeOpenCards(categories) {
      try {
        if (typeof sessionStorage === 'undefined') return;
        if (categories.length === 0) sessionStorage.removeItem(PAGE_OPEN_KEY);
        else sessionStorage.setItem(PAGE_OPEN_KEY, JSON.stringify(categories));
      } catch {
        /* UI-only state: a locked-down sessionStorage just means "always collapsed". */
      }
    }

    /** One shared stylesheet, injected once; the settings dialog may open more than once. */
    function injectPageCss() {
      if (typeof document === 'undefined') return;
      if (document.querySelector(`[${STYLE_ATTR}="${PAGE_STYLE_ATTR}"]`) !== null) return;
      const style = document.createElement('style');
      style.setAttribute(STYLE_ATTR, PAGE_STYLE_ATTR);
      style.textContent = PAGE_CSS;
      (document.head ?? document.documentElement).appendChild(style);
    }

    /**
     * Source image -> a 40px WebP data URL, or a rejection reason: `unavailable`
     * (no FileReader/Image), `read`, `decode`, `canvas`, `webp-unavailable`,
     * `too-large` (the encoded result exceeds `GLYPH_MAX_BYTES`).
     */
    function toGlyphDataUrl(file, max) {
      return new Promise((resolve, reject) => {
        if (typeof FileReader !== 'function' || typeof Image !== 'function' || typeof document === 'undefined') {
          reject(new Error('unavailable'));
          return;
        }
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('read'));
        reader.onload = () => {
          const image = new Image();
          image.onerror = () => reject(new Error('decode'));
          image.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = max;
            canvas.height = max;
            const context = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
            if (context === null) {
              reject(new Error('canvas'));
              return;
            }
            const width = image.width ?? max;
            const height = image.height ?? max;
            const side = Math.min(width, height);
            context.drawImage(image, (width - side) / 2, (height - side) / 2, side, side, 0, 0, max, max);
            const url = canvas.toDataURL('image/webp', 0.8);
            if (typeof url !== 'string' || url.startsWith('data:image/webp') === false) {
              reject(new Error('webp-unavailable'));
              return;
            }
            if (decodedBytes(url) > GLYPH_MAX_BYTES) {
              reject(new Error('too-large'));
              return;
            }
            resolve(url);
          };
          image.src = String(reader.result ?? '');
        };
        reader.readAsDataURL(file);
      });
    }

    /** The source gate: `missing` | `type` | `size` | null. */
    function glyphUploadReject(file) {
      if (file === null || file === undefined) return 'missing';
      if (GLYPH_FILE_TYPES.includes(String(file.type ?? '')) === false) return 'type';
      if (Number.isFinite(file.size) === false || file.size > GLYPH_SOURCE_MAX_BYTES) return 'size';
      return null;
    }

    /** The source gate of an uploaded sound: `missing` | `type` | `size` | null. */
    function soundUploadReject(file) {
      if (file === null || file === undefined) return 'missing';
      if (SOUND_FILE_TYPES.includes(String(file.type ?? '')) === false) return 'type';
      if (Number.isFinite(file.size) === false || file.size > SOUND_MAX_BYTES) return 'size';
      return null;
    }

    /** Any file -> its data URL; the audio path never touches a canvas. */
    function toDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          if (typeof reader.result === 'string') resolve(reader.result);
          else reject(new Error('failed'));
        };
        reader.onerror = () => reject(new Error('failed'));
        reader.readAsDataURL(file);
      });
    }

    function toggleNode(checked, onToggle, disabled) {
      return h('label', {
        className: 'hl-switch',
        'data-disabled': disabled === true ? 'true' : 'false',
      }, [
        h('input', {
          key: 'input',
          type: 'checkbox',
          checked: checked === true,
          disabled: disabled === true,
          onChange: () => {
            if (disabled !== true) onToggle();
          },
        }),
        h('span', { key: 'track', className: 'hl-switchTrack' }),
      ]);
    }

    function switchRow(key, titleText, hintText, checked, onToggle, disabled) {
      return h('div', {
        key,
        className: 'hl-row',
        'data-hotlist-row': key,
        'data-disabled': disabled === true ? 'true' : 'false',
      }, [
        h('div', { key: 'main', className: 'hl-rowMain' }, [
          h('span', { key: 'title', className: 'hl-rowTitle' }, titleText),
          hintText === undefined ? null : h('span', { key: 'hint', className: 'hl-rowHint' }, hintText),
        ]),
        h('div', { key: 'control', className: 'hl-fieldControl' }, toggleNode(checked, onToggle, disabled)),
      ]);
    }

    /**
     * The settings page: one collapsible card per category plus a global block.
     * Cards are ordered by `categories[*].order`; every write goes through
     * `writeSettings`, so the tab row and the sidebar react on the next tick.
     */
    function HotlistSettingsPage(props) {
      const close = props.close;
      const t = props.t;
      const [settings, setSettings] = React.useState(() => snapshot());
      const [openCards, setOpenCards] = React.useState(() => readOpenCards());
      const [uploadError, setUploadError] = React.useState(null);


      React.useEffect(() => onSettingsChange(setSettings), []);
      React.useEffect(() => {
        injectPageCss();
      }, []);

      const patch = (next) => setSettings(writeSettings(next));
      /** A patch carries only what the control changed; `mergePatch` keeps everything else. */
      const patchCategory = (category, change) => patch({ categories: { [category]: change } });
      const patchGlyph = (category, secondary, change) => {
        const key = secondary === true ? 'glyphSecondary' : 'glyph';
        patchCategory(category, { [key]: change });
      };
      const patchPopout = (category, change) => patchCategory(category, { popout: change });
      const patchSound = (category, change) => patchCategory(category, { sound: change });
      const toggleCard = (category) => {
        const next = openCards.includes(category)
          ? openCards.filter((item) => item !== category)
          : [...openCards, category];
        setOpenCards(next);
        writeOpenCards(next);
      };

      const glyphText = (category, secondary, glyph) => {
        if (glyph.kind === 'none') return '';
        if (glyph.kind === 'img' && glyph.value !== '') return '';
        if (glyph.kind === 'emoji' && glyph.value !== '') return glyph.value;
        return secondary === true ? '❓' : CATEGORY_GLYPHS[category];
      };
      const glyphNode = (category, secondary, glyph, size) => {
        /** The preview shows the first uploaded picture; drawing on a row picks by seed. */
        const preview = glyph.source === 'upload' && glyph.uploads.length > 0
          ? glyph.uploads[0].dataUrl
          : glyph.source === 'popout' ? pickPopoutArt(settings, category).value : '';
        const hasImage = preview !== '';
        const animate = glyph.motion !== 'none' && glyph.frequency > 0 && settings.display.reduceMotion !== 'on';
        const style = { fontSize: `${size}px`, lineHeight: `${size + 2}px` };
        if (animate) style.animation = previewStyle(glyph.motion, glyph.frequency);
        return h('span', {
          key: `glyph-${category}-${secondary === true ? 'secondary' : 'primary'}`,
          className: size >= 20 ? 'hl-preview' : 'hl-cardGlyph',
          'data-hotlist-glyph': '',
          'data-hotlist-glyph-kind': hasImage ? 'img' : glyph.kind === 'none' ? 'none' : 'emoji',
          'data-hotlist-char': hasImage ? '' : glyphText(category, secondary, glyph),
          'aria-hidden': 'true',
          style,
        }, hasImage ? h('img', { src: preview, alt: '', width: size, height: size }) : null);
      };
      const emojiInput = (value, onChange, disabled) => h('input', {
        className: 'hl-input hl-emoji',
        type: 'text',
        value,
        placeholder: t('settings.glyphPlaceholder'),
        disabled: disabled === true,
        onChange: (event) => onChange([...event.target.value].slice(0, GLYPH_TEXT_LIMIT).join('')),
      });
      const segmented = (values, current, onPick, format, disabled) => h('div', { className: 'hl-segmented' }, values.map((value) => h('button', {
        key: String(value),
        type: 'button',
        className: 'hl-seg',
        'aria-pressed': current === value ? 'true' : 'false',
        disabled: disabled === true,
        onClick: () => {
          if (disabled !== true) onPick(value);
        },
      }, format === undefined ? String(value) : format(value))));
      const select = (values, current, onPick, format, disabled) => h('select', {
        className: 'hl-select',
        value: current,
        disabled: disabled === true,
        onChange: (event) => onPick(event.target.value),
      }, values.map((value) => h('option', { key: value, value }, format === undefined ? value : format(value))));
      const numberInput = (value, min, max, step, onChange, disabled) => h('input', {
        className: 'hl-input hl-num',
        type: 'number',
        value,
        min,
        max,
        step,
        disabled: disabled === true,
        onChange: (event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onChange(next);
        },
      });
      /**
       * Every "how many" field uses this one widget: `[−] [value] [+]`, plus an
       * optional trailing button. Only `maxSeats` has one, its `自动` toggle.
       */
      const numberStepper = (value, min, max, onChange, extra, disabled) => h('div', {
        className: 'hl-stepper',
        'data-hotlist-stepper': '',
      }, [
        h('button', {
          key: 'minus',
          type: 'button',
          className: 'hl-step',
          'data-hotlist-step': 'minus',
          disabled: disabled === true || value <= min,
          onClick: () => onChange(Math.max(min, value - 1)),
        }, '−'),
        numberInput(value, min, max, 1, onChange, disabled),
        h('button', {
          key: 'plus',
          type: 'button',
          className: 'hl-step',
          'data-hotlist-step': 'plus',
          disabled: disabled === true || value >= max,
          onClick: () => onChange(Math.min(max, value + 1)),
        }, '＋'),
        extra ?? null,
      ]);
      /** Playback frequency slider: one step is 5%, so the preview loop always matches the value. */
      const rangeInput = (value, onChange, disabled) => h('input', {
        className: 'hl-range',
        type: 'range',
        min: MOTION_FREQUENCY.min,
        max: MOTION_FREQUENCY.max,
        step: MOTION_FREQUENCY.step,
        value,
        disabled: disabled === true,
        onChange: (event) => onChange(Number(event.target.value)),
      });
      const field = (labelText, control, hintText, attrs) => h('div', Object.assign({
        className: 'hl-field',
      }, attrs ?? {}), [
        h('span', { key: 'label', className: 'hl-fieldLabel' }, labelText),
        h('div', { key: 'control', className: 'hl-fieldControl' }, control),
        hintText === undefined ? null : h('span', { key: 'hint', className: 'hl-fieldHint' }, hintText),
      ]);
      const cell = (labelText, control, hintText) => h('div', { className: 'hl-cell' }, [
        h('span', { key: 'label', className: 'hl-cellLabel' }, labelText),
        h('div', { key: 'control', className: 'hl-cellControl' }, control),
        hintText === undefined ? null : h('span', { key: 'hint', className: 'hl-cellHint' }, hintText),
      ]);
      const multi = (cells, columns) => h('div', {
        className: 'hl-rowMulti',
        style: { '--hl-cols': String(columns) },
      }, cells);
      const group = (titleText, children, disabled) => h('div', {
        className: 'hl-cardGroup',
        'data-disabled': disabled === true ? 'true' : 'false',
      }, [h('span', { key: 'title', className: 'hl-cardGroupTitle' }, titleText), ...children]);

      /**
       * One upload goes into a pool: the file becomes a data URL, the same
       * sanitiser storage uses decides whether it fits, and an over-quota upload is
       * refused with a visible reason instead of replacing what is already there.
       */
      const pushAsset = (category, kind, file) => {
        const reason = kind === 'sound' ? soundUploadReject(file) : glyphUploadReject(file);
        if (reason !== null) {
          setUploadError(t(`settings.upload.${reason}`));
          return;
        }
        setUploadError(null);
        const read = kind === 'sound' ? toDataUrl(file) : toGlyphDataUrl(file, GLYPH_IMAGE_SIZE);
        read.then(
          (url) => {
            const asset = { name: String(file.name ?? ''), dataUrl: url };
            if (kind === 'sound') patchSound(category, { uploads: [...settings.categories[category].sound.uploads, asset] });
            else if (kind === 'popout') patchPopout(category, { images: [...settings.categories[category].popout.images, asset] });
            else patchGlyph(category, false, { uploads: [...settings.categories[category].glyph.uploads, asset] });
          },
          (error) => {
            const message = String(error?.message ?? '');
            const key = message === 'too-large' ? 'tooLarge' : message === 'webp-unavailable' ? 'noWebp' : 'failed';
            setUploadError(t(`settings.upload.${key}`));
          },
        );
      };

      const dropAssets = (category, kind) => {
        if (kind === 'sound') patchSound(category, { uploads: [] });
        else if (kind === 'popout') patchPopout(category, { images: [] });
        else patchGlyph(category, false, { uploads: [] });
      };

      /** Upload / hidden file input / clear, the one shape all three asset groups share. */
      const assetTools = (category, kind, pool) => [
        h('button', {
          key: 'upload',
          type: 'button',
          className: 'hl-link',
          onClick: (event) => {
            const input = event.currentTarget.parentElement.querySelector(`[data-hotlist-upload="${kind}-${category}"]`);
            if (input !== null && input !== undefined) input.click();
          },
        }, t('settings.asset.upload')),
        h('input', {
          key: 'file',
          className: 'hl-hidden',
          type: 'file',
          accept: kind === 'sound' ? SOUND_FILE_TYPES.join(',') : GLYPH_FILE_TYPES.join(','),
          'data-hotlist-upload': `${kind}-${category}`,
          onChange: (event) => {
            const file = event.target?.files?.[0];
            if (file !== undefined && file !== null) pushAsset(category, kind, file);
          },
        }),
        pool.length > 0 ? h('button', {
          key: 'clear',
          type: 'button',
          className: 'hl-link',
          onClick: () => dropAssets(category, kind),
        }, t('settings.asset.clear')) : null,
      ];

      const assetHint = (pool, kind) => (pool.length === 0
        ? t(kind === 'sound' ? 'settings.asset.emptySound' : 'settings.asset.emptyImage')
        : t('settings.asset.count', { count: pool.length }));

      const iconRows = (category) => {
        const entry = settings.categories[category];
        const glyph = entry.glyph;
        const rows = [
          multi([
            cell(t('settings.glyphSource'), select(GLYPH_SOURCES, glyph.source, (value) => patchGlyph(category, false, { source: value }), (value) => t(`settings.glyphSource.${value}`))),
            cell(t('settings.asset.upload'), h('div', { key: 'tools', className: 'hl-fieldControl' }, assetTools(category, 'glyph', glyph.uploads)), assetHint(glyph.uploads, 'glyph')),
          ], 2),
          field(t('settings.glyphValue'), [
            glyphNode(category, false, glyph, 20),
            emojiInput(glyphText(category, false, glyph), (value) => patchGlyph(category, false, value === '' ? { kind: 'none', value: '' } : { kind: 'emoji', value }), glyph.source !== 'emoji'),
          ], t('settings.glyphTextLimit')),
        ];
        if (category === 'pending') {
          rows.push(field(t('settings.glyphSecondary'), [
            glyphNode(category, true, entry.glyphSecondary, 16),
            emojiInput(glyphText(category, true, entry.glyphSecondary), (value) => patchGlyph(category, true, { kind: 'emoji', value }), entry.glyphSecondary.kind === 'img'),
          ], t('settings.glyphFollowHint')));
        }
        return group(t('settings.group.icon'), rows);
      };

      const motionRows = (category) => {
        const glyph = settings.categories[category].glyph;
        return group(t('settings.group.motion'), [
          multi([
            cell(t('settings.motion'), select(MOTION_NAMES, glyph.motion, (value) => patchGlyph(category, false, { motion: value }), (value) => t(`settings.motion.${value}`))),
            cell(t('settings.motionTarget'), segmented(MOTION_TARGETS, glyph.motionTarget, (value) => patchGlyph(category, false, { motionTarget: value }), (value) => t(`settings.motionTarget.${value}`))),
          ], 2),
          field(t('settings.frequency'), [
            rangeInput(glyph.frequency, (value) => patchGlyph(category, false, { frequency: value })),
            h('span', { key: 'value', className: 'hl-rowHint' }, `${Math.round(glyph.frequency * 100)}%`),
          ], t('settings.frequencyHint')),
        ]);
      };

      const popoutRows = (category) => {
        const popout = settings.categories[category].popout;
        const off = popout.enabled !== true;
        return group(t('settings.group.popout'), [
          multi([
            cell(t('settings.popout.enabled'), toggleNode(popout.enabled, () => patchPopout(category, { enabled: popout.enabled !== true }))),
            cell(t('settings.popout.image'), h('div', { key: 'image', className: 'hl-fieldControl' }, assetTools(category, 'popout', popout.images)), assetHint(popout.images, 'popout')),
          ], 2),
          multi([
            cell(t('settings.popout.entrance'), h('span', {
              className: 'hl-rowHint',
              title: t('settings.popout.entranceFixed'),
            }, t('settings.popout.entranceFixed'))),
            cell(t('settings.popout.ambient'), select(POPOUT_AMBIENTS, popout.ambient, (value) => patchPopout(category, { ambient: value }), (value) => t(`settings.popout.ambient.${value}`))),
            cell(t('settings.popout.exit'), select(POPOUT_EXITS, popout.exit, (value) => patchPopout(category, { exit: value }), (value) => t(`settings.popout.exit.${value}`))),
          ], 3),
          multi([
            cell(t('settings.popout.side'), select(OVERLAY_SIDES, popout.side, (value) => patchPopout(category, { side: value }), (value) => t(`settings.popout.side.${value}`))),
            cell(t('settings.popout.displayMs'), numberInput(Math.round(popout.displayMs / 500) / 2, POPOUT_DISPLAY_MS.min / 1000, POPOUT_DISPLAY_MS.max / 1000, 0.5, (value) => patchPopout(category, { displayMs: value * 1000 }))),
          ], 2),
        ], off);
      };

      const soundRows = (category) => {
        const sound = settings.categories[category].sound;
        const source = sound.builtin === true ? 'builtin' : 'upload';
        return group(t('settings.group.sound'), [
          multi([
            cell(t('settings.sound.enabled'), toggleNode(sound.enabled, () => patchSound(category, { enabled: sound.enabled !== true }))),
            cell(t('settings.sound.source'), select(SOUND_SOURCES, source, (value) => patchSound(category, { builtin: value === 'builtin' }), (value) => t(`settings.sound.source.${value}`))),
            cell(t('settings.sound.preview'), h('button', {
              key: 'preview',
              type: 'button',
              className: 'hl-step',
              title: t('settings.sound.previewHint'),
              onClick: () => soundPreview(category),
            }, '▶')),
          ], 3),
          source === 'upload'
            ? field(t('settings.asset.sound'), assetTools(category, 'sound', sound.uploads), assetHint(sound.uploads, 'sound'))
            : null,
        ]);
      };

      const orderRows = (category) => {
        const entry = settings.categories[category];
        return group(t('settings.group.order'), [
          field(t('settings.order'), numberInput(entry.order, 1, 99, 1, (value) => patchCategory(category, { order: value })), t('settings.orderHint')),
        ]);
      };

      const chip = (key, label, on, disabled, hint) => h('span', {
        key,
        className: 'hl-chip',
        'data-on': on === true ? 'true' : 'false',
        'data-disabled': disabled === true ? 'true' : 'false',
        'aria-label': label,
        title: hint ?? label,
      }, t(`settings.chipShort.${key}`));

      const card = (category) => {
        const entry = settings.categories[category];
        const enabled = entry.enabled === true;
        const open = openCards.includes(category);
        const allOff = categoryAllOff(settings, category) === true;
        const head = h('button', {
          key: 'head',
          type: 'button',
          className: 'hl-cardHead',
          'aria-expanded': open ? 'true' : 'false',
          onClick: () => toggleCard(category),
        }, [
          glyphNode(category, false, entry.glyph, 20),
          h('span', { key: 'name', className: 'hl-cardName' }, [
            h('span', { key: 'label' }, t(`settings.category.${category}`)),
            h('span', { key: 'order', className: 'hl-cardTag' }, t('settings.card.orderTag', { order: entry.order })),
            allOff ? h('span', { key: 'off', className: 'hl-cardTag' }, t('settings.card.disabled')) : null,
          ]),
          h('span', { key: 'chips', className: 'hl-chips' }, [
            chip('tab', t('settings.chip.tab'), enabled && entry.surfaces.tab, false, t('settings.chip.positionHint')),
            chip('sidebar', t('settings.chip.sidebar'), enabled && entry.surfaces.sidebar, false, t('settings.chip.positionHint')),
            chip('topbar', t('settings.chip.topbar'), enabled && entry.surfaces.topbar, false, t('settings.chip.positionHint')),
            chip('popout', t('settings.chip.popout'), enabled && entry.popout.enabled),
            chip('sound', t('settings.chip.sound'), enabled && entry.sound.enabled),
          ]),
          h('span', { key: 'caret', className: 'hl-caret', 'aria-hidden': 'true' }, '▸'),
        ]);
        const body = open === false ? null : h('div', { key: 'body', className: 'hl-cardBody', 'data-hotlist-card-body': category }, [
          switchRow(`categories.${category}.surfaces.tab`, t('settings.surface.tab'), t('settings.surface.tabHint'), entry.surfaces.tab === true, () => patchCategory(category, { surfaces: { ...entry.surfaces, tab: entry.surfaces.tab !== true } })),
          switchRow(`categories.${category}.surfaces.sidebar`, t('settings.surface.sidebar'), t('settings.surface.sidebarHint'), entry.surfaces.sidebar === true, () => patchCategory(category, { surfaces: { ...entry.surfaces, sidebar: entry.surfaces.sidebar !== true } })),
          switchRow(`categories.${category}.surfaces.topbar`, t('settings.surface.topbar'), t('settings.surface.topbarHint'), entry.surfaces.topbar === true, () => patchCategory(category, { surfaces: { ...entry.surfaces, topbar: entry.surfaces.topbar !== true } })),
          iconRows(category),
          motionRows(category),
          popoutRows(category),
          soundRows(category),
          h('div', { key: 'reset', className: 'hl-row', 'data-hotlist-row': `categories.${category}.reset` }, [
            h('div', { key: 'main', className: 'hl-rowMain' }, [
              h('span', { key: 'title', className: 'hl-rowTitle' }, t('settings.resetCategory')),
              h('span', { key: 'hint', className: 'hl-rowHint' }, t('settings.resetCategoryHint')),
            ]),
            h('div', { key: 'control', className: 'hl-fieldControl' }, h('button', {
              key: 'button',
              type: 'button',
              className: 'hl-link',
              'data-hotlist-reset-category': category,
              onClick: () => resetCategory(category),
            }, t('settings.resetCategoryGo'))),
          ]),
          orderRows(category),
        ]);
        return h('section', {
          key: category,
          className: 'hl-card',
          'data-category': category,
          'data-open': open ? 'true' : 'false',
          'data-hotlist-row': `categories.${category}`,
        }, [head, body]);
      };

      const toggled = (path, value) => {
        if (path.startsWith('positions.')) {
          const key = path.slice('positions.'.length);
          patch({ positions: { ...settings.positions, [key]: value } });
          return;
        }
        if (path.startsWith('display.')) {
          const key = path.slice('display.'.length);
          patch({ display: { ...settings.display, [key]: value } });
          return;
        }
        if (path.startsWith('shortcuts.')) {
          const key = path.slice('shortcuts.'.length);
          patch({ shortcuts: { ...settings.shortcuts, [key]: value } });
        }
      };

      const globalSection = () => h('section', { key: 'global', className: 'hl-global', 'data-hotlist-global': '' }, [
        h('h3', { key: 'title', className: 'hl-groupTitle' }, t('settings.group.global')),
        h('div', { key: 'scope', className: 'hl-row', 'data-hotlist-row': 'scope' }, [
          h('div', { key: 'main', className: 'hl-rowMain' }, [
            h('span', { key: 'title', className: 'hl-rowTitle' }, t('settings.scope')),
            h('span', { key: 'hint', className: 'hl-rowHint' }, t('settings.scopeHint')),
          ]),
          h('div', { key: 'control', className: 'hl-fieldControl' }, select(SCOPE_MODES, settings.scope, (value) => patch({ scope: value }), (value) => t(`settings.scope.${value}`))),
        ]),
        h('div', { key: 'seats', className: 'hl-row', 'data-hotlist-row': 'maxSeats' }, [
          h('div', { key: 'main', className: 'hl-rowMain' }, [
            h('span', { key: 'title', className: 'hl-rowTitle' }, t('settings.maxSeats')),
            h('span', { key: 'hint', className: 'hl-rowHint' }, t('settings.maxSeatsHint')),
          ]),
          /**
           * No "automatic" option: it was a second, differently-shaped control on a row that is
           * otherwise a plain stepper, and every other seat count here is a plain stepper too. A
           * stored `'auto'` is still honoured (`buildSeatPlan` reads it), the stepper just starts
           * from the fallback and the first click writes a number.
           */
          h('div', { key: 'control', className: 'hl-fieldControl' }, numberStepper(
            settings.maxSeats === 'auto' ? MAX_SEATS.fallback : settings.maxSeats,
            MAX_SEATS.min,
            MAX_SEATS.max,
            (value) => patch({ maxSeats: value }),
          )),
        ]),
        h('div', { key: 'pinnedSeats', className: 'hl-row', 'data-hotlist-row': 'pinned.maxSeats' }, [
          h('div', { key: 'main', className: 'hl-rowMain' }, [
            h('span', { key: 'title', className: 'hl-rowTitle' }, t('settings.pinnedMaxSeats')),
            h('span', { key: 'hint', className: 'hl-rowHint' }, t('settings.pinnedMaxSeatsHint')),
          ]),
          h('div', { key: 'control', className: 'hl-fieldControl' }, numberStepper(settings.pinned.maxSeats, PINNED_SEATS.min, PINNED_SEATS.max, (value) => patch({ pinned: { ...settings.pinned, maxSeats: value } }))),
        ]),
        h('div', { key: 'ttl', className: 'hl-row', 'data-hotlist-row': 'collect.completedTtlMs' }, [
          h('div', { key: 'main', className: 'hl-rowMain' }, [
            h('span', { key: 'title', className: 'hl-rowTitle' }, t('settings.ttl')),
            h('span', { key: 'hint', className: 'hl-rowHint' }, t('settings.ttlHint')),
          ]),
          h('div', { key: 'control', className: 'hl-fieldControl' }, numberStepper(Math.round(settings.collect.completedTtlMs / 60000), TTL_MINUTES.min, TTL_MINUTES.max, (value) => patch({ collect: { ...settings.collect, completedTtlMs: value * 60000 } }))),
        ]),
        h('div', { key: 'volume', className: 'hl-row', 'data-hotlist-row': 'sound.volume' }, [
          h('div', { key: 'main', className: 'hl-rowMain' }, [
            h('span', { key: 'title', className: 'hl-rowTitle' }, t('settings.sound.volume')),
            h('span', { key: 'hint', className: 'hl-rowHint' }, t('settings.sound.volumeHint')),
          ]),
          h('div', { key: 'control', className: 'hl-fieldControl' }, numberStepper(settings.sound.volume, 0, 100, (value) => patch({ sound: { ...settings.sound, volume: value } }))),
        ]),
        h('div', { key: 'recent', className: 'hl-row', 'data-hotlist-row': 'recentWindow' }, [
          h('div', { key: 'main', className: 'hl-rowMain' }, [
            h('span', { key: 'title', className: 'hl-rowTitle' }, t('settings.recentWindow')),
            h('span', { key: 'hint', className: 'hl-rowHint' }, t('settings.recentWindowHint')),
          ]),
          h('div', { key: 'control', className: 'hl-fieldControl' }, numberStepper(settings.collect.recentWindowMinutes, RECENT_WINDOW_UI.min, RECENT_WINDOW_UI.max, (value) => patch({ collect: { ...settings.collect, recentWindowMinutes: value } }))),
        ]),
        switchRow('positions.tab', t('settings.position.tab'), t('settings.position.tabHint'), settings.positions.tab, () => toggled('positions.tab', settings.positions.tab !== true)),
        switchRow('positions.topbar', t('settings.position.topbar'), hasWindowsTitlebar() === true ? t('settings.position.topbarHint') : t('settings.position.webOnly'), settings.positions.topbar === true, () => toggled('positions.topbar', settings.positions.topbar !== true)),
        settings.positions.topbar === true ? h('div', { key: 'chipWidthPct', className: 'hl-row', 'data-hotlist-row': 'topbar.chipWidthPct' }, [
          h('div', { key: 'main', className: 'hl-rowMain' }, [
            h('span', { key: 'title', className: 'hl-rowTitle' }, t('settings.topbar.chipWidth')),
            h('span', { key: 'hint', className: 'hl-rowHint' }, t('settings.topbar.chipWidthHint')),
          ]),
          h('div', { key: 'control', className: 'hl-fieldControl' }, select(CHIP_PCT_STEPS, settings.topbar.chipWidthPct, (value) => patch({ topbar: { ...settings.topbar, chipWidthPct: value } }), (value) => (value === 0 ? t('settings.topbar.chipWidthDefault') : value > 0 ? `+${value}%` : `${value}%`))),
        ]) : null,
        settings.positions.topbar === true ? h('div', { key: 'topbarTitleMode', className: 'hl-row', 'data-hotlist-row': 'topbar.titleMode' }, [
          h('div', { key: 'main', className: 'hl-rowMain' }, [
            h('span', { key: 'title', className: 'hl-rowTitle' }, t('settings.topbar.titleMode')),
            h('span', { key: 'hint', className: 'hl-rowHint' }, t('settings.topbar.titleModeHint')),
          ]),
          h('div', { key: 'control', className: 'hl-fieldControl' }, select(TOPBAR_TITLE_MODES, settings.topbar.titleMode, (value) => patch({ topbar: { ...settings.topbar, titleMode: value } }), (value) => t(`settings.topbar.titleMode.${value}`))),
        ]) : null,
        settings.positions.topbar === true && settings.topbar.titleMode === 'custom'
          ? h('div', { key: 'topbarCustomScope', className: 'hl-row hl-rowWrap', 'data-hotlist-row': 'topbar.customScope' }, [
            h('div', { key: 'main', className: 'hl-rowMain' }, [
              h('span', { key: 'title', className: 'hl-rowTitle' }, t('settings.topbar.customScope')),
              h('span', { key: 'hint', className: 'hl-rowHint' }, t('settings.topbar.customScopeHint')),
            ]),
            h('div', { key: 'control', className: 'hl-scopeToggles' }, orderedCategories(settings).map((category) => h('label', {
              key: category,
              className: 'hl-scope',
              'data-hotlist-scope': category,
              'data-on': settings.topbar.customScope[category] !== false ? 'true' : 'false',
            }, [
              h('input', {
                key: 'input',
                type: 'checkbox',
                checked: settings.topbar.customScope[category] !== false,
                onChange: () => patch({ topbar: { ...settings.topbar, customScope: { ...settings.topbar.customScope, [category]: settings.topbar.customScope[category] === false } } }),
              }),
              h('span', { key: 'glyph', className: 'hl-scopeGlyph' }, CATEGORY_GLYPHS[category]),
              h('span', { key: 'name', className: 'hl-scopeName' }, t(`settings.category.${category}`)),
            ]))),
          ]) : null,
        settings.positions.topbar === true ? h('div', { key: 'topbarMaxSeats', className: 'hl-row', 'data-hotlist-row': 'topbar.maxSeats' }, [
          h('div', { key: 'main', className: 'hl-rowMain' }, [
            h('span', { key: 'title', className: 'hl-rowTitle' }, t('settings.topbar.maxSeats')),
            h('span', { key: 'hint', className: 'hl-rowHint' }, t('settings.topbar.maxSeatsHint')),
          ]),
          h('div', { key: 'control', className: 'hl-fieldControl' }, numberStepper(settings.topbar.maxSeats === 'auto' ? MAX_SEATS.fallback : settings.topbar.maxSeats, MAX_SEATS.min, MAX_SEATS.max, (value) => patch({ topbar: { ...settings.topbar, maxSeats: value } }))),
        ]) : null,
        settings.positions.topbar === true ? switchRow('topbar.previewInWeb', t('settings.topbar.previewInWeb'), t('settings.topbar.previewInWebHint'), settings.topbar.previewInWeb === true, () => patch({ topbar: { ...settings.topbar, previewInWeb: settings.topbar.previewInWeb !== true } })) : null,
        switchRow('takeOverStatusDot', t('settings.takeOverStatusDot'), settings.takeOverStatusDot === true ? t('settings.takeOverStatusDotHint') : t('settings.takeOverStatusDotOff'), settings.takeOverStatusDot, () => patch({ takeOverStatusDot: settings.takeOverStatusDot !== true })),
      ]);

      const ordered = orderedCategories(settings);
      const cardOrder = [...ordered, ...CATEGORY_IDS.filter((category) => ordered.includes(category) === false)];
      const positions = positionsOf(settings);
      const notices = [];
      if (positions.allPositionsOff === true) notices.push(h('p', { key: 'off', className: 'hl-notice' }, t('settings.position.allOff')));
      if (uploadError !== null) notices.push(h('p', { key: 'upload', className: 'hl-warn' }, uploadError));

      return h('div', { className: 'hl-page', 'data-hotlist-settings': `v${VERSION}` }, [
        h('div', { key: 'head', className: 'hl-head' }, [
          h('h2', { key: 'title', className: 'hl-title' }, t('settings.title')),
          h('p', { key: 'sub', className: 'hl-sub' }, t('settings.subtitle')),
        ]),
        ...notices,
        globalSection(),
        h('div', { key: 'cards', className: 'hl-cards' }, cardOrder.map(card)),
        h('div', { key: 'foot', className: 'hl-foot' }, [
          h('button', { key: 'close', type: 'button', className: 'hl-step', onClick: close }, t('settings.close')),
          lastWriteError === null ? null : h('p', { key: 'storage', className: 'hl-warn' }, t('settings.storageFailed')),
        ]),
      ]);
    }

    /* ==================================================================
     * Popout overlay (inlined popout-kit).
     *
     * Authoritative copy: `cangku/tmp/hotlist-art/popout-kit.js`, contract:
     * `cangku/tmp/hotlist-art/v4-popout-integration.md`. This module cannot
     * `import`, so the kit is copied verbatim — keep the animation constants,
     * the three-layer DOM (`.hl-peeker > .pk > img`) and the function
     * signatures (`tierFor` / `sizeFor` / `assetRef` / `fallbackRef` /
     * `dropDistance` / `mountPopout`) in sync with that file.
     *
     * One addition to `mountPopout`: the `isReduced` option, because the
     * product setting `display.reduceMotion === 'on'` must force the same
     * downgrade the kit otherwise derives from the OS preference alone.
     * ================================================================== */

    /** Asset tiers; `1560` only serves HiDPI 3×. */
    const TIERS = Object.freeze([64, 320, 780, 1560]);
    /** Scale factor → CSS px. */
    const SCALES = Object.freeze({ 1: 260, 1.5: 390, 2: 520, 3: 780 });
    const KIT_CATEGORIES = Object.freeze(['pending', 'error', 'completed', 'running', 'idle', 'pinned']);
    const KIT_IDLES = Object.freeze(['breath', 'float', 'none']);
    const KIT_EXITS = Object.freeze(['drop', 'particles', 'fade', 'slide-out']);
    const KIT_EMOJI = Object.freeze({
      pending: '❓', error: '⛔', completed: '✅', running: '⏳', idle: '🧊', pinned: '📌',
    });
    const KIT_TIMING = Object.freeze({
      enterMs: 550,
      exitMs: { drop: 620, particles: 900, fade: 450, 'slide-out': 500 },
      reduceFadeMs: 120,
    });
    const KIT_STYLE_ID = 'hotlist-popout-kit-style';
    const HAS_BROWSER = typeof window !== 'undefined' && typeof document !== 'undefined';

    /** Smallest advertised tier that still covers `cssPx × devicePixelRatio`. */
    function tierFor(cssPx, dpr) {
      const ratio = Number.isFinite(dpr) && dpr > 0
        ? dpr
        : (HAS_BROWSER ? Math.min(3, Math.max(1, window.devicePixelRatio || 1)) : 1);
      const need = Number(cssPx) * ratio;
      if (need <= 64) return 64;
      if (need <= 320) return 320;
      if (need <= 780) return 780;
      return 1560;
    }

    /** Scale factor (or an explicit `size`) → CSS px. */
    function sizeFor(spec) {
      if (!spec || typeof spec !== 'object') return SCALES[1];
      if (Number.isFinite(spec.size) && spec.size > 0) return spec.size;
      const scale = Number.isFinite(spec.scale) ? spec.scale : 1;
      const hit = SCALES[scale] || SCALES[String(scale)];
      return hit || Math.round(SCALES[1] * scale);
    }

    /** OS "reduce motion"; decided in JS, never through a CSS `@media` override. */
    function prefersReducedMotion(win) {
      const target = win || (HAS_BROWSER ? window : null);
      if (!target || typeof target.matchMedia !== 'function') return false;
      try {
        return target.matchMedia('(prefers-reduced-motion: reduce)').matches;
      } catch {
        return false;
      }
    }

    function isDocumentHidden(doc) {
      const target = doc || (HAS_BROWSER ? document : null);
      return !!(target && target.hidden);
    }

    /** Asset path string; the caller resolves it through `require.asset`. */
    function assetRef(category, tier) {
      return `plugins/dsh-better-notice/assets/${category}-${tier}.webp`;
    }

    /** Offline fallback SVG: the same packaged artwork the popout glyph source uses. */
    function fallbackRef(category) {
      return popoutAssetRef(category);
    }

    /** Exit drop distance: `size * 0.46`. */
    function dropDistance(size) {
      return Math.round(size * 0.46);
    }

    const KIT_CSS = `
.hl-peeker{
  position:fixed;bottom:0;left:0;right:auto;
  width:var(--hl-size,780px);height:var(--hl-size,780px);
  overflow:hidden;pointer-events:none;z-index:2147483000;
  --dir:1;--hl-enter-ms:550ms;--hl-exit-ms:620ms;--hl-drop-y:180px;
  --hl-ease-enter:cubic-bezier(.22,.9,.24,1);
  transform-origin:50% 50%;transform:scaleX(var(--dir));
  -webkit-app-region:no-drag;
}
.hl-peeker[data-side="right"]{--dir:-1;left:auto;right:0}
.hl-peeker>.pk{position:relative;display:block;width:100%;height:100%;
  transform-origin:50% 100%;will-change:transform}
.hl-peeker[data-idle="breath"]>.pk{animation:hlk-breath 2.2s ease-in-out infinite;
  animation-delay:var(--hl-enter-ms)}
.hl-peeker[data-idle="float"]>.pk{animation:hlk-float 4s ease-in-out infinite;
  animation-delay:var(--hl-enter-ms)}
@keyframes hlk-breath{0%,100%{transform:scale(1)}50%{transform:scale(1.015)}}
@keyframes hlk-float{0%,100%{transform:translateY(0) rotate(-.6deg)}
  50%{transform:translateY(-6px) rotate(.6deg)}}
.hl-peeker img{display:block;width:100%;height:100%;object-fit:contain;
  transform-origin:50% 100%;pointer-events:auto;cursor:pointer;
  -webkit-user-drag:none;user-select:none}
.hl-peeker img[data-hotlist-fallback="emoji"]{display:none}
.hl-peeker>.pk[data-emoji]::before{content:attr(data-emoji);position:absolute;inset:0;
  display:flex;align-items:center;justify-content:center;
  font-size:calc(var(--hl-size,780px)*.34);line-height:1;
  pointer-events:auto;cursor:pointer;user-select:none}
.hl-peeker.paused,.hl-peeker.paused *{animation-play-state:paused}
.hl-peeker.enter{animation:hlk-clip-reveal var(--hl-enter-ms) var(--hl-ease-enter) both}
@keyframes hlk-clip-reveal{from{clip-path:inset(0 100% 0 0)}to{clip-path:inset(0 0 0 0)}}
.hl-peeker.enter img{animation:hlk-nudge var(--hl-enter-ms) var(--hl-ease-enter) both}
@keyframes hlk-nudge{from{transform:translateX(-9px) scale(.985)}to{transform:none}}
.hl-peeker.exit-drop img{animation:hlk-drop var(--hl-exit-ms) cubic-bezier(.5,0,.75,.3) both}
@keyframes hlk-drop{0%{transform:none;opacity:1}
  100%{transform:translateY(var(--hl-drop-y)) rotate(6deg) scale(.94);opacity:0}}
.hl-peeker.exit-slide img{animation:hlk-slide var(--hl-exit-ms) cubic-bezier(.4,0,.7,.2) both}
@keyframes hlk-slide{0%{opacity:1}
  100%{transform:translateX(calc(-120% * var(--dir)));opacity:0}}
.hl-peeker.exit-fade img{animation:hlk-fade var(--hl-exit-ms) ease-out both}
@keyframes hlk-fade{0%{opacity:1;transform:none}100%{opacity:0;transform:translateY(10px)}}
.hl-peeker.gone{opacity:0}
.hl-parts{position:absolute;inset:0;pointer-events:none}
.hl-parts>i{position:absolute;left:26px;bottom:46%;
  width:var(--r,6px);height:var(--r,6px);border-radius:50%;
  background:var(--c,#ffd45c);opacity:0;
  animation:hlk-p var(--life,900ms) cubic-bezier(.2,.6,.4,1) var(--d,0ms) both}
.hl-parts>i.sq{border-radius:3px;rotate:45deg}
@keyframes hlk-p{0%{opacity:0;transform:translate(0,0) scale(.6)}
  12%{opacity:1}100%{opacity:0;transform:translate(var(--dx),var(--dy)) scale(.25)}}
`;

    function injectKitStyle(doc) {
      if (typeof doc.getElementById === 'function' && doc.getElementById(KIT_STYLE_ID)) return;
      const style = doc.createElement('style');
      style.id = KIT_STYLE_ID;
      style.dataset.hotlistKit = 'style';
      style.textContent = KIT_CSS;
      doc.head.appendChild(style);
    }

    /**
     * Mount one single-node popout controller. Nothing is rendered before the
     * first `open()`, so the plugin can create this on load.
     */
    function mountPopout(options = {}) {
      const doc = options.doc || (HAS_BROWSER ? document : null);
      if (!doc) throw new Error('[hotlist] popout needs a document');
      const root = options.root || doc.body;
      const resolveAsset = typeof options.resolveAsset === 'function' ? options.resolveAsset : (ref) => ref;
      /** Product-level reduce motion (settings) merged with the OS preference by the caller. */
      const reducedNow = () => (typeof options.isReduced === 'function'
        ? options.isReduced() === true
        : prefersReducedMotion(doc.defaultView || (HAS_BROWSER ? window : null)));

      let shell = null;
      let pk = null;
      let img = null;
      let parts = null;
      let mounted = false;
      let current = null;
      let timers = [];
      let listeners = [];
      let phase = 'idle';

      const later = (fn, ms) => {
        const timer = setTimeout(() => {
          timers = timers.filter((entry) => entry !== timer);
          fn();
        }, ms);
        timers.push(timer);
        return timer;
      };
      const clearTimers = () => {
        timers.forEach(clearTimeout);
        timers = [];
      };
      const on = (target, type, fn, opts) => {
        target.addEventListener(type, fn, opts);
        listeners.push(() => target.removeEventListener(type, fn, opts));
      };
      const offAll = () => {
        listeners.forEach((fn) => {
          try {
            fn();
          } catch {
            // a listener that is already gone is fine
          }
        });
        listeners = [];
      };
      const cancelAnimations = () => {
        if (!shell || typeof shell.getAnimations !== 'function') return;
        try {
          shell.getAnimations({ subtree: true }).forEach((animation) => {
            try {
              animation.cancel();
            } catch {
              // already finished
            }
          });
        } catch {
          // older engines fall back to the class reset below
        }
      };
      const resetClasses = () => {
        if (!shell) return;
        shell.classList.remove('enter', 'exit-drop', 'exit-slide', 'exit-fade', 'gone', 'paused');
        shell.removeAttribute('data-idle');
        /** Forces a style recalc so the ambient animation is recreated on the next open. */
        void shell.offsetWidth;
      };
      const clearParticles = () => {
        if (parts) parts.textContent = '';
      };

      const ensureShell = () => {
        if (shell) return shell;
        injectKitStyle(doc);
        shell = doc.createElement('div');
        shell.className = 'hl-peeker';
        shell.dataset.side = 'left';
        shell.setAttribute('role', 'presentation');

        pk = doc.createElement('div');
        pk.className = 'pk';

        img = doc.createElement('img');
        img.alt = '';
        img.draggable = false;
        img.dataset.hotlistFallback = 'webp';
        img.addEventListener('dragstart', (event) => event.preventDefault());
        img.addEventListener('click', () => {
          options.onActivate?.();
        });
        pk.appendChild(img);

        parts = doc.createElement('div');
        parts.className = 'hl-parts';

        shell.appendChild(pk);
        shell.appendChild(parts);

        shell.addEventListener('click', (event) => {
          if (event.target === shell || event.target === pk) options.onActivate?.();
        });

        on(doc, 'visibilitychange', () => {
          if (!shell || !mounted) return;
          shell.classList.toggle('paused', isDocumentHidden(doc));
        });

        return shell;
      };

      const toEmoji = (category) => {
        if (!img) return;
        img.dataset.hotlistFallback = 'emoji';
        img.removeAttribute('src');
        pk.dataset.emoji = KIT_EMOJI[category] || '•';
        options.onFallback?.('emoji');
      };

      const attachFallback = (category) => {
        img.dataset.hotlistFallback = 'webp';
        pk.removeAttribute('data-emoji');
        img.onerror = () => {
          const stage = img.dataset.hotlistFallback;
          if (stage === 'emoji') return;
          if (stage === 'svg') {
            toEmoji(category);
            return;
          }
          img.dataset.hotlistFallback = 'svg';
          img.src = resolveAsset(fallbackRef(category));
          options.onFallback?.('svg');
        };
      };

      const unmount = (reason) => {
        if (!shell) return;
        clearTimers();
        offAll();
        if (mounted) {
          try {
            shell.remove();
          } catch {
            // already detached
          }
        }
        mounted = false;
        phase = 'idle';
        current = null;
        options.onDone?.(reason);
      };

      const finishExit = () => {
        if (phase !== 'closing') return;
        if (shell) shell.classList.add('gone');
        unmount('exit');
      };

      const playExit = (exit) => {
        if (!shell || !img) return;
        phase = 'closing';
        /** Freezes the ambient animation so the exit does not fight it. */
        pk.style.animationPlayState = 'paused';

        const reduced = reducedNow();
        const kind = reduced ? 'fade' : exit;

        if (kind === 'particles') {
          spawnParticles(current ? current.size : SCALES[1], reduced);
          shell.style.setProperty('--hl-exit-ms', `${KIT_TIMING.reduceFadeMs}ms`);
          shell.classList.add('exit-fade');
          /** Unmount only after the particles are done; must match the clearing timer below. */
          later(finishExit, KIT_TIMING.exitMs.particles);
          return;
        }

        const ms = reduced ? KIT_TIMING.reduceFadeMs : KIT_TIMING.exitMs[kind] || 620;
        shell.style.setProperty('--hl-exit-ms', `${ms}ms`);
        shell.classList.add(kind === 'drop' ? 'exit-drop' : kind === 'slide-out' ? 'exit-slide' : 'exit-fade');

        let done = false;
        const once = () => {
          if (done) return;
          done = true;
          finishExit();
        };
        on(img, 'animationend', once);
        later(once, ms + 120);
      };

      function spawnParticles(size, reduced) {
        if (!parts) return;
        parts.textContent = '';
        if (reduced) return;
        const count = 10;
        const scale = size / 390;
        const colors = ['#ffd45c', '#ff9aa2', '#d3e6ff'];
        /** The shell mirrors itself through `--dir`, so local +x always points indoors. */
        const maxDist = size * 0.4;
        for (let index = 0; index < count; index += 1) {
          const particle = doc.createElement('i');
          const angle = -Math.PI * (0.08 + (0.4 * index) / (count - 1));
          const dist = Math.min(maxDist, (70 + Math.random() * 130) * scale);
          particle.style.setProperty('--dx', `${Math.cos(angle) * dist}px`);
          particle.style.setProperty('--dy', `${Math.sin(angle) * dist}px`);
          particle.style.setProperty('--r', `${(3 + Math.random() * 5) * Math.max(0.6, scale)}px`);
          particle.style.setProperty('--c', colors[index % colors.length]);
          particle.style.setProperty('--d', `${Math.round(Math.random() * 120)}ms`);
          particle.style.setProperty('--life', `${700 + Math.round(Math.random() * 200)}ms`);
          if (index % 3 === 0) particle.className = 'sq';
          parts.appendChild(particle);
        }
        later(() => {
          if (parts) parts.textContent = '';
        }, KIT_TIMING.exitMs.particles);
      }

      function open(spec) {
        if (!spec || KIT_CATEGORIES.includes(spec.state) === false) return false;

        clearTimers();
        cancelAnimations();
        clearParticles();
        if (pk) pk.style.removeProperty('animation-play-state');

        const reduced = reducedNow();
        const size = sizeFor(spec);
        current = {
          state: spec.state,
          side: spec.side === 'right' ? 'right' : 'left',
          size,
          idle: reduced ? 'none' : (KIT_IDLES.includes(spec.idle) ? spec.idle : 'breath'),
          exit: KIT_EXITS.includes(spec.exit) ? spec.exit : 'drop',
        };
        phase = 'open';

        ensureShell();
        resetClasses();

        shell.dataset.side = current.side;
        /** Stable hooks for the acceptance script; the class name may change, these must not. */
        shell.dataset.hotlistPopout = '';
        shell.dataset.hotlistPopoutCat = current.state;
        shell.style.setProperty('--hl-size', `${size}px`);
        shell.style.setProperty('--hl-enter-ms', `${reduced ? KIT_TIMING.reduceFadeMs : KIT_TIMING.enterMs}ms`);
        shell.style.setProperty('--hl-exit-ms', `${KIT_TIMING.exitMs[current.exit] || 620}ms`);
        shell.style.setProperty('--hl-drop-y', `${dropDistance(size)}px`);
        shell.dataset.reduceMotion = reduced ? '1' : '0';

        img.alt = current.state;
        img.dataset.state = current.state;
        /** The controller picks the art: one random upload, the packaged SVG, or the emoji fallback. */
        if (typeof spec.image === 'string' && spec.image !== '') {
          attachFallback(current.state);
          img.src = spec.image;
        } else if (spec.builtin === false) {
          toEmoji(current.state);
        } else {
          attachFallback(current.state);
          img.src = resolveAsset(assetRef(current.state, tierFor(size)));
        }

        shell.dataset.idle = current.idle;
        if (!mounted) {
          root.appendChild(shell);
          mounted = true;
        }

        shell.classList.add('enter');
        let entered = false;
        const enterDone = () => {
          if (entered) return;
          entered = true;
          shell.classList.remove('enter');
        };
        on(shell, 'animationend', (event) => {
          if (event.animationName === 'hlk-clip-reveal') enterDone();
        });
        later(enterDone, (reduced ? KIT_TIMING.reduceFadeMs : KIT_TIMING.enterMs) + 80);
        return true;
      }

      function close(exit) {
        if (!shell || !mounted) {
          current = null;
          return;
        }
        if (phase === 'closing') return;
        playExit(KIT_EXITS.includes(exit) ? exit : (current ? current.exit : 'drop'));
      }

      function destroy() {
        clearTimers();
        offAll();
        cancelAnimations();
        if (shell) {
          try {
            shell.remove();
          } catch {
            // already detached
          }
        }
        mounted = false;
        phase = 'idle';
        current = null;
        shell = null;
        pk = null;
        img = null;
        parts = null;
        const style = typeof doc.getElementById === 'function' ? doc.getElementById(KIT_STYLE_ID) : null;
        if (style) style.remove();
      }

      return {
        open,
        close,
        destroy,
        el: () => (mounted ? shell : null),
        isOpen: () => mounted && phase !== 'idle',
      };
    }

    /**
     * `resolveAsset`: the controller already picked either a `data:` URL or a
     * packaged reference, so this only forwards it to the loader's own resolver
     * (`dsh-client-modules` lib/client.js:844).
     */
    function makeResolveAsset(asset) {
      const resolve = typeof asset === 'function' ? asset : (ref) => ref;
      return (ref) => resolve(ref);
    }

    /** Which edge the popout docks to; `auto` avoids the native session column. */
    function resolvePopoutSide(setting, doc) {
      if (setting === 'left' || setting === 'right') return setting;
      if (!doc || typeof doc.querySelector !== 'function') return 'left';
      const column = doc.querySelector('.mP3x-q_sidebarCol');
      const width = column === null || column === undefined
        ? 0
        : (typeof column.getBoundingClientRect === 'function'
          ? column.getBoundingClientRect().width
          : column.clientWidth);
      return typeof width === 'number' && width > 40 ? 'right' : 'left';
    }

    const POPOUT_PRIORITY = Object.freeze({ error: 3, pending: 2, completed: 1 });
    const POPOUT_COOLDOWN_MS = 10 * 1000;

    /**
     * Caller-side policy the kit deliberately leaves out: when to show, which one
     * wins, how long, and what happens when the same session flaps.
     */
    function createPopoutController(options) {
      const getSettings = options.getSettings;
      const openSession = options.openSession;
      const isCurrent = options.isCurrent;
      const log = typeof options.log === 'function' ? options.log : () => {};
      const doc = () => (typeof document === 'undefined' ? null : document);

      let kit = null;
      let showing = null;
      let showingPrio = 0;
      let seq = 0;
      let timer = null;
      /** `${category}:${sessionId}` → last shown timestamp. */
      const cooldown = new Map();
      /** sessionId → category announced last round; drives "first entry only". */
      const seen = new Map();
      /** sessionId → category of the latest observe(); feeds the manual hotkey. */
      const latest = new Map();

      const reduced = () => {
        const settings = getSettings();
        if (settings.display.reduceMotion === 'on') return true;
        return prefersReducedMotion(doc()?.defaultView);
      };

      const ensureKit = () => {
        if (kit !== null) return kit;
        kit = mountPopout({
          doc: doc() ?? undefined,
          isReduced: reduced,
          resolveAsset: makeResolveAsset(options.asset),
          onActivate: () => {
            const current = showing;
            if (current === null) return;
            openSession(current.sessionId);
            dismiss();
          },
          onDone: () => {
            if (timer !== null) {
              clearTimeout(timer);
              timer = null;
            }
            if (showing === null) showingPrio = 0;
          },
          onFallback: (stage) => log('asset fell back to', stage),
        });
        return kit;
      };

      const clearTimer = () => {
        if (timer === null) return;
        clearTimeout(timer);
        timer = null;
      };

      /** Manual close (click, session switch, settings change); timed close shares this path. */
      function dismiss(exit) {
        clearTimer();
        const current = showing;
        showing = null;
        showingPrio = 0;
        if (kit !== null && current !== null) kit.close(exit ?? current.exit);
      }

      function show(category, sessionId, settings, now) {
        const entry = settings.categories[category];
        const art = pickPopoutArt(settings, category);
        const my = ++seq;
        clearTimer();
        const mounted = ensureKit().open({
          state: category,
          image: art.kind === 'data' ? art.value : '',
          builtin: art.kind !== 'emoji',
          side: resolvePopoutSide(entry.popout.side, doc()),
          size: Math.round((settings.overlay.sizeMin + settings.overlay.sizeMax) / 2),
          idle: entry.popout.ambient,
          exit: entry.popout.exit,
        });
        if (mounted !== true) {
          showing = null;
          showingPrio = 0;
          return false;
        }
        showing = { category, sessionId, seq: my, exit: entry.popout.exit };
        showingPrio = POPOUT_PRIORITY[category];
        cooldown.set(`${category}:${sessionId}`, now);
        const ms = Math.min(20000, Math.max(2000, entry.popout.displayMs | 0));
        timer = setTimeout(() => {
          /** A newer overlay took over: never let an old timer close it. */
          if (showing?.seq !== my) return;
          dismiss();
        }, ms);
        return true;
      }

      /**
       * `offer` is the whole concurrency policy: one slot, higher priority wins,
       * lower priority is dropped instead of queued, and the same session flashing
       * the same category within `POPOUT_COOLDOWN_MS` stays quiet.
       */
      function offer(category, sessionId, now) {
        const settings = getSettings();
        if (settings.categories[category]?.popout?.enabled !== true) return false;
        if (isCurrent(sessionId)) return false;
        if (isDocumentHidden(doc())) {
          log('suppressed while the page is hidden', category, sessionId);
          return false;
        }
        const last = cooldown.get(`${category}:${sessionId}`);
        if (last !== undefined && now - last < POPOUT_COOLDOWN_MS) return false;
        const priority = POPOUT_PRIORITY[category];
        if (priority === undefined) return false;
        if (showing !== null && showingPrio > priority) return false;
        if (showing !== null) dismiss('fade');
        return show(category, sessionId, settings, now);
      }

      /**
       * Compare this snapshot with the previous round and offer only sessions that
       * just entered a category (`error` > `pending` > `completed`).
       */
      function observe(snapshot, now) {
        const settings = getSettings();
        const byId = snapshot.list.byId;
        const present = new Set();
        for (const sessionId of snapshot.list.ids) {
          const session = byId[sessionId];
          if (session === undefined || session.blank === true) continue;
          if (session.origin === 'subagent' || session.parentId != null) continue;
          present.add(sessionId);
          const status = snapshot.statuses.get(sessionId);
          let category;
          if (snapshot.errors !== undefined && snapshot.errors.has(sessionId)) category = 'error';
          else if (status?.pendingInteraction != null) category = 'pending';
          else if (snapshot.completedAt !== undefined) {
            const at = snapshot.completedAt.get(sessionId);
            if (at !== undefined && now - at <= settings.collect.completedTtlMs) category = 'completed';
          }
          if (category === undefined) {
            seen.delete(sessionId);
            continue;
          }
          if (seen.get(sessionId) === category) continue;
          seen.set(sessionId, category);
          offer(category, sessionId, now);
        }
        for (const sessionId of [...seen.keys()]) if (!present.has(sessionId)) seen.delete(sessionId);
        latest.clear();
        for (const [sessionId, category] of seen) latest.set(sessionId, category);
      }

      /**
       * The manual trigger behind `shortcuts.overlayEnabled`: pop the most urgent
       * class currently present, bypassing the first-entry edge and the cooldown
       * (a keypress is already an explicit request).
       */
      function manual() {
        const settings = getSettings();
        let best = null;
        for (const [sessionId, category] of latest) {
          if (settings.categories[category]?.popout?.enabled !== true) continue;
          const priority = POPOUT_PRIORITY[category];
          if (priority === undefined) continue;
          if (best === null || priority > best.priority) best = { category, sessionId, priority };
        }
        if (best === null) return false;
        if (showing !== null) dismiss('fade');
        return show(best.category, best.sessionId, settings, Date.now());
      }

      /** A settings write closes whatever is up and does not reopen: the next trigger decides. */
      function settingsChanged() {
        if (showing !== null) dismiss('fade');
      }

      function destroy() {
        clearTimer();
        showing = null;
        showingPrio = 0;
        seen.clear();
        latest.clear();
        cooldown.clear();
        if (kit !== null) kit.destroy();
        kit = null;
      }

      return {
        offer,
        manual,
        observe,
        dismiss,
        settingsChanged,
        destroy,
        showing: () => showing,
        open: () => kit !== null && kit.isOpen(),
      };
    }

    /**
     * Category sounds: one per real transition into that class, on the edge only
     * (a repaint never replays), never on the first sync, and never closer than
     * `SOUND_THROTTLE_MS`. An autoplay refusal is logged once per event, silent
     * to the user.
     */
    function createSoundPlayer(options) {
      const getSettings = options.getSettings;
      const createAudio = options.createAudio;
      const log = typeof options.log === 'function' ? options.log : () => {};
      /** sessionId -> category announced last round: re-entry replays, repaint does not. */
      const seen = new Map();
      let armed = false;
      let lastAt = -Infinity;

      const emit = (url, settings) => {
        const audio = createAudio(url);
        if (audio === null) return false;
        audio.volume = clamp(settings.sound.volume / 100, 0, 1);
        const played = audio.play();
        if (played && typeof played.catch === 'function') {
          played.catch((thrown) => log('blocked', thrown instanceof Error ? thrown.message : String(thrown)));
        }
        return true;
      };

      function play(category, at) {
        const settings = getSettings();
        if (settings.categories[category]?.sound?.enabled !== true) {
          log('off', category);
          return false;
        }
        if (at - lastAt < SOUND_THROTTLE_MS) {
          log('throttle', category, at - lastAt);
          return false;
        }
        const url = pickSoundUrl(settings, category);
        if (url === '') {
          log('mute', category);
          return false;
        }
        lastAt = at;
        log('play', category, url);
        try {
          return emit(url, settings);
        } catch (thrown) {
          log('failed', thrown instanceof Error ? thrown.message : String(thrown));
          return false;
        }
      }

      /** The edge detector: a session that newly entered a class is the only thing that rings. */
      function observe(snapshot, now) {
        const byId = snapshot.list.byId;
        for (const sessionId of snapshot.list.ids) {
          const session = byId[sessionId];
          if (session === undefined || session.blank === true) continue;
          if (session.origin === 'subagent' || session.parentId != null) continue;
          const status = snapshot.statuses.get(sessionId);
          let category;
          if (snapshot.errors.has(sessionId)) category = 'error';
          else if (status?.pendingInteraction != null) category = 'pending';
          else {
            const at = snapshot.completedAt.get(sessionId);
            if (at !== undefined && now - at <= getSettings().collect.completedTtlMs) category = 'completed';
          }
          if (category === undefined) {
            seen.delete(sessionId);
            continue;
          }
          if (seen.get(sessionId) === category) continue;
          seen.set(sessionId, category);
          if (armed) play(category, now);
          else log('armed', category);
        }
        for (const sessionId of [...seen.keys()]) {
          if (byId[sessionId] === undefined) seen.delete(sessionId);
        }
        armed = true;
      }

      /** The settings page preview: the cold-start gate and the throttle do not apply to a user click. */
      function preview(category) {
        const settings = getSettings();
        const url = pickSoundUrl(settings, category);
        if (url === '') {
          log('preview-mute', category);
          return false;
        }
        log('preview', category, url);
        try {
          return emit(url, settings);
        } catch (thrown) {
          log('failed', thrown instanceof Error ? thrown.message : String(thrown));
          return false;
        }
      }

      return { observe, preview };
    }

    /**
     * The scripting surface: settings plus the three asset pools. Every write goes
     * through `writeSettings`, so the tab row, the sidebar and the page all react
     * at once and the same quotas apply as for a click in the page.
     */
    function createHotlistApi(options) {
      const poolOf = (category, kind) => {
        const entry = options.getSettings().categories[category];
        if (entry === undefined) return null;
        if (kind === 'glyph') return entry.glyph.uploads;
        if (kind === 'popout') return entry.popout.images;
        if (kind === 'sound') return entry.sound.uploads;
        return null;
      };
      const patchOf = (category, kind, next) => {
        if (kind === 'glyph') return { categories: { [category]: { glyph: { uploads: next } } } };
        if (kind === 'popout') return { categories: { [category]: { popout: { images: next } } } };
        return { categories: { [category]: { sound: { uploads: next } } } };
      };
      return {
        version: VERSION,
        settings: {
          get: () => options.getSettings(),
          set: (patch) => options.writeSettings(isPlainObject(patch) ? patch : {}),
          reset: () => options.resetSettings(),
          /** Restore one category; drops that category's markers and leaves the rest alone. */
          resetCategory: (category) => options.resetCategory(category),
          subscribe: (fn) => options.onSettingsChange(fn),
          /** Rolling copies of earlier writes, newest first: `{at, version}` only. */
          backups: () => readBackups().map((item) => ({ at: item.at, version: item.settings.version })),
          /** Put one of those copies back, e.g. after an unexpected reset. */
          restore: (index) => {
            const entry = readBackups()[typeof index === 'number' ? index : -1];
            if (entry === void 0) return { ok: false };
            settingsCache = sanitizeSettings(entry.settings);
            persist(settingsCache);
            notify();
            return { ok: true, at: entry.at };
          },
        },
        assets: {
          add: (category, kind, asset) => {
            if (ASSET_KINDS.includes(kind) === false || !isPlainObject(asset)) return { ok: false, reason: 'invalid' };
            const pool = poolOf(category, kind);
            if (pool === null) return { ok: false, reason: 'invalid' };
            if (pool.length >= ASSET_POOL_MAX) return { ok: false, reason: 'full' };
            const kept = sanitizeAssets([...pool, asset], kind);
            if (kept.length <= pool.length) return { ok: false, reason: 'refused' };
            options.writeSettings(patchOf(category, kind, kept));
            /** The total budget trims on write: the pool may be exactly as long as it was. */
            if (poolOf(category, kind).length <= pool.length) return { ok: false, reason: 'budget' };
            return { ok: true, bytes: assetBytes(asset.dataUrl) };
          },
          list: (category, kind) => {
            const pool = poolOf(category, kind);
            return pool === null ? [] : pool.map((item) => ({ name: item.name, bytes: assetBytes(item.dataUrl) }));
          },
          clear: (category, kind) => {
            if (poolOf(category, kind) === null) return false;
            options.writeSettings(patchOf(category, kind, []));
            return true;
          },
          preview: (category) => options.preview(category),
        },
      };
    }

    function apply(ctx) {
      try {
        window.__HOTLIST_VERSION__ = VERSION;
        window.__SESSION_SWITCHER_VERSION__ = VERSION;
      } catch {
        // the version marker is diagnostics only; never block the plugin on it
      }
      ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'hotlist: dictionaries');
      const t = ctx.locale.bind(NS);

      /**
       * The settings page. Everything it shows comes from the same store the tab
       * row and the sidebar read, and each control writes through
       * `writeSettings`, which notifies this page, the seats and the glyphs at
       * once (`label:()=>t(...)` must stay a thunk: the slot resolves labels
       * without passing `t`).
       */
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: SECTION_ID,
        order: SECTION_ORDER,
        label: () => t('settings.nav'),
        locale: NS,
      }, (props) => h(HotlistSettingsPage, { close: props.close, t })), 'hotlist: settings page');

      /** Nav icon of our section: three rows, drawn inline (no asset request). */
      ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
        name: 'settings.section.icon',
        id: SECTION_ID,
      }, (props) => h('svg', {
        width: props.size || 16,
        height: props.size || 16,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        'aria-hidden': 'true',
      }, h('path', { d: 'M3 4h10M3 8h10M3 12h6' }))), 'hotlist: settings icon');

      /** Cross-window writes (another window of the same profile) land here. */
      ctx.effect(() => watchStorage(), 'hotlist: settings storage');
      /** Switch the main view; the hotkeys and the seats share this one call. */
      const openSession = (sessionId) => ctx.get('uiWorkspace').openSession(sessionId);

      /**
       * Everything `exportSessions` needs that lives in this closure. Mirrors
       * `planFrom()`: `readSnapshot()` is reused for the stores, and the three
       * things it deliberately does not carry (`errors`, `completedAt`, the
       * archived ids — it drops archived ids at the source) are added here
       * rather than by changing `readSnapshot()`, which is not this task's area.
       */
      function liveExportInput() {
        const snap = readSnapshot();
        const groups = ctx.get('uiWorkspace')?.workspaces.list.getSnapshot();
        const raw = ctx.get('sessions').list.getSnapshot();
        return {
          /** The unfiltered ids, so `includeArchived` can still reach archived rows. */
          ids: raw.ids,
          byId: snap.list.byId,
          list: snap.list,
          statuses: snap.statuses,
          errors,
          completedAt,
          currentId: snap.currentId,
          pinnedSessionIds: snap.pinnedSessionIds,
          workspaceIds: snap.workspaceIds,
          archivedSessionIds: groups?.archivedSessionIds ?? [],
          now: Date.now(),
          settings: readSettings(),
        };
      }

      /** sessionId -> {message, at}: run failures kept until that session reaches the main view. */
      const errors = new Map();
      /**
       * sessionId -> timestamp this plugin saw the session finish. Loaded from
       * `COMPLETED_AT_KEY` so an already-finished session keeps its ✅ seat after a
       * reload; written once per sync when it changed (see `flushCompletedAt`).
       */
      const completedAt = new Map(readCompletedAt(readSettings().collect.completedTtlMs, Date.now()));
      let completedDirty = false;
      let completedFlushTimer = null;
      /** sessionId -> running / completionUnread as of the previous sync, to spot those transitions. */
      const runningBefore = new Map();
      const unreadBefore = new Map();
      /** sessionId -> {order, title, label, message, dispose} of the live seat. */
      const registered = new Map();
      /** Repaints the tab row once a second: a host re-render can drop our span. */
      let tabTimer = null;
      let tabPlan = [];
      /** sessionId -> {seat, at}: a seat removed together with its session, ready to come back as it was. */
      const recentSeats = new Map();
      let shrinkTimer = null;
      let departuresArmed = false;
      /** Sidebar glyph adapter: a DOM enhancement beside the seats, not a seat itself. */
      let sidebar = null;
      /** Popout overlay: one single-node slot at the window edge, driven by category entries. */
      let popout = null;
      /** Category sounds: one player for the window, armed by the first sync. */
      let sound = null;
      /**
       * The hotkey cycle walks exactly the seats the last sync decided were live
       * (`buildSeatPlan` after limit and surface clipping), never "all sessions".
       */
      let cycleIds = [];
      /**
       * Stable ring of seat ids seen while cycling. The current session never owns a
       * seat, so after each jump it drops out of `cycleIds`; a plain re-read would lose
       * the position, while the ring keeps the departed id in place.
       */
      let cycleRing = [];
      let cycleCurrent = null;
      let cycleLast = null;

      /**
       * Tracks finishes ourselves instead of relying on `completionUnread`,
       * which the UI clears within 1–3 minutes (dsh-client-ui-session
       * lib/client.js:964-981). A non-current session that stops running (or
       * whose unread completion flag rises) is remembered for
       * `collect.completedTtlMs`; becoming the main view or leaving the
       * session list forgets it immediately.
       */
      function rememberFinished(sessionId, at) {
        completedAt.set(sessionId, at);
        completedDirty = true;
        scheduleCompletedFlush();
      }

      /** `immediate` is for the session the user is looking at: it leaves the table at once. */
      function forgetFinished(sessionId, immediate) {
        if (completedAt.delete(sessionId) === false) return;
        completedDirty = true;
        if (immediate === true) flushCompletedAt();
        else scheduleCompletedFlush();
      }

      /** A burst of transitions lands on disk together; 500ms is below human notice. */
      function scheduleCompletedFlush() {
        if (completedFlushTimer !== null) return;
        completedFlushTimer = setTimeout(() => {
          completedFlushTimer = null;
          flushCompletedAt();
        }, COMPLETED_FLUSH_MS);
      }

      function flushCompletedAt() {
        if (completedFlushTimer !== null) {
          clearTimeout(completedFlushTimer);
          completedFlushTimer = null;
        }
        if (completedDirty === false) return;
        completedDirty = false;
        persistCompletedAt(completedAt);
      }

      function observeCompletion(snapshot, now) {
        /**
         * The list snapshot is partial until the first `session.list` lands
         * (store `phase` is 'pending' before that), so pruning on it would
         * erase every timestamp just read from disk. Real-machine report: a
         * reload wrote `{}` back 1.2 s in, while the sidebar already had rows.
         */
        if (snapshot.list.phase !== 'ready') return;
        const present = new Set(snapshot.list.ids);
        for (const sessionId of [...completedAt.keys()]) if (!present.has(sessionId)) forgetFinished(sessionId);
        /** Only the workspace on screen keeps finished marks: another workspace's table is not ours. */
        if (snapshot.workspaceIds !== null) {
          const inWorkspace = new Set(snapshot.workspaceIds);
          for (const sessionId of [...completedAt.keys()]) if (!inWorkspace.has(sessionId)) forgetFinished(sessionId);
        }
        for (const sessionId of runningBefore.keys()) if (!present.has(sessionId)) runningBefore.delete(sessionId);
        for (const sessionId of unreadBefore.keys()) if (!present.has(sessionId)) unreadBefore.delete(sessionId);
        for (const id of present) {
          const status = snapshot.statuses.get(id);
          const running = status?.running === undefined ? snapshot.list.byId[id]?.running === true : status.running === true;
          const unread = status?.completionUnread === true;
          const wasRunning = runningBefore.get(id);
          const wasUnread = unreadBefore.get(id);
          if (id === snapshot.currentId) forgetFinished(id, true);
          else if (wasRunning === true && !running) rememberFinished(id, now);
          else if (wasUnread === false && unread) rememberFinished(id, now);
          runningBefore.set(id, running);
          unreadBefore.set(id, unread);
        }
      }

      /**
       * How many seats the tab row can show: the conversation UI caps visible
       * tabs at `max(1, floor((rowWidth - 48) / 120))`
       * (dsh-client-ui-conversation lib/client.js:20814-20831) and folds the
       * rest into a menu that cannot list them. Chat and trajectory keep two
       * places, so our seats get the remainder. The measured element is the
       * row's parent: the tablist itself is as wide as its content.
       */
      function seatLimit() {
        const row = typeof document === 'undefined' ? void 0 : document.querySelector('[data-conversation-tabs]');
        const box = row?.parentElement ?? row;
        const width = typeof box?.clientWidth === 'number' ? box.clientWidth : 0;
        if (width <= 0) return FALLBACK_LIMIT;
        const visible = Math.max(1, Math.floor((width - TAB_ROW_PADDING) / TAB_WIDTH));
        return Math.max(1, visible - 2);
      }

      /**
       * Body of one seat: selecting the tab switches the main session, and both
       * sessions are put back on the chat view. A seat id is global, so the tab
       * can be clicked from any session; without this the source session would
       * persist "my seat" as its view preference (dsh-client-ui-conversation
       * lib/client.js:4560-4571) and later reopen on our placeholder page.
       *
       * Real-machine note: a seat click does not reliably select the view
       * (`aria-selected` stayed on 对话), so switching cannot live in the mount
       * effect alone. The body root also switches on pointerdown/click, without
       * preventDefault so the tab still selects itself; `openSession` is
       * idempotent, so whichever path arrives first wins and repeats are free.
       */
      /**
       * One switch, shared by a tab seat, a band pill and the `+N` walk: the seat
       * body, the pill and the overflow button must not disagree about how a
       * session is opened. `openSession` is idempotent, and the activation passes
       * exist because the host reveals the target view asynchronously.
       */
      function switchTo(targetId, currentId, fail) {
        if (currentId === targetId) return;
        const workspace = ctx.get('uiWorkspace');
        if (workspace === void 0 || typeof workspace.openSession !== 'function') {
          fail(t('tab.error'));
          return;
        }
        const known = typeof currentId === 'string';
        /** `binding` throws for a session that is not retained yet (dsh-client-ui-conversation lib/client.js:4138-4139). */
        const activateChat = (target) => {
          try {
            ctx.get('uiConversation')?.binding?.(target)?.activate?.('chat');
          } catch (thrown) {
            console.debug('[hotlist] activate skipped', target, thrown instanceof Error ? thrown.message : String(thrown));
          }
        };
        const repair = (target) => {
          if (typeof target === 'string') repairSourcePreference(target);
        };
        const settle = () => {
          /** The switch resolved: the source's preference may already hold the target's seat id. */
          repair(currentId);
          activateChat(targetId);
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => activateChat(targetId));
          else setTimeout(() => activateChat(targetId), 0);
          /** In the first correction the target's binding may still be missing: the host retains it asynchronously. */
          setTimeout(() => activateChat(targetId), 250);
          /**
           * Late pass, once the host has settled the reveal: activate the target
           * again, and both activate plus repair the source, whose preference the
           * host rewrote while selecting the tab.
           */
          setTimeout(() => {
            activateChat(targetId);
            if (known === true) {
              activateChat(currentId);
              repair(currentId);
            }
          }, 1200);
        };
        if (known === true) activateChat(currentId);
        const failed = (thrown) => fail(thrown instanceof Error ? thrown.message : String(thrown));
        let pending;
        try {
          pending = workspace.openSession(targetId);
        } catch (thrown) {
          failed(thrown);
          return;
        }
        if (pending && typeof pending.then === 'function') {
          pending.then(() => {
            fail(null);
            settle();
          }, failed);
        } else {
          fail(null);
          settle();
        }
      }

      function seatComponent(sessionId, title, errorMessage) {
        return function SessionSeat(props) {
          const currentId = props.sessionId;
          const [failure, setFailure] = React.useState(null);
          const switchSession = () => switchTo(sessionId, currentId, setFailure);
          React.useEffect(() => {
            switchSession();
          }, [currentId]);
          const line = failure !== null
            ? failure
            : errorMessage === void 0
              ? t('tab.placeholder')
              : `${t('tab.failed')}${errorMessage.slice(0, ERROR_TEXT_LIMIT)}`;
          return h('div', {
            'data-hotlist-seat': sessionId,
            'data-hotlist-version': VERSION,
            onPointerDown: switchSession,
            onClick: switchSession,
            style: { padding: '16px 20px', fontSize: '13px', color: 'var(--dsw-alias-label-secondary)' },
          }, [
            h('div', {
              key: 'title',
              style: { marginBottom: '4px', fontWeight: 500 },
            }, title === '' ? t('tab.untitled') : title),
            h('div', { key: 'line' }, line),
          ]);
        };
      }

      /**
       * Disposals postponed to the next macrotask. Disposing a seat emits
       * `slots/changed`, and the conversation UI then restores every tracked
       * binding (dsh-client-ui-conversation lib/client.js:22652-22660), whose
       * own cleanup only runs on unmount; deferring lets that cleanup win the
       * race instead of hitting `uiConversation.binding: unknown session`.
       * A same-id rebuild stays synchronous: the id must be free before the
       * replacement registration.
       */
      const pendingDisposals = new Map();
      let disposalTimer = null;
      let disposalNested = null;

      function flushDisposals() {
        const disposers = [...pendingDisposals.values()];
        pendingDisposals.clear();
        for (const dispose of disposers) {
          try {
            dispose();
          } catch (thrown) {
            console.debug('[hotlist] dispose skipped', thrown instanceof Error ? thrown.message : String(thrown));
          }
        }
      }

      /**
       * Disposal runs after two macrotasks (~16-32 ms). The host restores every
       * tracked binding on `slots/changed` and only retires a released session's
       * binding on unmount (dsh-client-ui-conversation lib/client.js:22652-22660),
       * so the extra turn lowers the chance of `uiConversation.binding: unknown
       * session`. This mitigates that host race; it does not fix it.
       */
      function scheduleDisposals() {
        if (disposalTimer !== null) return;
        disposalTimer = setTimeout(() => {
          disposalTimer = null;
          const step = () => {
            disposalNested = null;
            flushDisposals();
          };
          if (typeof requestAnimationFrame === 'function') {
            disposalNested = requestAnimationFrame(() => {
              disposalNested = setTimeout(step, 0);
            });
          } else {
            disposalNested = setTimeout(step, 0);
          }
        }, 0);
      }

      /**
       * Adapter between the seat plan and `conversation.view`: keeps one entry
       * per seat. `order` and the label are fixed at registration time, so the
       * two only rebuild a seat when its order or run-failure text changes; a
       * title (and therefore label) change alone waits for the next real change
       * instead of churning the registry, because the host races every
       * `slots/changed` emission against its own binding cleanup. A seat whose
       * session left the plan is queued for deferred disposal.
       */
      function mountTabSeats(plan, present) {
        /**
         * `slots.inject` runs its callback the moment `key` is declared, and that
         * callback calls `sync()`. Whichever slot the host declares first triggers
         * a sync while the other slot may still be undeclared — registering then
         * throws "slot X is not declared". Ask before writing.
         */
        if (ctx.slots.spec(SLOT) === undefined) return;
        const wanted = new Map(plan.map((seat) => [seat.sessionId, seat]));
        let mutations = 0;
        for (const [sessionId, live] of registered) {
          const next = wanted.get(sessionId);
          if (next === void 0) {
            registered.delete(sessionId);
            pendingDisposals.set(sessionId, live.dispose);
            if (!present.has(sessionId)) recentSeats.set(sessionId, { seat: live.seat, at: Date.now() });
            mutations += 1;
            continue;
          }
          const message = next.errorMessage === void 0 ? '' : next.errorMessage;
          if (next.order === live.order && message === live.message) continue;
          live.dispose();
          registered.delete(sessionId);
          mutations += 1;
        }
        if (mutations === 0 && registered.size === wanted.size) return;
        if (pendingDisposals.size > 0) scheduleDisposals();
        for (const seat of plan) {
          if (registered.has(seat.sessionId)) continue;
          const stale = pendingDisposals.get(seat.sessionId);
          if (stale !== void 0) {
            pendingDisposals.delete(seat.sessionId);
            stale();
          }
          const label = labelOf(t, seat);
          const message = seat.errorMessage === void 0 ? '' : seat.errorMessage;
          const dispose = ctx.slots.register({
            name: SLOT,
            id: `${SEAT_PREFIX}${seat.sessionId}`,
            order: seat.order,
            locale: NS,
            label: () => label,
          }, seatComponent(seat.sessionId, seat.title, seat.errorMessage));
          registered.set(seat.sessionId, { order: seat.order, title: seat.title, label, message, seat, dispose });
        }
      }

      /**
       * The tab row is the host's own button; the only way to move what is
       * painted there is to own a node inside it, exactly like the sidebar
       * rows. One span carries the glyph, the host text node loses its own
       * emoji so the two never double up, and the class animation runs on the
       * span. A host re-render that drops the span is repaired on the next tick.
       */
      const TAB_GLYPH_ATTR = 'data-hotlist-tab-glyph';
      const TAB_STYLE_ATTR = 'data-hotlist-tab-style';
      const TAB_CSS = [
        '[' + TAB_GLYPH_ATTR + '][data-hotlist-motion="spin"]{animation:hl-spin 2.4s linear infinite}',
        '[' + TAB_GLYPH_ATTR + '][data-hotlist-motion="pulse"]{animation:hl-pulse 1.6s ease-in-out infinite}',
        '[' + TAB_GLYPH_ATTR + '][data-hotlist-motion="bounce"]{animation:hl-bounce 1.2s ease-in-out infinite}',
        '[' + TAB_GLYPH_ATTR + '][data-hotlist-motion="blink"]{animation:hl-blink 1.2s ease-in-out infinite}',
        '[' + TAB_GLYPH_ATTR + ']{display:inline-block;margin-right:4px}',
        '@keyframes hl-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}',
        '@keyframes hl-pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.12)}}',
        '@keyframes hl-bounce{0%,100%{transform:translateY(0)}40%{transform:translateY(-3px)}70%{transform:translateY(0)}90%{transform:translateY(-1.5px)}}',
        '@keyframes hl-blink{0%,100%{opacity:1}50%{opacity:.35}}',
        'html[' + REDUCE_MOTION_ATTR + '] [' + TAB_GLYPH_ATTR + ']{animation:none !important}',
        '@media (prefers-reduced-motion:reduce){[' + TAB_GLYPH_ATTR + ']{animation:none !important}}',
      ].join('');

      function injectTabCss() {
        if (typeof document === 'undefined') return;
        if (document.querySelector('[' + TAB_STYLE_ATTR + ']') !== null) return;
        const style = document.createElement('style');
        style.setAttribute(TAB_STYLE_ATTR, '');
        style.textContent = TAB_CSS;
        (document.head ?? document.documentElement).appendChild(style);
      }

      function removeTabCss() {
        if (typeof document === 'undefined') return;
        const style = document.querySelector('[' + TAB_STYLE_ATTR + ']');
        if (style !== null) style.remove();
      }

      /**
       * The host paints one text node per tab — since v5 it sits inside a
       * `span[class*="tabLabel"]`, not directly under the button. Our glyph span
       * has to go *inside that same span*, before the text, or it lands outside
       * the flex row the host lays out and gets clipped.
       */
      function findTabLabelTextNode(button, wanted) {
        const spans = button.querySelectorAll('span');
        const candidates = spans.length === 0 ? [button] : [button, ...spans];
        for (const scope of candidates) {
          for (const node of scope.childNodes ?? []) {
            if (node.nodeType === 3 && node.textContent.includes(wanted)) return node;
          }
        }
        return null;
      }

      function decorateTabSeat(settings, seat) {
        if (typeof document === 'undefined') return;
        const row = document.querySelector('[data-conversation-tabs]');
        if (row === null) return;
        const { emoji: shown, title: wanted } = labelParts(t, seat, settings);
        const token = seat.token ?? null;
        const moved = shown === '' ? { motion: 'none' } : tokenMotion(settings, token);
        for (const button of row.querySelectorAll('[role="tab"]')) {
          const textNode = findTabLabelTextNode(button, wanted);
          if (textNode === null) continue;
          const parent = textNode.parentElement ?? button;
          let glyph = parent.querySelector('[' + TAB_GLYPH_ATTR + ']');
          if (shown === '') {
            if (glyph !== null) glyph.remove();
            /** Text mode still has to strip the title's own emoji — we own the row. */
            if (textNode.textContent !== wanted) textNode.textContent = wanted;
            return;
          }
          if (glyph === null) {
            glyph = document.createElement('span');
            glyph.setAttribute(TAB_GLYPH_ATTR, '');
            parent.insertBefore(glyph, textNode);
          }
          if (glyph.textContent !== shown) glyph.textContent = shown;
          if (glyph.getAttribute('data-hotlist-motion') !== moved.motion) glyph.setAttribute('data-hotlist-motion', moved.motion);
          /** One emoji, never two: the host text keeps only the title. */
          if (textNode.textContent !== wanted) textNode.textContent = wanted;
          return;
        }
      }

      function decorateTabSeats(settings, plan) {
        injectTabCss();
        for (const seat of plan) decorateTabSeat(settings, seat);
      }

      function clearTabGlyphs() {
        if (typeof document === 'undefined') return;
        const row = document.querySelector('[data-conversation-tabs]');
        if (row !== null) {
          for (const glyph of row.querySelectorAll('[' + TAB_GLYPH_ATTR + ']')) glyph.remove();
        }
        removeTabCss();
        if (tabTimer !== null) {
          clearInterval(tabTimer);
          tabTimer = null;
        }
      }

      function disposeTabSeats() {
        if (disposalTimer !== null) {
          clearTimeout(disposalTimer);
          disposalTimer = null;
        }
        if (disposalNested !== null) {
          if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(disposalNested);
          clearTimeout(disposalNested);
          disposalNested = null;
        }
        if (shrinkTimer !== null) {
          clearTimeout(shrinkTimer);
          shrinkTimer = null;
        }
        flushDisposals();
        recentSeats.clear();
        for (const live of registered.values()) live.dispose();
        registered.clear();
        tabPlan = [];
        clearTabGlyphs();
      }

      /** Session list snapshot minus archived ids, plus the current session, its workspace and live failures. */
      /** The workspace store's pins, ignored until its first read lands (`phase`). */
      const pinnedIdsOf = () => {
        const groups = ctx.get('uiWorkspace')?.workspaces.list.getSnapshot();
        return groups?.phase === 'ready' && Array.isArray(groups.pinnedSessionIds) ? groups.pinnedSessionIds : [];
      };

      function readSnapshot() {
        const now = Date.now();
        for (const [sessionId, failure] of errors) {
          if (now - failure.at > ERROR_TTL_MS) errors.delete(sessionId);
        }
        const sessions = ctx.get('sessions');
        const list = sessions.list.getSnapshot();
        const statuses = ctx.get('uiSession').sessionStatus.getSnapshot();
        const groups = ctx.get('uiWorkspace')?.workspaces.list.getSnapshot();
        const archived = new Set(groups?.archivedSessionIds ?? []);
        const current = Object.values(list.byId).find((session) => (session.retainedBy?.mainView ?? 0) > 0);
        const currentId = current?.id;
        if (currentId !== void 0) errors.delete(currentId);
        const group = groups?.items.find((item) => currentId !== void 0 && item.sessionIds.includes(currentId));
        const ids = [];
        for (const id of list.ids) {
          if (archived.has(id)) continue;
          ids.push(id);
          const session = list.byId[id];
          if (session === void 0 || session.blank === true) continue;
          const failure = bindingFailure(sessions, id);
          if (failure === null) errors.delete(id);
          else if (failure !== void 0) errors.set(id, { message: failure, at: Date.now() });
        }
        const settings = readSettings();
        /**
         * `workspace` keeps the old cut (current workspace only); `all` and `smart`
         * stop pruning here and every consumer below simply sees every session.
         * `smart` still needs the current workspace on its own — it hides only the
         * pins that belong to another workspace — so the two never share one field.
         */
        const scope = SCOPE_MODES.includes(settings.scope) ? settings.scope : 'smart';
        const currentWorkspaceIds = group?.sessionIds ?? null;
        return {
          list: { ...list, ids },
          statuses,
          currentId,
          pinnedSessionIds: pinnedIdsOf(),
          /**
           * A null currentWorkspaceIds means the workspace group has not landed yet (or
           * this host has no workspace service). Treating that as "every session is foreign"
           * made smart — the default — return an empty list on a fresh install, so both
           * cuts fall back to "no cut" until the ids arrive.
           */
          workspaceIds: scope === 'workspace' && currentWorkspaceIds !== null ? currentWorkspaceIds : null,
          scopeWorkspaceIds: scope === 'smart' && currentWorkspaceIds !== null ? currentWorkspaceIds : null,
        };
      }

      /**
       * A seat whose session disappeared from the session list is kept for
       * `RECENT_SEAT_MS` and put back exactly as it was (same order and label)
       * if that session reappears. Removing a seat only because one snapshot
       * came back short would otherwise keep it away for good.
       */
      function restoreRecentSeats(plan, snapshot, limit, now) {
        const present = new Set(snapshot.list.ids);
        for (const [sessionId, record] of recentSeats) {
          if (now - record.at > RECENT_SEAT_MS || registered.has(sessionId) || !present.has(sessionId)) {
            recentSeats.delete(sessionId);
            continue;
          }
          const session = snapshot.list.byId[sessionId];
          if (session === void 0 || session.blank === true) continue;
          if (session.origin === 'subagent' || session.parentId != null) continue;
          if (sessionId === snapshot.currentId) continue;
          if (snapshot.workspaceIds !== null && !snapshot.workspaceIds.includes(sessionId)) continue;
          const at = plan.findIndex((seat) => seat.sessionId === sessionId);
          if (at >= 0) plan[at] = record.seat;
          else if (plan.length < limit) plan.push(record.seat);
        }
      }

      /**
       * True when a live seat's session is gone from the snapshot: the case a
       * short read must not act on right away. Seats that leave because of our
       * own rules (current session, cooled down, preference) still go at once.
       */
      function losesSeats(plan, present) {
        if (registered.size === 0) return false;
        const wanted = new Set(plan.map((seat) => seat.sessionId));
        for (const sessionId of registered.keys()) if (!wanted.has(sessionId) && !present.has(sessionId)) return true;
        return false;
      }

      const planFrom = (snapshot, settings, limit, now, surface = 'tab') => buildSeatPlan({
        surface,
        list: snapshot.list,
        statuses: snapshot.statuses,
        errors,
        completedAt,
        currentId: snapshot.currentId,
        pinnedSessionIds: snapshot.pinnedSessionIds,
        workspaceIds: snapshot.workspaceIds,
        scopeWorkspaceIds: snapshot.scopeWorkspaceIds ?? null,
        now,
        limit,
      }, settings);

      /**
       * The band's model. One object, one subscription: `TopbarBar` re-renders
       * from a snapshot instead of reading five module variables, and the probes
       * below only ever replace the whole object.
       */
      let topbarModel = {
        chips: [],
        bursts: new Map(),
        mode: 'chips',
        titleMode: 'custom',
        reserve: TOPBAR_RESERVE.fallback,
        left: 0,
        currentId: void 0,
      };
      /** How many pills the band's own width actually fits; the only number `topbar.maxSeats: 'auto'` reads. */
      let topbarCapacity = MAX_SEATS.fallback;
      const topbarListeners = new Set();
      let topbarEntry = null;

      let topbarCursor = 0;
      const topbarProbeTimers = new Set();

      /** `--dsh-windows-menu-start`, or 48 (the strip's own fallback) when unreadable. */

      function notifyTopbar() {
        for (const listener of [...topbarListeners]) listener();
      }

      /** Re-run the left-edge chain. It always yields a number, so the last real edge survives a miss. */
      function probeTopbarLeft() {
        if (topbarEntry === null) return;
        topbarModel = { ...topbarModel, left: bandLeft() };
        notifyTopbar();
      }

      function clearTopbarProbes() {
        for (const timer of [...topbarProbeTimers]) clearTimeout(timer);
        topbarProbeTimers.clear();
      }

      /** The menu strip can mount a frame or two after our entry does: retry a few times, then stop. */
      function startTopbarProbe() {
        clearTopbarProbes();
        for (const delay of TOPBAR_PROBES) {
          const timer = setTimeout(() => {
            topbarProbeTimers.delete(timer);
            probeTopbarLeft();
          }, delay);
          topbarProbeTimers.add(timer);
        }
      }

      /** The band exists only where it can be seen: the desktop strip, or an explicit web preview. */
      function topbarMountable(settings) {
        if (settings.positions.topbar !== true) return false;
        if (settings.topbar.mode === 'off') return false;
        return hasWindowsTitlebar() === true || settings.topbar.previewInWeb === true;
      }

      /**
       * `[current, ...seats]`. The current session always leads and never takes a
       * seat slot, so a band with `maxSeats` 6 shows at most 7 pills.
       */
      /**
       * The band shows only what its own surface switch allows: `plan` comes
       * from `planFrom(..., 'topbar')`, so a category that is off for the tab
       * row can still be on here. The session the tab row already names is not
       * a pill either — the user reads it there, not up here.
       */
      function topbarChips(settings, plan) {
        const mode = settings.topbar.titleMode;
        const reduced = settings.display.reduceMotion === 'on';
        const chips = [];
        for (const seat of plan) {
          const category = CATEGORY_OF_TOKEN[seat.token] ?? 'running';
          const own = ownEmoji(seat.title);
          const token = seat.token ?? null;
          /**
           * `custom` draws the title's own emoji, `icon` our category glyph,
           * `text` none. It is drawn in its own span rather than left inside the
           * title text: that span is what the per-category animation moves.
           */
          const shown = own !== '' && customIconWins(settings, category)
            ? own
            : mode === 'text' || token === null
              ? ''
              : emojiOf(settings, token);
          /** A pill with no glyph has nothing to move, so it never wins the lottery. */
          const moved = shown === '' || token === null || reduced
            ? { motion: 'none', motionTarget: 'glyph' }
            : tokenMotion(settings, token);
          chips.push({
            id: seat.sessionId,
            category,
            title: stripLeadingEmoji(seat.title),
            emoji: shown,
            motion: moved.motion,
            motionTarget: moved.motionTarget,
            frequency: settings.categories[category].glyph.frequency,
          });
        }
        return chips;
      }

      function publishTopbar(snapshot, settings, plan) {
        const chips = topbarChips(settings, plan);
        /** A pill that left the band takes its burst with it. */
        const live = new Set(chips.map((chip) => chip.id));
        for (const sessionId of [...chipBursts.keys()]) {
          if (live.has(sessionId) === false) stopChipBurst(sessionId);
        }
        topbarModel = {
          chips,
          bursts: new Map(chipBursts),
          mode: settings.topbar.mode,
          titleMode: settings.topbar.titleMode,
          reserve: settings.topbar.rightReservePx,
          left: bandLeft(),
          currentId: snapshot.currentId,
        };
        notifyTopbar();
      }

      /** `+N`: walk the sessions the band could not show, one click per step, wrapping around. */
      function openHidden(chips) {
        if (chips.length === 0) return;
        const index = topbarCursor % chips.length;
        topbarCursor = (index + 1) % chips.length;
        switchTo(chips[index].id, topbarModel.currentId, () => {});
      }

      /**
       * A band item is plain text, not a pill: no fill, no frame, no radius.
       * The width is still fixed so `fitChipCount` can do its arithmetic without
       * measuring anything; the label truncates inside it.
       */
      function chipStyle(width) {
        return {
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '4px',
          width: `${width}px`,
          maxWidth: `${width}px`,
          height: '24px',
          boxSizing: 'border-box',
          padding: '0 6px',
          fontSize: '13px',
          lineHeight: '24px',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          flexShrink: 0,
          cursor: 'pointer',
          pointerEvents: 'auto',
          WebkitAppRegion: 'no-drag',
          color: 'inherit',
          /**
           * The pill is a `<button>`: without this reset the browser paints its own grey
           * face and 2px border on the title strip, which reads as a boxed chip — exactly
           * what the band must not look like.
           */
          background: 'none',
          border: '0',
          margin: '0',
          font: 'inherit',
          appearance: 'none',
          WebkitAppearance: 'none',
        };
      }

      function chipLabelOf(chip) {
        return chip.title === '' || chip.title === void 0 ? t('tab.untitled') : chip.title;
      }

      /** Estimated width of a session pill: its label plus the emoji column when it has one. */
      function chipWidthFor(chip) {
        const extra = chip.emoji === '' || chip.emoji === void 0 ? 0 : CHIP_GLYPH;
        return Math.min(chipBounds().max, chipWidthOf(chipLabelOf(chip)) + extra);
      }

      function topbarChipNode(chip) {
        const burst = topbarModel.bursts.get(chip.id);
        const attrs = {
          key: chip.id,
          type: 'button',
          'data-hotlist-chip': chip.id,
          title: chipLabelOf(chip),
          tabIndex: -1,
          onClick: () => switchTo(chip.id, topbarModel.currentId, () => {}),
          style: chipStyle(chipWidthFor(chip)),
        };
        /** Declared even while idle, so the acceptance probe can read which motion a pill owns. */
        if (chip.motion !== void 0 && chip.motion !== 'none') attrs['data-hotlist-chip-motion'] = chip.motion;
        if (burst !== void 0) {
          attrs['data-hotlist-chip-burst'] = '';
          attrs['data-hotlist-chip-target'] = chip.motionTarget === 'row' ? 'row' : 'emoji';
        }
        return h('button', attrs, [
          chip.emoji === '' || chip.emoji === void 0
            ? null
            : h('span', { key: 'glyph', 'data-hotlist-chip-emoji': '', style: { fontSize: '14px', lineHeight: '24px' } }, chip.emoji),
          h('span', { key: 'title', 'data-hotlist-chip-title': '', style: { minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis' } }, chipLabelOf(chip)),
        ]);
      }

      /**
       * The only mark between two items: a 1 px hairline that costs exactly
       * `CHIP_GAP` of layout (2 px margin each side, zero width plus a border),
       * so the band width arithmetic stays honest without measuring.
       */
      function chipSeparator(key) {
        return h('span', {
          key,
          'data-hotlist-separator': '',
          style: {
            width: '0px',
            height: '12px',
            borderLeft: `1px solid ${CHIP_SEPARATOR}`,
            margin: '0 2px',
            flexShrink: 0,
          },
        });
      }

      function TopbarBar() {
        const [model, setModel] = React.useState(topbarModel);
        React.useEffect(() => {
          const listener = () => setModel(topbarModel);
          topbarListeners.add(listener);
          listener();
          return () => {
            topbarListeners.delete(listener);
          };
        }, []);
        const chips = model.chips;
        const width = typeof window === 'undefined' || typeof window.innerWidth !== 'number' ? 0 : window.innerWidth;
        const available = width - model.left - model.reserve - WINDOW_CONTROLS_GUARD - 8;
        const nodes = [];
        if (model.mode === 'count') {
          const first = chips[0];
          const emoji = first === void 0 || first.emoji === void 0 ? '' : first.emoji;
          const label = `${emoji} ${t('topbar.count', { count: chips.length })}`.trim();
          nodes.push(h('button', {
            key: 'count',
            type: 'button',
            'data-hotlist-chip-count': chips.length,
            title: t('topbar.countHint'),
            tabIndex: -1,
            onClick: () => openHidden(chips),
            style: chipStyle(chipWidthOf(label)),
          }, label));
        } else if (model.mode === 'chips') {
          const capacity = Math.max(1, fitChipCount(chips.map(chipWidthFor), available));
          topbarCapacity = capacity;
          const shown = Math.min(chips.length, capacity);
          for (let index = 0; index < shown; index += 1) {
            if (index > 0) nodes.push(chipSeparator(`sep-${index}`));
            nodes.push(topbarChipNode(chips[index]));
          }
          const hidden = chips.slice(shown);
          if (hidden.length > 0) {
            if (shown > 0) nodes.push(chipSeparator('sep-more'));
            nodes.push(h('button', {
              key: 'more',
              type: 'button',
              'data-hotlist-more': hidden.length,
              title: t('topbar.moreHint', { count: hidden.length }),
              tabIndex: -1,
              onClick: () => openHidden(hidden),
              style: chipStyle(MORE_WIDTH),
            }, `+${hidden.length}`));
          }
        }
        return h('div', {
          'data-hotlist-topbar': '',
          'data-hotlist-topbar-mode': model.mode,
          'data-hotlist-title-mode': model.titleMode ?? 'custom',
          'data-hotlist-topbar-left': String(Math.round(model.left)),
          'data-hotlist-topbar-left-src': leftSource(),
          'data-hotlist-version': VERSION,
          style: {
            position: 'absolute',
            top: '0',
            left: '0',
            right: '0',
            height: `var(--dsh-windows-titlebar-height, ${BAND_FALLBACK}px)`,
            display: 'flex',
            alignItems: 'center',
            gap: '0px',
            paddingLeft: `${model.left}px`,
            paddingRight: `${model.reserve}px`,
            boxSizing: 'border-box',
            overflow: 'hidden',
            pointerEvents: 'none',
          },
        }, nodes);
      }

      const CHIP_STYLE_ATTR = 'data-hotlist-chip-style';

      /**
       * The band carries its own stylesheet instead of leaning on the sidebar's:
       * `SIDEBAR_STYLE` is in the document only while the sidebar adapter runs,
       * and the band has to animate with the sidebar off. The four `hl-*`
       * keyframes are the same definitions the sidebar uses (a second identical
       * `@keyframes` is inert); `hl-chip-nudge` is band-only because a 24 px
       * pill must not scale the way a 16 px glyph may.
       */
      const CHIP_CSS = [
        '[data-hotlist-chip][data-hotlist-chip-burst][data-hotlist-chip-target="emoji"][data-hotlist-chip-motion="spin"] [data-hotlist-chip-emoji]{animation:hl-spin 2.4s linear 1}',
        '[data-hotlist-chip][data-hotlist-chip-burst][data-hotlist-chip-target="emoji"][data-hotlist-chip-motion="pulse"] [data-hotlist-chip-emoji]{animation:hl-pulse 1.6s ease-in-out 1}',
        '[data-hotlist-chip][data-hotlist-chip-burst][data-hotlist-chip-target="emoji"][data-hotlist-chip-motion="bounce"] [data-hotlist-chip-emoji]{animation:hl-bounce 1.2s ease-in-out 1}',
        '[data-hotlist-chip][data-hotlist-chip-burst][data-hotlist-chip-target="emoji"][data-hotlist-chip-motion="blink"] [data-hotlist-chip-emoji]{animation:hl-blink 1.2s ease-in-out 1}',
        '[data-hotlist-chip][data-hotlist-chip-burst][data-hotlist-chip-target="row"]{animation:hl-chip-nudge 1.2s ease-in-out 1}',
        '@keyframes hl-chip-nudge{0%,100%{transform:translateY(0)}40%{transform:translateY(-2px)}70%{transform:translateY(0)}90%{transform:translateY(-1px)}}',
        '@keyframes hl-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}',
        '@keyframes hl-pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.12)}}',
        '@keyframes hl-bounce{0%,100%{transform:translateY(0)}40%{transform:translateY(-3px)}70%{transform:translateY(0)}90%{transform:translateY(-1.5px)}}',
        '@keyframes hl-blink{0%,100%{opacity:1}50%{opacity:.35}}',
        `html[${REDUCE_MOTION_ATTR}] [data-hotlist-chip]{animation:none !important}html[${REDUCE_MOTION_ATTR}] [data-hotlist-chip] *{animation:none !important}`,
        '@media (prefers-reduced-motion:reduce){[data-hotlist-chip],[data-hotlist-chip] *{animation:none !important}}',
      ].join('');

      function injectChipCss() {
        if (typeof document === 'undefined') return;
        if (document.querySelector(`[${CHIP_STYLE_ATTR}]`) !== null) return;
        const style = document.createElement('style');
        style.setAttribute(CHIP_STYLE_ATTR, '');
        style.textContent = CHIP_CSS;
        (document.head ?? document.documentElement).appendChild(style);
      }

      function removeChipCss() {
        if (typeof document === 'undefined') return;
        const style = document.querySelector(`[${CHIP_STYLE_ATTR}]`);
        if (style !== null) style.remove();
      }

      /** sessionId -> the timeout that ends that pill's single shot. */
      const chipBursts = new Map();
      let chipTimer = null;

      function publishBursts() {
        topbarModel = { ...topbarModel, bursts: new Map(chipBursts) };
        notifyTopbar();
      }

      function stopChipBurst(sessionId) {
        const timer = chipBursts.get(sessionId);
        if (timer === void 0) return;
        clearTimeout(timer);
        chipBursts.delete(sessionId);
      }

      function startChipBurst(chip) {
        const timer = setTimeout(() => {
          stopChipBurst(chip.id);
          publishBursts();
        }, MOTION_MS[chip.motion] ?? 1200);
        chipBursts.set(chip.id, timer);
        publishBursts();
      }

      /**
       * The same lottery the sidebar runs (`motionBursts`), one roll per pill per
       * second: `glyph.frequency` is the chance of a hit, `MOTION_CONCURRENCY`
       * caps how many play at once, and a hit is one single shot — never a
       * permanently spinning glyph. Reduced motion and a hidden window start
       * nothing at all.
       */
      function bandBursts() {
        if (topbarModel.chips.length === 0) return;
        if (typeof document !== 'undefined' && document.hidden === true) return;
        const settings = readSettings();
        if (settings.display.reduceMotion === 'on') return;
        for (const chip of topbarModel.chips) {
          if (chipBursts.has(chip.id)) continue;
          if (chipBursts.size >= MOTION_CONCURRENCY) break;
          if (chip.motion === void 0 || chip.motion === 'none') continue;
          const frequency = typeof chip.frequency === 'number' ? chip.frequency : 0;
          if (frequency <= 0) continue;
          if (Math.random() >= frequency) continue;
          startChipBurst(chip);
        }
      }

      function mountTopbar() {
        if (topbarEntry !== null) return;
        if (ctx.slots.spec(TOPBAR_SLOT) === undefined) return;
        const dispose = ctx.slots.register({
          name: TOPBAR_SLOT,
          id: TOPBAR_ID,
          order: TOPBAR_ORDER,
          locale: NS,
          label: () => t('surface.topbar'),
        }, TopbarBar);
        topbarEntry = { dispose };
        injectChipCss();
        startTopbarProbe();
        /** One tick at once, so a fresh band moves before the first second is over. */
        bandBursts();
        chipTimer = setInterval(bandBursts, SIDEBAR_TICK_MS);
      }

      function disposeTopbar() {
        clearTopbarProbes();
        if (chipTimer !== null) {
          clearInterval(chipTimer);
          chipTimer = null;
        }
        for (const sessionId of [...chipBursts.keys()]) stopChipBurst(sessionId);
        removeChipCss();
        if (topbarEntry === null) return;
        const entry = topbarEntry;
        topbarEntry = null;
        entry.dispose();
      }

      // =======================================================================
      // The `热表` view: one fixed entry in the view row that shows what the three
      // surfaces decided, plus the sessions they dropped and why. It is a table
      // of *the plugin's own decision*, so it reads the same three classifiers
      // the surfaces read instead of keeping a second opinion.
      // =======================================================================

      const VIEW_STYLE_ATTR = 'data-hotlist-view-style';

      const VIEW_CSS = [
        '.hl-view{display:flex;flex-direction:column;gap:10px;padding:16px 20px;font-size:13px;overflow:auto}',
        '.hl-viewLead{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px}',
        '.hl-viewTitle{margin:6px 0 0;font-size:13px;font-weight:600}',
        '.hl-viewEmpty{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px}',
        '.hl-table{width:100%;border-collapse:collapse;table-layout:fixed}',
        '.hl-table th,.hl-table td{padding:5px 8px;text-align:left;border-bottom:.5px solid var(--dsw-alias-border-l2);vertical-align:top}',
        '.hl-table th{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
        '.hl-tableNum{width:48px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
        '.hl-tableWhere{width:150px;color:var(--dsw-alias-label-secondary)}',
        '.hl-tableNote{width:170px;color:var(--dsw-alias-label-secondary)}',
        '.hl-tableTitle{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.hl-tableGlyph{margin-right:4px}',
        '.hl-missingGroups{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none}',
        '.hl-missingGroup{border-radius:6px}',
        '.hl-missingGroup>summary{display:flex;gap:8px;align-items:baseline;cursor:pointer;padding:4px 6px;border-radius:6px;list-style:none}',
        '.hl-missingGroup>summary::-webkit-details-marker{display:none}',
        '.hl-missingGroup>summary:hover{background:rgba(127,127,127,0.08)}',
        '.hl-missingGroupName{font-weight:600}',
        '.hl-missingGroupName::before{content:"▸";display:inline-block;width:12px;transition:transform 160ms ease}',
        '.hl-missingGroup[open] .hl-missingGroupName::before{transform:rotate(90deg)}',
        '.hl-missingGroup[open]>.hl-missingList{animation:hlMissingIn 180ms cubic-bezier(.4,0,.2,1)}',
        '.hl-missingGroupCount{color:var(--dsw-alias-label-secondary);font-size:12px;font-variant-numeric:tabular-nums}',
        '.hl-missingGroupWhy{color:var(--dsw-alias-label-secondary);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.hl-missingList{display:flex;flex-direction:column;gap:4px;margin:4px 0 6px;padding:0 0 0 22px;list-style:none}',
        '.hl-missingList li{display:flex;gap:8px;align-items:baseline}',
        '.hl-missingIndex{color:var(--dsw-alias-label-secondary);font-size:11px;font-variant-numeric:tabular-nums;min-width:18px}',
        '.hl-missingTitle{max-width:46%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.hl-missingWhy{color:var(--dsw-alias-label-secondary);font-size:12px}',
        '.hl-missingHint{color:var(--dsw-alias-label-secondary);font-size:12px;margin:0 0 6px}',
        '@keyframes hlMissingIn{from{transform:translateY(-4px)}to{transform:translateY(0)}}',
        '@media (prefers-reduced-motion:reduce){.hl-missingGroupName::before{transition:none}.hl-missingGroup[open]>.hl-missingList{animation:none}}',
      ].join('');

      function injectViewCss() {
        if (typeof document === 'undefined') return;
        if (document.querySelector(`[${VIEW_STYLE_ATTR}]`) !== null) return;
        const style = document.createElement('style');
        style.setAttribute(VIEW_STYLE_ATTR, '');
        style.textContent = VIEW_CSS;
        (document.head ?? document.documentElement).appendChild(style);
      }

      function removeViewCss() {
        if (typeof document === 'undefined') return;
        const style = document.querySelector(`[${VIEW_STYLE_ATTR}]`);
        if (style !== null) style.remove();
      }

      let tableModel = null;
      let tableEntry = null;
      const tableListeners = new Set();

      function notifyTable() {
        for (const listener of [...tableListeners]) listener();
      }

      function computeTable(settings) {
        const snapshot = readSnapshot();
        const measured = seatLimit();
        const limit = settings.maxSeats === 'auto' ? measured : Math.min(settings.maxSeats, measured);
        const topbarLimit = settings.topbar.maxSeats === 'auto'
          ? Math.max(1, Math.min(MAX_SEATS.max, topbarCapacity))
          : Math.max(MAX_SEATS.min, Math.min(settings.topbar.maxSeats, MAX_SEATS.max));
        return hotlistTable(settings, snapshot, {
          now: Date.now(),
          errors,
          completedAt,
          limit,
          topbarLimit,
          bandUp: topbarMountable(settings),
        });
      }

      function publishTable(settings) {
        tableModel = computeTable(settings);
        notifyTable();
      }

      /** Which of the three surfaces name this row, in reading order. */
      function surfaceText(row) {
        const labels = [];
        if (row.surfaces.tab) labels.push(t('view.surface.tab'));
        if (row.surfaces.sidebar) labels.push(t('view.surface.sidebar'));
        if (row.surfaces.topbar) labels.push(t('view.surface.topbar'));
        return labels.length === 0 ? t('view.surface.none') : labels.join(' · ');
      }

      function noteText(note) {
        if (note.code === 'pin') return t('view.note.pin', { level: note.detail });
        if (note.code === 'error') return t('view.note.error', { message: note.detail });
        return t('view.note.current');
      }

      function reasonText(item) {
        return item.reason === 'over-cap'
          ? t('view.reason.over-cap', { limit: item.limit })
          : t(`view.reason.${item.reason}`);
      }

      function tableRowNode(row) {
        const notes = row.notes.map(noteText).join(' · ');
        return h('tr', { key: row.sessionId, 'data-hotlist-table-row': row.sessionId }, [
          h('td', { key: 'index', className: 'hl-tableNum' }, String(row.index)),
          h('td', { key: 'category' }, [
            h('span', { key: 'glyph', className: 'hl-tableGlyph' }, CATEGORY_GLYPHS[row.category] ?? ''),
            t(`settings.category.${row.category}`),
          ]),
          h('td', { key: 'order', className: 'hl-tableNum' }, String(row.order)),
          h('td', { key: 'title', className: 'hl-tableTitle', title: row.title }, row.title),
          h('td', { key: 'where', className: 'hl-tableWhere' }, surfaceText(row)),
          h('td', { key: 'note', className: 'hl-tableNote' }, notes),
        ]);
      }

      /**
       * Reading order of the groups. Fixed on purpose: the reasons are graded —
       * a row cut by the seat cap only missed the list by a little, a child agent
       * never belonged there at all. Sorting by count instead would reshuffle the
       * page between two syncs and make it unreadable.
       */
      const MISSING_REASON_ORDER = Object.freeze([
        'over-cap',
        'scope',
        'surface-off',
        'position-off',
        'no-category',
        'empty',
        'subagent',
      ]);

      /** `missing` rows bucketed by reason, in `MISSING_REASON_ORDER`, empty ones dropped. */
      function groupMissing(items) {
        const buckets = new Map();
        for (const item of items) {
          const bucket = buckets.get(item.reason);
          if (bucket === undefined) buckets.set(item.reason, [item]);
          else bucket.push(item);
        }
        const groups = [];
        for (const reason of MISSING_REASON_ORDER) {
          const rows = buckets.get(reason);
          if (rows === undefined) continue;
          groups.push({ reason, rows });
          buckets.delete(reason);
        }
        // A reason this version does not know about still has to be visible: an
        // unknown bucket is a bug in the classification, not a row to hide.
        for (const [reason, rows] of buckets) groups.push({ reason, rows });
        return groups;
      }

      function missingNode(item, index) {
        return h('li', { key: item.sessionId, 'data-hotlist-missing': item.reason }, [
          h('span', { key: 'index', className: 'hl-missingIndex' }, String(index + 1)),
          h('span', {
            key: 'title',
            className: 'hl-missingTitle',
            title: item.title,
          }, item.title === '' ? t('tab.untitled') : item.title),
          h('span', { key: 'why', className: 'hl-missingWhy' }, reasonText(item)),
        ]);
      }

      function missingGroupNode(group) {
        const first = group.rows[0];
        return h('details', {
          key: group.reason,
          className: 'hl-missingGroup',
          'data-hotlist-missing-group': group.reason,
        }, [
          h('summary', { key: 'sum' }, [
            h('span', { key: 'name', className: 'hl-missingGroupName' }, t(`view.group.${group.reason}`)),
            h('span', { key: 'count', className: 'hl-missingGroupCount' }, String(group.rows.length)),
            h('span', { key: 'why', className: 'hl-missingGroupWhy', title: reasonText(first) }, reasonText(first)),
          ]),
          h('ul', { key: 'rows', className: 'hl-missingList' }, group.rows.map(missingNode)),
        ]);
      }

      function HotlistTableView() {
        const [, setTick] = React.useState(0);
        React.useEffect(() => {
          const listener = () => setTick((value) => value + 1);
          tableListeners.add(listener);
          return () => {
            tableListeners.delete(listener);
          };
        }, []);
        const model = tableModel === null ? computeTable(readSettings()) : tableModel;
        const columns = [
          t('view.col.index'),
          t('view.col.category'),
          t('view.col.order'),
          t('view.col.title'),
          t('view.col.where'),
          t('view.col.note'),
        ];
        return h('div', { className: 'hl-view', 'data-hotlist-table': '' }, [
          h('p', { key: 'lead', className: 'hl-viewLead' }, t('view.lead', { count: model.rows.length, missing: model.missing.length })),
          h('table', { key: 'table', className: 'hl-table' }, [
            h('thead', { key: 'head' }, h('tr', {}, columns.map((label) => h('th', { key: label }, label)))),
            h('tbody', { key: 'body' }, model.rows.map(tableRowNode)),
          ]),
          h('h4', { key: 'missingTitle', className: 'hl-viewTitle' }, t('view.missing', { count: model.missing.length })),
          model.missing.length === 0
            ? h('p', { key: 'none', className: 'hl-viewEmpty' }, t('view.missingNone'))
            : h('p', { key: 'hint', className: 'hl-missingHint' }, t('view.missingHint')),
          model.missing.length === 0
            ? null
            : h('div', { key: 'missing', className: 'hl-missingGroups' }, groupMissing(model.missing).map(missingGroupNode)),
        ]);
      }

      /**
       * `slots.inject` callbacks take no arguments and may run while another slot
       * is being declared — so a registration must first prove its own slot is
       * declared (`ctx.slots.spec(name)`), never assume it from the caller.
       */
      function mountTableView() {
        if (tableEntry !== null) return;
        if (ctx.slots.spec(SLOT) === undefined) return;
        injectViewCss();
        tableEntry = ctx.slots.register({
          name: SLOT,
          id: TABLE_VIEW_ID,
          order: TABLE_VIEW_ORDER,
          locale: NS,
          label: () => t('view.table'),
        }, HotlistTableView);
      }

      function disposeTableView() {
        if (tableEntry !== null) {
          const dispose = tableEntry;
          tableEntry = null;
          dispose();
        }
        tableModel = null;
        removeViewCss();
      }

      const sync = () => {
        const now = Date.now();
        const snapshot = readSnapshot();
        observeCompletion(snapshot, now);
        /**
         * A failure is kept while the run flag still lags behind it. The old rule
         * ("any session that is running has no failure") wiped a failure that
         * arrived during the very turn that failed — a real agent error fires
         * before the status flips back to idle, so the glyph never showed. Only a
         * newer user message makes the previous failure history; see the
         * `api-session/activity` subscription below. The TTL above still bounds it.
         */
        /** Sounds follow the same entries: one per transition, never per repaint. */
        sound?.observe({
          list: snapshot.list,
          statuses: snapshot.statuses,
          errors,
          completedAt,
        }, now);
        /**
         * The popout follows category *entries* (see `observe`), independent of the
         * tab row: turning the tab position off must not silence the overlay.
         */
        popout?.observe({
          list: snapshot.list,
          statuses: snapshot.statuses,
          currentId: snapshot.currentId,
          errors,
          completedAt,
        }, now);
        const settings = readSettings();
        /** A position that is off does not exist: all three off means "hidden", never a fallback. */
        const topbarOn = topbarMountable(settings);
        /**
         * The two surfaces are independent: each one filters by its own
         * `CATEGORY_SURFACES[*].tab` / `[*].topbar`, so turning the band on never
         * takes the tab row away. Both plans are built below, from the same snapshot.
         */
        const tabOn = settings.positions.tab === true;
        if (settings.positions.sidebar === true) sidebar?.start();
        else sidebar?.stop();
        if (!tabOn && !topbarOn) {
          cycleIds = [];
          cycleRing = [];
          cycleCurrent = snapshot.currentId ?? null;
          disposeTabSeats();
          disposeTopbar();
          disposeTableView();
          sidebar?.refresh();
          return;
        }
        const measured = seatLimit();
        const limit = settings.maxSeats === 'auto' ? measured : Math.min(settings.maxSeats, measured);
        /** The band has its own cap: the tab row's width-derived `measured` never feeds it. */
        const topbarLimit = settings.topbar.maxSeats === 'auto'
          ? Math.max(1, Math.min(MAX_SEATS.max, topbarCapacity))
          : Math.max(MAX_SEATS.min, Math.min(settings.topbar.maxSeats, MAX_SEATS.max));
        const plan = planFrom(snapshot, settings, limit, now);
        cycleIds = plan.map((seat) => seat.sessionId);
        const kept = cycleRing.filter((id) => cycleIds.includes(id) || id === snapshot.currentId);
        for (const id of cycleIds) if (!kept.includes(id)) kept.push(id);
        cycleRing = kept;
        cycleCurrent = snapshot.currentId ?? null;
        const present = new Set(snapshot.list.ids);
        restoreRecentSeats(plan, snapshot, limit, now);
        /** The band has its own eligibility: a category off for the tab row may still be on here. */
        publishTopbar(snapshot, settings, topbarOn === true ? planFrom(snapshot, settings, topbarLimit, now, 'topbar') : plan);
        if (topbarOn) mountTopbar();
        else disposeTopbar();
        /** The band is the row now: the seats are gone, and the shrink guard below is tab-only. */
        if (!tabOn) {
          disposeTabSeats();
          disposeTableView();
          sidebar?.refresh();
          return;
        }
        /**
         * A short snapshot must not cost seats: when a session vanished from the
         * list, reread once after `SHRINK_CONFIRM_MS` and only remove its seat
         * if it is missing from both reads. Real-machine report: 5 seats dropped
         * to 2 about 70 s after a switch and never came back.
         */
        if (!departuresArmed && losesSeats(plan, present)) {
          if (shrinkTimer === null) {
            shrinkTimer = setTimeout(() => {
              shrinkTimer = null;
              departuresArmed = true;
              try {
                sync();
              } finally {
                departuresArmed = false;
              }
            }, SHRINK_CONFIRM_MS);
          }
          sidebar?.refresh();
          return;
        }
        publishTable(settings);
        mountTableView();
        mountTabSeats(plan, present);
        tabPlan = plan;
        decorateTabSeats(settings, plan);
        if (tabTimer === null) tabTimer = setInterval(() => decorateTabSeats(readSettings(), tabPlan), SIDEBAR_TICK_MS);
        sidebar?.refresh();
      };

      /** A settings page write (through `window.__HOTLIST_SETTINGS__.set`) recomputes seats and glyphs immediately. */
      ctx.effect(() => onSettingsChange(() => {
        /** The popout never reopens by itself after a settings write: the next entry decides. */
        popout?.settingsChanged();
        sync();
        sidebar?.refresh();
      }), 'hotlist: settings');

      /**
       * Sidebar glyphs read the same stores the row is drawn from, so the glyph
       * and the sidebar can never disagree about a session's state. The adapter
       * owns all of its own nodes, styles and inline overrides; a host DOM that
       * stops matching (miss counter) disables it instead of decorating wrongly.
       */
      ctx.effect(() => {
        if (typeof document === 'undefined') return () => {};
        sidebar = createSidebarAdapter({
          document,
          readSettings,
          readScope: () => {
            const scope = readSettings().scope;
            if (scope === 'workspace' || scope === 'smart') {
              const groups = ctx.get('uiWorkspace')?.workspaces.list.getSnapshot();
              const list = ctx.get('sessions').list.getSnapshot();
              const current = Object.values(list.byId).find((session) => (session.retainedBy?.mainView ?? 0) > 0);
              const group = groups?.items.find((item) => current?.id !== void 0 && item.sessionIds.includes(current.id));
              return { scope, currentWorkspaceIds: group?.sessionIds ?? null };
            }
            return { scope, currentWorkspaceIds: null };
          },
          readSession: (sessionId) => {
            const list = ctx.get('sessions').list.getSnapshot();
            const statuses = ctx.get('uiSession').sessionStatus.getSnapshot();
            return {
              session: list.byId[sessionId],
              status: statuses.get(sessionId),
              error: errors.get(sessionId),
              completedAt: completedAt.get(sessionId),
              pinned: pinnedIdsOf().includes(sessionId),
              children: runningChildren(list, statuses, sessionId),
            };
          },
        });
        /** Started by `sync()` once the `sidebar` position is on; off means no observer, no timer. */
        return () => {
          sidebar?.stop();
          sidebar = null;
        };
      }, 'hotlist: sidebar glyphs');

      /** Broadcast run failures (returned disposer is owned by the plugin effect). */
      ctx.effect(() => ctx.remote.$on('api-session/error', (sessionId, message) => {
        errors.set(sessionId, { message: String(message), at: Date.now() });
        sync();
      }), 'hotlist: run failures');

      /**
       * A newer user message retires the previous failure: that is what "a fresh
       * run makes it history" actually means. Reading the run flag instead wiped
       * failures that arrive during the failing turn itself (see `sync`).
       */
      ctx.effect(() => ctx.remote.$on('api-session/activity', (sessionId, updatedAt) => {
        const failure = errors.get(sessionId);
        if (failure === void 0 || typeof updatedAt !== 'number') return;
        if (updatedAt <= failure.at) return;
        errors.delete(sessionId);
        sync();
      }), 'hotlist: clear a failure when a newer run starts');

      /**
       * The popout overlay: one controller for the whole window, driven by the
       * same settings store as the cards. `asset` is the module loader's own
       * resolver (`dsh-client-modules` lib/client.js:844), so a packaged asset
       * request and a `data:` URL share one path.
       */
      ctx.effect(() => {
        if (typeof document === 'undefined') return () => {};
        popout = createPopoutController({
          getSettings: readSettings,
          openSession: (sessionId) => ctx.get('uiWorkspace').openSession(sessionId),
          isCurrent: (sessionId) => ctx.get('sessions').list.getSnapshot().byId[sessionId]?.retainedBy?.mainView > 0,
          asset: (ref) => require.asset(ref),
          log: (...args) => console.debug('[hotlist] popout', ...args),
        });
        return () => {
          popout?.destroy();
          popout = null;
        };
      }, 'hotlist: popout overlay');

      /** Category sounds: armed by the first sync, so opening the page never rings. */
      ctx.effect(() => {
        sound = createSoundPlayer({
          getSettings: readSettings,
          createAudio: (url) => (typeof Audio === 'function' ? new Audio(url) : null),
          log: (...args) => console.debug('[hotlist] sound', ...args),
        });
        soundPreview = (category) => sound?.preview(category) === true;
        return () => {
          sound = null;
          soundPreview = () => false;
        };
      }, 'hotlist: category sounds');

      /**
       * Keyboard. `fixed` commands are display-only, so every guard lives in the
       * listener: the service has no region/modal/repeat filtering there.
       * `shortcuts` is a soft dependency — without it the seats still mount.
       */
      ctx.inject(['shortcuts'], (scope) => {
        const shortcuts = scope.shortcuts;
        if (shortcuts === undefined) return;
        const log = (...args) => console.debug('[hotlist] shortcut', ...args);
        const keysOf = (code) => (typeof shortcuts.describeBinding === 'function'
          ? shortcuts.describeBinding({ code, modifiers: ['alt', 'shift'] }).keys
          : undefined);
        const register = (id, code, label) => ctx.effect(() => shortcuts.registerFixed({
          id,
          label,
          keys: keysOf(code),
          bindings: [{ code, modifiers: ['alt', 'shift'] }],
          group: 'application',
        }), `hotlist: ${id}`);
        // `label` is a thunk here: the host calls `command.label()` when it builds
        // its catalog (dsh-client-shortcuts/lib/client.js:1190, :1249). Passing the
        // translated string throws `TypeError: command.label is not a function` and
        // takes the whole web boot down with it.
        register('hotlist.cycle.prev', 'BracketLeft', () => t('shortcuts.cyclePrev'));
        register('hotlist.cycle.next', 'BracketRight', () => t('shortcuts.cycleNext'));
        register('hotlist.overlay.once', OVERLAY_CODE, () => t('shortcuts.overlayOnce'));

        /**
         * Walk the live seats. `direction` -1 is `[`, +1 is `]`; a current session
         * that owns no seat enters at the end for `[` and at the start for `]`,
         * and both ends wrap.
         */
        const cycleSeat = (direction) => {
          if (cycleIds.length === 0) return null;
          const base = cycleRing.length > 0 ? cycleRing : cycleIds;
          const anchor = cycleCurrent !== null && base.includes(cycleCurrent)
            ? cycleCurrent
            : (cycleLast !== null && base.includes(cycleLast) ? cycleLast : null);
          if (anchor === null) return direction < 0 ? cycleIds[cycleIds.length - 1] : cycleIds[0];
          const start = base.indexOf(anchor);
          for (let step = 1; step <= base.length; step += 1) {
            const slot = ((start + direction * step) % base.length + base.length) % base.length;
            const candidate = base[slot];
            if (cycleIds.includes(candidate)) return candidate;
          }
          return null;
        };

        ctx.effect(() => shortcuts.observeFixedInput((input) => {
          if (input.type === 'reset') return;
          const { gesture, context } = input;
          if (gesture.repeat || gesture.composing || gesture.defaultPrevented) return;
          if (gesture.control || gesture.meta) return;
          if (context.region !== 'page') return;
          /** Menus and dialogs own the keyboard while they are up (modalSelector includes role=menu). */
          if (context.modal !== null) return;
          const settings = readSettings();
          const manual = settings.shortcuts.overlayEnabled === true
            && gesture.alt === true && gesture.shift === true && gesture.code === OVERLAY_CODE;
          if (manual) {
            input.consume();
            const shown = popout?.manual() === true;
            log('overlay', shown ? 'shown' : 'nothing to show');
            return;
          }
          if (gesture.alt !== true || gesture.shift !== true) return;
          if (gesture.code !== 'BracketLeft' && gesture.code !== 'BracketRight') return;
          const target = cycleSeat(gesture.code === 'BracketLeft' ? -1 : 1);
          if (target === null) return;
          input.consume();
          cycleLast = target;
          log('cycle', gesture.code === 'BracketLeft' ? 'prev' : 'next', '->', target);
          openSession(target);
        }), 'hotlist: shortcut input');
      });

      /** The entry other assistants script against; see `docs/EXTENDING.md`. */
      try {
        window.__HOTLIST__ = {
          ...createHotlistApi({
            getSettings: readSettings,
            writeSettings,
            resetSettings,
            resetCategory,
            onSettingsChange,
            preview: (category) => soundPreview(category),
          }),
          /** Read-only probe for the acceptance run; see `docs/ARCHITECTURE.md` §18. */
          topbar: () => ({
            mounted: topbarEntry !== null,
            mode: topbarModel.mode,
            titleMode: topbarModel.titleMode,
            left: topbarModel.left,
            leftSource: leftSource(),
            measured: measuredLeft(),
            reserve: topbarModel.reserve,
            currentId: topbarModel.currentId,
            capacity: topbarCapacity,
            chips: topbarModel.chips.map((chip) => ({ id: chip.id })),
          }),
          /** Read-only probe: run the exporter from the console without the settings page. */
          /**
           * The console entry point: without liveExportInput() a bare call has no ids and
           * returns an empty array, which reads as "the exporter is broken". Merge order keeps
           * the caller's explicit fields (ids, scope, …) in charge.
           */
          export: (opts = {}) => exportSessions({ ...liveExportInput(), ...opts }),
        };
      } catch {
        // a locked-down window keeps the settings surface only
      }

      /**
       * `slots.inject` waits for the conversation UI to declare the slot and
       * collects the returned cleanup in the plugin's effect scope
       * (dsh-client-ui-renderer lib/client.js:1368-1427).
       */
      ctx.slots.inject(SLOT, () => {
        const stopList = ctx.get('sessions').list.subscribe(sync);
        const stopStatus = ctx.get('uiSession').sessionStatus.subscribe(sync);
        const stopGroups = ctx.get('uiWorkspace')?.workspaces.list.subscribe(sync);
        const timer = setInterval(sync, REFRESH_MS);
        let resizeTimer = 0;
        const onResize = () => {
          clearTimeout(resizeTimer);
          resizeTimer = setTimeout(sync, RESIZE_DEBOUNCE_MS);
        };
        const listensResize = typeof window !== 'undefined' && typeof window.addEventListener === 'function';
        if (listensResize) window.addEventListener('resize', onResize);
        sync();
        return () => {
          clearInterval(timer);
          clearTimeout(resizeTimer);
          if (listensResize) window.removeEventListener('resize', onResize);
          stopList();
          stopStatus();
          stopGroups?.();
          disposeTabSeats();
          disposeTableView();
          flushCompletedAt();
        };
      });

      /**
       * The band lives in `shell.overlay`: absolute, full-window, z-index 20. Its
       * `order` is -10 so toasts still paint above it; the entry itself never paints.
       */
      ctx.slots.inject(TOPBAR_SLOT, () => {
        sync();
        return () => {
          disposeTopbar();
        };
      }, 'hotlist: top bar');
    }

    return {
      inject: ['slots', 'remote', 'sessions', 'uiSession', 'locale'],
      apply,
      classify,
      sortSeats,
      buildSeatPlan,
      hotlistTable,
      TABLE_VIEW_ID,
      TABLE_VIEW_ORDER,
      isSeatViewId,
      CATEGORY_IDS,
      exportSessions,
      orderedCategories,
      categoryAllOff,
      CATEGORY_GLYPHS,
      defaultSettings,
      defaultCategory,
      sanitizeSettings,
      sanitizeCategory,
      sanitizeChoices,
      choicesFromPatch,
      migrateFromV3,
      migrateSettings,
      positionsOf,
      hasWindowsTitlebar,
      chipWidthOf,
      fitChipCount,
      TOPBAR_SLOT,
      TOPBAR_ID,
      TOPBAR_ORDER,
      TOPBAR_MODES,
      TOPBAR_RESERVE,
      tokenGlyph,
      tokenMotion,
      tokenPriority,
      glyphOf,
      emojiOf,
      resolveStateGlyph,
      readSettings,
      writeSettings,
      resetSettings,
      resetCategory,
      overrideSettings,
      sidebarStateOf,
      findRowTitle,
      createSidebarAdapter,
      shortenTitle,
      labelOf,
      snapshot,
      onSettingsChange,
      glyphUploadReject,
      soundUploadReject,
      toGlyphDataUrl,
      toDataUrl,
      sanitizeAssets,
      assetBytes,
      trimAssetBudget,
      fnv1a,
      pickIndex,
      randomIndex,
      pickPopoutArt,
      pickSoundUrl,
      BUILTIN_SOUND,
      SOUND_CATEGORIES,
      createSoundPlayer,
      createHotlistApi,
      ASSET_POOL_MAX,
      POPOUT_MAX_BYTES,
      SOUND_MAX_BYTES,
      SOUND_THROTTLE_MS,
      SOUND_URL,
      HotlistSettingsPage,
      tierFor,
      sizeFor,
      assetRef,
      fallbackRef,
      dropDistance,
      mountPopout,
      makeResolveAsset,
      resolvePopoutSide,
      createPopoutController,
      POPOUT_PRIORITY,
      POPOUT_COOLDOWN_MS,
      leadingEmoji,
      leadingEmojiRun,
      ownEmoji,
      isEmojiOnly,
      stripLeadingEmoji,
      labelParts,
      customIconWins,
      TITLE_MODE_ALIASES,
      TOPBAR_TITLE_MODES,
      bandHeight,
      menuStartValue,
      fallbackLeft,
      measuredLeft,
      occupiedLeft,
      bandLeft,
      leftSource,
    };
  },
});