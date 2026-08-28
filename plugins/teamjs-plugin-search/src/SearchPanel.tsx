import React, { useEffect, useState } from "react";
// Imported as any to avoid compilation dependency on terriajs types in this minimal plugin.
// In a stricter setup you can install @types/terriajs or appropriate type definitions.
import GeoJsonCatalogItem from "terriajs/lib/Models/GeoJsonCatalogItem";
import "./styles.css";

type Props = {
  terria?: any;
  viewState?: any;
};

function flattenCatalogMembers(memberOrGroup: any, out: any[] = []): any[] {
  if (!memberOrGroup) return out;
  const members = memberOrGroup.members || memberOrGroup.catalog || memberOrGroup.items || memberOrGroup;
  if (Array.isArray(members)) {
    for (const m of members) {
      if (!m) continue;
      const type = (m.type || (m.__type && m.__type())) || "";
      const url = m.url || (m.service && m.service.url) || (m.get && m.get("url"));
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

async function fetchLayerProperties(wfsBase: string, layerName: string): Promise<string[]> {
  try {
    const url = `${wfsBase}?service=WFS&version=1.1.0&request=DescribeFeatureType&typeName=${encodeURIComponent(
      layerName
    )}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`DescribeFeatureType failed: ${resp.status}`);
    const xmlText = await resp.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, "application/xml");
    // Search for xsd:element under complexType
    const elements = Array.from(doc.getElementsByTagName("xsd:element")).concat(
      Array.from(doc.getElementsByTagName("element"))
    );
    const props: string[] = [];
    for (const el of elements) {
      const name = el.getAttribute("name");
      const type = el.getAttribute("type") || "";
      if (!name) continue;
      const lowerType = type.toLowerCase();
      // Skip geometry-like fields (gml, geometry, MULTI*, etc.)
      if (lowerType.includes("gml") || lowerType.includes("geometry") || lowerType.includes("point") || lowerType.includes("polygon") || lowerType.includes("multi")) {
        continue;
      }
      // Only include textual types when possible
      if (lowerType.includes("string") || lowerType.includes("char") || lowerType.includes("token") || lowerType === "") {
        props.push(name);
      }
    }
    // Deduplicate preserving order
    return Array.from(new Set(props));
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("Failed to fetch properties:", e);
    return [];
  }
}

export default function SearchPanel({ terria, viewState }: Props) {
  const [layers, setLayers] = useState<any[]>([]);
  const [selectedLayer, setSelectedLayer] = useState<any | null>(null);
  const [queryText, setQueryText] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [properties, setProperties] = useState<string[]>([]);
  const [selectedProperty, setSelectedProperty] = useState<string | null>(null);
  const [pageSize, setPageSize] = useState<number>(50);
  const [startIndex, setStartIndex] = useState<number>(0);
  const [hasMore, setHasMore] = useState<boolean>(false);

  useEffect(() => {
    let catalogSource: any = null;
    if (terria && terria.catalog && terria.catalog.members) {
      catalogSource = terria.catalog;
    } else if (terria && terria.configParameters) {
      catalogSource = terria.configParameters.initSources || terria.configParameters;
    }
    const found = flattenCatalogMembers(catalogSource || []);
    setLayers(found);
  }, [terria]);

  useEffect(() => {
    async function loadProps() {
      if (!selectedLayer) {
        setProperties([]);
        setSelectedProperty(null);
        return;
      }
      const baseUrl = selectedLayer.url || (selectedLayer.service && selectedLayer.service.url) || (selectedLayer.get && selectedLayer.get("url"));
      let wfsBase = baseUrl;
      if (!wfsBase) return;
      if (wfsBase.toLowerCase().endsWith("/wms")) {
        wfsBase = wfsBase.slice(0, -4) + "wfs";
      }
      const layerName = selectedLayer.layer || selectedLayer.layers || selectedLayer.name || (selectedLayer.get && selectedLayer.get("layers"));
      const props = await fetchLayerProperties(wfsBase, layerName);
      setProperties(props);
      if (props.length > 0) setSelectedProperty(props[0]);
      else setSelectedProperty(selectedLayer.queryProperty || "NAME");
    }
    loadProps();
  }, [selectedLayer]);

  if (!viewState || !viewState.showSearchPanel) return null;

  async function doSearch(reset = true) {
    if (!selectedLayer) return;
    setLoading(true);
    if (reset) {
      setResults([]);
      setStartIndex(0);
      setHasMore(false);
    }
    try {
      const getProp = (obj: any, keys: string[]) => keys.reduce((acc: any, k: string) => (acc && (acc[k] || (acc.get && acc.get(k)))) || acc, obj);
      const baseUrl = selectedLayer.url || getProp(selectedLayer, ["service", "url"]);
      const layerName = selectedLayer.layer || selectedLayer.layers || selectedLayer.name || (selectedLayer.get && selectedLayer.get("layers"));
      if (!baseUrl || !layerName) {
        throw new Error("所选图层缺少 url 或 layer 名称，无法查询");
      }

      let wfsBase = baseUrl;
      if (wfsBase.toLowerCase().endsWith("/wms")) {
        wfsBase = wfsBase.slice(0, -4) + "wfs";
      }
      const propertyName = selectedProperty || selectedLayer.queryProperty || "NAME";
      const currentStart = reset ? 0 : startIndex;
      const cql = encodeURIComponent(`${propertyName} ILIKE '%${queryText}%'`);
      const url = `${wfsBase}?service=WFS&version=1.1.0&request=GetFeature&typeName=${encodeURIComponent(layerName)}&outputFormat=application/json&CQL_FILTER=${cql}&count=${pageSize}&startIndex=${currentStart}`;

      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`查询失败: ${resp.status}`);
      const geojson = await resp.json();
      const newFeatures = geojson.features || [];
      setResults((prev) => (reset ? newFeatures : prev.concat(newFeatures)));
      setStartIndex((prev) => (reset ? newFeatures.length : prev + newFeatures.length));
      setHasMore(newFeatures.length === pageSize);
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error(e);
      alert("查询出错: " + (e && e.message ? e.message : e));
    } finally {
      setLoading(false);
    }
  }

  function loadMore() {
    doSearch(false);
  }

  function onResultClick(feature: any) {
    try {
      const item = new GeoJsonCatalogItem(terria);
      item.name = `查询结果: ${feature.id || (feature.properties && (feature.properties.name || feature.properties.title)) || "要素"}`;
      item.isEnabled = true;
      item.geoJson = { type: "FeatureCollection", features: [feature] };
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
          <div style={{ display: "flex", gap: 8 }}>
            <input className="tjs-input" value={queryText} onChange={(e) => setQueryText(e.target.value)} placeholder="在选中图层中输入要查询的关键字" />
            <select value={selectedProperty || ""} onChange={(e) => setSelectedProperty(e.target.value)}>
              {properties.length === 0 ? (
                <option value="">(未发现属性，使用默认)</option>
              ) : (
                properties.map((p) => <option key={p} value={p}>{p}</option>)
              )}
            </select>
            <select value={String(pageSize)} onChange={(e) => setPageSize(Number(e.target.value))}>
              <option value="10">10</option>
              <option value="25">25</option>
              <option value="50">50</option>
              <option value="100">100</option>
            </select>
          </div>

          <div style={{ marginTop: 8 }}>
            <button onClick={() => doSearch(true)} disabled={loading || !selectedLayer}>查询</button>
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
            {hasMore ? <div style={{ textAlign: "center", marginTop: 8 }}><button onClick={loadMore}>加载更多</button></div> : null}
          </div>
        </div>

        <div className="tjs-col tjs-right">
          <div className="tjs-col-title">说明</div>
          <div className="tjs-help">- 使用 WFS GetFeature (GeoJSON) 进行属性搜索。<br/>- 描述属性通过 WFS DescribeFeatureType 获取并在下拉中选择（仅显示文本字段）。<br/>- 若 GeoServer 未启用 WFS 或受限，请使用代理或开启 CORS。<br/>- 点击结果会把要素添加到地图并缩放。</div>
        </div>
      </div>
    </div>
  );
}
