import type { HubConfig, Business, HubWorker, Playbook, Lock, HubEvent, DagTask } from "./types"

/**
 * HTTP client for the agent-hub REST API.
 * Mirrors hub_client.py in TypeScript.
 */
export class HubClient {
  private base: string
  private apiKey: string
  private businessCode: string
  private token: string
  private oauthToken: string | null = null

  constructor(config: HubConfig) {
    this.base = config.base_url.replace(/\/$/, "")
    this.apiKey = config.api_key ?? ""
    this.businessCode = config.business_code
    this.token = config.token ?? ""
  }

  // ── Internal ──

  private authHeaders(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" }
    if (this.oauthToken) h["Authorization"] = `Bearer ${this.oauthToken}`
    else if (this.token) h["Authorization"] = `Bearer ${this.token}`
    if (this.apiKey) h["X-API-Key"] = this.apiKey
    h["X-Business-Code"] = this.businessCode
    return h
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.base}${path}`
    const opts: RequestInit = {
      method,
      headers: this.authHeaders(),
    }
    if (body !== undefined) opts.body = JSON.stringify(body)

    const res = await fetch(url, opts)
    const text = await res.text()
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { parsed = { message: text } }

    if (!res.ok) {
      const err = parsed as Record<string, unknown>
      if (res.status === 409) {
        throw Object.assign(new Error(err.message as string ?? "Lock conflict"), {
          code: 409,
          resource_key: (body as Record<string, unknown>)?.resource_key,
          holder_worker_id: (err.data as Record<string, unknown>)?.holder_worker_id,
        })
      }
      throw new Error(`[${res.status}] ${err.message ?? text}`)
    }

    // agent-hub wraps responses in { data: ... }
    return ((parsed as Record<string, unknown>)?.data ?? parsed) as T
  }

  // ── Auth ──

  async register(email: string, password: string): Promise<{ token: string; user_id: number }> {
    const res = await fetch(`${this.base}/v1/hub/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    })
    const json = (await res.json()) as Record<string, unknown>
    if (!res.ok) throw new Error((json.message as string) ?? "Register failed")
    const data = json.data as { token: string; user_id: number }
    this.token = data.token
    return data
  }

  async login(email: string, password: string): Promise<{ token: string; user_id: number }> {
    const res = await fetch(`${this.base}/v1/hub/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    })
    const json = (await res.json()) as Record<string, unknown>
    if (!res.ok) throw new Error((json.message as string) ?? "Login failed")
    const data = json.data as { token: string; user_id: number }
    this.token = data.token
    return data
  }

  async createBusiness(code: string, name: string, description?: string): Promise<Business> {
    return this.req<Business>("POST", "/v1/hub/businesses", { code, name, description })
  }

  // ── OAuth 2.0 Device Auth ──

  async loginStep1(): Promise<{ verification_url: string; code: string }> {
    const res = await fetch(`${this.base}/v1/hub/auth/device`, { method: "POST" })
    const json = (await res.json()) as Record<string, unknown>
    if (!res.ok) throw new Error((json.message as string) ?? "Device auth failed")
    return json.data as { verification_url: string; code: string }
  }

  async loginStep2(code: string): Promise<string> {
    const res = await fetch(`${this.base}/v1/hub/auth/device/token?code=${code}`)
    const json = (await res.json()) as Record<string, unknown>
    const data = json.data as Record<string, unknown> | undefined
    if (!data?.token) throw new Error("Code not yet approved.")
    this.oauthToken = data.token as string
    return data.token as string
  }

  // ── Business ──

  async getBusiness(code: string): Promise<Business> {
    return this.req<Business>("GET", `/v1/hub/businesses/${code}`)
  }

  // ── Workers ──

  async listWorkers(businessCode?: string, status?: string): Promise<HubWorker[]> {
    const params = new URLSearchParams()
    if (businessCode) params.set("business", businessCode)
    if (status) params.set("status", status)
    const qs = params.toString()
    return this.req<HubWorker[]>("GET", `/v1/hub/workers${qs ? "?" + qs : ""}`)
  }

  async heartbeat(workerId: string, version: string, host?: string, pid?: number): Promise<unknown> {
    return this.req("POST", "/v1/hub/workers/heartbeat", {
      business_code: this.businessCode,
      worker_id: workerId,
      version,
      host: host ?? "hub-leader",
      pid: pid ?? 0,
    })
  }

  // ── Locks ──

  async acquireLock(resourceKey: string, workerId: string, ttlSeconds = 300): Promise<{ holder_token: string; expires_at: string }> {
    return this.req("POST", "/v1/hub/locks/acquire", {
      business_code: this.businessCode,
      resource_key: resourceKey,
      worker_id: workerId,
      ttl_seconds: ttlSeconds,
    })
  }

  async releaseLock(holderToken: string): Promise<void> {
    await this.req("POST", "/v1/hub/locks/release", { holder_token: holderToken })
  }

  async renewLock(holderToken: string, ttlSeconds = 300): Promise<void> {
    await this.req("POST", "/v1/hub/locks/renew", { holder_token: holderToken, ttl_seconds: ttlSeconds })
  }

  async listLocks(businessCode?: string): Promise<Lock[]> {
    const params = businessCode ? `?business=${businessCode}` : ""
    return this.req<Lock[]>("GET", `/v1/hub/locks${params}`)
  }

  // ── Playbooks ──

  async searchPlaybooks(query: string, category?: string, limit = 20): Promise<Playbook[]> {
    const params = new URLSearchParams({ q: query, limit: String(limit) })
    if (category) params.set("category", category)
    return this.req<Playbook[]>("GET", `/v1/hub/playbooks/search?${params}`)
  }

  async createPlaybook(
    category: string,
    title: string,
    content: string,
    tags: string[] = [],
    workerId?: string,
  ): Promise<Playbook> {
    return this.req<Playbook>("POST", "/v1/hub/playbooks", {
      business_code: this.businessCode,
      category,
      title,
      content,
      tags,
      worker_id: workerId ?? this.businessCode,
    })
  }

  // ── Events ──

  async appendEvent(actor: string, eventType: string, payload: Record<string, unknown> = {}): Promise<HubEvent> {
    return this.req<HubEvent>("POST", "/v1/hub/events", {
      business_code: this.businessCode,
      actor,
      event_type: eventType,
      payload,
    })
  }

  async listEvents(businessCode: string, eventType?: string, limit = 20): Promise<HubEvent[]> {
    const params = new URLSearchParams({ business: businessCode, limit: String(limit) })
    if (eventType) params.set("type", eventType)
    return this.req<HubEvent[]>("GET", `/v1/hub/events?${params}`)
  }

  // ── DAG ──

  async syncDag(task: DagTask): Promise<void> {
    await this.req("POST", `/v1/hub/dag/${this.businessCode}`, {
      task_id: task.task_id,
      title: task.title,
      status: task.status,
      assigned_worker: task.assigned_worker ?? "",
    })
  }

  async syncDagBatch(tasks: DagTask[]): Promise<void> {
    for (const task of tasks) {
      await this.syncDag(task)
    }
  }

  async getDag(): Promise<DagTask[]> {
    return this.req<DagTask[]>("GET", `/v1/hub/dag/${this.businessCode}`)
  }

  // ── Composite: fetch context for planning ──

  async fetchContext(query: string): Promise<{
    playbooks: Playbook[]
    workers: HubWorker[]
    events: HubEvent[]
  }> {
    const [playbooks, workers, events] = await Promise.all([
      this.searchPlaybooks(query).catch(() => [] as Playbook[]),
      this.listWorkers(this.businessCode).catch(() => [] as HubWorker[]),
      this.listEvents(this.businessCode, undefined, 10).catch(() => [] as HubEvent[]),
    ])
    return { playbooks, workers, events }
  }
}
