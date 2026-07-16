import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { importBook } from "@/lib/repo";
import { ValidationError, crossCheck, validateParsedBook, validateThread } from "@/lib/validate";

// Generous ceiling for the two pipeline JSONs (the sample book's are ~0.5MB
// each) that still stops an accidental multi-GB upload from being buffered.
const MAX_FILE_BYTES = 50 * 1024 * 1024;

export async function POST(request: Request): Promise<NextResponse> {
  // Same-origin check: this endpoint overwrites local data, and a hostile
  // webpage could otherwise fire a cross-origin POST at a running dev server.
  // Non-browser clients (curl) send no Origin header and are allowed.
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== new URL(request.url).origin) {
    return NextResponse.json({ error: "Cross-origin imports are not allowed." }, { status: 403 });
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 2 * MAX_FILE_BYTES) {
    return NextResponse.json({ error: "Upload too large." }, { status: 413 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected a multipart form upload." }, { status: 400 });
  }

  const threadFile = form.get("thread");
  const parsedFile = form.get("parsed");
  if (!(threadFile instanceof File) || !(parsedFile instanceof File)) {
    return NextResponse.json(
      { error: "Both files are required: a -thread.json and a -parsed.json." },
      { status: 400 }
    );
  }
  if (threadFile.size > MAX_FILE_BYTES || parsedFile.size > MAX_FILE_BYTES) {
    return NextResponse.json({ error: "Upload too large." }, { status: 413 });
  }

  const threadText = await threadFile.text();
  const parsedText = await parsedFile.text();

  let threadRaw: unknown;
  let parsedRaw: unknown;
  try {
    threadRaw = JSON.parse(threadText);
  } catch {
    return NextResponse.json({ error: `Thread file "${threadFile.name}" is not valid JSON.` }, { status: 400 });
  }
  try {
    parsedRaw = JSON.parse(parsedText);
  } catch {
    return NextResponse.json({ error: `Parsed file "${parsedFile.name}" is not valid JSON.` }, { status: 400 });
  }

  try {
    validateThread(threadRaw);
    validateParsedBook(parsedRaw);
    crossCheck(parsedRaw, threadRaw);
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  const result = importBook(getDb(), parsedRaw, threadRaw, threadText);
  revalidatePath("/");

  return NextResponse.json({
    slug: result.slug,
    replaced: result.replaced,
    title: threadRaw.meta.bookTitle ?? parsedRaw.title,
    chapterCount: parsedRaw.chapters.length,
    characterCount: threadRaw.meta.characterCount,
    relationshipCount: threadRaw.meta.relationshipCount,
    eventCount: threadRaw.meta.eventCount,
  });
}
