/**
 * 热表 / Hot List — Host half.
 *
 * Two jobs:
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
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Prefix this plugin owns on the host Web server. */
const SOUND_ROUTE = "/hotlist-sound";

/** Directory holding the bundled cues, resolved next to this file. */
const SOUND_DIR = join(dirname(fileURLToPath(import.meta.url)), "assets", "sounds");

/** Media type per served extension; anything else answers 404. */
const SOUND_MEDIA_TYPES = new Map([
  [".mp3", "audio/mpeg"],
  [".wav", "audio/wav"],
  [".ogg", "audio/ogg"],
  [".m4a", "audio/mp4"],
]);

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
 * Mount the sound route once a Web server exists; without one (a headless
 * profile) the plugin still loads, cues simply stay silent.
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
  });
}

export { apply, SOUND_ROUTE };