# Third-party player libraries

Loaded on demand by `js/channel-player.js` the first time a channel is opened —
no page downloads them before that. They are kept here, next to the site, so the
channel player never depends on an outside CDN.

| File | Library | Version | Licence | Used for |
| --- | --- | --- | --- | --- |
| `hls.min.js` | [hls.js](https://github.com/video-dev/hls.js) | 1.6.19 | Apache-2.0 (`hls.LICENSE.txt`) | HLS (`.m3u8`) channels |
| `mpegts.min.js` | [mpegts.js](https://github.com/xqq/mpegts.js) | 1.8.2 | Apache-2.0 (`mpegts.LICENSE.txt`, `mpegts.js.LICENSE.txt`) | MPEG-TS (`.ts`, Xtream) and FLV channels |

To update: `npm pack hls.js mpegts.js`, then copy `dist/hls.min.js` and
`dist/mpegts.js` (renamed `mpegts.min.js`) here and remove the trailing
`sourceMappingURL` comment.
