/** LOCAL PATCH (not upstream) — see ~/.narrafork-deploy/LOCAL_PATCHES.md. */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	contextColor,
	DEFAULT_STATUSLINE_SETTINGS,
	describeModel,
	fitStatuslineSegments,
	formatCostUsd,
	parseStatuslineSettings,
	shortenPath,
} from "./statusline-format";
import {
	getStatuslineContext,
	publishStatuslineContext,
	resetStatuslineStoreForTests,
} from "./statusline-store";

describe("shortenPath", () => {
	test("replaces the home directory with ~", () => {
		expect(shortenPath("/home/yuyi233/Project/NarraFork")).toBe("~/Project/NarraFork");
		expect(shortenPath("/Users/yu/Project")).toBe("~/Project");
		expect(shortenPath("/home/yuyi233")).toBe("~");
	});
	test("keeps only the last segments of deep paths", () => {
		expect(shortenPath("/home/u/a/b/c/d/e")).toBe("~/…/c/d/e");
		expect(shortenPath("/srv/a/b/c/d")).toBe("…/b/c/d");
		expect(shortenPath("/srv/app")).toBe("/srv/app");
	});
	test("handles Windows paths", () => {
		expect(shortenPath("C:\\Users\\yu\\Project\\X")).toBe("~\\Project\\X");
		expect(shortenPath("D:\\Project")).toBe("D:\\Project");
	});
	test("does not treat /homework as a home directory", () => {
		expect(shortenPath("/homework/x")).toBe("/homework/x");
	});
});

describe("formatCostUsd", () => {
	test("hides zero, negative and missing spend", () => {
		expect(formatCostUsd(null)).toBeNull();
		expect(formatCostUsd(0)).toBeNull();
		expect(formatCostUsd(-1)).toBeNull();
		expect(formatCostUsd(Number.NaN)).toBeNull();
	});
	test("formats dollars with sensible precision", () => {
		expect(formatCostUsd(72.6)).toBe("$72.60");
		expect(formatCostUsd(0.0042)).toBe("$0.0042");
	});
});

describe("contextColor", () => {
	test("matches the built-in ring thresholds", () => {
		expect(contextColor(50, false)).toContain("teal");
		expect(contextColor(95, false)).toContain("yellow");
		expect(contextColor(99, false)).toContain("red");
		expect(contextColor(99, true)).toContain("dimmed");
	});
});

describe("fitStatuslineSegments", () => {
	const widths = new Map([
		["model", 100],
		["cwd", 150],
		["branch", 40],
		["cost", 50],
		["context", 100],
		["window", 20],
	] as const);
	test("keeps everything when it fits", () => {
		expect(fitStatuslineSegments(widths, 1000, 10).size).toBe(6);
	});
	test("drops the least important segments first", () => {
		// context 100 + cost 60 + branch 50 + model 110 = 320; cwd needs ≥72 after a separator.
		const kept = fitStatuslineSegments(widths, 330, 10);
		expect([...kept].sort()).toEqual(["branch", "context", "cost", "model"]);
	});
	test("keeps a truncated path when enough room is left", () => {
		const kept = fitStatuslineSegments(widths, 410, 10);
		expect(kept.has("cwd")).toBe(true);
		expect(kept.has("window")).toBe(false);
	});
	test("can show nothing in a tiny row", () => {
		expect(fitStatuslineSegments(widths, 15, 10).size).toBe(0);
	});
	test("a small segment further down can still use leftover room", () => {
		// Only the 20px window fits in 30px; higher-priority segments are all wider.
		expect([...fitStatuslineSegments(widths, 30, 10)]).toEqual(["window"]);
	});
	test("skips segments without data", () => {
		const kept = fitStatuslineSegments(new Map([["cost", 50]]), 1000, 10);
		expect([...kept]).toEqual(["cost"]);
	});
});

describe("parseStatuslineSettings", () => {
	test("falls back to defaults for malformed input", () => {
		expect(parseStatuslineSettings(null)).toEqual(DEFAULT_STATUSLINE_SETTINGS);
		expect(parseStatuslineSettings("x")).toEqual(DEFAULT_STATUSLINE_SETTINGS);
		expect(parseStatuslineSettings({ segments: [] })).toEqual(DEFAULT_STATUSLINE_SETTINGS);
	});
	test("keeps valid booleans and ignores unknown keys", () => {
		const parsed = parseStatuslineSettings({ segments: { cost: false, bogus: true, cwd: "no" } });
		expect(parsed.segments.cost).toBe(false);
		expect(parsed.segments.cwd).toBe(true);
		expect("bogus" in parsed.segments).toBe(false);
	});
});

describe("describeModel", () => {
	const base = {
		inheritanceModel: null,
		aggregations: undefined,
		providerLabels: { "Sub2api-Anthropic": "Sub2API" },
		allModels: [
			{
				value: "Sub2api-Anthropic:claude-opus-5-5",
				label: "claude-opus-5-5",
				provider: "Sub2api-Anthropic",
			},
		],
	};
	test("resolves the default sentinel and applies provider labels", () => {
		expect(
			describeModel({
				...base,
				model: "__default__",
				defaultModelValue: "Sub2api-Anthropic:claude-opus-5-5",
			}),
		).toEqual({
			name: "claude-opus-5-5",
			provider: "Sub2API",
			full: "Sub2api-Anthropic:claude-opus-5-5",
		});
	});
	test("falls back to parsing unknown provider:model values", () => {
		expect(
			describeModel({ ...base, model: "other:gpt-x", defaultModelValue: undefined })?.name,
		).toBe("gpt-x");
	});
	test("returns null when nothing resolves", () => {
		expect(describeModel({ ...base, model: null, defaultModelValue: undefined })).toBeNull();
		expect(
			describeModel({ ...base, model: "__default__", defaultModelValue: undefined }),
		).toBeNull();
		expect(
			describeModel({ ...base, model: "__parent__", defaultModelValue: undefined }),
		).toBeNull();
	});
});

describe("statusline store", () => {
	afterEach(() => resetStatuslineStoreForTests());
	test("stores per-narrator values", () => {
		const usage = { percent: 61, promptTokens: 610_000, contextWindow: 1_000_000, stale: false };
		publishStatuslineContext("a", usage);
		expect(getStatuslineContext("a")).toEqual(usage);
		expect(getStatuslineContext("b")).toBeUndefined();
	});
	test("is bounded", () => {
		for (let i = 0; i < 250; i++) {
			publishStatuslineContext(`n${i}`, {
				percent: i,
				promptTokens: null,
				contextWindow: null,
				stale: false,
			});
		}
		expect(getStatuslineContext("n0")).toBeUndefined();
		expect(getStatuslineContext("n249")?.percent).toBe(249);
	});
});

describe("upstream hook points", () => {
	// These two lines are the whole upstream footprint of the patch. If an upstream
	// refactor drops them, the status line silently disappears — fail loudly instead.
	const dir = join(import.meta.dir, "..");
	test("status bar renders the status line", () => {
		const source = readFileSync(join(dir, "interaction/NarratorInteractionStatusBar.tsx"), "utf8");
		expect(source).toMatch(/<NarratorStatusline\s+narratorId=\{narratorId\}\s*\/>/);
	});
	test("panel publishes context usage", () => {
		const source = readFileSync(join(dir, "NarratorPanel.tsx"), "utf8");
		expect(source).toContain("useStatuslineContextPublisher(narratorId, {");
	});
});
