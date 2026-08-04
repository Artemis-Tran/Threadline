import { test } from "vitest";
import assert from "node:assert/strict";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CharacterRole } from "@pipeline/types";
import type { CharacterView } from "../src/lib/asOf";
import CharactersTab from "../src/components/CharactersTab";

// The first real component rendered under jsdom: role grouping, the empty
// state, and a click reaching its handler. Search is not covered — the tab has
// no search box yet.

function char(id: string, role: CharacterRole): CharacterView {
  return { id, name: id.toUpperCase(), role, description: "", aliases: [], firstSeenChapterIndex: 1, kind: "individual" };
}

const chapterLabel = (index: number) => `Chapter ${index}`;

test("renders a card per character under its role group", () => {
  render(
    <CharactersTab
      characters={[char("mira", "major"), char("aldric", "supporting")]}
      onSelect={() => {}}
      chapterLabel={chapterLabel}
    />,
  );

  assert.ok(screen.getByText("MIRA"));
  assert.ok(screen.getByText("ALDRIC"));
  assert.ok(screen.getByText("Major"));
  assert.ok(screen.getByText("Supporting"));
});

test("renders the empty state when no characters are known yet", () => {
  render(<CharactersTab characters={[]} onSelect={() => {}} chapterLabel={chapterLabel} />);

  assert.ok(screen.getByText(/No characters known yet/));
});

test("clicking a card selects that character", async () => {
  const selected: string[] = [];
  render(
    <CharactersTab
      characters={[char("mira", "major")]}
      onSelect={(id) => selected.push(id)}
      chapterLabel={chapterLabel}
    />,
  );

  await userEvent.click(screen.getByRole("button", { name: /MIRA/ }));

  assert.deepEqual(selected, ["mira"]);
});
