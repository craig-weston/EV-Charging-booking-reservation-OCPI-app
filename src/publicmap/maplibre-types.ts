// MapLibre GL JS 6.17 (BSD-3-Clause) is served as-is from public/vendor/maplibre-6.17.0 and loaded at
// run time, so it stays out of the app bundle. Only what the public map calls is typed here.
export type LngLat = [number, number];

export interface MapFeature {
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: LngLat };
}

export interface MapEvent {
  features?: MapFeature[];
  lngLat: { lng: number; lat: number };
  originalEvent?: Event;
}

export interface GeoJsonSource {
  setData(data: unknown): void;
  getClusterExpansionZoom(clusterId: number): Promise<number>;
}

export interface MapLike {
  on(type: string, listener: (e: MapEvent) => void): void;
  on(type: string, layer: string, listener: (e: MapEvent) => void): void;
  once(type: string, listener: () => void): void;
  addControl(control: unknown, position?: string): void;
  addSource(id: string, source: Record<string, unknown>): void;
  getSource(id: string): GeoJsonSource | undefined;
  addLayer(layer: Record<string, unknown>, before?: string): void;
  getLayer(id: string): unknown;
  addImage(name: string, image: { width: number; height: number; data: Uint8Array | Uint8ClampedArray }, options?: { pixelRatio?: number }): void;
  hasImage(name: string): boolean;
  setPaintProperty(layer: string, name: string, value: unknown): void;
  setLayoutProperty(layer: string, name: string, value: unknown): void;
  getStyle(): { layers: { id: string; type: string; layout?: Record<string, unknown> }[] };
  getCanvas(): HTMLCanvasElement;
  getBounds(): { getWest(): number; getSouth(): number; getEast(): number; getNorth(): number };
  getZoom(): number;
  isMoving(): boolean;
  setPadding(p: { top: number; right: number; bottom: number; left: number }): void;
  easeTo(o: Record<string, unknown>): void;
  flyTo(o: Record<string, unknown>): void;
  jumpTo(o: Record<string, unknown>): void;
  fitBounds(b: [LngLat, LngLat], o?: Record<string, unknown>): void;
  resize(): void;
  remove(): void;
  touchZoomRotate: { disableRotation(): void };
  dragRotate: { disable(): void };
  keyboard: { disableRotation(): void };
}

export interface MapLibreModule {
  setWorkerUrl(url: string): void;
  Map: new (options: Record<string, unknown>) => MapLike;
  NavigationControl: new (options?: Record<string, unknown>) => unknown;
}
