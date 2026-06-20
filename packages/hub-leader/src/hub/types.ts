import { z } from "zod"

// ── Business ──
export const BusinessSchema = z.object({
  id: z.number(),
  code: z.string(),
  name: z.string(),
  repo_url: z.string().nullish(),
  description: z.string().nullish(),
  status: z.string(),
})
export type Business = z.infer<typeof BusinessSchema>

// ── Worker ──
export const WorkerSchema = z.object({
  id: z.number().optional(),
  worker_id: z.string(),
  version: z.string().nullish(),
  status: z.string(),
  host: z.string().nullish(),
  pid: z.number().nullish(),
  last_heartbeat_at: z.string().nullish(),
  handbook: z.record(z.string(), z.unknown()).nullish(),
})
export type HubWorker = z.infer<typeof WorkerSchema>

// ── Playbook ──
export const PlaybookSchema = z.object({
  id: z.number().optional(),
  category: z.string(),
  title: z.string(),
  content: z.string(),
  tags: z.array(z.string()).optional(),
  tsv: z.string().nullish(),
  created_by_worker_id: z.string().nullish(),
})
export type Playbook = z.infer<typeof PlaybookSchema>

// ── Lock ──
export const LockSchema = z.object({
  id: z.number().optional(),
  resource_key: z.string(),
  holder_worker_id: z.string(),
  holder_token: z.string().optional(),
  expires_at: z.string().optional(),
})
export type Lock = z.infer<typeof LockSchema>

// ── Event ──
export const HubEventSchema = z.object({
  id: z.number().optional(),
  actor: z.string(),
  event_type: z.string(),
  payload: z.record(z.string(), z.unknown()).optional(),
  created_at: z.string().optional(),
})
export type HubEvent = z.infer<typeof HubEventSchema>

// ── DAG Task ──
export const DagTaskSchema = z.object({
  task_id: z.string(),
  title: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "blocked"]),
  assigned_worker: z.string().optional(),
  dependencies: z.array(z.string()).optional(),
  context_snippets: z.array(z.string()).optional(),
})
export type DagTask = z.infer<typeof DagTaskSchema>

// ── Hub Config ──
export const HubConfigSchema = z.object({
  base_url: z.string().default("https://hub.stifer.xyz"),
  business_code: z.string(),
  api_key: z.string().optional(),
  token: z.string().optional(),
})
export type HubConfig = z.infer<typeof HubConfigSchema>
