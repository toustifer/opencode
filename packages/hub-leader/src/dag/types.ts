import { z } from "zod"

/**
 * A planned task with optional context injection.
 * This is what the LLM planner generates.
 */
export const PlannedTaskSchema = z.object({
  task_id: z.string().describe("Unique task ID, e.g. T1, T2, T3"),
  title: z.string().describe("One-line task description"),
  description: z.string().optional().describe("Detailed task specification for the worker"),
  assigned_worker: z
    .string()
    .optional()
    .describe("Worker ID to assign to. Use 'general' when uncertain."),
  dependencies: z.array(z.string()).optional().describe("Task IDs this depends on"),
  required_skills: z
    .array(z.string())
    .optional()
    .describe("Skill/Playbook tags to inject into the worker context"),
  estimated_complexity: z
    .enum(["low", "medium", "high"])
    .optional()
    .describe("Complexity estimate"),
})
export type PlannedTask = z.infer<typeof PlannedTaskSchema>

/**
 * The full DAG plan output from the LLM.
 */
export const DagPlanSchema = z.object({
  goal: z.string().describe("Restated goal"),
  analysis: z.string().describe("Brief analysis of approach"),
  tasks: z.array(PlannedTaskSchema).describe("Ordered task list with dependencies"),
  critical_path: z.array(z.string()).optional().describe("Task IDs on the critical path"),
  risks: z.array(z.string()).optional().describe("Identified risks"),
})
export type DagPlan = z.infer<typeof DagPlanSchema>

/**
 * Hub context bundled for planning injection.
 */
export interface PlanningContext {
  goal: string
  business_code: string
  available_workers: Array<{
    worker_id: string
    status: string
    handbook_snippet?: string
  }>
  relevant_playbooks: Array<{
    category: string
    title: string
    content_snippet: string // truncated to avoid blowing context
    tags: string[]
  }>
  recent_events: Array<{
    event_type: string
    actor: string
    payload_snippet?: string
  }>
}
