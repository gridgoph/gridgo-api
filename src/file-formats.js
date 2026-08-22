/**
 * Platform file types a listing may name, and which of those GRIDGO can store.
 *
 * Super Admin / seed owns the `accepted_file_formats` rows. This module owns
 * aliases, which file codes `POST /files` purpose=artwork can actually sniff,
 * and how a shop's "plus" query resolves. A shop never invents a code.
 */

export const FORMAT_QUERY_MAX = 40;

export const UNOPENED_FILE_MESSAGE =
  "GRIDGO can't take that file yet. Tick Any other https link so they can send a Drive or WeTransfer file.";

/** Magic-byte types `purpose=artwork` will store. Keys are sniffed MIME. */
export const ARTWORK_UPLOAD_MIME_TO_CODE = Object.freeze({
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/webp": "webp",
  "image/vnd.adobe.photoshop": "psd",
});

export const ARTWORK_UPLOAD_CONTENT_TYPES = Object.freeze(Object.keys(ARTWORK_UPLOAD_MIME_TO_CODE));

const ARTWORK_UPLOAD_CODES = new Set(Object.values(ARTWORK_UPLOAD_MIME_TO_CODE));

/**
 * Extra aliases a shop might type. Extensions and the code itself are always
 * aliases; these cover the names print shops actually say.
 */
const EXTRA_ALIASES = Object.freeze({
  jpeg: ["jpg"],
  psd: ["photoshop", "adobephotoshop"],
  canva_link: ["canva"],
  google_drive: ["drive", "googledrive", "gdrive"],
  dropbox: ["dropbox"],
  we_transfer: ["wetransfer"],
  other_link: ["other", "otherlink", "link", "url", "https"],
});

export function normalizeFormatQuery(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\./, "")
    .replace(/[\s\-_]+/g, "");
}

export function isUploadableFileCode(code) {
  return ARTWORK_UPLOAD_CODES.has(code);
}

export function artworkCodeForContentType(mime) {
  return ARTWORK_UPLOAD_MIME_TO_CODE[mime] || null;
}

export function aliasesFor(format) {
  const extras = EXTRA_ALIASES[format.code] || [];
  return [...new Set(
    [format.code, format.displayName, ...(format.extensions || []), ...extras]
      .map(normalizeFormatQuery)
      .filter(Boolean),
  )];
}

export function projectAcceptedFormat(format) {
  const inputKind = format.inputKind === "url" ? "url" : "file";
  return {
    code: format.code,
    displayName: format.displayName,
    inputKind,
    extensions: [...(format.extensions || [])],
    mimeTypes: [...(format.mimeTypes || [])],
    aliases: aliasesFor(format),
    uploadable: inputKind === "file" && isUploadableFileCode(format.code),
    active: format.active !== false,
  };
}

export function publicAcceptedFormats(store) {
  return (store.acceptedFileFormats || [])
    .filter((format) => format.active !== false)
    .map(projectAcceptedFormat)
    .sort((left, right) => left.code.localeCompare(right.code));
}

/**
 * Whether sniffed artwork bytes are in this listing's effective accepted set.
 *
 * Extension is irrelevant. Unknown sniffed MIME is never accepted.
 */
export function listingAcceptsArtwork(acceptedFormats, sniffedContentType) {
  const code = artworkCodeForContentType(sniffedContentType);
  if (!code) return false;
  return (acceptedFormats || []).some((format) => {
    const projected = format.code ? projectAcceptedFormat(format) : format;
    return projected.active !== false && projected.code === code;
  });
}

export function resolveFormatQuery(query, formats) {
  const normalized = normalizeFormatQuery(query);
  if (!normalized) {
    return { status: "empty", query: "", format: null, message: null };
  }
  const match = (formats || []).find((format) => {
    const projected = format.aliases ? format : projectAcceptedFormat(format);
    if (projected.active === false) return false;
    return projected.aliases.includes(normalized);
  });
  if (!match) {
    return {
      status: "unknown",
      query: String(query).trim(),
      format: null,
      message: UNOPENED_FILE_MESSAGE,
    };
  }
  const format = match.aliases ? match : projectAcceptedFormat(match);
  if (format.inputKind === "url" || format.uploadable) {
    return { status: "matched", query: String(query).trim(), format, message: null };
  }
  return {
    status: "link_only",
    query: String(query).trim(),
    format,
    message: UNOPENED_FILE_MESSAGE,
  };
}
