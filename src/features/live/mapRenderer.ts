import * as maplibre from 'maplibre-gl';
import mapWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol } from 'pmtiles';
import style from '../../../maps/style.json';
import recipe from '../../../maps/recipe.json';
import type { LiveEvidenceSelection } from '../../live/history';
import { getRegionConfig } from '../../live/regions';
import type { MapFrame } from '../../map/observations';
import { nearestMapEvidence } from '../../map/hitTest';

export interface MapRenderer {
  update(frame: MapFrame, painted?: () => void): void;
  resetView(): void;
  dispose(): void;
}
interface Callbacks {
  ready(): void;
  unavailable(): void;
  select(selection: LiveEvidenceSelection): void;
}

let protocolOwners = 0;
function acquireProtocol() {
  if (protocolOwners === 0) {
    maplibre.setWorkerUrl(mapWorkerUrl);
    maplibre.addProtocol('pmtiles', new Protocol().tile);
  }
  protocolOwners += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--protocolOwners === 0) maplibre.removeProtocol('pmtiles');
  };
}

function aircraftIcon(): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Aircraft symbol canvas is unavailable.');
  context.fillStyle = '#ffffff';
  context.beginPath();
  context.moveTo(16, 2);
  context.lineTo(19, 12);
  context.lineTo(29, 18);
  context.lineTo(29, 21);
  context.lineTo(19, 18);
  context.lineTo(19, 25);
  context.lineTo(23, 28);
  context.lineTo(23, 30);
  context.lineTo(16, 28);
  context.lineTo(9, 30);
  context.lineTo(9, 28);
  context.lineTo(13, 25);
  context.lineTo(13, 18);
  context.lineTo(3, 21);
  context.lineTo(3, 18);
  context.lineTo(13, 12);
  context.closePath();
  context.fill();
  return context.getImageData(0, 0, 32, 32);
}

export function createMapRenderer(
  container: HTMLElement,
  initial: MapFrame,
  callbacks: Callbacks,
): MapRenderer {
  const releaseProtocol = acquireProtocol();
  const prefix = `${location.origin}/map-assets/${recipe.id}/`;
  let map: maplibre.Map;
  try {
    map = new maplibre.Map({
      container,
      style: {
        ...style,
        version: 8,
        glyphs: prefix + 'fonts/{fontstack}/{range}.pbf',
        sprite: prefix + 'sprites/v4/light',
        sources: { basemap: { type: 'vector', url: 'pmtiles://' + prefix + 'basemap.pmtiles' } },
        transition: { duration: 0, delay: 0 },
      } as maplibre.StyleSpecification,
      bounds: [
        [recipe.bounds[0]!, recipe.bounds[1]!],
        [recipe.bounds[2]!, recipe.bounds[3]!],
      ],
      maxBounds: [
        [recipe.bounds[0]!, recipe.bounds[1]!],
        [recipe.bounds[2]!, recipe.bounds[3]!],
      ],
      minZoom: 5,
      maxZoom: 12,
      maxPitch: 0,
      dragRotate: false,
      attributionControl: false,
      renderWorldCopies: false,
      cooperativeGestures: true,
    });
  } catch (error) {
    releaseProtocol();
    throw error;
  }
  let frame = initial;
  let disposed = false;
  let loaded = false;
  let regionId: string | undefined;
  let unavailable = false;
  let paintGeneration = 0;
  let pendingPaintFrame: number | undefined;
  let resize: ResizeObserver | undefined;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (pendingPaintFrame !== undefined) cancelAnimationFrame(pendingPaintFrame);
    pendingPaintFrame = undefined;
    resize?.disconnect();
    map.off('error', onError);
    map.off('webglcontextlost', onError);
    map.off('click', onClick);
    map.off('load', onLoad);
    try {
      map.remove();
    } finally {
      releaseProtocol();
    }
  };
  const onError = () => {
    if (disposed || unavailable) return;
    unavailable = true;
    callbacks.unavailable();
    // Leave MapLibre's event stack before removing its sources, requests and worker ownership.
    queueMicrotask(dispose);
  };
  const resetView = () => {
    const region = getRegionConfig(frame.regionId)!;
    map.fitBounds(
      [
        [region.bounds.west, region.bounds.south],
        [region.bounds.east, region.bounds.north],
      ],
      { animate: false, padding: 28 },
    );
    regionId = frame.regionId;
  };
  const update = (value: MapFrame, painted?: () => void) => {
    const generation = ++paintGeneration;
    frame = value;
    if (disposed || unavailable) return;
    try {
      if (regionId !== frame.regionId) resetView();
      if (!loaded) return;
      (map.getSource('observations') as maplibre.GeoJSONSource).setData(frame.observations);
      (map.getSource('selected-trail') as maplibre.GeoJSONSource).setData(frame.selectedTrail);
      map.setFilter('selection', ['==', ['get', 'aircraftId'], frame.selectedId ?? '']);
      map.setFilter('selected-trail-evidence', [
        '==',
        ['get', 'historySequence'],
        frame.resolvedHistorySequence ?? -1,
      ]);
      if (painted) {
        const onIdle = () => {
          map.off('idle', onIdle);
          if (disposed || unavailable || generation !== paintGeneration) return;
          if (pendingPaintFrame !== undefined) cancelAnimationFrame(pendingPaintFrame);
          pendingPaintFrame = requestAnimationFrame(() => {
            pendingPaintFrame = undefined;
            if (!disposed && !unavailable && generation === paintGeneration) painted();
          });
        };
        map.once('idle', onIdle);
      }
    } catch {
      onError();
    }
  };
  const onClick = (event: maplibre.MapMouseEvent) => {
    if (disposed || !loaded || unavailable) return;
    try {
      const point = event.point;
      const features = map.queryRenderedFeatures(
        [
          [point.x - 9, point.y - 9],
          [point.x + 9, point.y + 9],
        ],
        { layers: ['selected-trail-point', 'aircraft', 'unknown-track', 'stale-position'] },
      );
      const selection = nearestMapEvidence(features, point, (coordinates) =>
        map.project(coordinates),
      );
      if (selection !== undefined) callbacks.select(selection);
    } catch {
      onError();
    }
  };
  const onLoad = () => {
    if (disposed || unavailable) return;
    try {
      map.addImage('aircraft-symbol', aircraftIcon(), { sdf: true });
      map.addSource('selected-trail', { type: 'geojson', data: frame.selectedTrail });
      map.addSource('observations', { type: 'geojson', data: frame.observations });
      const color: maplibre.ExpressionSpecification = [
        'match',
        ['get', 'freshness'],
        'current',
        '#075eae',
        'delayed',
        '#956000',
        '#667580',
      ];
      map.addLayer({
        id: 'selected-trail-line',
        type: 'line',
        source: 'selected-trail',
        filter: ['==', ['geometry-type'], 'LineString'],
        paint: {
          'line-color': '#075eae',
          'line-width': 2,
          'line-opacity': 0.68,
          'line-dasharray': [2, 2],
        },
      });
      map.addLayer({
        id: 'selected-trail-point',
        type: 'circle',
        source: 'selected-trail',
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-radius': 4,
          'circle-color': '#ffffff',
          'circle-stroke-width': 2,
          'circle-stroke-color': '#075eae',
        },
      });
      map.addLayer({
        id: 'stale-position',
        type: 'circle',
        source: 'observations',
        filter: ['==', ['get', 'freshness'], 'stale'],
        paint: {
          'circle-radius': 7,
          'circle-color': '#ffffff',
          'circle-opacity': 0.65,
          'circle-stroke-width': 2,
          'circle-stroke-color': '#667580',
        },
      });
      map.addLayer({
        id: 'unknown-track',
        type: 'circle',
        source: 'observations',
        filter: ['all', ['!=', ['get', 'freshness'], 'stale'], ['==', ['get', 'track'], null]],
        paint: {
          'circle-radius': 6,
          'circle-color': color,
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
        },
      });
      map.addLayer({
        id: 'aircraft',
        type: 'symbol',
        source: 'observations',
        filter: ['all', ['!=', ['get', 'freshness'], 'stale'], ['!=', ['get', 'track'], null]],
        layout: {
          'icon-image': 'aircraft-symbol',
          'icon-size': 0.8,
          'icon-rotate': ['get', 'track'],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
        },
        paint: { 'icon-color': color, 'icon-halo-color': '#ffffff', 'icon-halo-width': 1 },
      });
      map.addLayer({
        id: 'observation-label',
        type: 'symbol',
        source: 'observations',
        layout: {
          'text-field': ['get', 'label'],
          'text-font': ['Noto Sans Medium'],
          'text-size': 12,
          'text-offset': [0, 1.8],
        },
        paint: { 'text-color': '#233b4c', 'text-halo-color': '#ffffff', 'text-halo-width': 2 },
      });
      map.addLayer({
        id: 'selection',
        type: 'circle',
        source: 'observations',
        paint: {
          'circle-radius': 16,
          'circle-opacity': 0,
          'circle-stroke-width': 2,
          'circle-stroke-color': '#075eae',
        },
      });
      map.addLayer({
        id: 'selected-trail-evidence',
        type: 'circle',
        source: 'selected-trail',
        filter: ['==', ['get', 'historySequence'], frame.resolvedHistorySequence ?? -1],
        paint: {
          'circle-radius': 9,
          'circle-color': '#ffffff',
          'circle-opacity': 0.82,
          'circle-stroke-width': 3,
          'circle-stroke-color': '#075eae',
        },
      });
      loaded = true;
      update(frame);
      if (!unavailable) callbacks.ready();
    } catch {
      onError();
    }
  };
  try {
    map.on('error', onError);
    map.on('webglcontextlost', onError);
    map.on('click', onClick);
    map.once('load', onLoad);
    const canvas = map.getCanvas();
    canvas.setAttribute(
      'aria-label',
      'Interactive regional geography, with observations in the linked aircraft table',
    );
    canvas.setAttribute('aria-describedby', 'map-instructions');
    map.addControl(new maplibre.NavigationControl({ showCompass: false }), 'top-right');
    map.touchZoomRotate.disableRotation();
    resize = new ResizeObserver(() => {
      if (disposed || unavailable) return;
      try {
        map.resize();
      } catch {
        onError();
      }
    });
    resize.observe(container);
    resetView();
  } catch (error) {
    dispose();
    throw error;
  }
  return {
    update,
    resetView() {
      if (disposed || unavailable) return;
      try {
        resetView();
      } catch {
        onError();
      }
    },
    dispose,
  };
}
