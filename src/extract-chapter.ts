import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs";
import * as path from "path";
import { ParsedBook, deriveSlug } from "./types";

const MODEL = "claude-sonnet-5";
const MAX_TOKENS = 16000;

// role/significance stay free-text in this probe: book-level judgments like
// protagonist/antagonist can't be made from one chapter, and free-text shows
// what vocabulary the model naturally uses before we lock enums in stage 3.
const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    characters: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          aliases: { type: "array", items: { type: "string" } },
          description: { type: "string" },
          role: { type: "string" },
        },
        required: ["name", "aliases", "description", "role"],
        additionalProperties: false,
      },
    },
    relationships: {
      type: "array",
      items: {
        type: "object",
        properties: {
          from: { type: "string" },
          to: { type: "string" },
          type: { type: "string" },
          description: { type: "string" },
        },
        required: ["from", "to", "type", "description"],
        additionalProperties: false,
      },
    },
    events: {
      type: "array",
      items: {
        type: "object",
        properties: {
          summary: { type: "string" },
          characters_involved: { type: "array", items: { type: "string" } },
          significance: { type: "string" },
        },
        required: ["summary", "characters_involved", "significance"],
        additionalProperties: false,
      },
    },
  },
  required: ["characters", "relationships", "events"],
  additionalProperties: false,
} as const;

export function buildSystemPrompt(bookTitle: string | null): string {
  return [
    `You are extracting structured story data from one chapter of the book "${bookTitle ?? "Unknown"}".`,
    "Extract the characters that appear in this chapter, the relationships between them, and the plot events that occur.",
    "Describe only what this chapter itself states or clearly shows. Do not speculate about events outside this chapter, and do not use outside knowledge of the book.",
    "Use the character's most complete name from the chapter as `name`, and list other forms they are called by in `aliases`.",
  ].join(" ");
}

async function main() {
  const [parsedJsonPath, chapterIndexArg] = process.argv.slice(2);
  if (!parsedJsonPath || chapterIndexArg === undefined) {
    console.error("Usage: tsx src/extract-chapter.ts <parsed-json-path> <chapter-index|--list>");
    process.exitCode = 1;
    return;
  }
  if (!fs.existsSync(parsedJsonPath)) {
    console.error(`File not found: ${parsedJsonPath}`);
    process.exitCode = 1;
    return;
  }

  const book: ParsedBook = JSON.parse(fs.readFileSync(parsedJsonPath, "utf-8"));

  // The array index is NOT the book's chapter number (front matter and POV
  // interludes are interleaved) — --list shows the mapping without an API call.
  if (chapterIndexArg === "--list") {
    for (const c of book.chapters) {
      const title = c.title ?? c.text.split("\n")[0].slice(0, 80);
      console.log(`${String(c.index).padStart(3)} | ${String(c.wordCount).padStart(5)} words | ${title}`);
    }
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set. Add it to .env before running extraction.");
    process.exitCode = 1;
    return;
  }

  const chapterIndex = Number(chapterIndexArg);
  if (!Number.isInteger(chapterIndex) || chapterIndex < 0 || chapterIndex >= book.chapters.length) {
    console.error(`Chapter index must be an integer in [0, ${book.chapters.length - 1}], got: ${chapterIndexArg}`);
    process.exitCode = 1;
    return;
  }

  const chapter = book.chapters[chapterIndex];
  const chapterTitle = chapter.title ?? chapter.text.split("\n")[0].slice(0, 80);
  console.log(`Selected chapters[${chapterIndex}]: "${chapterTitle}" (${chapter.wordCount} words)`);
  if (chapter.wordCount < 300) {
    console.warn(
      `Warning: chapter ${chapterIndex} has only ${chapter.wordCount} words — likely front matter. Consider a narrative chapter instead.`
    );
  }

  const systemPrompt = buildSystemPrompt(book.title);
  const client = new Anthropic();

  console.log(`Extracting chapter ${chapterIndex} (${chapter.wordCount} words) with ${MODEL} ...`);

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
    output_config: {
      format: { type: "json_schema", schema: EXTRACTION_SCHEMA },
    },
    messages: [{ role: "user", content: chapter.text }],
  });

  const slug = deriveSlug(parsedJsonPath);
  const outputDir = path.resolve(__dirname, "..", "output");
  const textBlock = response.content.find((b) => b.type === "text");

  if (response.stop_reason === "refusal") {
    console.error("The model refused this request (stop_reason: refusal). No output written.");
    process.exitCode = 1;
    return;
  }
  if (response.stop_reason === "max_tokens") {
    console.error(`Output truncated at ${MAX_TOKENS} tokens (stop_reason: max_tokens). No checkpoint written.`);
    console.error("Raw (truncated) text follows:\n");
    console.error(textBlock?.text ?? "(no text block)");
    process.exitCode = 1;
    return;
  }
  if (!textBlock) {
    console.error(`No text block in response (stop_reason: ${response.stop_reason}). No output written.`);
    process.exitCode = 1;
    return;
  }

  let extraction: unknown;
  try {
    extraction = JSON.parse(textBlock.text);
  } catch {
    const rawPath = path.join(outputDir, `${slug}-idx${chapterIndex}-extract-raw.txt`);
    fs.writeFileSync(rawPath, textBlock.text, "utf-8");
    console.error(`Response was not valid JSON despite structured outputs. Raw text dumped to: ${rawPath}`);
    process.exitCode = 1;
    return;
  }

  const checkpoint = {
    meta: {
      model: response.model,
      chapterIndex,
      chapterTitle,
      chapterWordCount: chapter.wordCount,
      systemPrompt,
      stopReason: response.stop_reason,
      usage: response.usage,
      timestamp: new Date().toISOString(),
    },
    extraction,
  };

  const outputPath = path.join(outputDir, `${slug}-idx${chapterIndex}-extract.json`);
  fs.writeFileSync(outputPath, JSON.stringify(checkpoint, null, 2), "utf-8");

  const e = extraction as { characters: unknown[]; relationships: unknown[]; events: unknown[] };
  console.log("");
  console.log("Extraction summary");
  console.log("------------------");
  console.log(`Characters:     ${e.characters.length}`);
  console.log(`Relationships:  ${e.relationships.length}`);
  console.log(`Events:         ${e.events.length}`);
  console.log(`Tokens:         ${response.usage.input_tokens} in / ${response.usage.output_tokens} out`);
  console.log(`Output written: ${outputPath}`);
}

// Only run the CLI when executed directly — buildSystemPrompt is also
// imported by the test suite, which must not trigger a real run.
if (require.main === module) {
  main().catch((err) => {
    if (err instanceof Anthropic.APIError) {
      console.error(`API error ${err.status}: ${err.message}`);
    } else {
      console.error("Extraction failed:", err);
    }
    process.exitCode = 1;
  });
}
