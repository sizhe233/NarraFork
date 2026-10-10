/**
 * LOCAL PATCH (not upstream) — see ~/.narrafork-deploy/LOCAL_PATCHES.md.
 *
 * Per-narrator context-usage values for the status line.
 *
 * The numbers live in `useNarratorPanelWS` state inside NarratorPanel; the status bar only
 * receives the already-rendered context ring. Threading three more props through
 * NarratorPanel → NarratorInteractionArea → useStatusBarProps → the status bar would touch
 * four upstream files, so the panel publishes here with one call and the status line reads
 * it back. Keeping the upstream footprint to a single line is the point of this module.
 */
import { useEffect, useSyncExternalStore } from "react";

export interface StatuslineContextUsage {
	percent: number | null;
	promptTokens: number | null;
	contextWindow: number | null;
	stale: boolean;
}

/** Bounded: one entry per narrator ever opened in this tab is plenty, but never unbounded. */
const MAX_ENTRIES = 200;

const values = new Map<string, StatuslineContextUsage>();
const listeners = new Set<() => void>();

function sameUsage(a: StatuslineContextUsage | undefined, b: StatuslineContextUsage): boolean {
	return (
		!!a &&
		a.percent === b.percent &&
		a.promptTokens === b.promptTokens &&
		a.contextWindow === b.contextWindow &&
		a.stale === b.stale
	);
}

export function publishStatuslineContext(narratorId: string, usage: StatuslineContextUsage): void {
	if (!narratorId || sameUsage(values.get(narratorId), usage)) return;
	// Re-insert so iteration order tracks recency and eviction drops the stalest entry.
	values.delete(narratorId);
	values.set(narratorId, usage);
	while (values.size > MAX_ENTRIES) {
		const oldest = values.keys().next().value;
		if (oldest === undefined) break;
		values.delete(oldest);
	}
	for (const listener of listeners) listener();
}

export function getStatuslineContext(narratorId: string): StatuslineContextUsage | undefined {
	return values.get(narratorId);
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Called once from NarratorPanel with the WS-derived context fields. */
export function useStatuslineContextPublisher(
	narratorId: string,
	usage: StatuslineContextUsage,
): void {
	const { percent, promptTokens, contextWindow, stale } = usage;
	useEffect(() => {
		publishStatuslineContext(narratorId, { percent, promptTokens, contextWindow, stale });
	}, [narratorId, percent, promptTokens, contextWindow, stale]);
}

export function useStatuslineContext(narratorId: string): StatuslineContextUsage | undefined {
	return useSyncExternalStore(
		subscribe,
		() => values.get(narratorId),
		() => values.get(narratorId),
	);
}

/** Test-only reset. */
export function resetStatuslineStoreForTests(): void {
	values.clear();
}
