import { useState } from "react";
import { test } from "vitest";
import assert from "node:assert/strict";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CharacterRole } from "@pipeline/types";
import type { CharacterView } from "../src/lib/asOf";
import CharactersTab from "../src/components/CharactersTab";

// Role grouping, the two empty states, a click reaching its handler, and the
// search filter. The tab is handed the cap-filtered list and the reader's
// query and narrows the list itself, so filtering is asserted here rather than
// through a pure helper.
//
// Absence is asserted as `assert.ok(!queryBy...)`, never
// `assert.equal(queryBy..., null)`. Don't tidy it back. A failing
// `assert.equal` hands the rendered node to node's AssertionError, which
// inspects it at depth 1000 and then diffs the result line by line — 420k
// lines for one card, growing at about 1 GB/s until the machine dies.

function char(
  id: string,
  role: CharacterRole,
  extra: Partial<CharacterView> = {},
): CharacterView {
  return {
    id,
    name: id.toUpperCase(),
    role,
    description: "",
    aliases: [],
    firstSeenChapterIndex: 1,
    kind: "individual",
    ...extra,
  };
}

const chapterLabel = (index: number) => `Chapter ${index}`;

function names(): string[] {
  return screen.getAllByRole("button").map((b) => b.textContent ?? "");
}

test("renders a card per character under its role group", () => {
  render(
    <CharactersTab
      characters={[char("mira", "major"), char("aldric", "supporting")]}
      query=""
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
  render(<CharactersTab characters={[]} query="" onSelect={() => {}} chapterLabel={chapterLabel} />);

  assert.ok(screen.getByText(/No characters known yet/));
});

test("clicking a card selects that character", async () => {
  const selected: string[] = [];
  render(
    <CharactersTab
      characters={[char("mira", "major")]}
      query=""
      onSelect={(id) => selected.push(id)}
      chapterLabel={chapterLabel}
    />,
  );

  await userEvent.click(screen.getByRole("button", { name: /MIRA/ }));

  assert.deepEqual(selected, ["mira"]);
});

test("a query narrows the list to characters whose name matches", () => {
  render(
    <CharactersTab
      characters={[char("mira", "major"), char("aldric", "major")]}
      query="mir"
      onSelect={() => {}}
      chapterLabel={chapterLabel}
    />,
  );

  assert.ok(screen.getByText("MIRA"));
  assert.ok(!screen.queryByText("ALDRIC"));
});

test("a query matches a character's aliases", () => {
  render(
    <CharactersTab
      characters={[
        char("mira", "major", { aliases: ["The Potter's Daughter"] }),
        char("aldric", "major"),
      ]}
      query="daughter"
      onSelect={() => {}}
      chapterLabel={chapterLabel}
    />,
  );

  assert.ok(screen.getByText("MIRA"));
  assert.ok(!screen.queryByText("ALDRIC"));
});

test("matching is case-insensitive and ignores surrounding whitespace", () => {
  render(
    <CharactersTab
      characters={[char("mira", "major"), char("aldric", "major")]}
      query="  MiRa  "
      onSelect={() => {}}
      chapterLabel={chapterLabel}
    />,
  );

  assert.ok(screen.getByText("MIRA"));
  assert.ok(!screen.queryByText("ALDRIC"));
});

test("survivors keep their role grouping, and emptied groups are dropped", () => {
  render(
    <CharactersTab
      characters={[
        char("mira", "major"),
        char("aldric", "supporting"),
        char("mirabel", "supporting"),
      ]}
      query="mira"
      onSelect={() => {}}
      chapterLabel={chapterLabel}
    />,
  );

  // Both survivors are still identifiable by role...
  assert.ok(screen.getByText("Major"));
  assert.ok(screen.getByText("Supporting"));
  assert.ok(screen.getByText("MIRA"));
  assert.ok(screen.getByText("MIRABEL"));
  assert.ok(!screen.queryByText("ALDRIC"));
});

test("a role group with no surviving matches is not rendered", () => {
  render(
    <CharactersTab
      characters={[char("mira", "major"), char("aldric", "supporting")]}
      query="mira"
      onSelect={() => {}}
      chapterLabel={chapterLabel}
    />,
  );

  assert.ok(screen.getByText("Major"));
  assert.ok(!screen.queryByText("Supporting"));
});

test("a query matching nothing is distinguishable from an empty chapter cap", () => {
  render(
    <CharactersTab
      characters={[char("mira", "major")]}
      query="nobody"
      onSelect={() => {}}
      chapterLabel={chapterLabel}
    />,
  );

  assert.ok(screen.getByText(/No characters match/));
  // The cap's own empty state would mislead here — the reader's position is
  // fine, their query just missed.
  assert.ok(!screen.queryByText(/No characters known yet/));
});

test("a query cannot surface a character the chapter cap withheld", () => {
  // The tab is handed the already-capped list, so filtering composes with the
  // cap by construction: a character past the reader's position is not in the
  // input and no query can conjure it.
  render(
    <CharactersTab
      characters={[char("mira", "major")]}
      query="aldric"
      onSelect={() => {}}
      chapterLabel={chapterLabel}
    />,
  );

  assert.ok(!screen.queryByText("ALDRIC"));
  assert.ok(screen.getByText(/No characters match/));
});

test("typing into the search box narrows the rendered entries", async () => {
  // Mirrors BookPage's wiring: it owns the query state and the input, the tab
  // owns the filtering.
  function Harness() {
    const [query, setQuery] = useState("");
    return (
      <>
        <input aria-label="Search characters" value={query} onChange={(e) => setQuery(e.target.value)} />
        <CharactersTab
          characters={[char("mira", "major"), char("aldric", "major")]}
          query={query}
          onSelect={() => {}}
          chapterLabel={chapterLabel}
        />
      </>
    );
  }
  render(<Harness />);

  assert.deepEqual(names(), ["MIRAFirst seen · Chapter 1", "ALDRICFirst seen · Chapter 1"]);

  await userEvent.type(screen.getByLabelText("Search characters"), "ald");

  assert.deepEqual(names(), ["ALDRICFirst seen · Chapter 1"]);
});
