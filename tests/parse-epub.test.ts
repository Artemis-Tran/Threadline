import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import { htmlToPlainText, countWords, deriveOutputPath } from "../src/parse-epub";

describe("htmlToPlainText", () => {
  test("strips tags and joins block elements as paragraphs", () => {
    const html = "<p>First paragraph.</p><p>Second paragraph.</p>";
    assert.equal(htmlToPlainText(html), "First paragraph.\n\nSecond paragraph.");
  });

  test("inline tags do not split paragraphs", () => {
    const html = "<p>He said <em>hello</em> to <strong>her</strong>.</p>";
    assert.equal(htmlToPlainText(html), "He said hello to her.");
  });

  test("<br> variants become line breaks (then paragraph-joined)", () => {
    assert.equal(htmlToPlainText("line one<br>line two<br/>line three"), "line one\n\nline two\n\nline three");
  });

  test("headings and divs break paragraphs", () => {
    const html = "<h1>Chapter 1</h1><div>The story begins.</div>";
    assert.equal(htmlToPlainText(html), "Chapter 1\n\nThe story begins.");
  });

  test("decodes named entities", () => {
    const html = "<p>Fish &amp; chips &mdash; &quot;the best&quot; &lt;said&gt; he&#39;s&nbsp;sure</p>";
    assert.equal(htmlToPlainText(html), 'Fish & chips — "the best" <said> he\'s sure');
  });

  test("decodes numeric entities", () => {
    assert.equal(htmlToPlainText("<p>caf&#233;</p>"), "café");
  });

  test("collapses runs of spaces and tabs within lines", () => {
    assert.equal(htmlToPlainText("<p>too     many\t\ttabs</p>"), "too many tabs");
  });

  test("drops empty lines produced by markup-only content", () => {
    const html = "<p></p><p>  </p><p>real content</p><div><span></span></div>";
    assert.equal(htmlToPlainText(html), "real content");
  });

  test("returns empty string for markup with no text", () => {
    assert.equal(htmlToPlainText("<p></p><br/><div></div>"), "");
  });
});

describe("countWords", () => {
  test("counts whitespace-separated words", () => {
    assert.equal(countWords("the quick brown fox"), 4);
  });

  test("handles newlines and repeated whitespace", () => {
    assert.equal(countWords("one\n\ntwo   three\tfour"), 4);
  });

  test("empty and whitespace-only strings count zero", () => {
    assert.equal(countWords(""), 0);
    assert.equal(countWords("   \n\t "), 0);
  });
});

describe("deriveOutputPath", () => {
  test("slugifies the epub basename and appends the parsed suffix", () => {
    const out = deriveOutputPath("/anywhere/My Book (1st Edition).epub");
    assert.equal(path.basename(out), "my-book-1st-edition-parsed.json");
  });

  test("output lands in the project output directory", () => {
    const out = deriveOutputPath("book.epub");
    assert.equal(path.basename(path.dirname(out)), "output");
  });
});
