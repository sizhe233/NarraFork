/**
 * LOCAL PATCH (not upstream) — see ~/.narrafork-deploy/LOCAL_PATCHES.md.
 *
 * Shell-prompt style status line in the idle part of the narrator status bar:
 *
 *   model › ~/Project/NarraFork › main › $72.60 › ▬▬▬▬▭ 61% › 1M
 *
 * Self-contained on purpose. Every value is read from queries the panel already keeps
 * warm (narrator detail, model catalog, workspace context, git workspace/status) plus the
 * small context store NarratorPanel publishes into, so the upstream code only needs one
 * `<NarratorStatusline narratorId=… />` line. Rendering nothing is always safe: the
 * component never throws for missing data, it just drops that segment.
 */
import { Box, Checkbox, Group, Menu, Text, Tooltip, UnstyledButton } from "@mantine/core";
import { useLocalStorage } from "@mantine/hooks";
import { Fragment, type ReactNode, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { gitWorkspaceTarget, useGitStatus, useGitWorkspace } from "../../../hooks/useGit";
import { useAllModels } from "../../../hooks/useModels";
import { useNarrator } from "../../../hooks/useNarrator";
import { useWorkspaceContext } from "../../../hooks/useWorkspaceContext";
import { formatCompactNumber } from "../../../lib/compact-number";
import {
	contextColor,
	DEFAULT_STATUSLINE_SETTINGS,
	describeModel,
	fitStatuslineSegments,
	formatCostUsd,
	parseStatuslineSettings,
	STATUSLINE_SEGMENTS,
	STATUSLINE_STORAGE_KEY,
	type StatuslineSegment,
	type StatuslineSettings,
	shortenPath,
} from "./statusline-format";
import { useStatuslineContext } from "./statusline-store";

/** Labels are local so the patch never touches upstream locale JSON files. */
const LABELS: Record<"en" | "zh", Record<StatuslineSegment | "title", string>> = {
	en: {
		title: "Status line segments",
		model: "Model",
		cwd: "Directory",
		branch: "Branch",
		cost: "Cost",
		context: "Context usage",
		window: "Context window",
	},
	zh: {
		title: "状态行显示内容",
		model: "模型",
		cwd: "目录",
		branch: "分支",
		cost: "费用",
		context: "上下文占用",
		window: "上下文窗口",
	},
};

const BAR_WIDTH = 64;

function Separator() {
	return (
		<Text span size="xs" c="dimmed" style={{ flexShrink: 0, opacity: 0.6 }} aria-hidden>
			›
		</Text>
	);
}

interface Segment {
	key: StatuslineSegment;
	node: ReactNode;
	tooltip?: string;
	/** Cap so one long value (a branch name) cannot crowd out everything else. */
	maxWidth?: number;
}

/** Gap between a segment and a separator, matching the row's `gap={6}`. */
const ROW_GAP = 6;

/**
 * Measure every segment at its natural width in a hidden row, then decide which ones fit
 * the visible row. Measuring all of them (not just the visible ones) is what lets a hidden
 * segment come back when the panel widens again.
 */
function useFittedSegments(segments: Segment[]) {
	const containerRef = useRef<HTMLButtonElement | null>(null);
	const measureRef = useRef<HTMLDivElement | null>(null);
	const [visible, setVisible] = useState<Set<StatuslineSegment> | null>(null);
	const signature = segments.map((segment) => segment.key).join(",");

	// biome-ignore lint/correctness/useExhaustiveDependencies: `signature` re-measures when the segment set changes; text changes are caught by the ResizeObserver on the measuring row.
	useLayoutEffect(() => {
		const container = containerRef.current;
		const measure = measureRef.current;
		if (!container || !measure) return;
		let frame = 0;
		const compute = () => {
			frame = 0;
			const widths = new Map<StatuslineSegment, number>();
			let separatorWidth = 0;
			for (const child of Array.from(measure.children) as HTMLElement[]) {
				const key = child.dataset.segment as StatuslineSegment | undefined;
				if (key) widths.set(key, child.getBoundingClientRect().width);
				else if (child.dataset.separator) separatorWidth = child.getBoundingClientRect().width;
			}
			const next = fitStatuslineSegments(
				widths,
				container.getBoundingClientRect().width,
				separatorWidth + ROW_GAP * 2,
			);
			setVisible((previous) =>
				previous && previous.size === next.size && [...next].every((key) => previous.has(key))
					? previous
					: next,
			);
		};
		const schedule = () => {
			if (!frame) frame = requestAnimationFrame(compute);
		};
		compute();
		const observer = new ResizeObserver(schedule);
		observer.observe(container);
		observer.observe(measure);
		return () => {
			observer.disconnect();
			if (frame) cancelAnimationFrame(frame);
		};
	}, [signature]);

	return { containerRef, measureRef, visible };
}

export function NarratorStatusline({ narratorId }: { narratorId: string }) {
	const { i18n } = useTranslation();
	const labels = LABELS[i18n.language?.startsWith("zh") ? "zh" : "en"];
	const [stored, setStored] = useLocalStorage<StatuslineSettings>({
		key: STATUSLINE_STORAGE_KEY,
		defaultValue: DEFAULT_STATUSLINE_SETTINGS,
		getInitialValueInEffect: false,
	});
	const settings = useMemo(() => parseStatuslineSettings(stored), [stored]);
	const enabled = settings.segments;

	const { data: narrator } = useNarrator(narratorId);
	const { visibleWithDefault, defaultModelValue, aggregations, providerLabels } = useAllModels();
	const { data: executionContext } = useWorkspaceContext(narratorId);
	const workspace = useGitWorkspace(narratorId);
	const gitTarget =
		enabled.branch && !workspace.isError ? gitWorkspaceTarget(narratorId, workspace.data) : null;
	const { data: gitStatus } = useGitStatus(gitTarget);
	const context = useStatuslineContext(narratorId);

	const n = narrator as
		| {
				model?: string | null;
				totalCostUsd?: number | null;
				modelInheritance?: { model?: string | null } | null;
		  }
		| undefined;

	const segments: Segment[] = [];

	if (enabled.model) {
		const model = describeModel({
			model: n?.model,
			inheritanceModel: n?.modelInheritance?.model,
			defaultModelValue,
			aggregations,
			allModels: visibleWithDefault,
			providerLabels,
		});
		if (model) {
			// The provider is only in the tooltip: the model selector at the right of the same
			// bar already spells out `provider:model`, so repeating it here only costs width.
			segments.push({
				key: "model",
				maxWidth: 220,
				tooltip: model.provider ? `${model.name} via ${model.provider}` : model.full,
				node: (
					<Text span size="xs" fw={600} c="var(--mantine-color-teal-5)" truncate>
						{model.name}
					</Text>
				),
			});
		}
	}

	if (enabled.cwd && executionContext?.cwd) {
		segments.push({
			key: "cwd",
			tooltip: `${executionContext.deviceId}: ${executionContext.cwd}`,
			node: (
				<Text span size="xs" c="dimmed" ff="monospace" truncate>
					{shortenPath(executionContext.cwd)}
				</Text>
			),
		});
	}

	const branch = gitStatus?.branch || workspace.data?.branch;
	if (enabled.branch && branch) {
		segments.push({
			key: "branch",
			maxWidth: 160,
			tooltip: branch,
			node: (
				<Text span size="xs" c="var(--mantine-color-violet-4)" ff="monospace" truncate>
					{branch}
				</Text>
			),
		});
	}

	const cost = formatCostUsd(n?.totalCostUsd);
	if (enabled.cost && cost) {
		segments.push({
			key: "cost",
			node: (
				<Text span size="xs" c="var(--mantine-color-yellow-5)" ff="monospace">
					{cost}
				</Text>
			),
		});
	}

	if (enabled.context && context?.percent != null) {
		const percent = Math.max(0, Math.min(100, context.percent));
		const color = contextColor(percent, context.stale);
		segments.push({
			key: "context",
			tooltip:
				context.promptTokens != null
					? `${formatCompactNumber(context.promptTokens).exact} tokens`
					: undefined,
			node: (
				<Group gap={6} wrap="nowrap" style={{ flexShrink: 0 }}>
					<Box
						w={BAR_WIDTH}
						h={4}
						style={{
							borderRadius: 2,
							overflow: "hidden",
							background: "light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))",
						}}
					>
						<Box
							h="100%"
							w={`${percent}%`}
							style={{ background: color, transition: "width 0.3s" }}
						/>
					</Box>
					<Text span size="xs" c={color} ff="monospace">
						{context.stale ? "?" : `${Math.round(percent)}%`}
					</Text>
				</Group>
			),
		});
	}

	if (enabled.window && context?.contextWindow) {
		segments.push({
			key: "window",
			node: (
				<Text span size="xs" c="dimmed" ff="monospace">
					{formatCompactNumber(context.contextWindow, { compactFractionDigits: 0 }).compact}
				</Text>
			),
		});
	}

	const { containerRef, measureRef, visible } = useFittedSegments(segments);
	// Until the first measurement lands, show nothing rather than a row that may overflow.
	const shown = visible ? segments.filter((segment) => visible.has(segment.key)) : [];

	return (
		<Menu position="top-start" withinPortal shadow="md" closeOnItemClick={false}>
			<Menu.Target>
				<UnstyledButton
					ref={containerRef}
					aria-label={labels.title}
					style={{
						position: "relative",
						minWidth: 0,
						flex: 1,
						alignSelf: "stretch",
						display: "flex",
						alignItems: "center",
						overflow: "hidden",
						cursor: "context-menu",
					}}
					onClick={(event) => event.preventDefault()}
				>
					{/* Hidden measuring row: every segment at natural width, never visible. */}
					<Group
						ref={measureRef}
						gap={0}
						wrap="nowrap"
						aria-hidden
						style={{
							position: "absolute",
							visibility: "hidden",
							pointerEvents: "none",
							left: 0,
							top: 0,
							width: "max-content",
						}}
					>
						<Box data-separator="1" style={{ display: "flex" }}>
							<Separator />
						</Box>
						{segments.map((segment) => (
							<Box
								key={segment.key}
								data-segment={segment.key}
								style={{ display: "flex", maxWidth: segment.maxWidth }}
							>
								{segment.node}
							</Box>
						))}
					</Group>
					<Group gap={ROW_GAP} wrap="nowrap" style={{ minWidth: 0, overflow: "hidden" }}>
						{shown.map((segment, index) => (
							<Fragment key={segment.key}>
								{index > 0 && <Separator />}
								<Tooltip label={segment.tooltip} disabled={!segment.tooltip} openDelay={400}>
									<Box
										style={{
											display: "flex",
											minWidth: segment.key === "cwd" ? 0 : undefined,
											maxWidth: segment.maxWidth,
											flexShrink: segment.key === "cwd" ? 1 : 0,
											overflow: "hidden",
										}}
									>
										{segment.node}
									</Box>
								</Tooltip>
							</Fragment>
						))}
					</Group>
				</UnstyledButton>
			</Menu.Target>
			<Menu.Dropdown>
				<Menu.Label>{labels.title}</Menu.Label>
				{STATUSLINE_SEGMENTS.map((key) => (
					<Menu.Item key={key}>
						<Checkbox
							size="xs"
							label={labels[key]}
							checked={enabled[key]}
							onChange={(event) =>
								setStored({
									segments: { ...enabled, [key]: event.currentTarget.checked },
								})
							}
						/>
					</Menu.Item>
				))}
			</Menu.Dropdown>
		</Menu>
	);
}
