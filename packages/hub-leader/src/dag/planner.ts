import { generateObject, type LanguageModel } from "ai"
import { DagPlanSchema, type PlanningContext, type DagPlan } from "./types"

const PLANNER_SYSTEM_PROMPT = `You are a DAG Planner — a strategic task decomposition agent for the Agent Hub system.

## Your Role
You receive a user goal and context from the Agent Hub (available workers, playbooks, recent events). You produce a structured execution plan: a directed acyclic graph (DAG) of tasks with dependencies.

## Hub Context Types
- **Workers**: Persistent domain agents. Each has a worker_id, status, and handbook (experience). Use the right worker for each task.
- **Playbooks**: Reusable skill patterns (like code snippets for agents). Tag them for injection into worker context.
- **Events**: Recent activity. Use to avoid re-doing completed work.

## Planning Rules
1. **Decompose the goal** into concrete, atomic tasks. Each task should be completable by a single worker in one session.
2. **Assign workers** based on domain match between task scope and worker handbook. When uncertain, assign to "general".
3. **Identify dependencies**: what must complete before what. Keep the DAG as parallel as possible.
4. **Tag required skills**: for each task, pick playbook tags that the worker should have in context.
5. **Max 8 tasks** per plan. If the goal is larger, group sub-tasks.
6. **Critical path**: identify the longest dependency chain.

## Output Format
Strict JSON matching the DagPlan schema:
- goal: restate the goal clearly
- analysis: 2-3 sentence approach summary
- tasks: ordered array with task_id, title, description, assigned_worker, dependencies, required_skills, estimated_complexity
- critical_path: task_ids on the longest chain
- risks: any foreseen issues`

export function buildPlanningPrompt(ctx: PlanningContext): string {
  const workerList = ctx.available_workers
    .map((w) => `- **${w.worker_id}** (${w.status})${w.handbook_snippet ? `: ${w.handbook_snippet.slice(0, 200)}` : ""}`)
    .join("\n")

  const playbookList = ctx.relevant_playbooks.length
    ? ctx.relevant_playbooks
        .map((p) => `- [${p.category}] ${p.title} (tags: ${p.tags.join(", ")}) — ${p.content_snippet.slice(0, 300)}`)
        .join("\n")
    : "(no relevant playbooks found)"

  const eventList = ctx.recent_events.length
    ? ctx.recent_events.map((e) => `- ${e.event_type} by ${e.actor}`).join("\n")
    : "(no recent events)"

  return `## Goal
${ctx.goal}

## Business
${ctx.business_code}

## Available Workers
${workerList}

## Relevant Playbooks (skills to inject)
${playbookList}

## Recent Events
${eventList}

Decompose the goal into a DAG of atomic tasks. Assign the right worker to each task. Tag required playbooks.`
}

export async function planDag(
  model: LanguageModel,
  ctx: PlanningContext,
): Promise<{ plan: DagPlan; prompt: string }> {
  const prompt = buildPlanningPrompt(ctx)
  const result = await generateObject({
    model,
    schema: DagPlanSchema,
    system: PLANNER_SYSTEM_PROMPT,
    prompt,
    temperature: 0.3,
  })
  return { plan: result.object as DagPlan, prompt }
}
