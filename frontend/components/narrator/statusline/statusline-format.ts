/**
 * LOCAL PATCH (not upstream) — see ~/.narrafork-deploy/LOCAL_PATCHES.md.
 *
 * Pure formatting for the narrator usage indicator. No React, no DOM.
 */

/** `$72.60`; small positive spend keeps enough precision not to read as zero. */
export function formatCostUsd(cost: number | null | undefined): string | null {
	if (cost == null || !Number.isFinite(cost) || cost <= 0) return null;
	if (cost < 0.01) return `$${cost.toFixed(4)}`;
	return `$${cost.toFixed(2)}`;
}
