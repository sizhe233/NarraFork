/**
 * LOCAL PATCH (not upstream) — see ~/.narrafork-deploy/LOCAL_PATCHES.md.
 *
 * Pure formatting + settings helpers for the narrator status line. No React, no DOM, so
 * every rule here is unit-tested directly.
 */
import type { ModelAggregation, ModelOption } from "../../../lib/constants";
import { resolveDisplayModel } from "../../../lib/constants";
import { capabilityModelReference } from "../interaction/use-resolved-model";

export const STATUSLINE_SEGMENTS = ["model", "cwd", "branch", "cost", "context", "window"] as const;
export type StatuslineSegment = (typeof STATUSLINE_SEGMENTS)[number];

export interface StatuslineSettings {
	segments: Record<StatuslineSegment, boolean>;
}

export const STATUSLINE_STORAGE_KEY = "narrafork_local_statusline";

export const DEFAULT_STATUSLINE_SETTINGS: StatuslineSettings = {
	segments: { model: true, cwd: true, branch: true, cost: true, context: true, window: true },
};

/** Parse persisted settings defensively; unknown or malformed input falls back per field. */
export function parseStatuslineSettings(raw: unknown): StatuslineSettings {
	const segments = { ...DEFAULT_STATUSLINE_SETTINGS.segments };
	const stored =
		raw && typeof raw === "object" && !Array.isArray(raw)
			? (raw as { segments?: unknown }).segments
			: undefined;
	if (stored && typeof stored === "object" && !Array.isArray(stored)) {
		for (const key of STATUSLINE_SEGMENTS) {
			const value = (stored as Record<string, unknown>)[key];
			if (typeof value === "boolean") segments[key] = value;
		}
	}
	return { segments };
}

/**
 * Shorten an absolute path the way a shell prompt does: the user's home becomes `~`, and
 * only the last `keep` segments survive when the path is deep. The full path stays
 * available as a tooltip, so nothing is lost by shortening.
 */
export function shortenPath(path: string, keep = 3): string {
	if (!path) return "";
	const windows = /^[a-zA-Z]:[\\/]/.test(path) || path.includes("\\");
	const sep = windows ? "\\" : "/";
	let rest = path;
	let prefix = "";
	const home = windows
		? /^[a-zA-Z]:[\\/]Users[\\/][^\\/]+(?=[\\/]|$)/i.exec(path)
		: /^\/(?:home\/[^/]+|Users\/[^/]+|root)(?=\/|$)/.exec(path);
	if (home) {
		prefix = "~";
		rest = path.slice(home[0].length);
	}
	const parts = rest.split(/[\\/]/).filter(Boolean);
	if (parts.length === 0) return prefix || path;
	if (parts.length <= keep) {
		return prefix ? `${prefix}${sep}${parts.join(sep)}` : windows ? path : `/${parts.join(sep)}`;
	}
	return `${prefix || "…"}${sep}${prefix ? `…${sep}` : ""}${parts.slice(-keep).join(sep)}`;
}

/**
 * Which segments stay when space runs out, most important first. Context and cost are the
 * reason to look at this line at all; the window size and path are the most expendable.
 */
export const STATUSLINE_KEEP_PRIORITY: readonly StatuslineSegment[] = [
	"context",
	"cost",
	"branch",
	"model",
	"cwd",
	"window",
];

/** Minimum width a truncating segment (`cwd`) is still worth showing at. */
export const STATUSLINE_MIN_TRUNCATED_WIDTH = 72;

/**
 * Pick the segments that fit `available` pixels.
 *
 * Greedy over {@link STATUSLINE_KEEP_PRIORITY}: a segment is kept when its natural width
 * (plus one separator if it is not the first) still fits. The one segment allowed to
 * truncate (`cwd`) is also kept when at least {@link STATUSLINE_MIN_TRUNCATED_WIDTH} is
 * left, because an ellipsized path is still useful while a missing one is not.
 */
export function fitStatuslineSegments(
	widths: ReadonlyMap<StatuslineSegment, number>,
	available: number,
	separatorWidth: number,
	truncatable: ReadonlySet<StatuslineSegment> = new Set(["cwd"]),
): Set<StatuslineSegment> {
	const kept = new Set<StatuslineSegment>();
	let used = 0;
	for (const key of STATUSLINE_KEEP_PRIORITY) {
		const width = widths.get(key);
		if (width == null) continue;
		const cost = (kept.size > 0 ? separatorWidth : 0) + width;
		if (used + cost <= available) {
			kept.add(key);
			used += cost;
			continue;
		}
		const left = available - used - (kept.size > 0 ? separatorWidth : 0);
		if (truncatable.has(key) && left >= STATUSLINE_MIN_TRUNCATED_WIDTH) {
			kept.add(key);
			used = available;
		}
	}
	return kept;
}

/** `$72.60`; small positive spend keeps enough precision not to read as zero. */
export function formatCostUsd(cost: number | null | undefined): string | null {
	if (cost == null || !Number.isFinite(cost) || cost <= 0) return null;
	if (cost < 0.01) return `$${cost.toFixed(4)}`;
	return `$${cost.toFixed(2)}`;
}

/** Same thresholds as the built-in context ring, so both indicators agree on colour. */
export function contextColor(percent: number, stale: boolean): string {
	if (stale) return "var(--mantine-color-dimmed)";
	if (percent >= 99) return "var(--mantine-color-red-6)";
	if (percent >= 95) return "var(--mantine-color-yellow-6)";
	return "var(--mantine-color-teal-6)";
}

export interface StatuslineModelInput {
	model: string | null | undefined;
	inheritanceModel: string | null | undefined;
	defaultModelValue: string | undefined;
	aggregations: ModelAggregation[] | undefined;
	allModels: readonly ModelOption[];
	providerLabels: Record<string, string> | undefined;
}

/** `{ name: "claude-opus-5-5", provider: "Sub2api-Anthropic" }` for the effective model. */
export function describeModel(input: StatuslineModelInput): {
	name: string;
	provider: string | null;
	full: string;
} | null {
	const reference = capabilityModelReference(input.model, input.inheritanceModel);
	const resolved = resolveDisplayModel(reference, {
		defaultModelValue: input.defaultModelValue,
		aggregations: input.aggregations,
	});
	// Unresolvable sentinels (`__default__` with no default configured, `__parent__` with no
	// inheritance report, a bare `__agg__:` id) are internal markers, not model names.
	if (!resolved || resolved.startsWith("__")) return null;
	const option = input.allModels.find((candidate) => candidate.value === resolved);
	const colon = resolved.indexOf(":");
	const rawProvider = option?.provider ?? (colon > 0 ? resolved.slice(0, colon) : null);
	const name = option?.label || (colon > 0 ? resolved.slice(colon + 1) : resolved);
	const provider = rawProvider ? (input.providerLabels?.[rawProvider] ?? rawProvider) : null;
	return { name, provider, full: resolved };
}
