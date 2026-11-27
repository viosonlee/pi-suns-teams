/**
 * team-doctor.ts — Proactive health diagnostics & safe auto-remediation for pi-teams.
 *
 * Scans active team state, worktrees, child sessions, and model configurations so
 * friction points (sentinel "inherit" models, expired quota locks, stuck INCOMPLETE
 * review loops, orphan W-rev-* slots, reclaimable worktrees, and JSONL bloat) are
 * detected and resolved before impacting the user's normal workflow.
 */

import { statSync } from "node:fs";
import { pruneStaleReviews, terminalWork, type WorkLedger, type WorkTask } from "./team-ledger.ts";
import { sanitizeModelOverride } from "./team-runner.ts";
import { auditWorktrees, type WorktreeAuditReport } from "./team-worktree.ts";
import type { ChildGcResult } from "./team-gc.ts";

export interface TeamDoctorFinding {
	code: string;
	severity: "info" | "warn" | "error";
	autoFixable: boolean;
	summary: string;
	fixHint: string;
}

export interface TeamDoctorInput {
	enabled: boolean;
	cwd: string;
	ledger?: WorkLedger;
	roles: Record<string, { model?: string; thinking?: string }>;
	fallbacks?: Partial<Record<string, string[]>>;
	roleModel?: Record<string, string>;
	roleThinking?: Record<string, string>;
	unavailable?: Partial<Record<string, string>>;
	unavailableAt?: Partial<Record<string, number>>;
	unavailableModel?: Partial<Record<string, string>>;
	unavailableCooldownMs?: number;
	availableModelRefs?: ReadonlySet<string>;
	worktreeAudit?: WorktreeAuditReport | null;
	childGcPreview?: ChildGcResult | null;
	parentSessionFile?: string;
	parentSessionMaxWarnBytes?: number;
	staleRunningMs?: number;
	nowMs?: number;
}

export interface TeamDoctorReport {
	healthy: boolean;
	findings: TeamDoctorFinding[];
	stats: {
		openTasks: number;
		blockedTasks: number;
		uncertainTasks: number;
		failedTasks: number;
		prunableReviews: number;
		reclaimableWorktrees: number;
		reclaimableChildSessions: number;
		parentSessionBytes: number;
	};
}

const SENTINEL_VALUES = new Set(["inherit", "default", "auto", "none", "unset", "null", "undefined"]);
function isSentinelOrBlank(val: unknown): boolean {
	if (typeof val !== "string") return false;
	const trimmed = val.trim().toLowerCase();
	return trimmed.length === 0 || SENTINEL_VALUES.has(trimmed);
}

export function diagnoseTeamHealth(input: TeamDoctorInput): TeamDoctorReport {
	const now = input.nowMs ?? Date.now();
	const findings: TeamDoctorFinding[] = [];
	const tasks: WorkTask[] = input.ledger?.tasks ?? [];
	const openTasks = tasks.filter(t => !terminalWork(t.status));
	const blockedTasks = openTasks.filter(t => t.status === "blocked");
	const uncertainTasks = openTasks.filter(t => t.status === "uncertain");
	const failedTasks = openTasks.filter(t => t.status === "failed");

	// 1. Sentinel / blank model or thinking overrides that crash host/CLI runners
	const badModelRoles: string[] = [];
	for (const role of Object.keys(input.roles)) {
		const stickyModel = input.roleModel?.[role];
		const cfgModel = input.roles[role]?.model;
		const stickyThinking = input.roleThinking?.[role];
		const cfgThinking = input.roles[role]?.thinking;
		if ((stickyModel !== undefined && isSentinelOrBlank(stickyModel))
			|| (cfgModel !== undefined && isSentinelOrBlank(cfgModel))
			|| (stickyThinking !== undefined && isSentinelOrBlank(stickyThinking))
			|| (cfgThinking !== undefined && isSentinelOrBlank(cfgThinking))) {
			badModelRoles.push(role);
		}
	}
	if (badModelRoles.length > 0) {
		findings.push({
			code: "sentinel_model_override",
			severity: "error",
			autoFixable: true,
			summary: `检测到无效/占位模型配置（如 inherit / 空字符串）：${badModelRoles.join(", ")}`,
			fixHint: "运行 /team doctor --fix（或自动清理）移除占位值以继承主会话有效模型。",
		});
	}

	// 2. Configured models & fallbacks missing from available model catalog
	if (input.availableModelRefs && input.availableModelRefs.size > 0) {
		const unknownRoles: string[] = [];
		for (const role of Object.keys(input.roles)) {
			const effective = sanitizeModelOverride(input.roleModel?.[role]) ?? sanitizeModelOverride(input.roles[role]?.model);
			if (effective && !input.availableModelRefs.has(effective)) {
				unknownRoles.push(`${role}=${effective}`);
			}
			for (const fb of input.fallbacks?.[role] ?? []) {
				const cleanFb = sanitizeModelOverride(fb);
				if (cleanFb && !input.availableModelRefs.has(cleanFb)) {
					unknownRoles.push(`${role}.fallback=${cleanFb}`);
				}
			}
		}
		if (unknownRoles.length > 0) {
			findings.push({
				code: "unknown_configured_model",
				severity: "warn",
				autoFixable: false,
				summary: `以下角色/备用链配置了当前不可用的模型：${unknownRoles.join(", ")}`,
				fixHint: "使用 /team model <角色> <可用模型> 切换，或更新 team.json 中不可用的备用模型 ID。",
			});
		}
	}

	// 3. Quota pause locks (expired vs active blocking ready work)
	const cooldownMs = input.unavailableCooldownMs ?? 10 * 60_000;
	const expiredQuotaRoles: string[] = [];
	const activeQuotaRoles: string[] = [];
	for (const [role, reason] of Object.entries(input.unavailable ?? {})) {
		if (!reason) continue;
		const pausedAt = input.unavailableAt?.[role];
		const pausedModel = input.unavailableModel?.[role];
		const currentModel = sanitizeModelOverride(input.roleModel?.[role]) ?? sanitizeModelOverride(input.roles[role]?.model);
		const modelChanged = Boolean(pausedModel && currentModel && currentModel !== pausedModel);
		const expiredByCooldown = typeof pausedAt === "number" && Number.isFinite(pausedAt) && (now - pausedAt) >= cooldownMs;
		if (modelChanged || expiredByCooldown) {
			expiredQuotaRoles.push(role);
		} else {
			activeQuotaRoles.push(role);
		}
	}
	if (expiredQuotaRoles.length > 0) {
		findings.push({
			code: "expired_quota_lock",
			severity: "warn",
			autoFixable: true,
			summary: `以下角色的限流冷静期已结束但暂停锁仍在：${expiredQuotaRoles.join(", ")}`,
			fixHint: "运行 /team doctor --fix 或 /team unpause 立即解锁恢复调度。",
		});
	}
	if (activeQuotaRoles.length > 0) {
		findings.push({
			code: "active_quota_lock",
			severity: "warn",
			autoFixable: false,
			summary: `当前仍处于限流暂停状态的角色：${activeQuotaRoles.join(", ")}`,
			fixHint: "可用 /team model <角色> <新模型> 换用可用模型并自动解锁，或 /team unpause 强制解锁。",
		});
	}

	// 4. Prunable / stale / duplicate W-rev-* slots
	let prunableReviews = 0;
	if (input.ledger && tasks.length > 0) {
		const probeLedger = structuredClone(input.ledger);
		const prunePreview = pruneStaleReviews(probeLedger, { dryRun: true });
		prunableReviews = prunePreview.pruned.length + prunePreview.migratedToCp.length;
		if (prunableReviews > 0) {
			findings.push({
				code: "prunable_stale_reviews",
				severity: "warn",
				autoFixable: true,
				summary: `账本中有 ${prunePreview.pruned.length} 条可清理的失效审查任务、${prunePreview.migratedToCp.length} 条旧角色待迁移至 cp`,
				fixHint: "运行 /team doctor --fix 或 /team prune-reviews 自动清理。",
			});
		}
	}

	// 5. Blocked / uncertain / failed tasks & stalled INCOMPLETE review holds
	if (blockedTasks.length > 0 || uncertainTasks.length > 0 || failedTasks.length > 0) {
		const sample = [...blockedTasks, ...uncertainTasks, ...failedTasks]
			.slice(0, 5)
			.map(t => `${t.id}[${t.status}]`)
			.join(", ");
		findings.push({
			code: "stalled_open_tasks",
			severity: "warn",
			autoFixable: false,
			summary: `存在阻塞/异常开放任务（blocked=${blockedTasks.length}, uncertain=${uncertainTasks.length}, failed=${failedTasks.length}）：${sample}`,
			fixHint: "对 blocked/failed 任务用 team_tasks update 恢复或关闭；对 uncertain 任务用 /team reconcile 或 get_subagent_result 对账。",
		});
	}

	// 6. Long-silent running tasks (e.g. host crashed before timeout cleanup)
	const staleThreshold = input.staleRunningMs ?? 45 * 60_000;
	const longRunning = openTasks.filter(t => {
		if (t.status !== "running" || !t.dispatchedAt) return false;
		const ms = Date.parse(t.dispatchedAt);
		return Number.isFinite(ms) && (now - ms) >= staleThreshold;
	});
	if (longRunning.length > 0) {
		findings.push({
			code: "long_running_children",
			severity: "info",
			autoFixable: false,
			summary: `${longRunning.length} 个 running 任务已持续超过 ${Math.round(staleThreshold / 60_000)} 分钟：${longRunning.slice(0, 4).map(t => t.id).join(", ")}`,
			fixHint: "运行 /team reconcile 检查对应子会话是否已完成或中断。",
		});
	}

	// 7. Secondary git worktrees safely reclaimable
	const wtAudit = input.worktreeAudit !== undefined
		? input.worktreeAudit
		: (input.cwd ? auditWorktrees(input.cwd, { tasks, nowMs: now }) : null);
	const reclaimableWtCount = wtAudit
		? wtAudit.reclaimableMerged.length + wtAudit.reclaimableSuperseded.length + wtAudit.prunableMissing.length
		: 0;
	if (reclaimableWtCount > 0 && wtAudit) {
		const reclaimBytes = [...wtAudit.reclaimableMerged, ...wtAudit.reclaimableSuperseded]
			.reduce((sum, item) => sum + item.bytes, 0);
		const mb = (reclaimBytes / (1024 * 1024)).toFixed(1);
		findings.push({
			code: "reclaimable_worktrees",
			severity: reclaimableWtCount >= 3 || reclaimBytes >= 500 * 1024 * 1024 ? "warn" : "info",
			autoFixable: true,
			summary: `发现 ${reclaimableWtCount} 个可安全回收的 worktree/残留元数据（已合并=${wtAudit.reclaimableMerged.length}，已替代=${wtAudit.reclaimableSuperseded.length}，失效元数据=${wtAudit.prunableMissing.length}，约 ${mb} MB）`,
			fixHint: "运行 /team doctor --fix 或 /team gc --worktrees 安全回收（自动保留未合并/脏工作区）。",
		});
	}

	// 8. Child session JSONL & orphan sidecar accumulation
	const childGcCount = input.childGcPreview
		? input.childGcPreview.archived.length + input.childGcPreview.orphanSidecarsRemoved
		: 0;
	if (childGcCount > 0 && input.childGcPreview) {
		const mb = (input.childGcPreview.totalBytesFreed / (1024 * 1024)).toFixed(1);
		findings.push({
			code: "reclaimable_child_sessions",
			severity: input.childGcPreview.totalBytesFreed >= 100 * 1024 * 1024 ? "warn" : "info",
			autoFixable: true,
			summary: `发现 ${input.childGcPreview.archived.length} 个可归档历史子会话与 ${input.childGcPreview.orphanSidecarsRemoved} 个孤立 sidecar（约 ${mb} MB）`,
			fixHint: "运行 /team doctor --fix 或 /team gc 归档清理（--all 可连同历史父会话一并清理）。",
		});
	}

	// 9. Parent session JSONL file bloat
	let parentSessionBytes = 0;
	if (input.parentSessionFile) {
		try {
			parentSessionBytes = statSync(input.parentSessionFile).size;
		} catch {
			parentSessionBytes = 0;
		}
	}
	const maxWarnBytes = input.parentSessionMaxWarnBytes ?? 15 * 1024 * 1024;
	if (parentSessionBytes >= maxWarnBytes) {
		const mb = (parentSessionBytes / (1024 * 1024)).toFixed(1);
		findings.push({
			code: "parent_session_bloat",
			severity: "warn",
			autoFixable: false,
			summary: `当前父会话 JSONL 体积较大（${mb} MB >= ${(maxWarnBytes / (1024 * 1024)).toFixed(0)} MB），可能导致上下文压缩缓慢`,
			fixHint: "建议当前阶段收尾后使用 /compact 或开启新会话承接后续需求。",
		});
	}

	return {
		healthy: !findings.some(f => f.severity === "error" || f.severity === "warn"),
		findings,
		stats: {
			openTasks: openTasks.length,
			blockedTasks: blockedTasks.length,
			uncertainTasks: uncertainTasks.length,
			failedTasks: failedTasks.length,
			prunableReviews,
			reclaimableWorktrees: reclaimableWtCount,
			reclaimableChildSessions: childGcCount,
			parentSessionBytes,
		},
	};
}

export function formatDoctorReport(report: TeamDoctorReport, appliedFixes: string[] = []): string {
	const icon = (sev: TeamDoctorFinding["severity"]) => (sev === "error" ? "❌" : sev === "warn" ? "⚠️" : "ℹ️");
	const mb = (report.stats.parentSessionBytes / (1024 * 1024)).toFixed(2);
	const lines: string[] = [
		report.healthy
			? "🩺 Team Doctor：未发现阻塞或告警级问题"
			: `🩺 Team Doctor：发现 ${report.findings.length} 项待关注健康状态`,
		`统计：开放任务=${report.stats.openTasks}（blocked=${report.stats.blockedTasks}, uncertain=${report.stats.uncertainTasks}, failed=${report.stats.failedTasks}） | 可清旧审查=${report.stats.prunableReviews} | 可收worktree=${report.stats.reclaimableWorktrees} | 可清子会话=${report.stats.reclaimableChildSessions} | 会话JSONL=${mb} MB`,
	];
	if (appliedFixes.length > 0) {
		lines.push("", "已自动安全修复：");
		for (const fix of appliedFixes) lines.push(`• ✓ ${fix}`);
	}
	if (report.findings.length > 0) {
		lines.push("");
		for (const f of report.findings) {
			lines.push(`${icon(f.severity)} [${f.code}] ${f.summary}`);
			lines.push(`  建议：${f.fixHint}`);
		}
	}
	if (report.findings.some(f => f.autoFixable)) {
		lines.push("", "提示：运行 `/team doctor --fix` 可一键执行全部无损自动修复。");
	}
	return lines.join("\n");
}
