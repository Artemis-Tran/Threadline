import { EPub } from "epub2";
import * as fs from "fs";
import * as path from "path";
import { ParsedBook, ParsedChapter, PARSED_SUFFIX } from "./types";

const BLOCK_TAGS = /<\/(p|div|h[1-6]|li|blockquote|tr|section|article)\s*>/gi;
const BREAK_TAGS = /<br\s*\/?>/gi;

export function htmlToPlainText(html: string): string {
  let text = html
    .replace(BREAK_TAGS, "\n")
    .replace(BLOCK_TAGS, "\n")
    .replace(/<[^>]+>/g, "");

  text = text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&mdash;/gi, "—")
    .replace(/&ndash;/gi, "–")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));

  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n\n");
}

export function countWords(text: string): number {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  return words.length;
}

async function parseEpub(epubPath: string): Promise<ParsedBook> {
  const epub = await EPub.createAsync(epubPath);

  const chapters: ParsedChapter[] = [];

  for (let i = 0; i < epub.flow.length; i++) {
    const item = epub.flow[i];
    if (!item.id) continue;

    let rawHtml: string;
    try {
      rawHtml = await epub.getChapterAsync(item.id);
    } catch (err) {
      console.warn(
        `  Skipping flow item "${item.id}" (${item.href}): ${(err as Error).message}`
      );
      continue;
    }

    const text = htmlToPlainText(rawHtml);
    if (text.length === 0) {
      console.warn(`  Skipping flow item "${item.id}" (${item.href}): no text content`);
      continue;
    }

    // epub2 flow items rarely carry titles; fall back to the chapter's first
    // text line so downstream tools can show which book chapter an index is.
    const firstLine = text.split("\n")[0].slice(0, 80);

    chapters.push({
      index: chapters.length,
      id: item.id,
      href: item.href ?? "",
      title: item.title ?? firstLine,
      wordCount: countWords(text),
      text,
    });
  }

  const totalWordCount = chapters.reduce((sum, c) => sum + c.wordCount, 0);

  return {
    sourceFile: path.resolve(epubPath),
    title: epub.metadata.title ?? null,
    creator: epub.metadata.creator ?? null,
    language: epub.metadata.language ?? null,
    chapterCount: chapters.length,
    wordCount: totalWordCount,
    chapters,
  };
}

export function deriveOutputPath(epubPath: string): string {
  const base = path.basename(epubPath, path.extname(epubPath));
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const outputDir = path.resolve(__dirname, "..", "output");
  fs.mkdirSync(outputDir, { recursive: true });
  return path.join(outputDir, `${slug}${PARSED_SUFFIX}`);
}

async function main() {
  const epubPath = process.argv[2];
  if (!epubPath) {
    console.error("Usage: tsx src/parse-epub.ts <path-to-epub>");
    process.exitCode = 1;
    return;
  }
  if (!fs.existsSync(epubPath)) {
    console.error(`File not found: ${epubPath}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Parsing ${epubPath} ...`);
  const book = await parseEpub(epubPath);

  if (book.chapterCount === 0) {
    console.error("No chapters were parsed. Something is likely broken with this EPUB or the parser.");
    process.exitCode = 1;
    return;
  }

  const outputPath = deriveOutputPath(epubPath);
  fs.writeFileSync(outputPath, JSON.stringify(book, null, 2), "utf-8");

  const firstChapterPreview = book.chapters[0].text.slice(0, 200);

  console.log("");
  console.log("Parse summary");
  console.log("-------------");
  console.log(`Title:          ${book.title ?? "(unknown)"}`);
  console.log(`Chapters:       ${book.chapterCount}`);
  console.log(`Total words:    ${book.wordCount}`);
  console.log(`Output written: ${outputPath}`);
  console.log("");
  console.log("First 200 chars of chapter 1:");
  console.log(firstChapterPreview);
}

// Only run the CLI when executed directly — the parsing helpers above are
// also imported by the test suite, which must not trigger a real run.
if (require.main === module) {
  main().catch((err) => {
    console.error("Parsing failed:", err);
    process.exitCode = 1;
  });
}
