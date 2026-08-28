import React from "react";
import { createRoot } from "react-dom/client";
import SearchPanel from "./SearchPanel";

export const name = "terriajs-plugin-search";

export default {
  name,
  register(pluginContext) {
    try {
      const { viewState, terria } = pluginContext;
      if (viewState) {
        viewState.showSearchPanel = false;
        viewState.toggleSearchPanel = () => {
          viewState.showSearchPanel = !viewState.showSearchPanel;
        };
      }

      // Mount a React container to the document body so the plugin's UI can render.
      // We create a container element once per page.
      const containerId = "terriajs-plugin-search-root";
      let container = document.getElementById(containerId);
      if (!container) {
        container = document.createElement("div");
        container.id = containerId;
        document.body.appendChild(container);
      }

      // Render the SearchPanel React component into the container.
      // We pass terria and viewState so the panel can interact with the host app.
      const root = createRoot(container);
      root.render(<SearchPanel terria={terria} viewState={viewState} />);

      // eslint-disable-next-line no-console
      console.log(`${name} registered`);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`Error registering ${name}:`, e);
    }
  }
};
