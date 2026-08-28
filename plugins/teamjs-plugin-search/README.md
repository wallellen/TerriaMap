# terriajs-plugin-search (workspace)

This is a minimal TerriaJS plugin skeleton created inside the TerriaMap repository as a workspace at `plugins/teamjs-plugin-search`.

It exports a plugin with a `register(pluginContext)` function. The register function attaches a `showSearchPanel` boolean and `toggleSearchPanel()` method onto the provided `viewState` so the host application can render a search panel UI.

Notes:
- The package name is `terriajs-plugin-search` to follow TerriaJS plugin naming conventions so the build tooling can detect plugin assets (icons, etc.).
- Run `yarn` (with workspaces enabled) at the repository root to install dependencies and make this package resolvable by package name.
- This is a skeleton: the UI components (React) should be added in the host app or inside the plugin and registered via the plugin API.
