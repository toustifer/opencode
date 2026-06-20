/**
 * hub-leader — Agent Hub Leader
 *
 * Takes a goal, fetches context from agent-hub, plans a DAG,
 * dispatches workers (as opencode subagents), and syncs results back.
 *
 * Usage (CLI):
 *   bun run src/index.ts --goal "Add login" --business my-project
 *
 * Usage (library):
 *   import { runGoal } from "@opencode-ai/hub-leader"
 *   await runGoal({ goal: "Add login", business: "my-project" })
 */

import { HubClient, type HubConfig } from "./hub"
import { planDag } from "./dag/planner"
import { dispatchDag } from "./dispatch/dispatcher"
import type { DagTask } from "./hub/types"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"

// ── Public API ──

export interface RunGoalOpts {
  goal: string
  business: string
  baseUrl?: string
  opencodeBin?: string
  cwd?: string
  model?: string
  dryRun?: boolean
  apiKey?: string
  token?: string
  /** Called before dispatch for user review. Return false to abort. */
  onPlan?: (plan: { tasks: Array<{ task_id: string; title: string; assigned_worker?: string; dependencies?: string[] }>; goal: string; analysis?: string }) => Promise<boolean> | boolean
  /** Called after dispatch completes */
  onComplete?: (results: Array<{ task_id: string; success: boolean; duration_ms: number; error?: string }>) => void | Promise<void>
}

export async function runGoal(opts: RunGoalOpts): Promise<void> {
  // 1. Connect to agent-hub
  const config: HubConfig = {
    base_url: opts.baseUrl ?? "https://hub.stifer.xyz",
    business_code: opts.business,
    api_key: opts.apiKey ?? undefined,
    token: opts.token,
  }
  const hub = new HubClient(config)

  // Try OAuth device flow if no token provided
  if (!opts.dryRun && !opts.token) {
    try {
      const { verification_url, code } = await hub.loginStep1()
      console.log(`\n${"=".repeat(60)}`)
      console.log(`🔐 Open this URL in your browser and click Approve:`)
      console.log(`   ${verification_url}`)
      console.log(`   Code: ${code}`)
      console.log(`   Waiting up to 5 minutes for approval...`)
      console.log(`${"=".repeat(60)}\n`)

      await pollForToken(hub, code, 300_000)
      console.log("✅ Hub OAuth authenticated!\n")
    } catch (err) {
      console.log("⚠️  Hub OAuth skipped:", (err as Error).message)
    }
  }

  // 2. Fetch context from hub
  console.log("📡 Fetching context from Agent Hub...")
  const ctx = await hub.fetchContext(opts.goal)

  console.log(`   Playbooks found: ${ctx.playbooks.length}`)
  const onlineCount = ctx.workers.filter((w) => w.status === "online").length
  console.log(`   Workers online:  ${onlineCount}/${ctx.workers.length}`)

  // 3. Plan DAG with LLM
  console.log("\n🧠 Planning DAG...")
  const compatible = createOpenAICompatible({
    name: "deepseek",
    apiKey: process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || process.env.LLM_API_KEY,
    baseURL: process.env.LLM_BASE_URL || "https://api.deepseek.com/v1",
  })
  const modelName = (opts.model ?? "deepseek-chat").replace(/^deepseek\//, "")
  const model = compatible.chatModel(modelName)

  const { plan } = await planDag(model, {
    goal: opts.goal,
    business_code: opts.business,
    available_workers: ctx.workers.map((w) => ({
      worker_id: w.worker_id,
      status: w.status,
      handbook_snippet: w.handbook ? JSON.stringify(w.handbook).slice(0, 200) : undefined,
    })),
    relevant_playbooks: ctx.playbooks.map((p) => ({
      category: p.category,
      title: p.title,
      content_snippet: p.content.slice(0, 300),
      tags: p.tags ?? [],
    })),
    recent_events: ctx.events.map((e) => ({
      event_type: e.event_type,
      actor: e.actor,
      payload_snippet: e.payload ? JSON.stringify(e.payload).slice(0, 200) : undefined,
    })),
  })

  // 4. Show plan
  console.log(`\n📋 Plan: ${plan.goal}`)
  console.log(`   Analysis: ${plan.analysis}`)
  console.log(`   Tasks: ${plan.tasks.length}`)
  if (plan.critical_path?.length) {
    console.log(`   Critical Path: ${plan.critical_path.join(" → ")}`)
  }
  if (plan.risks?.length) {
    console.log("   Risks:")
    for (const r of plan.risks) console.log(`     ⚠️  ${r}`)
  }

  console.log("\n── Tasks ──")
  for (const t of plan.tasks) {
    const deps = t.dependencies?.length ? ` (depends: ${t.dependencies.join(", ")})` : ""
    const skills = t.required_skills?.length ? ` [skills: ${t.required_skills.join(", ")}]` : ""
    console.log(`  ${t.task_id}: ${t.title} → ${t.assigned_worker ?? "general"}${deps}${skills}`)
  }

  // 5. User review hook
  if (opts.onPlan) {
    const ok = await opts.onPlan(plan)
    if (!ok) {
      console.log("\n⏹  Goal cancelled by user.")
      return
    }
  }

  // 6. Sync plan to hub
  if (!opts.dryRun) {
    console.log("\n📤 Syncing DAG to hub...")
    const dagTasks: DagTask[] = plan.tasks.map((t) => ({
      task_id: t.task_id,
      title: t.title,
      status: "pending" as const,
      assigned_worker: t.assigned_worker,
      dependencies: t.dependencies,
    }))
    try {
      await hub.syncDagBatch(dagTasks)
      console.log("   ✅ DAG synced to dashboard")
    } catch (e) {
      console.log("   ⚠️  Hub sync skipped:", (e as Error).message)
    }
  }

  // 7. Build playbook index
  const playbookIndex = new Map<string, string[]>()
  for (const t of plan.tasks) {
    if (t.required_skills?.length) {
      const snippets: string[] = []
      for (const skill of t.required_skills) {
        const match = ctx.playbooks.find(
          (p) => p.tags?.includes(skill) || p.category === skill || p.title.includes(skill),
        )
        if (match) snippets.push(`[Playbook: ${match.title}]\n${match.content.slice(0, 1000)}`)
      }
      playbookIndex.set(t.task_id, snippets)
    }
  }

  // 8. Dispatch
  console.log("\n🚀 Dispatching workers...")
  const results = await dispatchDag(hub, plan.tasks, playbookIndex, {
    opencodeBin: opts.opencodeBin,
    cwd: opts.cwd,
    model: opts.model,
    dryRun: opts.dryRun,
  })

  // 9. Summary
  console.log("\n── Results ──")
  const succeeded = results.filter((r) => r.success).length
  const failed = results.filter((r) => !r.success).length
  console.log(`  ✅ ${succeeded} succeeded`)
  if (failed) console.log(`  ❌ ${failed} failed`)

  for (const r of results) {
    const icon = r.success ? "✅" : "❌"
    const time = `${(r.duration_ms / 1000).toFixed(1)}s`
    console.log(`  ${icon} ${r.task_id}: ${time}`)
    if (r.error) console.log(`     Error: ${r.error.slice(0, 200)}`)
  }

  // 10. Append completion event
  try {
    await hub.appendEvent("leader", "plan_completed", {
      goal: opts.goal,
      total: results.length,
      succeeded,
      failed,
    })
  } catch {
    // best-effort
  }

  if (opts.onComplete) await opts.onComplete(results)

  console.log("\n🏁 Done. Dashboard: https://hub.stifer.xyz")
}

// ── CLI entry point ──

interface CliOpts {
  goal: string
  business: string
  baseUrl: string
  opencodeBin: string
  cwd: string
  model?: string
  dryRun: boolean
  apiKey?: string
  token?: string
}

function parseArgs(): CliOpts {
  const args = process.argv.slice(2)
  const flags: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2)
      const val = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "true"
      flags[key] = val
    }
  }

  if (!flags.goal) {
    console.error("Usage: hub-leader --goal <goal> --business <code> [--dry-run] [--token <hub-jwt>]")
    process.exit(1)
  }

  return {
    goal: flags.goal,
    business: flags.business ?? "ai-medbox",
    baseUrl: flags["base-url"] ?? "https://hub.stifer.xyz",
    opencodeBin: flags["opencode-bin"] ?? "opencode",
    cwd: flags.cwd ?? process.cwd(),
    model: flags.model,
    dryRun: flags["dry-run"] === "true",
    apiKey: flags["api-key"],
    token: flags.token || process.env.HUB_TOKEN,
  }
}

async function main(): Promise<void> {
  const opts = parseArgs()

  console.log("🚀 hub-leader starting...")
  console.log(`   Goal:     ${opts.goal}`)
  console.log(`   Business: ${opts.business}`)
  console.log(`   Hub:      ${opts.baseUrl}`)
  if (opts.dryRun) console.log("   🔍 DRY RUN MODE — no subagents will be spawned\n")

  await runGoal(opts)
}

// ── Helpers ──

async function pollForToken(hub: HubClient, code: string, timeoutMs = 120_000): Promise<string> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    await sleep(2000)
    try {
      return await hub.loginStep2(code)
    } catch {
      // not yet approved, keep polling
    }
  }
  throw new Error("Authentication timed out")
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── Run ──

main().catch((err) => {
  console.error("Fatal:", err)
  process.exit(1)
})

// ── Re-exports ──

export { HubClient } from "./hub/client"
export { planDag } from "./dag/planner"
export { dispatchDag, dispatchTask } from "./dispatch/dispatcher"
export * from "./hub/types"
export * from "./dag/types"
