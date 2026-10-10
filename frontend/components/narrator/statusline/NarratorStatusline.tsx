/**
 * LOCAL PATCH (not upstream) — see ~/.narrafork-deploy/LOCAL_PATCHES.md.
 *
 * Shows this narrator's accumulated spend, including its direct subagents, in the left
 * part of the status bar: `· 用量 $72.60`. Rendered outside the idle/working switch so it
 * stays visible (and keeps updating) while a turn runs.
 *
 * Source: `GET /narrators/:id/usage-stats?includeSubagents=true`, the same endpoint the
 * details panel uses. It sums `api_requests.cost_usd` (the per-request cost records) on an
 * indexed query that runs in the DB read worker, so it is safe to call per idle transition.
 * `narrators.total_cost_usd` is NOT used: upstream only ever adds 0 to it, so it stays 0.
 *
 * Refresh policy: one fetch on mount, one when a turn ends, and during a turn at most one
 * per 10s triggered by finished assistant messages. No timer polling.
 */
import { Text, Tooltip } from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useNarrator, useNarratorUsageStats } from "../../../hooks/useNarrator";
import { narratorWSManager } from "../../../lib/narrator-ws-manager";
import { formatCostUsd } from "./statusline-format";

/** At most one usage query per this interval while assistant messages stream in. */
const REFRESH_MIN_INTERVAL_MS = 10_000;

const LABELS = {
	en: {
		usage: "Usage",
		tooltip: "Spend of this session including subagents ({requests} requests)",
		partial: "; {unpriced} requests have no price, so this is a lower bound",
	},
	zh: {
		usage: "用量",
		tooltip: "本会话累计花费，含子代理（{requests} 次请求）",
		partial: "；其中 {unpriced} 次请求无定价，实际可能更高",
	},
} as const;

function fill(template: string, values: Record<string, number>): string {
	return template.replace(/\{(\w+)\}/g, (match, key: string) =>
		key in values ? String(values[key]) : match,
	);
}

export function NarratorStatusline({ narratorId }: { narratorId: string }) {
	const { i18n } = useTranslation();
	const labels = LABELS[i18n.language?.startsWith("zh") ? "zh" : "en"];
	const qc = useQueryClient();
	const { data: narrator } = useNarrator(narratorId);
	const { data: stats } = useNarratorUsageStats(narratorId, true);

	// Refetch once when a turn ends, so the number reflects the turn that just finished.
	const status = (narrator as { status?: string } | undefined)?.status;
	const previousStatus = useRef(status);
	useEffect(() => {
		const wasWorking = previousStatus.current === "working" || previousStatus.current === "waiting";
		previousStatus.current = status;
		if (wasWorking && status !== "working" && status !== "waiting") {
			void qc.invalidateQueries({
				queryKey: ["narrators", narratorId, "usage-stats"],
			});
		}
	}, [qc, narratorId, status]);

	// While a turn runs, each finished assistant message means at least one billed request
	// landed. Refresh on those, throttled, so the number moves during long turns without
	// re-querying on every streamed chunk.
	useEffect(() => {
		let last = 0;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const refresh = () => {
			timer = null;
			last = Date.now();
			void qc.invalidateQueries({ queryKey: ["narrators", narratorId, "usage-stats"] });
		};
		const handle = narratorWSManager.addListener(
			{ narratorIds: [narratorId], types: ["message"] },
			(event) => {
				const role = (event.message as { role?: string } | undefined)?.role;
				if (role !== "assistant" || timer) return;
				const wait = Math.max(0, last + REFRESH_MIN_INTERVAL_MS - Date.now());
				timer = setTimeout(refresh, wait);
			},
		);
		return () => {
			narratorWSManager.removeListener(handle);
			if (timer) clearTimeout(timer);
		};
	}, [qc, narratorId]);

	const cost = formatCostUsd(stats?.totalCost);
	if (!stats || !cost) return null;
	const partial = (stats.unpricedRequestCount ?? 0) > 0;
	const tooltip =
		fill(labels.tooltip, { requests: stats.totalRequests }) +
		(partial ? fill(labels.partial, { unpriced: stats.unpricedRequestCount ?? 0 }) : "");

	return (
		<Tooltip label={tooltip} openDelay={300} multiline maw={320}>
			<Text
				span
				size="xs"
				c="dimmed"
				style={{ flexShrink: 0, whiteSpace: "nowrap", cursor: "default" }}
			>
				· {labels.usage}{" "}
				<Text span size="xs" ff="monospace" c="var(--mantine-color-yellow-5)">
					{partial ? "≥" : ""}
					{cost}
				</Text>
			</Text>
		</Tooltip>
	);
}
