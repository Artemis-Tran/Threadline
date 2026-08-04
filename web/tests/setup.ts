import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Testing Library only auto-registers its own afterEach when vitest's globals
// are on. They aren't, so unmount rendered trees here instead — otherwise one
// test's DOM is still in document.body when the next one queries it.
afterEach(cleanup);
