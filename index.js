/**
 * 热表 / Hot List — Host half.
 *
 * Three jobs:
 *
 *  1. Load the web client half (see client.js), which draws the session seats
 *     in the conversation tab row, the sidebar state markers and the settings
 *     page.
 *  2. Serve the bundled sound cues. The client package-asset route only knows
 *     image media types (`@deepseek-ai/dsh-client-modules` PACKAGE_ASSET_MEDIA_TYPES:
 *     .svg/.png/.webp/.jpg/.jpeg), so `.mp3` there answers 404 and a sound can
 *     never reach an `<audio>`/WebAudio decode. This route hands the same files
 *     out as `audio/mpeg` instead. User-uploaded cues are data URLs and do not
 *     come through here.
 *  3. Ring the whole screen once (`tools/attn-ring/Show-AttnRing.ps1`). The ring
 *     is a WPF process, so it cannot start from the browser: the client half
 *     only asks, this half spawns. Every failure stays a `console.debug` line —
 *     a machine without `pwsh`, or an install without the script, must still
 *     boot the plugin.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Prefix this plugin owns on the host Web server. */
const SOUND_ROUTE = "/hotlist-sound";

/** Prefix for the one-shot full-screen ring trigger. GET only, one header required. */
const RING_ROUTE = "/hotlist-ring";

/** Directory holding the bundled cues, resolved next to this file. */
const SOUND_DIR = join(dirname(fileURLToPath(import.meta.url)), "assets", "sounds");

/** The ring script ships inside the package, so an installed copy works on its own. */
const RING_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "tools", "attn-ring", "Show-AttnRing.ps1");

/** The only three parameters the script implements; the rest of its tail is inert. */
const RING_SECONDS = { min: 1, max: 30, fallback: 4 };
const RING_SCOPES = ["Primary", "All"];
const RING_ANIMS = ["Expand", "Breathe", "None"];

/** One ring per this window: a burst of state changes must not stack processes. */
const RING_COOLDOWN_MS = 2500;

/** Media type per served extension; anything else answers 404. */
const SOUND_MEDIA_TYPES = new Map([
  [".mp3", "audio/mpeg"],
  [".wav", "audio/wav"],
  [".ogg", "audio/ogg"],
  [".m4a", "audio/mp4"],
]);

/** Last time a ring was started, in ms; the cooldown reads it. */
let ringLastAt = -Infinity;

/** Bare file name of a cue URL, or undefined when the name is not a plain file of a served type. */
function servedName(pathname) {
  if (!pathname.startsWith(`${SOUND_ROUTE}/`)) return undefined;
  const name = decodeURIComponent(pathname.slice(SOUND_ROUTE.length + 1));
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return undefined;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return undefined;
  return SOUND_MEDIA_TYPES.has(name.slice(dot).toLowerCase()) ? name : undefined;
}

/** Answer one cue request; unknown or unreadable cues answer 404. */
async function serveSound(request) {
  const name = servedName(new URL(request.url).pathname);
  if (name === undefined) return new Response(null, { status: 404 });
  let body;
  try {
    body = await readFile(join(SOUND_DIR, name));
  } catch {
    return new Response(null, { status: 404 });
  }
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": SOUND_MEDIA_TYPES.get(name.slice(name.lastIndexOf(".")).toLowerCase()),
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * Turn a query into script arguments, or a reason to refuse. Pure: the three
 * values are clamped to what the script accepts, never passed through raw, so a
 * stray `?seconds=99999` cannot hold the screen for five hours.
 */
function ringArgs(query) {
  const rawSeconds = Number(query.get("seconds"));
  const seconds = Number.isFinite(rawSeconds) ? Math.round(rawSeconds) : RING_SECONDS.fallback;
  const scope = query.get("scope");
  const anim = query.get("anim");
  return {
    seconds: Math.min(RING_SECONDS.max, Math.max(RING_SECONDS.min, seconds)),
    scope: RING_SCOPES.includes(scope) ? scope : RING_SCOPES[0],
    anim: RING_ANIMS.includes(anim) ? anim : RING_ANIMS[0],
  };
}

/** The exact argv the script is started with; also what a test asserts on. */
function ringCommand(args, scriptPath = RING_SCRIPT) {
  return {
    script: scriptPath,
    argv: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-Seconds", String(args.seconds), "-Scope", args.scope, "-Anim", args.anim],
  };
}

/** The `pwsh` this host would start, or null when the machine has none on PATH. */
function resolvePwsh(env = process.env) {
  const fromEnv = typeof env.DSH_PWSH === "string" && env.DSH_PWSH !== "" ? env.DSH_PWSH : null;
  if (fromEnv !== null) return fromEnv;
  return "pwsh";
}

/**
 * Start the ring process and forget about it.
 *
 * Two option choices carry a whole afternoon of measuring:
 *
 *  - `stdio: "ignore"`: this machine's sandbox refuses named pipes, so
 *    `stdio: "pipe"` fails with EPERM before the process exists.
 *  - **no `detached`**: measured on 2026-11-14 — a `detached: true` child of
 *    this host starts, exits ~200 ms later with code 0 and never runs the
 *    script (same argv, `detached` removed, runs fine). The ring simply never
 *    appeared. Do not "improve" this by detaching.
 *
 * The `error` listener is mandatory: an unhandled `error` event on a
 * ChildProcess kills the whole host.
 */
function spawnRing(options) {
  const { args, scriptPath, log } = options;
  const start = typeof options.spawn === "function" ? options.spawn : spawn;
  if (existsSync(scriptPath) === false) {
    log("ring script missing", scriptPath);
    return false;
  }
  const built = ringCommand(args, scriptPath);
  let child;
  try {
    child = start(resolvePwsh(), built.argv, { stdio: "ignore", windowsHide: true });
  } catch (thrown) {
    log("ring spawn threw", thrown instanceof Error ? thrown.message : String(thrown));
    return false;
  }
  if (child === undefined || child === null) {
    log("ring spawn returned nothing");
    return false;
  }
  if (typeof child.on === "function") {
    child.on("error", (thrown) => log("ring spawn failed", thrown instanceof Error ? thrown.message : String(thrown)));
  }
  if (typeof child.unref === "function") child.unref();
  log("ring started", `${args.seconds}s`, args.scope, args.anim);
  return true;
}

/**
 * One ring request. Three gates, cheapest first: the marker header (a plain
 * `<img src>` from a foreign page cannot set it), the cooldown, then the spawn.
 */
function serveRing(request, deps = {}) {
  const log = typeof deps.log === "function" ? deps.log : (message, ...rest) => console.debug("[hotlist]", message, ...rest);
  try {
    if (request.headers.get("x-hotlist-ring") !== "1") {
      return Response.json({ ok: false, reason: "no-marker" }, { status: 403 });
    }
    const now = Date.now();
    if (now - ringLastAt < RING_COOLDOWN_MS) {
      log("ring cooling", now - ringLastAt);
      return Response.json({ ok: false, reason: "cooling" }, { status: 429 });
    }
    const args = ringArgs(new URL(request.url).searchParams);
    const started = spawnRing({
      args,
      scriptPath: deps.scriptPath ?? RING_SCRIPT,
      log,
      spawn: deps.spawn,
    });
    if (started === false) return Response.json({ ok: false, reason: "not-started" }, { status: 503 });
    ringLastAt = now;
    return Response.json({ ok: true, ...args });
  } catch (thrown) {
    log("ring request failed", thrown instanceof Error ? thrown.message : String(thrown));
    return Response.json({ ok: false, reason: "error" }, { status: 500 });
  }
}

/**
 * Mount the two routes once a Web server exists; without one (a headless
 * profile) the plugin still loads, cues stay silent and the ring never fires.
 */
function apply(ctx) {
  ctx.inject(["webServer"], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: "prefix",
          path: SOUND_ROUTE,
          resource: (request) => serveSound(request),
        }),
      "hotlist: bundled sound cues",
    );
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: "prefix",
          path: RING_ROUTE,
          resource: (request) => serveRing(request),
        }),
      "hotlist: full-screen ring",
    );
  });
}

export { apply, RING_ANIMS, RING_ROUTE, RING_SCRIPT, RING_SCOPES, SOUND_ROUTE, ringArgs, ringCommand, serveRing, spawnRing };
