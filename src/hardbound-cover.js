import { artworkFileIdsFor } from "./artwork-attachments.js";

/**
 * The cover choice and spine text for hardbound and bound books.
 *
 * A client ordering a binding product says how the cover is made (the first
 * page of the file, a separate uploaded cover page, or a plain cover lettered
 * with text only) and gives the spine lettering: an optional institution code,
 * the title, the author, and the month and year. The shop works out the cover
 * and spine dimensions itself, so there is no template and no spine width here.
 *
 * Which products ask is decided by the catalogue, never by the shop: every
 * listing whose approved product type is in COVER_SPINE_SUBCATEGORIES.
 *
 * The form is validated strictly whenever it is sent. Checkout requires it on
 * those lines only while the Super Admin setting `coverSpineRequired` is on,
 * because released client builds cannot send it; until then a line without it
 * is agreed as "not given" and the shop asks as before.
 *
 * Contract: docs/HARDBOUND_COVER_API.md.
 */

/** Product types (taxonomy subcategory codes) whose listings carry the form. */
export const COVER_SPINE_SUBCATEGORIES = Object.freeze(["binding_hardbound"]);

/** Canonical order; the codes are stable. */
export const COVER_CHOICES = Object.freeze(["first_page", "separate_file", "text_only"]);

export const SPINE_LIMITS = Object.freeze({ institutionCode: 24, title: 200, author: 160 });
export const SPINE_YEAR_RANGE = Object.freeze({ min: 1950, max: 2100 });

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const FORM_KEYS = new Set(["cover", "coverFileId", "spine"]);
const SPINE_KEYS = new Set(["institutionCode", "title", "author", "month", "year"]);

/** Whether a listing (read through the approved catalogue view) asks for the form. */
export function coverSpineApplies(item) {
  return COVER_SPINE_SUBCATEGORIES.includes(item?.subcategoryCode);
}

/** Whether checkout refuses an eligible line without the form. Off until Super Admin turns it on. */
export function coverSpineRequiredSetting(settings) {
  return settings?.coverSpineRequired === true;
}

function invalid(fail, field, reason, message) {
  fail(400, "invalid_cover_spine", message, { field, reason });
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function spineText(fail, spine, key, { required }) {
  const field = `coverSpine.spine.${key}`;
  const value = spine[key];
  if (value == null || (typeof value === "string" && !value.trim())) {
    if (required) invalid(fail, field, "required", `Enter the ${key === "title" ? "title" : "author"} for the spine.`);
    return null;
  }
  if (typeof value !== "string") invalid(fail, field, "not_text", `${field} must be text.`);
  // One line of lettering: no line breaks, tabs or other control characters.
  if (/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value)) invalid(fail, field, "not_one_line", "Spine text must be one line, without line breaks.");
  const text = value.trim().replace(/ {2,}/g, " ");
  if ([...text].length > SPINE_LIMITS[key]) {
    invalid(fail, field, "too_long", `Use at most ${SPINE_LIMITS[key]} characters.`);
  }
  return text;
}

function spineInteger(fail, spine, key, min, max, message) {
  const field = `coverSpine.spine.${key}`;
  const value = spine[key];
  if (value == null) invalid(fail, field, "required", message);
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(fail, field, "out_of_range", message);
  return value;
}

/**
 * A client's form on a cart line. Null clears it. The whole form is sent
 * together; the app keeps a half-typed form to itself for the live preview.
 */
export function parseCoverSpine(item, value, fail) {
  if (value == null) return null;
  if (!coverSpineApplies(item)) {
    fail(409, "cover_spine_not_applicable", "Cover and spine details are only taken for hardbound and binding products. Remove them and try again.", {
      field: "coverSpine",
    });
  }
  if (!isRecord(value)) invalid(fail, "coverSpine", "not_object", "Send coverSpine as an object with cover and spine.");
  const unknown = Object.keys(value).find(key => !FORM_KEYS.has(key));
  if (unknown) invalid(fail, `coverSpine.${unknown}`, "unknown_field", `coverSpine does not take ${unknown}.`);
  if (!COVER_CHOICES.includes(value.cover)) {
    fail(400, "invalid_cover_spine", "Choose the first page of the file, a separate cover page, or a plain text-only cover.", {
      field: "coverSpine.cover", reason: "unknown_cover", allowed: [...COVER_CHOICES],
    });
  }
  let coverFileId = null;
  if (value.cover === "separate_file") {
    if (typeof value.coverFileId !== "string" || !value.coverFileId.trim() || value.coverFileId.length > 120) {
      invalid(fail, "coverSpine.coverFileId", "required", "Attach the cover page and name it in coverFileId.");
    }
    coverFileId = value.coverFileId.trim();
  } else if (value.coverFileId != null) {
    invalid(fail, "coverSpine.coverFileId", "not_separate_file", "Only a separate cover page takes coverFileId.");
  }
  if (!isRecord(value.spine)) invalid(fail, "coverSpine.spine", "required", "Fill in the spine: title, author, month and year.");
  const unknownSpine = Object.keys(value.spine).find(key => !SPINE_KEYS.has(key));
  if (unknownSpine) invalid(fail, `coverSpine.spine.${unknownSpine}`, "unknown_field", `The spine does not take ${unknownSpine}.`);
  const spine = {
    institutionCode: spineText(fail, value.spine, "institutionCode", { required: false }),
    title: spineText(fail, value.spine, "title", { required: true }),
    author: spineText(fail, value.spine, "author", { required: true }),
    month: spineInteger(fail, value.spine, "month", 1, 12, "Choose the month, 1 to 12."),
    year: spineInteger(fail, value.spine, "year", SPINE_YEAR_RANGE.min, SPINE_YEAR_RANGE.max,
      `Enter the year as four digits, ${SPINE_YEAR_RANGE.min} to ${SPINE_YEAR_RANGE.max}.`),
  };
  return { cover: value.cover, coverFileId, spine };
}

/** A separate cover page travels as one of the line's own artwork files, so it is checked and released like them. */
export function assertCoverFileAttached(line, fail, details = {}) {
  const form = line.coverSpine;
  if (form?.cover !== "separate_file" || artworkFileIdsFor(line).includes(form.coverFileId)) return;
  fail(409, "cover_file_not_attached", "Attach the cover page to this item's artwork, or choose another cover.", {
    ...details, field: "coverSpine.coverFileId", fileId: form.coverFileId,
  });
}

/** Checkout's gate for one cart line. */
export function assertCheckoutCoverSpine(store, item, line, fail) {
  if (!coverSpineApplies(item)) {
    if (line.coverSpine != null) {
      fail(409, "cover_spine_not_applicable", "This product no longer takes cover and spine details. Remove them from the cart item and try again.", {
        lineId: line.id, field: "coverSpine",
      });
    }
    return;
  }
  if (line.coverSpine == null) {
    if (coverSpineRequiredSetting(store.settings)) {
      fail(409, "cover_spine_required", "Choose the cover and fill in the spine before checkout.", { lineId: line.id, field: "coverSpine" });
    }
    return;
  }
  assertCoverFileAttached(line, fail, { lineId: line.id });
}

/** The agreed form for an order line; null for products that do not ask. */
export function coverSpineSnapshot(item, line) {
  if (!coverSpineApplies(item)) return null;
  if (line.coverSpine == null) return { version: 1, status: "not_given" };
  return { version: 1, status: "given", ...structuredClone(line.coverSpine) };
}

/** "October 2026". */
export function spineDate(spine) {
  return spine?.month && spine?.year ? `${MONTHS[spine.month - 1]} ${spine.year}` : null;
}

/**
 * The lettering in reading order, one string, for lists and tickets where a
 * drawn spine does not fit. The apps draw their own preview from `spine`.
 */
export function spineSummary(spine) {
  if (!spine) return null;
  return [spine.institutionCode, spine.title, spine.author, spineDate(spine)].filter(Boolean).join(" | ");
}

function projected(form, status) {
  return {
    status,
    cover: form.cover,
    coverFileId: form.coverFileId ?? null,
    // Field order is fixed: jsonb does not keep the order it was written in.
    spine: {
      institutionCode: form.spine.institutionCode ?? null, title: form.spine.title, author: form.spine.author,
      month: form.spine.month, year: form.spine.year,
    },
    spineDate: spineDate(form.spine),
    spineSummary: spineSummary(form.spine),
  };
}

/** A cart line's form as the client sees it; null until given. */
export function publicCartCoverSpine(line) {
  return line.coverSpine == null ? null : projected(line.coverSpine, "given");
}

/**
 * An order line's agreed form. Null for products that do not ask and for
 * orders placed before this existed; `status: "not_given"` when the product
 * asked and the client did not answer.
 */
export function publicOrderCoverSpine(snapshot) {
  if (snapshot == null) return null;
  if (snapshot.status !== "given") return { status: "not_given", cover: null, coverFileId: null, spine: null, spineDate: null, spineSummary: null };
  return projected(snapshot, "given");
}
