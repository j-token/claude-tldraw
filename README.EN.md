# claude-tldraw

English · [한국어](README.md)

A Claude Code plugin for drawing on a tldraw canvas. When Claude draws a diagram in tldraw, it shows up right inside a Claude Code pane, with no browser window.

- **See it in the pane**: in a terminal, the drawing is rendered with block characters and the labels are drawn on top as real terminal text, so text (including Korean) stays sharp. In the Code tab of Claude Desktop it is shown as SVG.
- **Navigate**: drag to pan, scroll to zoom at the cursor. Click the drawing, then use `←↑↓→`, `+`, `-`, `f` (fit) and `d` (dark mode).
- **Saved locally**: the canvas is saved on your machine and is still there next session.
- **Includes the official tldraw.com MCP**: sign in to your tldraw.com account and Claude can list your boards, create new boards, and look at board screenshots.

## Install

In Claude Code:

```
/plugin marketplace add j-token/claude-tldraw
/plugin install tldraw@claude-tldraw
```

Then ask something like "draw our service architecture in tldraw", or open the pane with `/tldraw`.

To use the tldraw.com tools, pick `tldraw-com` in `/mcp` and sign in once (optional).

## Requirements

- Claude Code v2.1.287 or later (mods support), in a terminal or the Code tab of Claude Desktop
- Node.js 18 or later (`node` on your PATH)
- A Chromium-based browser: Microsoft Edge or Google Chrome. It only runs headless; no window is ever shown. If it is installed somewhere unusual, set the `TLDRAW_BROWSER` environment variable to its executable.
- tldraw fonts are downloaded from the internet the first time it runs.

## How it works

```
Claude ──mcp__tldraw__exec──▶ mod (hooks/register.tsx)
                                 │ HTTP (127.0.0.1:7717, token auth)
                                 ▼
                         server/server.mjs ──▶ headless Edge/Chrome
                                 ▲                 └ tldraw 5 (server/dist/app.js)
                                 └── cells/labels ◀──┘
mod ──Raster + text overlay──▶ Claude Code pane
```

- Closing the pane also stops the server and the headless browser. They also stop on their own after 30 minutes of no use.
- The server listens on `127.0.0.1` only and rejects any request without the token it generates on each start.
- Data location: `CLAUDE_PLUGIN_DATA`, or `~/.claude/plugins/data/tldraw` when that is not set.

## Development

```
plugins/tldraw/
├─ .claude-plugin/plugin.json   manifest (includes the tldraw.com MCP)
├─ hooks/                       the mod: register.tsx, canvas-input.ts, tests
└─ server/
   ├─ server.mjs                dependency-free local server
   ├─ index.html
   ├─ dist/                     prebuilt page bundle (committed)
   └─ web/                      bundle source (src/main.js)
```

After changing the page bundle:

```
cd plugins/tldraw/server/web
npm install
npm run build
```

Checks:

```
claude plugin validate plugins/tldraw
claude plugin test plugins/tldraw
claude --plugin-dir plugins/tldraw     # load it for one session to try it
```

## License

This plugin bundles the [tldraw SDK](https://tldraw.dev). The tldraw SDK is under the [tldraw license](https://tldraw.dev/community/license); running it on localhost counts as development use, so no license key is needed.
