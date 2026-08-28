import React, { useEffect, useState } from "react";
import GeoJsonCatalogItem from "terriajs/lib/Models/GeoJsonCatalogItem";
import "./styles.css";

type Props = { terria?: any; viewState?: any };

type Clause = {
  id: string;
  property: string;
  match: "contains" | "equals" | "startsWith" | "endsWith";
  value: string;
  connector?: "AND" | "OR"; // connector to the next clause
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

function uniqueId(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

async function fetchWithAuth(url: string, opts: any, auth: any, proxyUrl?: string) {
  const headers: Record<string, string> = (opts && opts.headers) || {};
  if (auth) {
    if (auth.type === "bearer" && auth.token) headers["Authorization"] = `Bearer ${auth.token}`;
    if (auth.type === "basic" && auth.username !== undefined) {
      const token = btoa(`${auth.username}:${auth.password || ""}`);
      headers["Authorization"] = `Basic ${token}`;
    }
    if (auth.custom && auth.customHeaders) {
      for (const k of Object.keys(auth.customHeaders)) {
        const v = auth.customHeaders[k];
        if (v) headers[k] = v;
      }
    }
  }
  const finalUrl = proxyUrl ? `${proxyUrl}${encodeURIComponent(url)}` : url;
  return fetch(finalUrl, { ...opts, headers });
}

/**
 * Try to robustly parse DescribeFeatureType responses. Returns an ordered list of property names.
 */
async function fetchLayerProperties(wfsBase: string, layerName: string, auth: any, proxyUrl?: string): Promise<string[]> {
  try {
    const url = `${wfsBase}?service=WFS&version=1.1.0&request=DescribeFeatureType&typeName=${encodeURIComponent(layerName)}`;
    const resp = await fetchWithAuth(url, {}, auth, proxyUrl);
    if (!resp.ok) throw new Error(`DescribeFeatureType failed: ${resp.status}`);
    const xmlText = await resp.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, "application/xml");

    // Attempt several strategies to collect element names
    const props: { name: string; type: string }[] = [];

    // 1) Look for xsd:element under complexType/sequence
    const seqs = Array.from(doc.getElementsByTagNameNS("*", "sequence"));
    for (const seq of seqs) {
      const elems = Array.from(seq.getElementsByTagNameNS("*", "element"));
      for (const el of elems) {
        const name = el.getAttribute("name");
        const type = el.getAttribute("type") || el.getAttribute("typeName") || "";
        if (!name) continue;
        const lowerType = type.toLowerCase();
        if (lowerType.includes("gml") || lowerType.includes("geometry") || name.toLowerCase().includes("geom") || name.toLowerCase().includes("the_geom")) continue;
        props.push({ name, type });
      }
    }

    // 2) Fallback: any element tags
    if (props.length === 0) {
      const elements = Array.from(doc.getElementsByTagNameNS("*", "element")).concat(Array.from(doc.getElementsByTagName("element")));
      for (const el of elements) {
        const name = el.getAttribute("name");
        const type = el.getAttribute("type") || el.getAttribute("typeName") || "";
        if (!name) continue;
        const lowerType = type.toLowerCase();
        if (lowerType.includes("gml") || lowerType.includes("geometry") || name.toLowerCase().includes("geom") || name.toLowerCase().includes("the_geom")) continue;
        props.push({ name, type });
      }
    }

    // 3) If still empty, parse complexContent elements or attributes
    if (props.length === 0) {
      const elems = Array.from(doc.getElementsByTagNameNS("*", "complexType")).flatMap((ct) => Array.from(ct.getElementsByTagNameNS("*", "element")));
      for (const el of elems) {
        const name = el.getAttribute("name");
        const type = el.getAttribute("type") || "";
        if (!name) continue;
        if (type.toLowerCase().includes("gml")) continue;
        props.push({ name, type });
      }
    }

    // Heuristic ordering: prefer textual/date types first
    const textual = props.filter((p) => {
      const t = (p.type || "").toLowerCase();
      return t.includes("string") || t.includes("char") || t.includes("token") || t.includes("date") || t.includes("time");
    });
    const others = props.filter((p) => !textual.includes(p));
    const ordered = [...textual, ...others].map((p) => p.name);
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
  const [clauses, setClauses] = useState<Clause[]>([]);
  const [pageSize, setPageSize] = useState<number>(50);
  const [startIndex, setStartIndex] = useState<number>(0);
  const [hasMore, setHasMore] = useState<boolean>(false);

  // auth & proxy
  const [auth, setAuth] = useState<any>({ type: "none" });
  const [proxyUrl, setProxyUrl] = useState<string>("");

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
        setClauses([]);
        return;
      }
      const baseUrl = selectedLayer.url || (selectedLayer.service && selectedLayer.service.url) || (selectedLayer.get && selectedLayer.get("url"));
      let wfsBase = baseUrl;
      if (!wfsBase) return;
      if (wfsBase.toLowerCase().endsWith("/wms")) {
        wfsBase = wfsBase.slice(0, -4) + "wfs";
      }
      const layerName = selectedLayer.layer || selectedLayer.layers || selectedLayer.name || (selectedLayer.get && selectedLayer.get("layers"));
      const props = await fetchLayerProperties(wfsBase, layerName, auth.type === "none" ? null : auth, proxyUrl);
      setProperties(props);
      if (props.length > 0) {
        setClauses([{ id: uniqueId("clause"), property: props[0], match: "contains", value: "", connector: "OR" }]);
      } else {
        setClauses([]);
      }
    }
    loadProps();
    // note: intentionally include auth/proxy in deps so credential changes refetch props
  }, [selectedLayer, auth, proxyUrl]);

  if (!viewState || !viewState.showSearchPanel) return null;

  function addClause() {
    setClauses((prev) => [...prev, { id: uniqueId("clause"), property: properties[0] || "", match: "contains", value: "", connector: "OR" }]);
  }
  function removeClause(id: string) {
    setClauses((prev) => prev.filter((c) => c.id !== id));
  }
  function updateClause(id: string, patch: Partial<Clause>) {
    setClauses((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }

  async function doSearch(reset = true) {
    if (!selectedLayer) return;
    if (clauses.length === 0) {
      alert("请先添加查询条件（至少一条）");
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

      // Build CQL from clauses
      const clauseStrings = clauses.map((c) => {
        const val = c.value || "";
        const esc = (s: string) => s.replace(/'/g, "\\'");
        const pattern = (v: string) => {
          switch (c.match) {
            case "contains":
              return `'%${esc(v)}%'`;
            case "startsWith":
              return `'${esc(v)}%'`;
            case "endsWith":
              return `'%${esc(v)}'`;
            case "equals":
            default:
              return `'${esc(v)}'`;
          }
        };
        const op = c.match === "equals" ? "=" : "ILIKE";
        return `${c.property} ${op} ${pattern(val)}`;
      });
      // Combine using connectors between clauses. If connectors missing, default OR
      let combined = "";
      for (let i = 0; i < clauseStrings.length; i++) {
        combined += clauseStrings[i];
        if (i < clauses.length - 1) combined += ` ${clauses[i].connector || "OR"} `;
      }

      const currentStart = reset ? 0 : startIndex;
      const cql = encodeURIComponent(combined);
      const url = `${wfsBase}?service=WFS&version=1.1.0&request=GetFeature&typeName=${encodeURIComponent(layerName)}&outputFormat=application/json&CQL_FILTER=${cql}&count=${pageSize}&startIndex=${currentStart}`;

      const resp = await fetchWithAuth(url, {}, auth.type === "none" ? null : auth, proxyUrl);
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

  function highlightFeatureAnimation(item: any, terria: any) {
    // Best-effort flash: try toggling style properties a few times
    try {
      let count = 0;
      const colors = ["#ff0000", "#ffff00", "#ff7f00"];
      const interval = setInterval(() => {
        try {
          const color = colors[count % colors.length];
          (item as any).point = { color, pixelSize: 12 };
          (item as any).fill = color;
          (item as any).stroke = color;
        } catch (e) {}
        count++;
        if (count > 5) {
          clearInterval(interval);
        }
      }, 300);
    } catch (e) {
      // ignore
    }
  }

  function onResultClick(feature: any) {
    try {
      const item = new GeoJsonCatalogItem(terria);
      item.name = `查询结果: ${feature.id || (feature.properties && (feature.properties.name || feature.properties.title)) || "要素"}`;
      item.isEnabled = true;
      item.geoJson = { type: "FeatureCollection", features: [feature] };
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

      highlightFeatureAnimation(item, terria);
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

          <div style={{ marginTop: 10 }}>
            <div className="tjs-col-title">请求设置</div>
            <div style={{ fontSize: 12, marginBottom: 6 }}>Proxy (可选):</div>
            <input style={{ width: "100%" }} value={proxyUrl} onChange={(e) => setProxyUrl(e.target.value)} placeholder="输入代理基地址（例如 https://myproxy/?url=）" />

            <div style={{ marginTop: 8, fontSize: 12 }}>认证类型:</div>
            <select value={auth.type} onChange={(e) => setAuth({ type: (e.target.value as any) })}>
              <option value="none">无</option>
              <option value="basic">Basic</option>
              <option value="bearer">Bearer Token</option>
              <option value="custom">自定义 Header</option>
            </select>
            {auth.type === "basic" ? (
              <div style={{ marginTop: 6 }}>
                <input placeholder="用户名" value={auth.username || ""} onChange={(e) => setAuth({ ...auth, username: e.target.value })} />
                <input placeholder="密码" type="password" value={auth.password || ""} onChange={(e) => setAuth({ ...auth, password: e.target.value })} />
              </div>
            ) : null}
            {auth.type === "bearer" ? (
              <div style={{ marginTop: 6 }}>
                <input placeholder="Token" value={auth.token || ""} onChange={(e) => setAuth({ ...auth, token: e.target.value })} />
              </div>
            ) : null}
            {auth.type === "custom" ? (
              <div style={{ marginTop: 6 }}>
                <div style={{ fontSize: 12 }}>格式: HeaderName:HeaderValue（一行一个）</div>
                <textarea placeholder="X-API-Key: abc\nX-Other: val" value={auth.customText || ""} onChange={(e) => {
                  const text = e.target.value;
                  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
                  const headers: Record<string, string> = {};
                  for (const ln of lines) {
                    const idx = ln.indexOf(":");
                    if (idx > 0) {
                      const k = ln.slice(0, idx).trim();
                      const v = ln.slice(idx + 1).trim();
                      headers[k] = v;
                    }
                  }
                  setAuth({ ...auth, customText: text, customHeaders: headers });
                }} style={{ width: "100%", height: 80 }} />
              </div>
            ) : null}
          </div>
        </div>

        <div className="tjs-col tjs-middle">
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <input className="tjs-input" value={queryText} onChange={(e) => setQueryText(e.target.value)} placeholder="输入要匹配的文本（可为空，若为空使用完整表达式的 value）" />

            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, marginBottom: 6 }}>表达式构建器（多字段 / 多条件）</div>
              {clauses.map((c, idx) => (
                <div key={c.id} style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
                  <select value={c.property} onChange={(e) => updateClause(c.id, { property: e.target.value })}>
                    {properties.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                  <select value={c.match} onChange={(e) => updateClause(c.id, { match: e.target.value as any })}>
                    <option value="contains">包含</option>
                    <option value="startsWith">以...开始</option>
                    <option value="endsWith">以...结束</option>
                    <option value="equals">等于</option>
                  </select>
                  <input value={c.value} onChange={(e) => updateClause(c.id, { value: e.target.value })} placeholder="匹配值" />
                  {idx < clauses.length - 1 ? (
                    <select value={c.connector} onChange={(e) => updateClause(c.id, { connector: e.target.value as any })}>
                      <option value="OR">OR</option>
                      <option value="AND">AND</option>
                    </select>
                  ) : null}
                  <button onClick={() => removeClause(c.id)} style={{ marginLeft: 6 }}>删除</button>
                </div>
              ))}
              <div>
                <button onClick={addClause}>添加条件</button>
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ fontSize: 12 }}>页面大小</div>
              <select value={String(pageSize)} onChange={(e) => setPageSize(Number(e.target.value))}>
                <option value="10">10</option>
                <option value="25">25</option>
                <option value="50">50</option>
                <option value="100">100</option>
              </select>
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
          <div className="tjs-help">- 使用 WFS GetFeature (GeoJSON) 进行属性搜索。<br/>- 描述属性通过 WFS DescribeFeatureType 获取并在构建器中使用（过滤几何字段并优先显示文本/日期字段）。<br/>- 可构建多字段复杂表达式（支持 AND/OR、包含/开始/结束/等于）。<br/>- 若 GeoServer 未启用 WFS 或受限，请使用代理或开启 CORS。<br/>- 点击结果会把要素添加到地图并缩放；会尝试做闪烁高亮动画（视 viewer 支持而定）。</div>
        </div>
      </div>
    </div>
  );
}
