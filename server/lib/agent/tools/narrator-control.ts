/**
 * local(narrator-control): optional tool that lets a narrator list, message and
 * interrupt the user's OTHER primary narrators. Service logic and the ownership /
 * rate-limit guards live in `server/services/narrator-steer.ts`.
 */
import { z } from "zod/v4";
import type { ToolDefinition, ToolResult } from "../types";

const MODES = ["turn", "tool", "interrupt"] as const;

export const narratorControlParameters = z.discriminatedUnion("action", [
	z
		.object({
			action: z.literal("list"),
			query: z.string().max(200).optional(),
			include_archived: z.boolean().optional(),
		})
		.strict(),
	z
		.object({
			action: z.literal("send"),
			target: z.string().min(1).max(200),
			message: z.string().min(1),
			mode: z.enum(MODES).optional(),
		})
		.strict(),
	z
		.object({
			action: z.literal("interrupt"),
			target: z.string().min(1).max(200),
			message: z.string().optional(),
		})
		.strict(),
]);

export type NarratorControlArgs = z.infer<typeof narratorControlParameters>;

/** Only `list` is a pure read; everything else drives another session. */
export function isNarratorControlReadAction(action: unknown): boolean {
	return action === "list";
}

const DESCRIPTION = [
	"Control the user's OTHER primary narrators (independent sessions owned by the same user): list them, send them a message, or interrupt them.",
	"This is NOT for your own subagents — use Send/Agent for those. Targets owned by other users, subagents and yourself are refused.",
	"",
	'action "list": your own primary narrators (id, title, status, model). Optional query filters by id/title substring.',
	'action "send": deliver `message` to `target` (narrator id, or its exact unique title). Asynchronous: returns once the message is accepted, never waits for a reply. `mode` mirrors the composer:',
	'  - "turn" (default) — queue it; the target handles it after finishing its current task.',
	'  - "tool" — immediate guidance: added to the current task at the next safe boundary; running tools are NOT aborted.',
	'  - "interrupt" — urgent guidance: aborts running tools and delivers immediately. Changes already made are not rolled back.',
	'action "interrupt": stop the target\'s current turn (like the Stop button). If `message` is given, it is delivered as urgent guidance in the same step so the target resumes with your correction.',
	"",
	"The recipient sees the message labelled as coming from you, not from the user. Do not send acknowledgements or status pings; rate limits apply and a refused send must not be retried in a loop.",
].join("\n");

function formatList(
	result: Awaited<
		ReturnType<typeof import("@server/services/narrator-steer").listControllableNarrators>
	>,
): string {
	if (result.items.length === 0) return "No primary narrators found.";
	const lines = result.items.map(
		(item) =>
			`- ${item.id} | ${item.title ?? "(untitled)"} | ${item.status}${item.model ? ` | ${item.model}` : ""}${item.isSelf ? " | (you)" : ""}`,
	);
	if (result.hasMore) lines.push("… more exist; narrow with `query`.");
	return lines.join("\n");
}

const MODE_LABEL: Record<(typeof MODES)[number], string> = {
	turn: "queued after the current task",
	tool: "immediate guidance (next safe boundary)",
	interrupt: "urgent guidance (running tools aborted)",
};

export const narratorControlTool: ToolDefinition = {
	name: "NarratorControl",
	description: DESCRIPTION,
	parameters: narratorControlParameters,
	rawJsonSchema: {
		type: "object",
		properties: {
			action: {
				type: "string",
				enum: ["list", "send", "interrupt"],
				description: "list | send | interrupt",
			},
			target: {
				type: "string",
				description:
					"send/interrupt: target narrator id, or its exact unique title. Use list to find it.",
			},
			message: {
				type: "string",
				description:
					"send: required message body. interrupt: optional correction delivered as urgent guidance after stopping.",
			},
			mode: {
				type: "string",
				enum: [...MODES],
				description:
					'send only. "turn" (default) = after current task; "tool" = immediate guidance, no tool aborted; "interrupt" = urgent guidance, aborts running tools.',
			},
			query: { type: "string", description: "list only: id/title substring filter." },
			include_archived: {
				type: "boolean",
				description: "list only: include archived narrators.",
			},
		},
		required: ["action"],
		additionalProperties: false,
	},
	async execute(args, ctx): Promise<ToolResult> {
		const parsed = narratorControlParameters.safeParse(args);
		if (!parsed.success) {
			return {
				output: `Invalid NarratorControl arguments: ${parsed.error.issues
					.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
					.join("; ")}`,
				isError: true,
			};
		}
		const service = await import("@server/services/narrator-steer");
		const caller = { narratorId: ctx.narratorId, userId: ctx.userId, locale: ctx.locale };
		try {
			const input = parsed.data;
			if (input.action === "list") {
				const result = await service.listControllableNarrators(caller, {
					query: input.query,
					includeArchived: input.include_archived,
				});
				return { output: formatList(result) };
			}
			if (input.action === "send") {
				const sent = await service.sendControlMessage(caller, input);
				const name = sent.targetTitle ?? sent.targetId;
				return {
					output: `Message delivered to "${name}" (${sent.targetId}) as ${MODE_LABEL[sent.mode]}; ${
						sent.buffered ? "queued" : "started a new turn"
					}. This is asynchronous — no reply is returned here.`,
					metadata: { kind: "narrator_control", action: "send", ...sent },
				};
			}
			const result = await service.interruptControlTarget(caller, input);
			const name = result.targetTitle ?? result.targetId;
			const head = result.interrupted
				? `Interrupted "${name}" (${result.targetId}).`
				: `"${name}" (${result.targetId}) had no running turn to interrupt.`;
			const tail = result.followUp
				? ` Correction delivered as urgent guidance (${result.followUp.buffered ? "queued" : "started a new turn"}).`
				: "";
			return {
				output: head + tail,
				metadata: { kind: "narrator_control", action: "interrupt", ...result },
			};
		} catch (error) {
			return {
				output: `NarratorControl error: ${error instanceof Error ? error.message : String(error)}`,
				isError: true,
			};
		}
	},
};
