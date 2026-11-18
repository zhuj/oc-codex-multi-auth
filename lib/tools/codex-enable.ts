/**
 * `codex-enable` tool — re-enable a disabled Codex account.
 *
 * Headless counterpart of the auth menu's "Enable account" action (#288):
 * clears the plugin's auto-disable attribution note and any auth-failure
 * cooldown inside the storage transaction, then reloads the account manager
 * so rotation sees the change.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool";
import { getWorkspaceIdentityKey, loadAccounts, withAccountStorageTransaction } from "../storage.js";
import { hasAutoDisableNote, stripAutoDisableNote } from "../accounts/state.js";
import { logWarn } from "../logger.js";
import {
	formatUiHeader,
	formatUiItem,
	formatUiKeyValue,
} from "../ui/format.js";
import { rethrowIfRetryable, withToolErrorEnvelope } from "./output.js";
import type { ToolContext } from "./index.js";

export function createCodexEnableTool(ctx: ToolContext): ToolDefinition {
	const {
		resolveUiRuntime,
		promptAccountIndexSelection,
		supportsInteractiveMenus,
		formatCommandAccountLabel,
		resolveMaskEmail,
		withAccountManagerMutation,
		manualAccountOverrideIdentityRef,
	} = ctx;
	const definition = tool({
		description:
			"Re-enable a disabled Codex account by index (1-based) or interactive picker when index is omitted. " +
			"Clears the plugin's auto-disable note and auth-failure cooldown so rotation can use the account again.",
		args: {
			index: tool.schema
				.number()
				.optional()
				.describe(
					"Account number to re-enable (1-based, e.g., 1 for first account)",
				),
		},
		async execute({ index }: { index?: number } = {}) {
			const ui = resolveUiRuntime();
			const maskEmail = resolveMaskEmail();
			// Read-only snapshot for the "no accounts" / picker UX; the mutation
			// below re-reads inside the transaction so a concurrent save can't be
			// clobbered between the two.
			const initialStorage = await loadAccounts();
			if (!initialStorage || initialStorage.accounts.length === 0) {
				if (ui.v2Enabled) {
					return [
						...formatUiHeader(ui, "Enable account"),
						"",
						formatUiItem(ui, "No accounts configured.", "warning"),
					].join("\n");
				}
				return "No Codex accounts configured. Nothing to enable.";
			}

			const disabledIndices = initialStorage.accounts
				.map((account, accountIndex) => (account.enabled === false ? accountIndex : -1))
				.filter((accountIndex) => accountIndex >= 0);
			if (disabledIndices.length === 0) {
				if (ui.v2Enabled) {
					return [
						...formatUiHeader(ui, "Enable account"),
						"",
						formatUiItem(
							ui,
							`No disabled accounts — all ${initialStorage.accounts.length} account(s) are enabled.`,
							"success",
						),
					].join("\n");
				}
				return `No disabled accounts — all ${initialStorage.accounts.length} account(s) are enabled.`;
			}

			let resolvedIndex = index;
			if (resolvedIndex === undefined && disabledIndices.length === 1) {
				// The sole-disabled case is the auto-disable dead end from #288 —
				// `codex-enable` with no index must not stall on a picker there.
				const [onlyDisabled] = disabledIndices;
				if (onlyDisabled !== undefined) resolvedIndex = onlyDisabled + 1;
			}
			if (resolvedIndex === undefined) {
				const selectedIndex = await promptAccountIndexSelection(
					ui,
					initialStorage,
					"Enable account",
				);
				if (selectedIndex === null) {
					const slotList = disabledIndices.map((i) => i + 1).join(", ");
					if (supportsInteractiveMenus()) {
						if (ui.v2Enabled) {
							return [
								...formatUiHeader(ui, "Enable account"),
								"",
								formatUiItem(ui, "No account selected.", "warning"),
								formatUiItem(
									ui,
									`Disabled slots: ${slotList}. Run again and pick one, or pass codex-enable index=<N>.`,
									"muted",
								),
							].join("\n");
						}
						return `No account selected. Disabled slots: ${slotList}.`;
					}
					if (ui.v2Enabled) {
						return [
							...formatUiHeader(ui, "Enable account"),
							"",
							formatUiItem(ui, "Missing account number.", "warning"),
							formatUiItem(ui, `Disabled slots: ${slotList}`, "muted"),
							formatUiItem(ui, "Use: codex-enable index=<N>", "accent"),
						].join("\n");
					}
					return `Missing account number. Disabled slots: ${slotList}. Use: codex-enable index=<N>`;
				}
				resolvedIndex = selectedIndex + 1;
			}

			type EnableOutcome =
				| { kind: "invalid"; accountCount: number }
				| { kind: "not-found" }
				| { kind: "already-enabled"; label: string }
				| { kind: "save-failed"; label: string }
				| { kind: "ok"; label: string; wasAutoDisabled: boolean };

			const outcome = await withAccountManagerMutation(() => withAccountStorageTransaction<EnableOutcome>(
				async (current, persist) => {
					const storage = current;
					const accounts = storage?.accounts ?? [];
					const targetIndex = (resolvedIndex ?? 0) - 1;
					if (
						!Number.isInteger(targetIndex) ||
						targetIndex < 0 ||
						targetIndex >= accounts.length
					) {
						return { kind: "invalid", accountCount: accounts.length };
					}

					const account = accounts[targetIndex];
					if (!account || !storage) {
						return { kind: "not-found" };
					}

					const label = formatCommandAccountLabel(account, targetIndex, {
						maskEmail,
						peerAccounts: accounts,
					});
					if (account.enabled !== false) {
						return { kind: "already-enabled", label };
					}

					const wasAutoDisabled = hasAutoDisableNote(account.accountNote);
					delete account.enabled;
					delete account.userDisabled;
					// The plugin's own attribution goes; operator text around it stays.
					account.accountNote = stripAutoDisableNote(account.accountNote);
					// A leftover auth-failure cooldown would keep the account out of
					// rotation even with enabled restored — re-enable must mean usable.
					if (account.cooldownReason === "auth-failure") {
						delete account.coolingDownUntil;
						delete account.cooldownReason;
					}

					try {
						await persist(storage);
					} catch (saveError) {
						// Lease compromise surfaces through persist() — let it escape
						// so the wrapper reports a retryable contention error.
						rethrowIfRetryable(saveError);
						logWarn("Failed to save account enable", {
							error: String(saveError),
						});
						return { kind: "save-failed", label };
					}
					if (manualAccountOverrideIdentityRef.current === getWorkspaceIdentityKey(account)) {
						manualAccountOverrideIdentityRef.current = null;
					}
					return { kind: "ok", label, wasAutoDisabled };
				},
			), (result) => result.kind === "ok");

			if (outcome.kind === "invalid") {
				if (ui.v2Enabled) {
					return [
						...formatUiHeader(ui, "Enable account"),
						"",
						formatUiItem(
							ui,
							`Invalid account number: ${resolvedIndex}`,
							"danger",
						),
						formatUiKeyValue(
							ui,
							"Valid range",
							`1-${outcome.accountCount}`,
							"muted",
						),
						formatUiItem(ui, "Use codex-list to list all accounts.", "accent"),
					].join("\n");
				}
				return `Invalid account number: ${resolvedIndex}\n\nValid range: 1-${outcome.accountCount}\n\nUse codex-list to list all accounts.`;
			}

			if (outcome.kind === "not-found") {
				return `Account ${resolvedIndex} not found.`;
			}

			if (outcome.kind === "save-failed") {
				if (ui.v2Enabled) {
					return [
						...formatUiHeader(ui, "Enable account"),
						"",
						formatUiItem(
							ui,
							`Failed to enable ${outcome.label}: account storage could not be updated.`,
							"danger",
						),
					].join("\n");
				}
				return `Failed to enable ${outcome.label}: account storage could not be updated.`;
			}

			if (outcome.kind === "already-enabled") {
				if (ui.v2Enabled) {
					return [
						...formatUiHeader(ui, "Enable account"),
						"",
						formatUiItem(ui, `${outcome.label} is already enabled.`, "success"),
					].join("\n");
				}
				return `${outcome.label} is already enabled.`;
			}

			const { label, wasAutoDisabled } = outcome;
			const detail = wasAutoDisabled
				? "Auto-disable note and auth-failure cooldown cleared; the account is back in rotation."
				: "The account is back in rotation.";
			const nextStep = "Validate the retained credential with `codex-health` if requests still fail.";
			if (ui.v2Enabled) {
				return [
					...formatUiHeader(ui, "Enable account"),
					"",
					formatUiItem(ui, `Enabled ${label}.`, "success"),
					formatUiItem(ui, detail, "muted"),
					formatUiItem(ui, nextStep, "muted"),
				].join("\n");
			}
			return [`Enabled ${label}.`, detail, "", nextStep].join("\n");
		},
	});
	return withToolErrorEnvelope("codex-enable", definition);
}
