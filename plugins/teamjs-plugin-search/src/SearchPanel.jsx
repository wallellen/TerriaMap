import React, { useEffect, useState } from "react";
import GeoJsonCatalogItem from "terriajs/lib/Models/GeoJsonCatalogItem";
import "./styles.css";

function flattenCatalogMembers(memberOrGroup, out = []) {
  if (!memberOrGroup) return out;
  const members = memberOrGroup.members || memberOrGroup.catalog || memberOrGroup.items || memberOrGroup;
  if (Array.isArray(members)) {
    for (const m of members) {
      if (!m) continue;
      // m may be a plain config object or a Terria CatalogModel instance
      const type = (m.type || (m.__type && m.__type())) || "";
      const url = m.url || m.service && m.service.url || (m.get && m.get("url"));
      const name = m.name || m.title || (m.get && m.get("name"));
      const layer = m.layer || m.layers || m.wmsLayer || m.get && m.get("layers");

      const typeStr = String(type).toLowerCase();
      if (typeStr.includes("wms") || typeStr.includes("wfs") || (url && String(url).toLowerCase().includes("wms"))) {
        out.push(m);
      }
      if (m.members || m.catalog || m.items) {
        flattenCatalogMembers(m, out);
      }
    }
  }
  return out;
}

export default function SearchPanel({ terria, viewState }) {
  const [layers, setLayers] = useState([]);
  const [selectedLayer, setSelectedLayer] = useState(null);
  const [queryText, setQueryText] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Try to get catalog from terria; fallback to configParameters
    let catalogSource = null;
    if (terria && terria.catalog && terria.catalog.members) {
      catalogSource = terria.catalog;
    } else if (terria && terria.configParameters) {
      catalogSource = terria.configParameters.initSources || terria.configParameters;
    }
    const found = flattenCatalogMembers(catalogSource || []);
    setLayers(found);
  }, [terria]);

  useEffect(() => {
    // Hide if viewState is not provided
    if (!viewState || !viewState.showSearchPanel) return;
  }, [viewState && viewState.showSearchPanel]);

  if (!viewState || !viewState.showSearchPanel) return null;

  async function doSearch() {
    if (!selectedLayer) return;
    setLoading(true);
    setResults([]);
    try {
      const getProp = (obj, keys) => keys.reduce((acc, k) => (acc && (acc[k] || acc.get && acc.get(k))) || acc, obj);
      const baseUrl = selectedLayer.url || getProp(selectedLayer, ["service", "url"]);
      const layerName = selectedLayer.layer || selectedLayer.layers || selectedLayer.name || (selectedLayer.get && selectedLayer.get("layers"));
      if (!baseUrl || !layerName) {
        throw new Error("所选图层缺少 url 或 layer 名称，无法查询");
      }

      let wfsBase = baseUrl;
      if (wfsBase.toLowerCase().endsWith("/wms")) {
        wfsBase = wfsBase.slice(0, -4) + "wfs";
      }
      // Default search property — you can adapt this to your layer's searchable attribute
      const propertyName = selectedLayer.queryProperty || "NAME";
      const cql = encodeURIComponent(`${propertyName} ILIKE '%${queryText}%'`);
      const url = `${wfsBase}?service=WFS&version=1.1.0&request=GetFeature&typeName=${encodeURIComponent(layerName)}&outputFormat=application/json&CQL_FILTER=${cql}&count=100`;

      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`查询失败: ${resp.status}`);
      const geojson = await resp.json();
      setResults(geojson.features || []);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(e);
      alert("查询出错: " + e.message);
    } finally {
      setLoading(false);
    }
  }

  function onResultClick(feature) {
    try {
      const item = new GeoJsonCatalogItem(terria);
      item.name = `查询结果: ${feature.id || (feature.properties && (feature.properties.name || feature.properties.title)) || "要素"}`;
      item.isEnabled = true;
      item.geoJson = { type: "FeatureCollection", features: [feature] };
      // Add to terria's workbench/now viewing
      if (terria.addModel) {
        terria.addModel(item);
      } else if (terria.workbench && terria.workbench.add) {
        terria.workbench.add(item);
      } else if (terria.nowViewing && terria.nowViewing.add) {
        terria.nowViewing.add(item);
      }
      if (item.zoomTo) {
        item.zoomTo();
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(e);
    }
  }

  return (
    <div className="tjs-search-panel">
      <div className="tjs-search-header">
        <strong>属性查询</strong>
        <button className="tjs-close-btn" onClick={() => (viewState.showSearchPanel = false)}>关闭</button>
      </div>
      <div className="tjs-search-body">
        <div className="tjs-col tjs-left">
          <div className="tjs-col-title">可查询图层</div>
          <ul className="tjs-layer-list">
            {layers.length === 0 ? <li>未找到 WMS/WFS 图层</li> : null}
            {layers.map((l, i) => (
              <li key={i} className={selectedLayer === l ? "selected" : ""} onClick={() => setSelectedLayer(l)}>
                {l.name || l.title || l.layer || l.layers || (l.get && l.get("name"))}
              </li>
            ))}
          </ul>
        </div>
        <div className="tjs-col tjs-middle">
          <input className="tjs-input" value={queryText} onChange={(e) => setQueryText(e.target.value)} placeholder="在选中图层中输入要查询的关键字" />
          <div style={{ marginTop: 8 }}>
            <button onClick={doSearch} disabled={loading || !selectedLayer}>查询</button>
            {loading ? <span style={{ marginLeft: 8 }}>查询中…</span> : null}
          </div>
          <div className="tjs-results">
            <div className="tjs-col-title">结果 ({results.length})</div>
            <ul>
              {results.map((f, idx) => (
                <li key={idx} onClick={() => onResultClick(f)}>
                  {f.properties && (f.properties.name || f.properties.title) ? f.properties.name || f.properties.title : f.id || JSON.stringify(f.properties).slice(0, 80)}
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="tjs-col tjs-right">
          <div className="tjs-col-title">说明</div>
          <div className="tjs-help">- 使用 WFS GetFeature (GeoJSON) 进行属性搜索。<br/>- 若 GeoServer 未启用 WFS 或受限，请使用代理或开启 CORS。<br/>- 点击结果会把要素添加到地图并缩放。</div>
        </div>
      </div>
    </div>
  );
}
