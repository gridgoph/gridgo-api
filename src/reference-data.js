import { defaultOperationalSettings } from "./operational-model.js";
import { defaultTaxonomy } from "./taxonomy.js";

export function defaultCatalog() {
  return [
    { id: "prod_tarpaulin", name: "Tarpaulin / Banner", family: "banner", basePriceMinor: 45000, unit: "sqm" },
    { id: "prod_sticker", name: "Stickers", family: "sticker", basePriceMinor: 15000, unit: "sheet" },
    { id: "prod_flyer", name: "Brochures / Flyers", family: "flyer", basePriceMinor: 2500, unit: "pack100" },
    { id: "prod_card", name: "Business Cards", family: "card", basePriceMinor: 35000, unit: "box100" },
    { id: "prod_apparel", name: "Simple Apparel Print", family: "apparel", basePriceMinor: 28000, unit: "piece" },
  ];
}

export function defaultZones() {
  return [
    { id: "zone_central", code: "davao_central", name: "Davao Central (Bajada / JP Laurel)", active: true },
    { id: "zone_south", code: "davao_south", name: "Davao South (Matina)", active: true },
    { id: "zone_north", code: "davao_north", name: "Davao North (Lanang)", active: true },
    { id: "zone_west", code: "davao_west", name: "Davao West (Toril side)", active: true },
    { id: "zone_east", code: "davao_east", name: "Davao East (Buhangin / Sasa)", active: true },
  ];
}

export function defaultAcceptedFileFormats() {
  return [
    { code: "pdf", displayName: "PDF", inputKind: "file", extensions: ["pdf"], mimeTypes: ["application/pdf"], active: true },
    { code: "png", displayName: "PNG", inputKind: "file", extensions: ["png"], mimeTypes: ["image/png"], active: true },
    { code: "jpeg", displayName: "JPEG", inputKind: "file", extensions: ["jpg", "jpeg"], mimeTypes: ["image/jpeg"], active: true },
    { code: "psd", displayName: "Adobe Photoshop", inputKind: "file", extensions: ["psd"], mimeTypes: ["image/vnd.adobe.photoshop", "application/octet-stream"], active: true },
    { code: "canva_link", displayName: "Canva link", inputKind: "url", extensions: [], mimeTypes: [], active: true },
    { code: "3mf", displayName: "3MF", inputKind: "file", extensions: ["3mf"], mimeTypes: ["model/3mf", "application/vnd.ms-package.3dmanufacturing-3dmodel+xml"], active: true },
    { code: "stl", displayName: "STL", inputKind: "file", extensions: ["stl"], mimeTypes: ["model/stl", "application/sla"], active: true },
  ];
}

export function referenceData() {
  return {
    catalog: defaultCatalog(),
    taxonomy: defaultTaxonomy(),
    settings: defaultOperationalSettings(),
    zones: defaultZones(),
    acceptedFileFormats: defaultAcceptedFileFormats(),
  };
}
