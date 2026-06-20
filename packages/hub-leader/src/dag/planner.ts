import { generateText, type LanguageModel } from "ai"
import { type PlanningContext, type DagPlan } from "./types"

const PLANNER_SYSTEM_PROMPT = `You are a DAG Planner — a strategic task decomposition agent for the Agent Hub system. You receive a user goal and produce a structured execution plan as a JSON object.

## Planning Rules
1. Decompose the goal into 2-6 concrete, atomic tasks
2. Assign workers based on domain match, or "general" when uncertain
3. Identify dependencies between tasks
4. Keep the DAG as parallel as possible
5. Identify critical path and risks

## Output Format — return ONLY valid JSON, no markdown, no code fences:
{
  "goal": "restate the goal",
  "analysis": "2-3 sentence approach summary",
  "tasks": [
    {
      "task_id": "1",
      "title": "short title",
      "description": "what to do",
      "assigned_worker": "general",
      "dependencies": [],
      "required_skills": [],
      "estimated_complexity": "medium"
    }
  ],
  "critical_path": ["1", "2"],
  "risks": ["risk 1"]
}`

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
  const result = await generateText({
    model,
    system: PLANNER_SYSTEM_PROMPT,
    prompt,
    temperature: 0.3,
  })
  // Parse JSON from text response (handle both plain JSON and code-fenced JSON)
  const text = result.text.trim()
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    throw new Error("No JSON object found in planner response")
  }
  const plan = JSON.parse(jsonMatch[0]) as DagPlan
  return { plan, prompt }
}
