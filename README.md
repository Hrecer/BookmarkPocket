# BookmarkPocket

A bookmark manager for Chrome and Edge — with the option to let an AI assistant do the tidying for you.

It works on the browser's own bookmarks. Nothing is copied anywhere else, so there is no shadow database, no sync conflict, and no second copy that quietly goes stale. Deleting means deleting, exactly like the browser does it.

## Features

- **A proper manager** — folder tree, sortable list, details pane, search, inline rename, multi-select, drag & drop, cut / copy / paste, one-step undo.
- **Light and dark** — follows your system by default, and can be pinned either way.
- **Bookmarks land where they belong** — rules route a new bookmark to the right folder the moment it is saved, so the browser's "last used folder" stops deciding for you. A catch-all sends everything else to the bookmarks bar.
- **AI can drive it** — ask an assistant to search, create, rename, move or delete bookmarks for you. Bulk operations move thousands of items in a single step, and the assistant can write the routing rules too.
- **No junk in your bookmarks** — the app never creates extra folders or a recycle bin. The undo history is kept outside your bookmark tree.

## Install

1. **Load the extension** — open `edge://extensions` (or `chrome://extensions`), enable Developer mode, click *Load unpacked*, and select the `extension/` folder.
2. **Start the local hub** — `cd mcp && npm install && npm start`. On first run it creates `config.json` and prints the path.
3. **Pair** — open the manager, go to **Settings**, and click **One-click pairing**. The port and token are filled in for you.

That's the whole setup. From then on the extension reconnects on its own.

## Using it

Click the toolbar icon to open the manager.

| Action | How |
| --- | --- |
| Select | single click (Ctrl to toggle, Shift for a range) |
| Open | double click, or Enter |
| Back / up | Backspace |
| Search | Ctrl+F |
| Rename | F2, or click a selected name again |
| New folder / bookmark | Ctrl+Shift+N |
| Undo | Ctrl+Z |
| Refresh | F5 |
| Clear selection | Esc, or click empty space |

Deleting is permanent, just like the browser's own delete. Every write keeps an undo record, so **Undo** brings it back.

## Routing new bookmarks

The **Rules** tab decides where newly saved bookmarks go. Rules are checked top to bottom — first match wins — and anything unmatched falls through to the fallback folder (the bookmarks bar by default).

A rule is a match plus a target folder:

| Match | Target |
| --- | --- |
| Domain `example.com` | `Bookmarks bar > 示例分类` |
| URL contains `example.com/class` | `Bookmarks bar > 示例分类 > Mods` |

Both the switch and the fallback can be turned off in **Settings**; the Rules tab picks target folders straight from your bookmark tree, and missing folders are created on demand.

One limitation worth knowing: the folder dropdown inside the browser's own "Added to bookmarks" popup is not reachable by any extension. The popup may still show the last folder you used, but the bookmark is moved to the right place as soon as it is created.

## Letting an AI assistant manage your bookmarks

Register the MCP server with your host:

```json
{
  "mcpServers": {
    "bookmarkpocket": {
      "command": "node",
      "args": ["<path-to-this-repo>/mcp/src/server.js"]
    }
  }
}
```

The assistant gets 14 tools: read the tree, search, create, rename, move, bulk move, bulk create, delete, undo, check the connection, and read/write the routing rules.

The local hub listens on `127.0.0.1` only, guarded by a token and an origin allowlist.

## Tests

Run from the repository root:

```
node extension/test/ops.smoke.mjs       # operation semantics
node extension/test/bridge.smoke.mjs    # connection handling
node extension/test/keys.smoke.mjs      # storage keys and first-paint theming
node extension/test/rules.smoke.mjs     # routing rules, matching and auto-filing
node extension/test/manager.smoke.mjs   # manager page, end to end
cd mcp && npm test                      # MCP server and hub, full round trip
```

## Repository layout

- `extension/` — the manager extension (MV3)
- `mcp/` — MCP server and local hub

## License

[MIT](LICENSE) © 2026 Hrecer
