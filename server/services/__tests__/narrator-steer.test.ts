/**
 * local(narrator-control): guards for steering another narrator.
 *
 * Pinned properties:
 * - only the triggering user's OWN primary narrators are reachable (admin does not widen it);
 * - subagents and the caller itself are refused;
 * - send uses the composer admission with the requested queue mode, a sender prefix and an
 *   agent origin carried in executionIntent (so a queued message keeps its attribution);
 * - interrupt-with-message is one urgent-guidance admission, not abort-then-send;
 * - ping-pong between two narrators is rate limited.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narrators, users } from "../../db/schema";

const { db, sqlite } = getTestDb();
const realDb = { ...(await import("../../db")) };
const realSession = { ...(await import("../narrator-session")) };
const realSessionState = { ...(await import("../narrator-session-state")) };
const realCompact = { ...(await import("../narrator-compact")) };
const realI18n = { ...(await import("../../lib/i18n")) };
const realService = { ...(await import("../narrator-service")) };

const acceptCalls: Array<{ id: string; prompt: string; options: Record<string, unknown> }> = [];
const interruptCalls: string[] = [];
let busy = false;

mock.module("../../db", () => ({ ...realDb, db, sqlite }));
mock.module("../narrator-session", () => ({
	...realSession,
	acceptUserMessage: async (id: string, prompt: string, options: Record<string, unknown>) => {
		acceptCalls.push({ id, prompt, options });
		return busy
			? { buffered: true, id: "queued-1", bufferedAt: "now" }
			: { buffered: false, userMsg: { id: "msg-1" } };
	},
	interruptNarrator: (id: string) => {
		interruptCalls.push(id);
		return busy;
	},
	isLoopRunning: () => busy,
}));
mock.module("../narrator-session-state", () => ({
	...realSessionState,
	isNarratorRuntimeBusy: () => busy,
}));
mock.module("../narrator-compact", () => ({ ...realCompact, isCompactInProgress: () => false }));
mock.module("../../lib/i18n", () => ({
	...realI18n,
	getUserLanguage: async () => "zh-CN",
	getUserReplyInLanguage: async () => false,
}));
mock.module("../narrator-service", () => ({
	...realService,
	interruptManualBash: () => false,
}));

const control = await import("../narrator-steer");

afterAll(() => {
	mock.module("../../db", () => realDb);
	mock.module("../narrator-session", () => realSession);
	mock.module("../narrator-session-state", () => realSessionState);
	mock.module("../narrator-compact", () => realCompact);
	mock.module("../../lib/i18n", () => realI18n);
	mock.module("../narrator-service", () => realService);
	mock.restore();
});

const now = new Date().toISOString();
function insertNarrator(values: Partial<typeof narrators.$inferInsert> & { id: string }) {
	db.insert(narrators)
		.values({ createdAt: now, updatedAt: now, ownerUserId: "alice", ...values })
		.run();
}

beforeEach(() => {
	for (const id of ["alice", "bob"]) {
		db.insert(users)
			.values({ id, username: id, passwordHash: "x", createdAt: now, updatedAt: now } as never)
			.run();
	}
	insertNarrator({ id: "caller", title: "Supervisor" });
	insertNarrator({ id: "worker", title: "Worker" });
	insertNarrator({ id: "dup-1", title: "Twin" });
	insertNarrator({ id: "dup-2", title: "twin" });
	insertNarrator({ id: "bobs", title: "Bob's", ownerUserId: "bob" });
	insertNarrator({
		id: "child",
		title: "Child",
		type: "subagent",
		variant: "general",
		parentNarratorId: "worker",
	});
});

afterEach(() => {
	acceptCalls.length = 0;
	interruptCalls.length = 0;
	busy = false;
	control.resetNarratorControlRateLimits();
	cleanDb(sqlite);
});

const caller = { narratorId: "caller", userId: "alice", locale: "zh-CN" };

describe("target resolution", () => {
	test("resolves by id and by unique case-insensitive title", async () => {
		expect((await control.resolveControlTarget(caller, "worker")).id).toBe("worker");
		expect((await control.resolveControlTarget(caller, "  worker ")).id).toBe("worker");
		expect((await control.resolveControlTarget(caller, "WORKER")).id).toBe("worker");
	});

	test("another user's narrator is reported as not found", async () => {
		await expect(control.resolveControlTarget(caller, "bobs")).rejects.toThrow(/not found/);
		await expect(control.resolveControlTarget(caller, "Bob's")).rejects.toThrow(/not found/);
	});

	test("refuses subagents, itself, ambiguous titles and a missing user", async () => {
		await expect(control.resolveControlTarget(caller, "child")).rejects.toThrow(/subagent/);
		await expect(control.resolveControlTarget(caller, "caller")).rejects.toThrow(/itself/);
		await expect(control.resolveControlTarget(caller, "twin")).rejects.toThrow(/matches 2/);
		await expect(
			control.resolveControlTarget({ ...caller, userId: null }, "worker"),
		).rejects.toThrow(/No user/);
	});
});

describe("list", () => {
	test("only the user's own primary narrators, marking self", async () => {
		const result = await control.listControllableNarrators(caller);
		const ids = result.items.map((item) => item.id).sort();
		expect(ids).toEqual(["caller", "dup-1", "dup-2", "worker"]);
		expect(result.items.find((item) => item.id === "caller")?.isSelf).toBe(true);
		const filtered = await control.listControllableNarrators(caller, { query: "work" });
		expect(filtered.items.map((item) => item.id)).toEqual(["worker"]);
	});
});

describe("send", () => {
	for (const mode of ["turn", "tool", "interrupt"] as const) {
		test(`passes queue mode "${mode}" through the composer admission`, async () => {
			await control.sendControlMessage(caller, { target: "worker", message: "fix it", mode });
			expect(acceptCalls).toHaveLength(1);
			expect(acceptCalls[0]?.options.queueMode).toBe(mode);
		});
	}

	test("defaults to turn, prefixes the sender and carries an agent origin", async () => {
		const sent = await control.sendControlMessage(caller, { target: "Worker", message: "hi" });
		expect(sent).toMatchObject({ targetId: "worker", mode: "turn", buffered: false });
		const call = acceptCalls[0];
		expect(call?.id).toBe("worker");
		expect(call?.prompt).toStartWith('[来自叙述者"Supervisor"（caller）的消息');
		expect(call?.prompt).toEndWith("\nhi");
		expect(call?.options.userId).toBe("alice");
		expect(call?.options.executionIntent).toEqual({
			origin: { origin: "assistant", originLabel: "agentMessage:Supervisor" },
		});
	});

	test("reports queued delivery while the target is busy", async () => {
		busy = true;
		const sent = await control.sendControlMessage(caller, { target: "worker", message: "x" });
		expect(sent).toMatchObject({ buffered: true, messageId: "queued-1", wasBusy: true });
	});

	test("rejects empty and oversized messages before delivery", async () => {
		await expect(
			control.sendControlMessage(caller, { target: "worker", message: "   " }),
		).rejects.toThrow(/empty/);
		await expect(
			control.sendControlMessage(caller, {
				target: "worker",
				message: "x".repeat(control.NARRATOR_CONTROL_MAX_MESSAGE_CHARS + 1),
			}),
		).rejects.toThrow(/exceeds/);
		expect(acceptCalls).toHaveLength(0);
	});

	test("ping-pong between two narrators is rate limited in both directions", async () => {
		const workerCaller = { narratorId: "worker", userId: "alice" };
		for (let i = 0; i < control.NARRATOR_CONTROL_PAIR_LIMIT; i++) {
			const from = i % 2 === 0 ? caller : workerCaller;
			await control.sendControlMessage(from, {
				target: i % 2 === 0 ? "worker" : "caller",
				message: `m${i}`,
			});
		}
		await expect(
			control.sendControlMessage(caller, { target: "worker", message: "again" }),
		).rejects.toThrow(/Rate limit/);
		expect(acceptCalls).toHaveLength(control.NARRATOR_CONTROL_PAIR_LIMIT);
	});
});

describe("interrupt", () => {
	test("without a message stops the running turn", async () => {
		busy = true;
		const result = await control.interruptControlTarget(caller, { target: "worker" });
		expect(result).toMatchObject({ targetId: "worker", interrupted: true });
		expect(interruptCalls).toEqual(["worker"]);
		expect(acceptCalls).toHaveLength(0);
	});

	test("idle target with no message reports nothing interrupted", async () => {
		const result = await control.interruptControlTarget(caller, { target: "worker" });
		expect(result.interrupted).toBe(false);
	});

	test("with a message is a single urgent-guidance admission", async () => {
		busy = true;
		const result = await control.interruptControlTarget(caller, {
			target: "worker",
			message: "wrong file, use b.ts",
		});
		expect(interruptCalls).toEqual([]);
		expect(acceptCalls).toHaveLength(1);
		expect(acceptCalls[0]?.options.queueMode).toBe("interrupt");
		expect(result.interrupted).toBe(true);
		expect(result.followUp?.mode).toBe("interrupt");
	});

	test("cannot interrupt another user's narrator", async () => {
		await expect(control.interruptControlTarget(caller, { target: "bobs" })).rejects.toThrow(
			/not found/,
		);
		expect(interruptCalls).toEqual([]);
	});
});
