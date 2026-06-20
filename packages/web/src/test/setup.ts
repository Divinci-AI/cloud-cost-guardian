import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Unmount React trees between tests so the DOM doesn't leak across cases.
afterEach(() => cleanup());
