import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseDecisionSection, projectTrackerItem, normalizeIssue } from "../src/tracker.js";

function fixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/tracker-decisions/${name}.json`, import.meta.url))).body;
}

// Expected question counts, option keys and recommendations are taken from the
// captured issues, independently of the parser. All fixtures stay offline.
const shapes = [
  ["gridgo-api-117", ["ABC", "ABC"], "AB"],
  ["gridgo-api-123", ["ABCD", "AB"], "DA"],
  ["gridgo-api-125", ["ABC"], "A"],
  ["gridgo-api-131", ["ABC", "ABC", "ABC", "ABCD"], "ACAD"],
  ["gridgo-api-132", ["ABC", "AB"], "AA"],
  ["gridgo-api-133", ["ABC"], "A"],
  ["gridgo-client-170", ["ABCD", "ABC", "ABC"], "BAB"],
  ["gridgo-rider-76", ["ABC", "AB", "AB"], "AAA"],
  ["gridgo-web-115", ["AB"], "A"],
  ["gridgo-web-116", ["ABC", "ABC"], "AB"],
];

for (const [name, keys, recommended] of shapes) {
  test(`decision section: real ${name} issue body`, () => {
    const body = fixture(name);
    const { decisionQuestions, decisionMarkdown } = parseDecisionSection(body);
    assert.equal(decisionQuestions.length, keys.length);
    assert.equal(decisionMarkdown, body.split("## Waiting on a decision\n")[1].split(/\n## /)[0].replace(/<!--\s*tracker:[\s\S]*?-->/g, "").trim());
    for (const [index, question] of decisionQuestions.entries()) {
      assert.equal(question.number, index + 1);
      assert.ok(question.question.endsWith("?"));
      assert.ok(body.includes(question.question));
      assert.equal(question.options.map((option) => option.key).join(""), keys[index]);
      assert.equal(question.allowOther, true);
      assert.equal(question.recommended.key, recommended[index]);
      assert.ok(question.recommended.reason.length > 20);
      for (const option of question.options) {
        assert.ok(option.label.length > 0);
        assert.ok(!option.label.includes("**"));
        assert.ok(body.includes(option.label));
        assert.ok(body.includes(option.detail));
      }
    }
    assert.ok(!JSON.stringify({ decisionQuestions, decisionMarkdown }).includes("<!--"));
    const projected = projectTrackerItem(normalizeIssue({ name: "gridgo-api" }, { number: 1, body, labels: ["tracker"] }));
    assert.deepEqual(projected.decisionQuestions, decisionQuestions);
    assert.equal(projected.decisionMarkdown, decisionMarkdown);
  });
}

test("real issue variants preserve inline context, option punctuation, code and recommendation qualifiers", () => {
  const checkout = parseDecisionSection(fixture("gridgo-api-117")).decisionQuestions;
  assert.deepEqual(checkout[1].options[0], {
    key: "A", label: "One receipt per shop group,",
    detail: "matching the separate ledger, payout and refund of each group. The client gets several receipts for one payment.",
  });
  assert.equal(checkout[1].options[1].label, "One combined receipt");
  assert.equal(checkout[1].options[2].label, "Both:");
  assert.equal(checkout[0].recommended.reason, "for the pilot. Each group already gets its own rider and payout, so one deadline keeps checkout short.");
  const deductions = parseDecisionSection(fixture("gridgo-api-123")).decisionQuestions;
  assert.equal(deductions[0].context, "(The tiers themselves were decided on 2 Oct.)");
  assert.deepEqual(deductions[0].recommended, { key: "D", reason: "starting at A. The pilot can begin gentle, and the rates can rise later without a release." });
  const app = parseDecisionSection(fixture("gridgo-api-125")).decisionQuestions[0];
  assert.equal(app.number, 1); // The source says "Question." without a number.
  assert.equal(app.options[0].label, "`gridgoph/gridgo-admin`, public,");
  const maps = parseDecisionSection(fixture("gridgo-client-170")).decisionQuestions[1];
  assert.equal(maps.context, "With the current fees (Nearby up to 5 km ₱89, Away 5–10 km ₱149, Long Distance 10–15 km ₱229, Out of Zone ₱40 + ₱15 per km):\n- a drop-off 9 km away in a straight line but 12 km by road pays ₱149 today and ₱229 by road;\n- a drop-off 16 km away in a straight line but 20 km by road pays ₱280 today and ₱340 by road.\n\nThe options:");
  assert.deepEqual(maps.recommended, { key: "A", reason: "for the pilot. The zones are wide enough that the difference is modest; revisit together with the switch in Question 1." });
  assert.equal(parseDecisionSection(fixture("gridgo-api-131")).decisionQuestions[3].options[0].detail, "");
});

test("whitespace, CRLF, optional context/recommendation, multiline details and section bounds", () => {
  const section = [
    " ** Question 2 . Choose? ** Inline context.", "", "More context.", "- context bullet",
    " + ** a . __Alpha__. ** First line.", "   Continued detail.", " - ** B. Beta **",
    " - ** Something else: ** write here.", "", " * Recommended : a. * First reason. Another sentence.",
    "", "**Question 7. Next?**", "- **A. Yes.**", "- **B. No.**",
  ].join("\r\n");
  const body = `Before\r\n  ##  Waiting on a decision  ## \r\n${section}\r\n# Next section\r\nHidden\r\n`;
  const parsed = parseDecisionSection(body);
  assert.equal(parsed.decisionMarkdown, section.trim());
  assert.deepEqual(parsed.decisionQuestions, [
    { number: 2, question: "Choose?", context: "Inline context.\n\nMore context.\n- context bullet", options: [
      { key: "A", label: "Alpha.", detail: "First line.\n   Continued detail." },
      { key: "B", label: "Beta", detail: "" },
    ], allowOther: true, recommended: { key: "A", reason: "First reason. Another sentence." } },
    { number: 7, question: "Next?", context: "", options: [
      { key: "A", label: "Yes.", detail: "" }, { key: "B", label: "No.", detail: "" },
    ], allowOther: true, recommended: null },
  ]);
});

test("absent, empty and non-string bodies never throw", () => {
  for (const body of [undefined, null, 42, [], {}, Object.create(null), "", "No section", "## Waiting on a decision\n\n## Done\nOther"]) {
    assert.deepEqual(parseDecisionSection(body), { decisionQuestions: [], decisionMarkdown: "" });
  }
});

test("malformed sections retain Markdown, with no partial question panel", () => {
  for (const markdown of [
    "We need a decision.", "**Question 1. Choose?**\nNo options yet.",
    "**Question 1 Choose?**\n- **A. Yes.**", "**Question 0. Choose?**\n- **A. Yes.**",
    "**Question 99999999999999999. Choose?**\n- **A. Yes.**",
    "**Question 1. Choose?**\n- **A. ** Empty label", "**Question 1. Choose?**\n- **A. Yes.**\n- **A. Duplicate.**",
    "**Question 1. Choose?**\n- **A. Yes.**\n- B. Broken option",
    "**Question 1. Choose?**\n- **A. Yes.**\n**Question 2. Missing options?**",
    "**Question 1. Choose?**\n- **A. Yes.**\n**Question 1. Duplicate?**\n- **B. No.**",
  ]) {
    assert.deepEqual(parseDecisionSection(`## Waiting on a decision\n${markdown}`), { decisionQuestions: [], decisionMarkdown: markdown });
  }
});

test("hidden markers never appear in fallback or parsed fields, including unterminated markers", () => {
  const markdown = "**Question 1. Choose?**\n- **A. Yes.**\n- **B. No.**";
  for (const marker of ['<!-- tracker: {"private":"secret"} -->', '<!-- TRACKER : {broken', '<!-- tracker: \n## Waiting on a decision\nsecret\n-->']) {
    const parsed = parseDecisionSection(`## Waiting on a decision\n${markdown}\n${marker}`);
    assert.equal(parsed.decisionMarkdown, markdown);
    assert.equal(parsed.decisionQuestions.length, 1);
    assert.ok(!JSON.stringify(parsed).includes("secret"));
    assert.deepEqual(parseDecisionSection(`## Waiting on a decision\nunsupported\n${marker}`), { decisionQuestions: [], decisionMarkdown: "unsupported" });
  }
  assert.deepEqual(parseDecisionSection('<!-- tracker: \n## Waiting on a decision\nsecret -->'), { decisionQuestions: [], decisionMarkdown: "" });
});

test("an unknown recommendation cannot select a nonexistent option", () => {
  const parsed = parseDecisionSection("## Waiting on a decision\n**Question 1. Choose?**\n- **A. Yes.**\n*Recommended: Z.* Unknown.");
  assert.equal(parsed.decisionQuestions[0].recommended, null);
});
