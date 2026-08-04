import { test } from "vitest";
import assert from "node:assert/strict";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Proves the jsdom stack itself, on the one path the search box will need:
// typing into a controlled input re-renders with the new value. Nothing here
// touches an app component — this fails only if the environment is wrong.

function ControlledInput() {
  const [value, setValue] = useState("");
  return (
    <>
      <input aria-label="query" value={value} onChange={(e) => setValue(e.target.value)} />
      <p>echo: {value}</p>
    </>
  );
}

test("typing into a controlled input updates its value and re-renders", async () => {
  render(<ControlledInput />);
  const input = screen.getByLabelText<HTMLInputElement>("query");

  await userEvent.type(input, "mir");

  assert.equal(input.value, "mir");
  assert.ok(screen.getByText("echo: mir"));
});
