# Dependency patches

`npm run postinstall` applies the versioned patches through `patch-package`.
The lockfile fixes the dependency versions. An upgrade that invalidates a
patch must be reviewed rather than silently skipping it.

An application overlay over an older image must also include any affected
patched dependency files, or rebuild from the public Dockerfile. Copying only
`src` and `dist` does not apply `patch-package`. Copy the complete tracked
`src` tree, including shared runtime modules outside `src/server`. Check the changed dependency's
actual patched bytes in the target image; an unchanged package version alone
is insufficient. Do not reinstall unrelated dependencies or repeat the plugin
acceptance matrix for this check.

## rss-feed-emitter 3.2.4

Used by `koishi-plugin-rss@3.0.1`. With `skipFirstLoad: true`, the upstream
`FeedManager.getContent()` never cleared `feed.failedFirstLoad` after a
successful fetch. Every subsequent poll was therefore still treated as the
first load and suppressed new-item notifications.

The patch clears that flag after any successful load, while preserving the
existing conditional `initial-load` event. It keeps first-load backlog
suppression and permits later new items. The local HTTP-feed integration
test covers subscription, later update notification, and restart restoration.
The Feed URL/homepage mapping requires no patch: `Feed.fetchData()` already
sets `item.meta.link` to the fetched feed URL.

The same patch clears the emitter's tracked deduplication timeouts in
`destroy()`. The RSS validator uses a long refresh interval; upstream stopped
its polling interval but left that timeout referenced, preventing normal
process shutdown even after successful validation and app stop.

This does not replace the emitter or add another polling loop. It is fixed to
3.2.4; the newer 4.x major is not silently substituted.

Upstream: <https://github.com/filipedeschamps/rss-feed-emitter>.

## koishi-plugin-rss 3.0.1

The pinned emitter also offers the optional local
`groupweave/rss-before-broadcast` lifecycle hook. The GroupWeave host uses
Koishi's existing `serial` event to filter the original targets using current
group policy and collect only approved prepared notification text. Returned
targets must be a subset; invalid results or hook failures withhold the batch.
Without a host listener the ordinary upstream broadcast remains unchanged.
This single adapter hook replaces context/prototype broadcast interception,
which did not cover the actual deployed emitter. It adds no scheduler or event
bus and must be included with the host source when deploying an overlay.

The upstream new-item announcement now appends the item's `payload.link` only
when it parses as an HTTP or HTTPS URL with a hostname and no embedded user
credentials. Missing authors are omitted instead of being rendered as
`null`/`undefined`. The message is broadcast as `h.text`, so feed-supplied text
remains a text segment rather than Koishi markup. No feed body or URL is
fetched by this patch, and it adds no polling behavior. The native RSS test
uses a local feed to verify the delivered item URL, absent author, and text
segment behavior.

Upstream: <https://github.com/koishijs/koishi-plugin-rss>.

## file-type 16.5.4

The existing Telegram adapter compatibility patch is retained. This utility
batch does not change its behavior.

## @satorijs/adapter-telegram 4.5.11

Resolve Telegram remote file paths as absolute URLs beneath the configured
file endpoint. Select the largest incoming photo without reordering the raw
Telegram photo list. Recognize offset-zero `bot_command` entities in media captions.
For a top-level command caption, keep the original update metadata for command
handlers but omit the media segment from parsed command content, so it does not
become an extra positional argument. Quoted messages keep their normal media
elements and quote data. Failed attachment fetches skip the unavailable media
segment while retaining the original update; asynchronous update failures are
caught so polling continues. Failure logs do not print error objects that may
contain bot credentials. A focused test exercises the upstream handler and
Satori file interceptor against a local server, including command arguments,
quoted media, failed downloads, and polling recovery.

## koishi-plugin-video-to-gif 1.2.2

The upstream converter and command remain in use. A small pinned patch:

- accepts Telegram's default `data:video/*;base64` input using Koishi's
  `http.file`, with a decoded-size check before processing data URIs;
- compares interactive upload chat/user against the original command session
  (upstream accidentally compares each value with itself), and clears the
  timer when a video is accepted;
- adds `/cancelv2g`, scoped to the current bot/chat/user, and a 60-second task
  deadline; cancellation clears the upload waiter, passes an AbortSignal to
  HTTP downloads, kills the active FFmpeg child, and suppresses the old result;
- cleans temporary input/output files in `finally`, including failures;
- reports a fixed error rather than logging URLs or provider error bodies.

Tests include real FFmpeg conversion and the native host's real HTTP data-URI
helper and Telegram animation encoder. Telegram network delivery remains
separate acceptance. HTTP downloads are still buffered before the size check.
If GIF upload has already started, cancellation or the deadline stops waiting
but cannot retract the Telegram request.

The transitive `fluent-ffmpeg` dependency is deprecated upstream. It is retained
for this pinned compatibility slice; dependency review and a maintained
replacement, if needed, belong to the existing final hardening work.

## koishi-plugin-markdown-to-image-service 2.7.0

Keep the original renderer, KaTeX, Mermaid and bundled assets. The adapter loads
its exported Koishi service rather than publishing upstream's ungated commands.
The patch disables raw HTML, uses strict Mermaid rendering, blocks page requests
except about/data/blob, limits rendered height to 8000 px and closes pages after
30 seconds. Input/output bounds and one-at-a-time admission live in the command
adapter. Page cleanup tolerates a page already closed by its deadline.

## koishi-plugin-puppeteer 3.9.0

Koishi may withdraw the Puppeteer provider before the child canvas service
stops. Canvas shutdown now checks the page's own browser reference, tolerating
a close error only when the page is closed, the browser is disconnected or its
target no longer exists. Errors closing a still-live page remain errors. This
fixes a reproducible `Target.closeTarget` error after native-host rendering,
without changing rendering algorithms or disabling the browser sandbox.

## koishi-plugin-video-parser-all 1.7.7

Keep upstream API response parsing and site rules. When debug logging is off,
problem logs use a fixed message instead of source URLs or raw API errors. The
adapter never enables debug logging. This avoids per-request mutation of module
exports. The versioned internal service import is a documented upgrade seam.
