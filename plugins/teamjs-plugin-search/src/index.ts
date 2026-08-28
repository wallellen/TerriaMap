export const name = "terriajs-plugin-search";

export default {
  name,
  register(pluginContext: any) {
    // The pluginContext is created by createPluginContext(viewState) inside TerriaMap.
    // We expose a simple toggle on the viewState so the host app can render the UI.
    try {
      const { viewState } = pluginContext;
      if (viewState) {
        // initialise flags/functions used by the UI
        viewState.showSearchPanel = false;
        viewState.toggleSearchPanel = () => {
          viewState.showSearchPanel = !viewState.showSearchPanel;
        };
      }
      // Simple log for debugging
      // eslint-disable-next-line no-console
      console.log(`${name} registered`);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`Error registering ${name}:`, e);
    }
  }
};
