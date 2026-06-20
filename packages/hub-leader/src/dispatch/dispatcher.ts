import type { HubClient } from "../hub/client"
import type { PlannedTask } from "../dag/types"

export interface DispatchOptions {
  /** Path to opencode binary */
  opencodeBin: string
  /** Working directory for the subagent */
  cwd: string
  /** Model to use for the subagent (opencode model ref, e.g. "anthropic/claude-sonnet-4-20250514") */
  model?: string
  /** Extra context to inject into the subagent system prompt */
  extraContext?: string[]
  /** Dry run: print but don't execute */
  dryRun?: boolean
}

export interface DispatchResult {
  task_id: string
  success: boolean
  output?: string
  error?: string
  duration_ms: number
}

/**
 * Build the context-injected prompt for a subagent worker.
 */
export function buildWorkerPrompt(
  task: PlannedTask,
  playbookSnippets: string[],
  extraContext: string[] = [],
): string {
  const parts: string[] = []

  parts.push(`## Task: ${task.title}`)
  if (task.description) parts.push(`\n${task.description}`)

  if (playbookSnippets.length > 0) {
    parts.push("\n## Injected Skills (from Agent Hub Playbooks)")
    for (const snippet of playbookSnippets) {
      parts.push(`\n${snippet}`)
    }
  }

  if (extraContext.length > 0) {
    parts.push("\n## Additional Context")
    for (const ctx of extraContext) {
      parts.push(`\n${ctx}`)
    }
  }

  parts.push(
    "\n## Completion",
    "When finished, report: 1) what was done, 2) any new patterns discovered (for playbook), 3) any issues encountered.",
  )

  return parts.join("\n")
}

/**
 * Dispatch a single task as an opencode subagent session.
 * Spawns `opencode` with the task prompt as a one-shot message.
 */
export async function dispatchTask(
  hub: HubClient,
  task: PlannedTask,
  playbookSnippets: string[],
  options: DispatchOptions,
): Promise<DispatchResult> {
  const prompt = buildWorkerPrompt(task, playbookSnippets, options.extraContext)
  const start = Date.now()

  if (options.dryRun) {
    console.log(`\n── [DRY RUN] Task ${task.task_id} ──`)
    console.log(`Worker: ${task.assigned_worker ?? "general"}`)
    console.log(`Prompt:\n${prompt.slice(0, 500)}...`)
    return { task_id: task.task_id, success: true, duration_ms: 0 }
  }

  try {
    // Sync task status to hub
    await hub.syncDag({
      task_id: task.task_id,
      title: task.title,
      status: "in_progress",
      assigned_worker: task.assigned_worker,
    })

    // Spawn opencode subprocess
    const proc = Bun.spawn({
      cmd: [
        options.opencodeBin,
        "--cwd", options.cwd,
        "--message", prompt,
        "--json",
        ...(options.model ? ["--model", options.model] : []),
      ],
      stdout: "pipe",
      stderr: "pipe",
    })

    const output = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    await proc.exited

    const duration_ms = Date.now() - start

    if (proc.exitCode !== 0) {
      await hub.syncDag({
        task_id: task.task_id,
        title: task.title,
        status: "blocked",
        assigned_worker: task.assigned_worker,
      })
      return {
        task_id: task.task_id,
        success: false,
        error: stderr || `exit code ${proc.exitCode}`,
        duration_ms,
      }
    }

    // Mark completed
    await hub.syncDag({
      task_id: task.task_id,
      title: task.title,
      status: "completed",
      assigned_worker: task.assigned_worker,
    })

    await hub.appendEvent(
      task.assigned_worker ?? "leader",
      "task_completed",
      { task_id: task.task_id, title: task.title },
    )

    return { task_id: task.task_id, success: true, output, duration_ms }
  } catch (err: unknown) {
    const duration_ms = Date.now() - start
    const message = err instanceof Error ? err.message : String(err)
    return { task_id: task.task_id, success: false, error: message, duration_ms }
  }
}

/**
 * Topological dispatch: execute tasks respecting dependencies.
 *
 * Simple implementation: wave-by-wave. Tasks with no pending deps run
 * concurrently in each wave.
 */
export async function dispatchDag(
  hub: HubClient,
  tasks: PlannedTask[],
  playbookIndex: Map<string, string[]>, // task_id → playbook snippets
  options: DispatchOptions,
): Promise<DispatchResult[]> {
  const results: DispatchResult[] = []
  const completed = new Set<string>()
  const remaining = new Map(tasks.map((t) => [t.task_id, t]))

  while (remaining.size > 0) {
    // Find tasks whose dependencies are all satisfied
    const ready: PlannedTask[] = []
    for (const [id, task] of remaining) {
      const deps = task.dependencies ?? []
      if (deps.every((d) => completed.has(d))) {
        ready.push(task)
      }
    }

    if (ready.length === 0) {
      // Circular dependency or all remaining are blocked
      console.error("Deadlock detected — remaining tasks have unresolved dependencies:", [...remaining.keys()])
      break
    }

    console.log(`\n⚡ Wave: dispatching ${ready.length} task(s) — [${ready.map((t) => t.task_id).join(", ")}]`)

    // Dispatch wave concurrently
    const waveResults = await Promise.all(
      ready.map((task) =>
        dispatchTask(hub, task, playbookIndex.get(task.task_id) ?? [], options),
      ),
    )

    for (const r of waveResults) {
      results.push(r)
      if (r.success) completed.add(r.task_id)
      remaining.delete(r.task_id)
    }
  }

  return results
}
