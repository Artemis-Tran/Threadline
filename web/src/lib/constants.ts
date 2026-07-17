// Web-side runtime constants. These deliberately duplicate the pipeline's
// CHARACTER_ROLES / EVENT_SIGNIFICANCE values rather than importing them:
// imports from ../src (via @pipeline/types) must stay type-only, or the
// bundler tries to resolve the pipeline's node16-CJS code.
import type { CharacterRole, EventSignificance } from "@pipeline/types";

export const ROLE_ORDER: readonly CharacterRole[] = ["pov", "major", "supporting", "minor", "mentioned"];

export const ROLE_LABELS: Record<CharacterRole, string> = {
  pov: "Point of view",
  major: "Major",
  supporting: "Supporting",
  minor: "Minor",
  mentioned: "Mentioned",
};

export const SIGNIFICANCE_ORDER: readonly EventSignificance[] = ["major", "moderate", "minor"];
