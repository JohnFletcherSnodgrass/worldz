// Builds data/world-data.js from real datasets:
//   - world-atlas (Natural Earth 1:50m country outlines, public domain)
//   - world-countries (country names, regions, coordinates; ODbL, from mledoze/countries)
// Nothing about a country is typed in by hand except the editorial choices marked EDITORIAL.
import fs from "node:fs";
import { createRequire } from "node:module";
import * as topojson from "topojson-client";
import { geoArea } from "d3";

const require = createRequire(import.meta.url);
const topo = require("world-atlas/countries-50m.json");
const wc = require("world-countries");

const R = 6371.0088; // km
const geoms = topo.objects.countries.geometries;
// The atlas can give two shapes the same id (e.g. Ashmore and Cartier Is. shares Australia's). Keep them all.
const byId = new Map();
for (const g of geoms) if (g.id) byId.set(g.id, [...(byId.get(g.id) || []), g]);
const byName = new Map(geoms.map((g) => [g.properties.name, g]));

// EDITORIAL: independent states, plus Taiwan, Palestine and Kosovo, which most map quizzes include.
const extra = new Set(["TWN", "PSE"]);
const countries = wc.filter((c) => c.independent || extra.has(c.cca3));
countries.push({ cca3: "XKX", ccn3: undefined, name: { common: "Kosovo" }, region: "Europe", subregion: "Southeast Europe", latlng: [42.667, 21.167], area: 10887, _atlasName: "Kosovo" });

// EDITORIAL: pieces of a country that the atlas draws separately.
const mergeIn = { SOM: ["Somaliland"], CYP: ["N. Cyprus"] };

const round = (n) => Math.round(n * 100) / 100;
function roundRing(ring) {
  const out = [];
  for (const [x, y] of ring) {
    const p = [round(x), round(y)];
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  return out.length >= 4 ? out : null;
}
function roundGeometry(g) {
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  const outPolys = [];
  for (const poly of polys) {
    const rings = poly.map(roundRing).filter(Boolean);
    if (rings.length) outPolys.push(rings);
  }
  return outPolys.length === 1 ? { type: "Polygon", coordinates: outPolys[0] } : { type: "MultiPolygon", coordinates: outPolys };
}
const areaKm2 = (geom) => geoArea({ type: "Feature", geometry: geom }) * R * R;

function continentsOf(c) {
  if (c.cca3 === "XKX") return ["Europe"];
  const list = [];
  if (c.region === "Africa") list.push("Africa");
  else if (c.region === "Europe") list.push("Europe");
  else if (c.region === "Asia") list.push("Asia");
  else if (c.region === "Oceania") list.push("Oceania");
  else if (c.region === "Americas") list.push(c.subregion === "South America" ? "South America" : "North America");
  // EDITORIAL: the two big transcontinental countries are playable on both maps.
  if (c.cca3 === "RUS") list.push("Asia");
  if (c.cca3 === "TUR") list.push("Europe");
  return list;
}

const out = { countries: [], context: [] };
const used = new Set();
const problems = [];

for (const c of countries) {
  const parts = c._atlasName ? [byName.get(c._atlasName)] : byId.get(c.ccn3) || [];
  parts.push(...(mergeIn[c.cca3] || []).map((n) => byName.get(n)));
  let geometry = null;
  if (parts.length) {
    parts.forEach((p) => used.add(p));
    geometry = parts.length > 1 ? topojson.merge(topo, parts) : topojson.feature(topo, parts[0]).geometry;
    geometry = roundGeometry(geometry);
  }
  const area = c.area || (geometry ? areaKm2(geometry) : 0);
  if (geometry && c.area && c.area > 1000) {
    const ratio = areaKm2(geometry) / c.area;
    if (ratio < 0.7 || ratio > 1.4) problems.push(`${c.name.common}: outline ${Math.round(areaKm2(geometry))} km2 vs listed ${c.area}`);
  }
  out.countries.push({
    id: c.cca3,
    name: c.name.common,
    continents: continentsOf(c),
    area: Math.round(area),
    latlng: c.latlng,
    geometry,
  });
}

for (const g of geoms) {
  if (used.has(g)) continue;
  if (g.properties.name === "Antarctica") continue;
  out.context.push({ name: g.properties.name, geometry: roundGeometry(topojson.feature(topo, g).geometry) });
}

out.countries.sort((a, b) => a.name.localeCompare(b.name));
fs.writeFileSync("data/world-data.js", "window.WORLDZ_DATA = " + JSON.stringify(out) + ";\n");

const noGeom = out.countries.filter((c) => !c.geometry).map((c) => c.name);
console.log(`countries: ${out.countries.length}, context shapes: ${out.context.length}`);
console.log("no outline (drawn as dots):", noGeom.join(", ") || "none");
console.log("area sanity warnings:", problems.length ? problems : "none");
for (const k of ["Africa", "Asia", "Europe", "North America", "South America", "Oceania"])
  console.log(k, out.countries.filter((c) => c.continents.includes(k)).length);
console.log("small(<100k km2):", out.countries.filter((c) => c.area < 100000).length, "big:", out.countries.filter((c) => c.area >= 100000).length);
console.log("no continent:", out.countries.filter((c) => !c.continents.length).map((c) => c.name));
