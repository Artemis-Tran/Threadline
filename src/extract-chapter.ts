import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { ParsedBook, deriveSlug } from "./types";
import { DEFAULT_MODEL, resolveModel } from "./models";
import { apiErrorMessage, apiKeyEnvVar, callExtraction } from "./extraction-call";

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

const USAGE = "Usage: tsx src/extract-chapter.ts <parsed-json-path> <chapter-index|--list> [--model <id>]";

export interface ChapterCliArgs {
  parsedJsonPath: string;
  chapterArg: string; // a numeric index, or the literal "--list"
  model: string;
}

// Pure so the guard is unit-testable: --model is pulled out (anywhere on the
// line), --list is an allowed positional, any other --flag is rejected, and
// exactly two positionals are required. Throwing here — instead of silently
// dropping a misspelled flag — stops a typo'd --model from reaching the paid
// API call with the default model.
export function parseChapterArgs(argv: string[]): ChapterCliArgs {
  let model = DEFAULT_MODEL;
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--model") {
      const value = argv[++i];
      if (!value) throw new Error("--model expects a model name");
      model = resolveModel(value).id;
    } else if (arg === "--list") {
      positionals.push(arg);
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length !== 2) throw new Error(USAGE);
  return { parsedJsonPath: positionals[0], chapterArg: positionals[1], model };
}

async function main() {
  let parsedJsonPath: string;
  let chapterIndexArg: string;
  let model: string;
  try {
    ({ parsedJsonPath, chapterArg: chapterIndexArg, model } = parseChapterArgs(process.argv.slice(2)));
  } catch (err) {
    console.error((err as Error).message);
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

  // Only the chosen model's vendor needs a credential — an OpenAI run must not
  // demand an Anthropic key, or the reverse. resolveModel is idempotent on an
  // already-resolved ID, so re-resolving here just recovers the registry row.
  const { provider } = resolveModel(model);
  const apiKeyVar = apiKeyEnvVar(provider);
  if (!process.env[apiKeyVar]) {
    console.error(`${apiKeyVar} is not set. Add it to .env before running extraction.`);
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

  console.log(`Extracting chapter ${chapterIndex} (${chapter.wordCount} words) with ${model} ...`);

  const result = await callExtraction({
    model,
    provider,
    systemPrompt,
    chapterText: chapter.text,
    schema: EXTRACTION_SCHEMA,
    maxTokens: MAX_TOKENS,
  });

  const slug = deriveSlug(parsedJsonPath);
  const outputDir = path.resolve(__dirname, "..", "output");
  // The model is part of the filename because comparing two models on one
  // chapter is what this stage is *for* — without it a second run silently
  // overwrites the first, which is the one output you wanted to keep. Stage 3
  // separates runs by directory instead (--out-dir), since there a whole book's
  // extracts move together. The resolved registry ID is used verbatim, so the
  // name matches the `model` recorded in the checkpoint's meta.
  const stem = `${slug}-idx${chapterIndex}-${model}`;

  if (result.stopReason === "refusal") {
    console.error("The model refused this request (stopReason: refusal). No output written.");
    process.exitCode = 1;
    return;
  }
  if (result.stopReason === "max_tokens") {
    console.error(`Output truncated at ${MAX_TOKENS} tokens (stopReason: max_tokens). No checkpoint written.`);
    console.error("Raw (truncated) text follows:\n");
    console.error(result.text || "(no text)");
    process.exitCode = 1;
    return;
  }
  if (!result.text) {
    console.error(`No text in response (stopReason: ${result.stopReason}). No output written.`);
    process.exitCode = 1;
    return;
  }

  let extraction: unknown;
  try {
    extraction = JSON.parse(result.text);
  } catch {
    const rawPath = path.join(outputDir, `${stem}-extract-raw.txt`);
    fs.writeFileSync(rawPath, result.text, "utf-8");
    console.error(`Response was not valid JSON despite structured outputs. Raw text dumped to: ${rawPath}`);
    process.exitCode = 1;
    return;
  }

  const checkpoint = {
    meta: {
      // The registry ID that was *requested*, not the string the vendor
      // returned. The requested ID is the one the registry can price, and it
      // survives a vendor resolving an alias to a dated snapshot — a served
      // string would not, which is what would make a run un-resumable once
      // extracts are matched against the model that asked for them. The served
      // string is kept alongside so a re-pointed alias stays visible.
      model,
      modelReturned: result.modelReturned,
      chapterIndex,
      chapterTitle,
      chapterWordCount: chapter.wordCount,
      systemPrompt,
      stopReason: result.stopReason,
      // Exactly the two counts, as the pipeline's own format — not a dump of
      // whatever usage object the SDK returned. The snake_case names are
      // deliberate: the comparison tooling already reads them off extracts on
      // disk, so keeping them means no paid output needs migrating.
      usage: { input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens },
      timestamp: new Date().toISOString(),
    },
    extraction,
  };

  const outputPath = path.join(outputDir, `${stem}-extract.json`);
  fs.writeFileSync(outputPath, JSON.stringify(checkpoint, null, 2), "utf-8");

  const e = extraction as { characters: unknown[]; relationships: unknown[]; events: unknown[] };
  console.log("");
  console.log("Extraction summary");
  console.log("------------------");
  console.log(`Characters:     ${e.characters.length}`);
  console.log(`Relationships:  ${e.relationships.length}`);
  console.log(`Events:         ${e.events.length}`);
  console.log(`Tokens:         ${result.usage.inputTokens} in / ${result.usage.outputTokens} out`);
  console.log(`Output written: ${outputPath}`);
}

// Only run the CLI when executed directly — buildSystemPrompt is also
// imported by the test suite, which must not trigger a real run.
if (require.main === module) {
  main().catch((err) => {
    // Which vendor's error class this is stays behind the seam — the handler
    // asks for a description and falls through only for a genuine bug.
    const apiError = apiErrorMessage(err);
    if (apiError) {
      console.error(apiError);
    } else {
      console.error("Extraction failed:", err);
    }
    process.exitCode = 1;
  });
}
