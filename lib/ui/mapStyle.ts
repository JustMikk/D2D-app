"use client";
// Restyle the OpenFreeMap vector style with the design tokens (design doc §8.8): land concrete, roads paper
// with a concrete casing, water blue-100, labels asphalt-500. The dusk theme swaps all five, because the
// tokens are read at the moment the map loads. Best effort: a layer that does not match is left alone.
import type { Map as MapLibreMap, StyleSpecification } from "maplibre-gl";

type Layer = StyleSpecification["layers"][number];

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function applyTokenColors(map: MapLibreMap): void {
  const colors = { land: token("--map-land"), water: token("--map-water"), road: token("--map-road"), casing: token("--map-road-casing"), label: token("--map-label") };
  const layers = (map.getStyle()?.layers ?? []) as Layer[];
  for (const layer of layers) {
    const id = layer.id.toLowerCase();
    try {
      if (layer.type === "background") map.setPaintProperty(layer.id, "background-color", colors.land);
      else if (layer.type === "fill" && /water/.test(id)) map.setPaintProperty(layer.id, "fill-color", colors.water);
      else if (layer.type === "line" && /water/.test(id)) map.setPaintProperty(layer.id, "line-color", colors.water);
      else if (layer.type === "line" && /(road|highway|street|bridge|tunnel|motorway|trunk|primary|secondary|tertiary|minor|service|path)/.test(id)) {
        map.setPaintProperty(layer.id, "line-color", /(casing|outline)/.test(id) ? colors.casing : colors.road);
      } else if (layer.type === "symbol") {
        map.setPaintProperty(layer.id, "text-color", colors.label);
        map.setPaintProperty(layer.id, "text-halo-color", colors.land);
      }
    } catch {
      // Not every layer has these properties.
    }
  }
}
