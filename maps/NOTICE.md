# Georgia regional map assets

These assets provide geographic context only. They are not aviation navigation charts, current airspace restrictions or evidence that any aircraft is visible.

- Basemap data: Protomaps Basemap 4.15.2, derived from OpenStreetMap and Natural Earth. OpenStreetMap and OSM-derived coastlines are licensed under ODbL. Display `© OpenStreetMap contributors` with a link to [OpenStreetMap copyright](https://www.openstreetmap.org/copyright).
- Landcover: ESA WorldCover, CC BY 4.0, as described in the bundled basemap data-license notice. [WorldCover data access](https://esa-worldcover.org/en/data-access).
- Styling software: `@protomaps/basemaps` 5.7.2, BSD-3-Clause. Map design: CC0. Local changes are regional bounds, local asset URLs and aircraft observation overlays.
- Glyphs: Noto Sans Regular, Medium and Italic, SIL Open Font License. The complete `fonts/OFL.txt` is bundled with the prepared assets.
- Sprites: Protomaps v4 light sprites, derived from Mapzen/Tangram icons, MIT. Their copyright and license are included in the bundled `licenses/LICENSE_DATA.md` and `licenses/LICENSE.md`.
- Rendering: MapLibre GL JS, BSD-3-Clause. PMTiles browser decoder and CLI: BSD-3-Clause.

The checked-in recipe pins the source date, extraction bounds, zoom limit, utility version, style and asset commits. `pnpm maps:prepare` downloads only the regional PMTiles extract and pinned preparation dependencies. `pnpm maps:manifest` verifies the header, generates the style and records SHA-256/size for each asset. The reported planet BLAKE3 is provenance only; downloading a partial extract cannot establish a whole-planet checksum match.

The archive and prepared binary assets live in ignored `.map-data/`, not in the source repository. `maps/manifest.json` is the allowlist and integrity record. Do not replace bytes under an existing map ID. A source/style/asset change requires a new ID and manifest. The original daily archive can age out of Protomaps hosting; retain the exact prepared artifact for a release rather than relying on a moving download URL.

Preparation and local R2 emulation do not create a Cloudflare bucket or authorize publication. Map and infrastructure launch gates remain separate.

Sources: [basemap distribution](https://docs.protomaps.com/basemaps/downloads), [license guidelines](https://github.com/protomaps/basemaps#licensing-and-attribution-guidelines), [asset licenses](https://github.com/protomaps/basemaps-assets#license), [PMTiles CLI](https://docs.protomaps.com/pmtiles/cli).
