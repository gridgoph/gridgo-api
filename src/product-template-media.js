import fs from "node:fs/promises";
import { defaultListingStarters } from "./listing-starters.js";

const photos = new Set(defaultListingStarters().map((row) => `${row.id}.jpg`));
/** Only shipped, governed stock photographs can resolve to a reference object. */
export function templatePhotoKey(url) {
  const name =
    typeof url === "string" && url.startsWith("/product-template-photos/")
      ? url.slice("/product-template-photos/".length)
      : null;
  return photos.has(name) ? `reference/product-templates/${name}` : null;
}

export async function seedProductTemplatePhotos(objectStorage) {
  if (!objectStorage) return false;
  await objectStorage.ensureBucket();
  for (const name of photos) {
    const key = `reference/product-templates/${name}`;
    // Existing keys are immutable. New artwork uses a new photo ID.
    try {
      await objectStorage.statObject(key);
      continue;
    } catch (error) {
      if (error.code !== "storage_object_missing") throw error;
    }
    const body = await fs.readFile(
      new URL(`./seed-assets/starters/${name}`, import.meta.url),
    );
    await objectStorage.putObject({
      key,
      body,
      contentType: "image/jpeg",
      size: body.length,
    });
  }
  return true;
}
