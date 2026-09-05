// Api.ts
// 简单的 Buffer 分析前端实现（PoC）
// 依赖: @turf/turf
// 集成说明：将此文件打包到页面（或通过现有 bundler），并确保 terria 全局可访问（window['terria']）。
// 消息协议：
// - 开始模式：window.postMessage({ type: 'buffer:start', requestId: '<id>' }, '*')
// - 取消：window.postMessage({ type: 'buffer:stop', requestId })
// - 直接分析：window.postMessage({ type: 'buffer:analyze', requestId, circle: { center:[lon,lat], radiusMeters } }, '*')
// - 返回结果：window.postMessage({ type: 'buffer:result', requestId, matches: [...] }, '*')

import * as turf from '@turf/turf';

type Msg = {
  type: string;
  requestId?: string;
  circle?: { center: [number, number]; radiusMeters: number };
};

declare const window: any; // terria 可能挂在 window

class BufferApi {
  private terria: any;
  private state: 'idle' | 'waiting-center' | 'waiting-radius' = 'idle';
  private requestId: string | null = null;
  private center: [number, number] | null = null;
  private tempMarker: any = null;
  private leafletClickHandler: any = null;
  private cesiumHandler: any = null;

  constructor() {
    this.terria = window.terria || (window as any).app && (window as any).app.terria;
    window.addEventListener('message', this.onMessage.bind(this), false);
    console.info('BufferApi initialized');
  }

  private postMessage(payload: any) {
    try {
      window.postMessage(payload, '*');
    } catch (e) {
      console.error('postMessage failed', e);
    }
  }

  private onMessage(e: MessageEvent) {
    // 仅响应本页面内消息；如果你需要更严格的源校验，可在这里检查 e.origin
    const data = e.data as Msg;
    if (!data || !data.type) return;

    if (data.type === 'buffer:start') {
      this.requestId = data.requestId || null;
      this.enterDrawMode();
    } else if (data.type === 'buffer:stop') {
      this.exitDrawMode();
      this.postMessage({ type: 'buffer:stopped', requestId: data.requestId });
    } else if (data.type === 'buffer:analyze' && data.circle) {
      const { center, radiusMeters } = data.circle;
      const circle = turf.circle(center, radiusMeters, { units: 'meters', steps: 64 });
      this.runAnalysis(circle, data.requestId || null);
    }
  }

  private enterDrawMode() {
    const viewer = this.getViewer();
    if (!viewer) {
      this.postMessage({ type: 'buffer:error', requestId: this.requestId, message: 'Viewer not found' });
      return;
    }
    this.postMessage({ type: 'buffer:mode', requestId: this.requestId, mode: 'select-center' });
    this.state = 'waiting-center';

    if (viewer.leafletMap) {
      this.startLeafletInteraction(viewer.leafletMap);
    } else if (viewer.cesiumViewer) {
      this.startCesiumInteraction(viewer.cesiumViewer);
    } else {
      this.postMessage({ type: 'buffer:error', requestId: this.requestId, message: 'Unsupported viewer' });
    }
  }

  private exitDrawMode() {
    this.state = 'idle';
    this.requestId = null;
    this.center = null;
    this.clearTempMarker();
    this.removeLeafletHandlers();
    this.removeCesiumHandlers();
  }

  // Viewer detection helpers - adapt if your terria API differs
  private getViewer() {
    const t = this.terria;
    if (!t) return null;
    // common TerriaJS embedding patterns vary; try multiples
    return {
      leafletMap: t.leaflet && (t.leaflet as any).map,
      cesiumViewer: (t.cesium && t.cesium.viewer) || (window as any).viewer
    };
  }

  // --- Leaflet interaction (简单两次点击：中心 + 半径点) ---
  private startLeafletInteraction(map: any) {
    if (!map) return;
    const onClick = (ev: any) => {
      if (this.state === 'waiting-center') {
        const latlng = ev.latlng;
        this.center = [latlng.lng, latlng.lat];
        this.addTempMarkerLeaflet(map, latlng);
        this.state = 'waiting-radius';
        this.postMessage({ type: 'buffer:select-radius', requestId: this.requestId });
      } else if (this.state === 'waiting-radius' && this.center) {
        const latlng = ev.latlng;
        const p2: [number, number] = [latlng.lng, latlng.lat];
        const radiusMeters = turf.distance(turf.point(this.center), turf.point(p2), { units: 'meters' }) * 1000;
        const circle = turf.circle(this.center, radiusMeters, { units: 'meters', steps: 64 });
        this.postMessage({ type: 'buffer:circle-drawn', requestId: this.requestId, circle: { center: this.center, radiusMeters } });
        this.runAnalysis(circle, this.requestId);
        this.exitDrawMode();
      }
    };
    map.on('click', onClick);
    this.leafletClickHandler = onClick;
    this.postMessage({ type: 'buffer:ready', requestId: this.requestId, viewer: 'leaflet' });
  }

  private addTempMarkerLeaflet(map: any, latlng: any) {
    try {
      if ((window as any).L) {
        this.clearTempMarker();
        this.tempMarker = (window as any).L.circle(latlng, { radius: 1, color: 'red' }).addTo(map);
      }
    } catch (e) { /* ignore */ }
  }

  private clearTempMarker() {
    try {
      if (this.tempMarker && this.tempMarker.remove) this.tempMarker.remove();
      this.tempMarker = null;
    } catch (e) {}
  }

  private removeLeafletHandlers() {
    const viewer = this.getViewer();
    if (viewer && viewer.leafletMap && this.leafletClickHandler) {
      viewer.leafletMap.off('click', this.leafletClickHandler);
      this.leafletClickHandler = null;
    }
  }

  // --- Cesium interaction (点击两次：中心 + 半径点) ---
  private startCesiumInteraction(cesium: any) {
    if (!cesium) return;
    const handler = new cesium.ScreenSpaceEventHandler(cesium.scene.canvas);
    const clickHandler = (click: any) => {
      const cartesian = cesium.camera.pickEllipsoid(click.position, cesium.scene.globe.ellipsoid);
      if (!cartesian) return;
      const cartographic = cesium.Cartographic.fromCartesian(cartesian);
      const lon = cesium.Math.toDegrees(cartographic.longitude);
      const lat = cesium.Math.toDegrees(cartographic.latitude);
      if (this.state === 'waiting-center') {
        this.center = [lon, lat];
        this.state = 'waiting-radius';
        this.postMessage({ type: 'buffer:select-radius', requestId: this.requestId });
      } else if (this.state === 'waiting-radius' && this.center) {
        const p2: [number, number] = [lon, lat];
        const radiusMeters = turf.distance(turf.point(this.center), turf.point(p2), { units: 'meters' }) * 1000;
        const circle = turf.circle(this.center, radiusMeters, { units: 'meters', steps: 64 });
        this.postMessage({ type: 'buffer:circle-drawn', requestId: this.requestId, circle: { center: this.center, radiusMeters } });
        this.runAnalysis(circle, this.requestId);
        this.exitDrawMode();
      }
    };
    handler.setInputAction(clickHandler, cesium.ScreenSpaceEventType.LEFT_CLICK);
    this.cesiumHandler = handler;
    this.postMessage({ type: 'buffer:ready', requestId: this.requestId, viewer: 'cesium' });
  }

  private removeCesiumHandlers() {
    const viewer = this.getViewer();
    if (viewer && viewer.cesiumViewer && this.cesiumHandler) {
      try {
        this.cesiumHandler.destroy();
      } catch (e) {}
      this.cesiumHandler = null;
    }
  }

  // --- 分析主逻辑 ---
  private async runAnalysis(circlePolygon: GeoJSON.Polygon, requestId: string | null) {
    const results: Array<{ itemId: string; featureIndex: number; feature: any }> = [];
    const circleBbox = turf.bbox(circlePolygon);

    const geoItems = await this.collectGeoJsonItems();
    for (const item of geoItems) {
      const fc = await this.ensureFeatureCollection(item);
      if (!fc || !fc.features) continue;
      for (let i = 0; i < fc.features.length; i++) {
        const f = fc.features[i];
        // bbox 快速排除
        const fb = turf.bbox(f);
        if (!this.bboxesIntersect(circleBbox, fb)) continue;

        let intersects = false;
        try {
          if (f.geometry && f.geometry.type === 'Point') {
            const pt = turf.point(f.geometry.coordinates);
            intersects = turf.booleanPointInPolygon(pt, circlePolygon);
          } else {
            intersects = turf.booleanIntersects(f as any, circlePolygon);
          }
        } catch (e) {
          // 若 booleanIntersects 出错，回退到 bbox 规则
          intersects = false;
        }
        if (intersects) {
          results.push({ itemId: item.id || item.name || 'unknown', featureIndex: i, feature: f });
        }
      }
    }

    this.postMessage({
      type: 'buffer:result',
      requestId,
      matches: results,
      stats: { itemsSearched: geoItems.length, matches: results.length }
    });
  }

  private bboxesIntersect(a: number[], b: number[]) {
    // a: [minX,minY,maxX,maxY]
    return !(b[0] > a[2] || b[2] < a[0] || b[1] > a[3] || b[3] < a[1]);
  }

  // 尝试从 terria catalog 中收集所有 GeoJSON catalog items（根据实际 repo 结构可能需调整）
  private async collectGeoJsonItems(): Promise<any[]> {
    const t = this.terria;
    if (!t) return [];
    const items: any[] = [];

    // 尝试常见位置
    const maybeMembers = t.catalog && (t.catalog.items || t.catalog.members || t.catalog._members || t.catalog.groupModels || t.catalog._items);
    if (Array.isArray(maybeMembers)) {
      for (const m of maybeMembers) {
        this.collectFromModelRecursive(m, items);
      }
    } else if (Array.isArray(t.catalog)) {
      for (const m of t.catalog) this.collectFromModelRecursive(m, items);
    }
    return items;
  }

  private collectFromModelRecursive(model: any, out: any[]) {
    if (!model) return;
    const typ = (model.type || model.catalogType || '').toLowerCase();
    if (typ.includes('geojson') || (model && (model.geoJsonData || model.geoJson || model.isGeoJson))) {
      out.push(model);
      return;
    }
    // 递归 group
    const children = model.items || model.members || model.catalog || model.group || model.items;
    if (Array.isArray(children)) {
      for (const c of children) this.collectFromModelRecursive(c, out);
    }
  }

  // 确保拿到 FeatureCollection；若没有内嵌 data，会尝试 fetch item.url
  private async ensureFeatureCollection(item: any): Promise<GeoJSON.FeatureCollection | null> {
    if (!item) return null;
    if (item.geoJsonData && item.geoJsonData.type === 'FeatureCollection') return item.geoJsonData;
    if (item.geoJson && item.geoJson.type === 'FeatureCollection') return item.geoJson;
    if (item._data && item._data.type === 'FeatureCollection') return item._data;
    // 如果有 url，尝试 fetch
    const url = item.url || item.dataUrl || (item.source && item.source.url);
    if (url) {
      try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const j = await res.json();
        if (j.type === 'FeatureCollection') return j;
        // 如果返回是单个 Feature，包一下
        if (j.type === 'Feature') return { type: 'FeatureCollection', features: [j] };
        // 其他可能是 array of features
        if (Array.isArray(j)) return { type: 'FeatureCollection', features: j };
      } catch (e) {
        console.warn('fetch geojson failed', e);
      }
    }
    return null;
  }
}

if (!(window as any).bufferApi) {
  (window as any).bufferApi = new BufferApi();
}
