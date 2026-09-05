import { captureSnapshot } from "../src/page-snapshot";
(window as unknown as Record<string, unknown>).__velaSnapshot = captureSnapshot;
