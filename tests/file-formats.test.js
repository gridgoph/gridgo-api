import test from "node:test";
import assert from "node:assert/strict";

import { PURPOSE_POLICIES, validateUpload } from "../src/attachments.js";
import {
  ARTWORK_UPLOAD_CONTENT_TYPES,
  FORMAT_QUERY_MAX,
  UNOPENED_FILE_MESSAGE,
  artworkCodeForContentType,
  listingAcceptsArtwork,
  publicAcceptedFormats,
  resolveFormatQuery,
} from "../src/file-formats.js";
import { defaultAcceptedFileFormats } from "../src/reference-data.js";

const formats = defaultAcceptedFileFormats().map((format) => ({ ...format, active: true }));

test("artwork upload MIME list is exactly what purpose=artwork sniffs", () => {
  assert.deepEqual([...PURPOSE_POLICIES.artwork.contentTypes].sort(), [...ARTWORK_UPLOAD_CONTENT_TYPES].sort());
});

test("plus finds aliases of types GRIDGO can store", () => {
  assert.equal(resolveFormatQuery("JPG", formats).status, "matched");
  assert.equal(resolveFormatQuery("JPG", formats).format.code, "jpeg");
  assert.equal(resolveFormatQuery(".png", formats).format.code, "png");
  assert.equal(resolveFormatQuery("Photoshop", formats).format.code, "psd");
  assert.equal(resolveFormatQuery("webp", formats).format.code, "webp");
  assert.equal(resolveFormatQuery("Canva", formats).format.code, "canva_link");
  assert.equal(resolveFormatQuery("Google Drive", formats).format.code, "google_drive");
});

test("unknown and uns sniffable types tell the shop to take a link", () => {
  const ai = resolveFormatQuery("AI", formats);
  assert.equal(ai.status, "unknown");
  assert.equal(ai.message, UNOPENED_FILE_MESSAGE);

  const model = resolveFormatQuery("3mf", formats);
  assert.equal(model.status, "link_only");
  assert.equal(model.format.code, "3mf");
  assert.equal(model.format.uploadable, false);
  assert.equal(model.message, UNOPENED_FILE_MESSAGE);

  const stl = resolveFormatQuery(".STL", formats);
  assert.equal(stl.status, "link_only");
  assert.equal(stl.format.code, "stl");
});

test("a listing only accepts artwork GRIDGO sniffed into its own set", () => {
  const accepted = [{ code: "pdf", displayName: "PDF", inputKind: "file", extensions: ["pdf"], active: true }];
  assert.equal(listingAcceptsArtwork(accepted, "application/pdf"), true);
  assert.equal(listingAcceptsArtwork(accepted, "image/jpeg"), false);
  assert.equal(listingAcceptsArtwork(accepted, "application/zip"), false);
  assert.equal(artworkCodeForContentType("image/vnd.adobe.photoshop"), "psd");
});

test("the public registry marks 3MF un-uploadable and WebP uploadable", () => {
  const published = publicAcceptedFormats({ acceptedFileFormats: formats });
  assert.equal(published.find((format) => format.code === "webp").uploadable, true);
  assert.equal(published.find((format) => format.code === "psd").uploadable, true);
  assert.equal(published.find((format) => format.code === "3mf").uploadable, false);
  assert.equal(published.find((format) => format.code === "other_link").inputKind, "url");
  assert.ok(published.find((format) => format.code === "jpeg").aliases.includes("jpg"));
});

test("Photoshop artwork sniffs 8BPS and a 3MF zip does not pass as artwork", () => {
  const psd = Buffer.from("8BPS");
  assert.equal(
    validateUpload({ originalFilename: "layout.psd", declaredContentType: "", sniffBytes: psd, size: 12 }, "artwork"),
    "image/vnd.adobe.photoshop",
  );
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.throws(
    () => validateUpload({ originalFilename: "model.3mf", declaredContentType: "", sniffBytes: zip, size: 12 }, "artwork"),
    (error) => error.code === "file_type_mismatch",
  );
});

test("finder query length is the plus field's cap", () => {
  assert.equal(FORMAT_QUERY_MAX, 40);
});
