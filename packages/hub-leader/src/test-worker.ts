/**
 * test-worker.ts — A test worker that registers with agent-hub
 * Used for multi-container collaboration testing.
 *
 * Run: bun run packages/hub-leader/src/test-worker.ts --worker-id <id>
 */

import { HubClient } from "./hub/client.js"

const workerId = process.argv.find(a => a.startsWith("--worker-id="))?.split("=")[1] || "worker-" + Math.random().toString(36).slice(2, 6)
const businessCode = process.argv.find(a => a.startsWith("--business="))?.split("=")[1] || "hub-leader-test"
const token = process.env.HUB_TOKEN || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE3ODE4NjM1MDIsImlhdCI6MTc4MTYwNDMwMiwicm9sZSI6InVzZXIiLCJzdWIiOiJkZXZpY2UiLCJ1aWQiOjB9.JP2Et-P7VhkpxvbRZH0vuFyDqTxChvN-xYrIx8SEsqs"
const apiKey = process.env.HUB_API_KEY || process.argv.find(a => a.startsWith("--api-key="))?.split("=")[1]

const hub = new HubClient({
  base_url: "https://hub.stifer.xyz",
  business_code: businessCode,
  token,
  api_key: apiKey,
})

async function main() {
  console.log(`\n🤖 Worker [${workerId}] starting...`)
  console.log(`   Business: ${businessCode}`)

  // Send initial heartbeat
  await hub.heartbeat(workerId, "0.1.0", "docker", process.ppid)
  console.log(`   ✅ Heartbeat sent — status: online`)

  // Report online event
  await hub.appendEvent(workerId, "worker_online", {
    worker_id: workerId,
    started_at: new Date().toISOString(),
  })
  console.log(`   ✅ Event recorded`)

  // Continuous heartbeat loop (every 30s)
  let cycles = 0
  const interval = setInterval(async () => {
    cycles++
    try {
      await hub.heartbeat(workerId, "0.1.0", "docker", process.ppid)
      console.log(`   💓 [cycle ${cycles}] heartbeat OK`)

      // Check DAG for tasks assigned to me
      const dag = await hub.getDag()
      const myTasks = dag.filter(t => t.assigned_worker === workerId && t.status === "pending")
      if (myTasks.length > 0) {
        console.log(`   📋 Found ${myTasks.length} task(s) assigned to me!`)
        for (const task of myTasks) {
          console.log(`   → ${task.task_id}: ${task.title}`)
          // Mark as in_progress then completed for demo
          await hub.syncDag({ ...task, status: "in_progress" })
          await new Promise(r => setTimeout(r, 2000))
          await hub.syncDag({ ...task, status: "completed" })
          await hub.appendEvent(workerId, "task_completed", {
            task_id: task.task_id,
            title: task.title,
          })
          console.log(`   ✅ ${task.task_id} completed`)
        }
      }
    } catch (err) {
      console.error(`   ❌ heartbeat error:`, (err as Error).message)
    }
  }, 15000)

  console.log(`\n   Listening for tasks (heartbeat every 15s)...`)
  console.log(`   Press Ctrl+C to stop.\n`)

  // Keep alive for 5 minutes then exit gracefully
  setTimeout(() => {
    clearInterval(interval)
    console.log(`\n   Worker [${workerId}] shutting down.\n`)
    process.exit(0)
  }, 300_000)
}

main().catch(err => {
  console.error("Fatal:", err)
  process.exit(1)
})
