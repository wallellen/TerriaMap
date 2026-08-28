import React from "react";
import { createRoot } from "react-dom/client";
import SearchPanel from "./SearchPanel";

export const name = "terriajs-plugin-search";

export default {
  name,
  register(pluginContext: any) {
    try {
      const { viewState, terria } = pluginContext;
      if (viewState) {
        viewState.showSearchPanel = false;
        viewState.toggleSearchPanel = () => {
          viewState.showSearchPanel = !viewState.showSearchPanel;
        };
      }

      const containerId = "terriajs-plugin-search-root";
      let container = document.getElementById(containerId);
      if (!container) {
        container = document.createElement("div");
        container.id = containerId;
        document.body.appendChild(container);
      }

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
