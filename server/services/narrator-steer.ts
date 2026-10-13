/**
 * local(narrator-control): let one narrator steer another narrator owned by the same user.
 *
 * Built for the optional `NarratorControl` tool. Three operations:
 *
 * - `list`: the caller's own primary narrators, bounded, metadata only.
 * - `send`: deliver a message through the exact admission path the composer uses
 *   (`acceptUserMessage`), so the three composer modes keep their meaning:
 *     turn      — "完成后继续": queue behind the current task
 *     tool      — "即时引导": supplement at the next safe boundary, no tool is aborted
 *     interrupt — "紧急引导": abort running tools and deliver immediately
 * - `interrupt`: stop the target's current turn, like the Stop button.
 *
 * Scope is deliberately narrow: the target must be a primary narrator whose OWNER is
 * the user who triggered the caller's turn. Admin status does not widen it — a shared
 * or admin-visible narrator belonging to someone else is reported exactly like a
 * missing one, so ids cannot be probed.
 *
 * Messages are prefixed with the sender's identity (the model must know a machine
 * wrote them) and stored with `origin: "assistant"` / `agentMessage:<sender>` so the
 * reader is not told a human typed them.
 */

import type { BufferQueueMode } from "@shared/buffer-queue-mode";
import { and, desc, eq, ne } from "drizzle-orm";
import { db } from "../db";
import { narrators } from "../db/schema";
import { getUserLanguage, getUserReplyInLanguage } from "../lib/i18n";
import { logger } from "../lib/logger";
import { isSubagentVariant } from "../lib/narrator-utils";
import { buildAgentMessageOrigin } from "./agent-message-origin";

export type NarratorControlMode = BufferQueueMode;

export class NarratorControlError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NarratorControlError";
	}
}

export interface NarratorControlCaller {
	narratorId: string;
	/** The human whose turn is running in the caller. Required: it decides ownership. */
	userId: string | null | undefined;
	locale?: string;
}

/** Max characters of a delivered message body (before the sender prefix). */
export const NARRATOR_CONTROL_MAX_MESSAGE_CHARS = 32_000;
/** Rows returned by `list`. */
export const NARRATOR_CONTROL_LIST_LIMIT = 50;

// ── Rate limiting ───────────────────────────────────────────────────────────
//
// Two narrators that can wake each other can also wake each other forever. The
// window bounds both a single pair (A↔B ping-pong) and one sender fanning out.

const WINDOW_MS = 60_000;
export const NARRATOR_CONTROL_PAIR_LIMIT = 6;
export const NARRATOR_CONTROL_SENDER_LIMIT = 20;
const sendLog = new Map<string, number[]>();

function recent(key: string, now: number): number[] {
	const kept = (sendLog.get(key) ?? []).filter((at) => now - at < WINDOW_MS);
	if (kept.length) sendLog.set(key, kept);
	else sendLog.delete(key);
	return kept;
}

function assertWithinRate(senderId: string, targetId: string, now = Date.now()): void {
	const pairKey = `${senderId}\u0000${targetId}`;
	const reverseKey = `${targetId}\u0000${senderId}`;
	// Ping-pong counts both directions against the same pair budget.
	if (recent(pairKey, now).length + recent(reverseKey, now).length >= NARRATOR_CONTROL_PAIR_LIMIT) {
		throw new NarratorControlError(
			`Rate limit: at most ${NARRATOR_CONTROL_PAIR_LIMIT} messages per minute between the same two narrators. Stop and report to the user instead of retrying.`,
		);
	}
	if (recent(senderId, now).length >= NARRATOR_CONTROL_SENDER_LIMIT) {
		throw new NarratorControlError(
			`Rate limit: at most ${NARRATOR_CONTROL_SENDER_LIMIT} NarratorControl messages per minute from one narrator.`,
		);
	}
}

function recordSend(senderId: string, targetId: string, now = Date.now()): void {
	for (const key of [`${senderId}\u0000${targetId}`, senderId]) {
		const entries = sendLog.get(key) ?? [];
		entries.push(now);
		sendLog.set(key, entries);
	}
}

/** Tests only. */
export function resetNarratorControlRateLimits(): void {
	sendLog.clear();
}

// ── Resolution ──────────────────────────────────────────────────────────────

type NarratorRow = typeof narrators.$inferSelect;

function requireUser(caller: NarratorControlCaller): string {
	const userId = caller.userId?.trim();
	if (!userId) {
		throw new NarratorControlError(
			"No user is associated with this turn, so target ownership cannot be verified.",
		);
	}
	return userId;
}

function notFound(target: string): NarratorControlError {
	return new NarratorControlError(
		`Narrator "${target}" was not found among your own primary narrators. Use action "list" to see valid targets.`,
	);
}

/** Resolve by exact id, else by unique case-insensitive title among the user's narrators. */
export async function resolveControlTarget(
	caller: NarratorControlCaller,
	target: string,
): Promise<NarratorRow> {
	const userId = requireUser(caller);
	const selector = target.trim();
	if (!selector) throw new NarratorControlError("target is required");

	const byId = await db.query.narrators.findFirst({ where: eq(narrators.id, selector) });
	let row: NarratorRow | undefined = byId;
	if (!row) {
		const candidates = await db
			.select()
			.from(narrators)
			.where(
				and(
					eq(narrators.ownerUserId, userId),
					eq(narrators.type, "primary"),
					ne(narrators.status, "archived"),
				),
			)
			.orderBy(desc(narrators.updatedAt))
			.limit(500);
		const lowered = selector.toLowerCase();
		const matches = candidates.filter((c) => c.title?.trim().toLowerCase() === lowered);
		if (matches.length > 1) {
			throw new NarratorControlError(
				`Title "${selector}" matches ${matches.length} narrators; use the narrator id instead (action "list").`,
			);
		}
		row = matches[0];
	}
	if (!row || row.ownerUserId !== userId) throw notFound(selector);
	if (row.type !== "primary" || isSubagentVariant(row.variant)) {
		throw new NarratorControlError(
			"The target is a subagent. Message your own subagents with Send; other narrators' subagents cannot be targeted.",
		);
	}
	if (row.id === caller.narratorId) {
		throw new NarratorControlError("A narrator cannot target itself.");
	}
	return row;
}

// ── list ────────────────────────────────────────────────────────────────────

export interface NarratorControlListItem {
	id: string;
	title: string | null;
	status: string;
	model: string | null;
	updatedAt: string;
	isSelf: boolean;
}

export async function listControllableNarrators(
	caller: NarratorControlCaller,
	options: { query?: string; includeArchived?: boolean } = {},
): Promise<{ items: NarratorControlListItem[]; hasMore: boolean }> {
	const userId = requireUser(caller);
	const conditions = [eq(narrators.ownerUserId, userId), eq(narrators.type, "primary")];
	if (!options.includeArchived) conditions.push(ne(narrators.status, "archived"));
	const query = options.query?.trim().toLowerCase();
	// The title filter runs in memory over a bounded page: titles are short, the page is
	// capped, and a LIKE pattern built from model input would need its own escaping.
	const scanLimit = query ? 500 : NARRATOR_CONTROL_LIST_LIMIT + 1;
	const rows = await db
		.select({
			id: narrators.id,
			title: narrators.title,
			status: narrators.status,
			model: narrators.model,
			updatedAt: narrators.updatedAt,
		})
		.from(narrators)
		.where(and(...conditions))
		.orderBy(desc(narrators.updatedAt))
		.limit(scanLimit);
	const filtered = query
		? rows.filter(
				(row) =>
					row.id.toLowerCase().includes(query) || (row.title ?? "").toLowerCase().includes(query),
			)
		: rows;
	return {
		items: filtered.slice(0, NARRATOR_CONTROL_LIST_LIMIT).map((row) => ({
			...row,
			isSelf: row.id === caller.narratorId,
		})),
		hasMore: filtered.length > NARRATOR_CONTROL_LIST_LIMIT,
	};
}

// ── send ────────────────────────────────────────────────────────────────────

async function senderIdentity(caller: NarratorControlCaller) {
	const sender = await db.query.narrators.findFirst({
		where: eq(narrators.id, caller.narratorId),
		columns: { id: true, title: true },
	});
	const title = sender?.title?.trim() || null;
	return { id: caller.narratorId, title, label: title ?? caller.narratorId };
}

export function formatControlMessage(
	sender: { id: string; title: string | null },
	mode: NarratorControlMode,
	message: string,
	locale: string | undefined,
): string {
	const name = sender.title ?? sender.id;
	if (locale === "zh-CN") {
		const how =
			mode === "interrupt" ? "紧急引导" : mode === "tool" ? "即时引导" : "完成当前任务后处理";
		return `[来自叙述者"${name}"（${sender.id}）的消息 · ${how} · 由 AI 通过 NarratorControl 发送，不是用户本人输入]\n${message}`;
	}
	const how =
		mode === "interrupt"
			? "urgent guidance"
			: mode === "tool"
				? "immediate guidance"
				: "handle after the current task";
	return `[Message from narrator "${name}" (${sender.id}) · ${how} · sent by an AI via NarratorControl, not typed by the user]\n${message}`;
}

export interface NarratorControlSendResult {
	targetId: string;
	targetTitle: string | null;
	mode: NarratorControlMode;
	/** true: queued behind running work; false: started a turn immediately. */
	buffered: boolean;
	messageId: string;
	wasBusy: boolean;
}

export async function sendControlMessage(
	caller: NarratorControlCaller,
	input: { target: string; message: string; mode?: NarratorControlMode },
): Promise<NarratorControlSendResult> {
	const userId = requireUser(caller);
	const body = input.message.trim();
	if (!body) throw new NarratorControlError("message must not be empty");
	if (body.length > NARRATOR_CONTROL_MAX_MESSAGE_CHARS) {
		throw new NarratorControlError(
			`message exceeds ${NARRATOR_CONTROL_MAX_MESSAGE_CHARS} characters; send a file path or summary instead.`,
		);
	}
	const mode: NarratorControlMode = input.mode ?? "turn";
	const target = await resolveControlTarget(caller, input.target);
	assertWithinRate(caller.narratorId, target.id);

	const session = await import("./narrator-session");
	const { isNarratorRuntimeBusy } = await import("./narrator-session-state");
	const { narratorService } = await import("./narrator-service");
	const { isCompactInProgress } = await import("./narrator-compact");

	if (target.status === "archived") await narratorService.updateStatus(target.id, "idle");

	const sender = await senderIdentity(caller);
	const prompt = formatControlMessage(sender, mode, body, caller.locale);
	const origin = buildAgentMessageOrigin({ ...sender, isParent: false });
	const wasBusy = isNarratorRuntimeBusy(target.id) || session.isLoopRunning(target.id);
	const [locale, replyInUserLanguage] = await Promise.all([
		getUserLanguage(userId),
		getUserReplyInLanguage(userId),
	]);

	const result = await session.acceptUserMessage(target.id, prompt, {
		locale,
		replyInUserLanguage,
		userId,
		queueMode: mode,
		// A compacting narrator must not start a turn against history being replaced;
		// the compact exit drains the queue on every outcome.
		queueOnly: isCompactInProgress(target.id),
		executionIntent: { origin },
	});
	recordSend(caller.narratorId, target.id);
	logger.info("NarratorControl message delivered", {
		from: caller.narratorId,
		to: target.id,
		mode,
		buffered: result.buffered,
	});
	return {
		targetId: target.id,
		targetTitle: target.title,
		mode,
		buffered: result.buffered,
		messageId: result.buffered ? result.id : result.userMsg.id,
		wasBusy,
	};
}

// ── interrupt ───────────────────────────────────────────────────────────────

export interface NarratorControlInterruptResult {
	targetId: string;
	targetTitle: string | null;
	/** Whether a running turn / manual Bash was actually stopped. */
	interrupted: boolean;
	/** Present when a follow-up message was delivered as urgent guidance. */
	followUp?: NarratorControlSendResult;
}

export async function interruptControlTarget(
	caller: NarratorControlCaller,
	input: { target: string; message?: string },
): Promise<NarratorControlInterruptResult> {
	const message = input.message?.trim();
	if (message) {
		// "Stop and correct": the urgent-guidance admission queues the correction at the
		// front, then aborts the running owner, so the message is the very next input and
		// cannot be overtaken by anything already queued.
		const followUp = await sendControlMessage(caller, {
			target: input.target,
			message,
			mode: "interrupt",
		});
		return {
			targetId: followUp.targetId,
			targetTitle: followUp.targetTitle,
			interrupted: followUp.wasBusy,
			followUp,
		};
	}

	const target = await resolveControlTarget(caller, input.target);
	const { interruptManualBash, narratorService } = await import("./narrator-service");
	const { interruptNarrator } = await import("./narrator-session");
	let interrupted = interruptManualBash(target.id);
	if (interruptNarrator(target.id)) interrupted = true;
	if (!interrupted) {
		// Same zombie fallback as POST /:id/interrupt: a loop that ended without
		// settling its status would otherwise keep showing as running forever.
		const fresh = await narratorService.getById(target.id);
		if (fresh.status === "working" || fresh.status === "waiting") {
			await narratorService.updateStatus(target.id, "idle", { substatus: ["interrupted"] });
			interrupted = true;
		}
	}
	logger.info("NarratorControl interrupt", { from: caller.narratorId, to: target.id, interrupted });
	return { targetId: target.id, targetTitle: target.title, interrupted };
}
