import { Rpc } from "@opencode/plugin/rpc";
import { z } from "zod";

export const CodexStatusRpc = Rpc.define({
	id: "oc-codex-multi-auth",
	methods: {
		status: {
			input: z.object({ width: z.number().int().min(1).max(1000) }),
			output: z.object({
				text: z.string(), details: z.string(), showFor: z.enum(["always", "codex-models"]),
				accountStorage: z.enum(["project", "global"]),
				// Configured glyph mode, sent unresolved so a remote TUI answers
				// `auto` against ITS environment, not the service's.
				glyphMode: z.enum(["ascii", "unicode", "auto"]).optional(),
				statusColor: z.string().optional(),
				statusTone: z.enum(["normal", "warning", "danger", "stale", "unknown"]).optional(),
				quotaDisplay: z.enum(["free", "used"]).optional(),
				sidebar: z.object({
					enabled: z.boolean(), showQuota: z.boolean(), showResetTimes: z.boolean(), color: z.string(),
					showFiveHour: z.boolean().optional(),
				}).optional(),
				accounts: z.array(z.object({
					index: z.number().int(), label: z.string(), active: z.boolean(), enabled: z.boolean(),
					shortName: z.string().optional(),
					displayName: z.string().optional(),
					// Display-only data: the remote TUI never receives account IDs or credentials.
					quota: z.object({
						limits: z.array(z.object({
							label: z.string(), leftPercent: z.number().nullable(), usedPercent: z.number().optional(),
							windowMinutes: z.number().optional(), resetAtMs: z.number().optional(),
						})),
						fetchedAt: z.number().optional(), stale: z.boolean(), readFailed: z.boolean().optional(),
					}).optional(),
				})),
			}),
		},
	},
	events: {},
});
