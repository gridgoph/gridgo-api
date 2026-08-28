import test from "node:test";
import assert from "node:assert/strict";

import { philippineMobileNumber } from "../src/phone.js";

test("every shape a shop owner types normalizes to one canonical number", () => {
  for (const typed of [
    "09171234567",
    "0917 123 4567",
    "0917-123-4567",
    "(0917) 123-4567",
    "639171234567",
    "63 917 123 4567",
    "+639171234567",
    "+63 (917) 123-4567",
    "  09171234567  ",
  ]) {
    assert.equal(philippineMobileNumber(typed), "+639171234567", typed);
  }
});

test("a blank number is refused so a shop cannot erase its only contact", () => {
  for (const typed of ["", "   ", "\t", null, undefined]) {
    assert.throws(
      () => philippineMobileNumber(typed),
      (error) => error.status === 400
        && error.code === "invalid_supplier_profile"
        && error.details.field === "phone",
    );
  }
});

test("a number that is not a Philippine mobile is refused with the field named", () => {
  for (const typed of [
    "0817123456",
    "091712345678",
    "0917123456",
    "+1 415 555 0123",
    "+63821234567",
    "0917123456a",
    "0917.123.4567",
    "639171234567 ext 4",
  ]) {
    assert.throws(
      () => philippineMobileNumber(typed),
      (error) => error.status === 400
        && error.code === "invalid_supplier_profile"
        && error.details.field === "phone",
      typed,
    );
  }
});

test("the rejected field follows the caller so another form can reuse the check", () => {
  assert.throws(
    () => philippineMobileNumber("nope", "contactPhone"),
    (error) => error.details.field === "contactPhone",
  );
});
