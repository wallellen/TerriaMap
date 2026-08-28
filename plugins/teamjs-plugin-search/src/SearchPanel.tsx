import React, { useEffect, useState } from "react";
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

/**
 * Robust DescribeFeatureType parser:
 * - Uses getElementsByTagNameNS to handle arbitrary namespaces
 * - Looks for elements with name/type attributes
 * - Filters out geometry-like types (gml, geometry)
 * - Prefers textual/date fields but returns any non-geometry fields
 */
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

    // Collect <element> nodes across namespaces
    const nsElements = Array.from(doc.getElementsByTagNameNS("*", "element"));
    const xsdElements = Array.from(doc.getElementsByTagNameNS("*", "element"));
    const allElements = Array.from(new Set([...nsElements, ...xsdElements]));

    const props: { name: string; type: string }[] = [];

    for (const el of allElements) {
      const name = el.getAttribute("name");
      const type = el.getAttribute("type") || el.getAttribute("typeName") || "";
      if (!name) continue;
      const lowerType = type.toLowerCase();
      // Skip geometry-like fields
      if (lowerType.includes("gml") || lowerType.includes("geometry") || lowerType.includes("point") || lowerType.includes("polygon") || lowerType.includes("multi") || name.toLowerCase().includes("geom") || name.toLowerCase().includes("the_geom")) {
        continue;
      }
      props.push({ name, type });
    }

    // Heuristic ordering: prefer textual types first
    const textual = props.filter((p) => {
      const t = (p.type || "").toLowerCase();
      return t.includes("string") || t.includes("char") || t.includes("token") || t.includes("date") || t.includes("time");
    });
    const others = props.filter((p) => !textual.includes(p));
    const ordered = [...textual, ...others].map((p) => p.name);

    // Deduplicate and return
    return Array.from(new Set(ordered));
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
  const [selectedProperties, setSelectedProperties] = useState<string[]>([]);
  const [operator, setOperator] = useState<"OR" | "AND">("OR");
  const [fuzzy, setFuzzy] = useState<boolean>(true);
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
        setSelectedProperties([]);
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
      if (props.length > 0) setSelectedProperties([props[0]]);
      else setSelectedProperties(selectedLayer.queryProperty ? [selectedLayer.queryProperty] : []);
    }
    loadProps();
  }, [selectedLayer]);

  if (!viewState || !viewState.showSearchPanel) return null;

  function toggleProperty(name: string) {
    setSelectedProperties((prev) => {
      if (prev.includes(name)) return prev.filter((p) => p !== name);
      return [...prev, name];
    });
  }

  async function doSearch(reset = true) {
    if (!selectedLayer) return;
    if (selectedProperties.length === 0) {
      alert("请至少选择一个属性字段进行查询");
      return;
    }

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

      const pattern = (val: string) => (fuzzy ? `'%${val}%'` : `'${val}'`);

      // Build CQL by combining selectedProperties
      const clauses = selectedProperties.map((prop) => {
        const op = fuzzy ? "ILIKE" : "=";
        return `${prop} ${op} ${pattern(queryText)}`;
      });
      const combined = clauses.join(` ${operator} `);

      const currentStart = reset ? 0 : startIndex;
      const cql = encodeURIComponent(combined);
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
      // create a temporary geojson layer and attempt to style it for highlight
      const item = new GeoJsonCatalogItem(terria);
      item.name = `查询结果: ${feature.id || (feature.properties && (feature.properties.name || feature.properties.title)) || "要素"}`;
      item.isEnabled = true;
      item.geoJson = { type: "FeatureCollection", features: [feature] };
      // Try setting common style fields - terriajs may respect these depending on version
      try {
        (item as any).point = { color: "#ff0000", pixelSize: 12 };
        (item as any).fill = "#ff0000";
        (item as any).stroke = "#ff0000";
      } catch {}

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

      // also set a quick visual flash if viewer provides ability (best-effort)
      try {
        const viewer = terria.currentViewer || terria.cesium || terria.leaflet || null;
        if (viewer && (viewer as any).zoomTo) {
          (viewer as any).zoomTo(item);
        }
      } catch (e) {
        // ignore
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
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input className="tjs-input" value={queryText} onChange={(e) => setQueryText(e.target.value)} placeholder="在选中图层中输入要查询的关键字" />

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontSize: 12 }}>选择字段（多选）</div>
              <div style={{ maxHeight: 120, overflow: "auto", border: "1px solid #eee", padding: 6 }}>
                {properties.length === 0 ? <div style={{ fontSize: 12, color: "#666" }}>(未发现属性)</div> : null}
                {properties.map((p) => (
                  <label key={p} style={{ display: "block", marginBottom: 4 }}>
                    <input type="checkbox" checked={selectedProperties.includes(p)} onChange={() => toggleProperty(p)} /> {p}
                  </label>
                ))}
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ fontSize: 12 }}>组合</div>
              <select value={operator} onChange={(e) => setOperator(e.target.value as "OR" | "AND")}> 
                <option value="OR">OR</option>
                <option value="AND">AND</option>
              </select>

              <label style={{ marginTop: 8 }}>
                <input type="checkbox" checked={fuzzy} onChange={() => setFuzzy(!fuzzy)} /> 模糊匹配
              </label>

              <div style={{ marginTop: 8 }}>
                <select value={String(pageSize)} onChange={(e) => setPageSize(Number(e.target.value))}>
                  <option value="10">10</option>
                  <option value="25">25</option>
                  <option value="50">50</option>
                  <option value="100">100</option>
                </select>
              </div>
            </div>
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
          <div className="tjs-help">- 使用 WFS GetFeature (GeoJSON) 进行属性搜索。<br/>- 描述属性通过 WFS DescribeFeatureType 获取并在下拉中选择（过滤几何字段并优先显示文本/日期字段）。<br/>- 可选择多字段组合并指定 AND/OR、模糊/精确匹配。<br/>- 若 GeoServer 未启用 WFS 或受限，请使用代理或开启 CORS。<br/>- 点击结果会把要素添加到地图并缩放。</div>
        </div>
      </div>
    </div>
  );
}
