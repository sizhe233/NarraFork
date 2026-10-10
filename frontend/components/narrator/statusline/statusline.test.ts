/** LOCAL PATCH (not upstream) — see ~/.narrafork-deploy/LOCAL_PATCHES.md. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatCostUsd } from "./statusline-format";

describe("formatCostUsd", () => {
	test("hides zero, negative and missing spend", () => {
		expect(formatCostUsd(null)).toBeNull();
		expect(formatCostUsd(undefined)).toBeNull();
		expect(formatCostUsd(0)).toBeNull();
		expect(formatCostUsd(-1)).toBeNull();
		expect(formatCostUsd(Number.NaN)).toBeNull();
	});
	test("formats dollars with sensible precision", () => {
		expect(formatCostUsd(72.6)).toBe("$72.60");
		expect(formatCostUsd(0.0042)).toBe("$0.0042");
	});
});

describe("upstream contracts the patch relies on", () => {
	const narratorDir = join(import.meta.dir, "..");
	const repoRoot = join(narratorDir, "../../..");
	const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");

	// The single upstream hook point. If an upstream refactor drops it, the usage line
	// silently disappears — fail loudly instead.
	test("status bar renders the usage line", () => {
		const source = read(
			"frontend/components/narrator/interaction/NarratorInteractionStatusBar.tsx",
		);
		expect(source).toMatch(/<NarratorStatusline\s+narratorId=\{narratorId\}\s*\/>/);
	});

	// The number comes from this endpoint with subagents included by default.
	test("usage-stats endpoint still sums direct subagents", () => {
		expect(read("server/routes/narrators.ts")).toContain(
			'const includeSubagents = c.req.query("includeSubagents") !== "false";',
		);
		expect(read("server/services/usage-history-service.ts")).toContain(
			"filters.includeSubagents",
		);
		expect(read("frontend/hooks/useNarrator.ts")).toContain(
			'queryKey: ["narrators", narratorId, "usage-stats", { includeSubagents }]',
		);
	});
});
