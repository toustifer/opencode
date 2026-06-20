/**
 * forge review — Review Agent
 *
 * Pre-commit code review gate and test plan generation.
 * Called by git hooks (pre-commit, pre-push) and directly by users.
 *
 * Usage:
 *   forge review --pre-commit         # Check staged diff against criteria
 *   forge review --test-plan           # Generate test doc from diff
 *   forge review --override            # Override a failed review (records to diary)
 */

import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { UI } from "../ui"
import { EOL } from "os"
import fs from "fs"
import path from "path"
import { execSync } from "child_process"

// ── Config ──

interface ReviewConfig {
  preCommit: "disabled" | "enabled" | "strict"
  prePush: "disabled" | "enabled"
  generateTestDoc: boolean
  autoInstallHooks: boolean
}

function loadReviewConfig(): ReviewConfig {
  try {
    const settingsPath = path.join(osHomedir(), ".config", "forge", "settings.json")
    const raw = JSON.parse(fs.readFileSync(settingsPath, "utf-8"))
    return {
      preCommit: raw.review?.preCommit ?? "enabled",
      prePush: raw.review?.prePush ?? "enabled",
      generateTestDoc: raw.review?.generateTestDoc ?? true,
      autoInstallHooks: raw.review?.autoInstallHooks ?? true,
    }
  } catch {
    return { preCommit: "enabled", prePush: "enabled", generateTestDoc: true, autoInstallHooks: true }
  }
}

function osHomedir(): string {
  return process.env.HOME || process.env.USERPROFILE || "/root"
}

// ── Git Helpers ──

function getStagedDiff(): string {
  try {
    return execSync("git diff --cached --no-color", { encoding: "utf-8", maxBuffer: 2 * 1024 * 1024 })
  } catch {
    return ""
  }
}

function getCommitHash(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim()
  } catch {
    return "unknown"
  }
}

function getChangedFiles(): string[] {
  try {
    return execSync("git diff --cached --name-only", { encoding: "utf-8" })
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

// ── Mycompany Helpers ──

function findMycompanyDir(): string | null {
  let dir = process.cwd()
  while (true) {
    try {
      if (fs.statSync(path.join(dir, ".mycompany")).isDirectory()) return dir
    } catch {
      /* not found */
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function readAcceptanceCriteria(mycompanyDir: string): string {
  const dir = path.join(mycompanyDir, "tasks")
  const files: string[] = []
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith(".md") || f.endsWith(".txt")) {
        files.push(fs.readFileSync(path.join(dir, f), "utf-8"))
      }
    }
  } catch {
    /* no tasks dir */
  }
  return files.join("\n\n---\n\n")
}

function readProductDefinitions(mycompanyDir: string): string {
  const dir = path.join(mycompanyDir, "product")
  const defs: string[] = []
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith(".md")) {
        defs.push(`# ${f}\n${fs.readFileSync(path.join(dir, f), "utf-8")}`)
      }
    }
  } catch {
    /* no product dir */
  }
  return defs.join("\n\n---\n\n")
}

function readReviewerPlaybook(mycompanyDir: string): string {
  try {
    return fs.readFileSync(path.join(mycompanyDir, "playbook", "reviewer.md"), "utf-8")
  } catch {
    return ""
  }
}

function writeTestPlan(mycompanyDir: string, commitHash: string, content: string): void {
  const dir = path.join(mycompanyDir, "tasks", "test-plan")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${commitHash}.md`), content, "utf-8")
}

function appendLeaderDiary(mycompanyDir: string, entry: string): void {
  const dir = path.join(mycompanyDir, "leader", "diary")
  fs.mkdirSync(dir, { recursive: true })
  const date = new Date().toISOString().slice(0, 10)
  const file = path.join(dir, `${date}.md`)
  fs.appendFileSync(file, `\n## ${new Date().toISOString()}\n\n${entry}\n`, "utf-8")
}

// ── LLM Review ──

interface ReviewResult {
  passed: boolean
  score: number // 0-100
  reasons: string[]
  suggestions: string[]
  testPlan?: string
}

async function callReviewLLM(diff: string, criteria: string, productDefs: string, reviewerMd: string): Promise<ReviewResult> {
  const systemPrompt = `You are a code review agent. Review the following git diff against:
1. Acceptance criteria
2. Product definitions (immutable rules)
3. Reviewer playbook (accumulated review standards)

Return a JSON object:
{
  "passed": boolean,
  "score": number (0-100),
  "reasons": string[],
  "suggestions": string[],
  "testPlanSummary": string
}

Be strict: if acceptance criteria are not met, score < 70 and passed=false.
Be fair: use the reviewer playbook standards, not personal opinions.`

  const userPrompt = [
    reviewerMd ? `## Reviewer Playbook\n${reviewerMd}\n` : "",
    criteria ? `## Acceptance Criteria\n${criteria}\n` : "",
    productDefs ? `## Product Definitions\n${productDefs}\n` : "",
    `## Git Diff\n\`\`\`diff\n${diff.slice(0, 8000)}\n\`\`\``,
    "\nReview this diff. Output ONLY valid JSON.",
  ]
    .filter(Boolean)
    .join("\n")

  const apiKey = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || process.env.LLM_API_KEY
  const baseUrl = process.env.ANTHROPIC_BASE_URL || process.env.LLM_BASE_URL
  const model = process.env.FORGE_REVIEW_MODEL || "deepseek-chat"
  const isAnthropic = !baseUrl || baseUrl.includes("anthropic")

  if (!apiKey) {
    return {
      passed: true,
      score: 50,
      reasons: ["⚠️  No API key configured — review skipped automatically"],
      suggestions: ["Set ANTHROPIC_AUTH_TOKEN or LLM_API_KEY in environment to enable review"],
    }
  }

  try {
    let response
    if (isAnthropic) {
      response = await fetch(`${baseUrl || "https://api.anthropic.com"}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 2000,
          system: [{ type: "text", text: systemPrompt }],
          messages: [{ role: "user", content: [{ type: "text", text: userPrompt }] }],
        }),
      })
    } else {
      // OpenAI-compatible endpoint (DeepSeek, etc.)
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: model.replace(/^deepseek\//, ""),
          max_tokens: 2000,
          temperature: 0.3,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
      })
    }

    if (!response.ok) {
      const errBody = await response.text()
      return {
        passed: true,
        score: 50,
        reasons: [`⚠️  LLM API error (${response.status}): ${errBody.slice(0, 200)} — review skipped`],
        suggestions: [],
      }
    }

    const data = await response.json()
    // Handle both Anthropic ({content: [{text: ...}}]}) and OpenAI ({choices: [{message: {content: ...}}]}) response formats
    let text = ""
    if (data.content?.[0]?.text) {
      text = data.content[0].text
    } else if (data.choices?.[0]?.message?.content) {
      text = data.choices[0].message.content
    }

    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return { passed: true, score: 50, reasons: ["Could not parse LLM response — review skipped"], suggestions: [] }
    }

    const result = JSON.parse(jsonMatch[0])
    return {
      passed: result.passed !== false,
      score: result.score ?? 50,
      reasons: result.reasons || [],
      suggestions: result.suggestions || [],
      testPlan: result.testPlanSummary,
    }
  } catch (err) {
    return {
      passed: true,
      score: 50,
      reasons: [`⚠️  Review agent error: ${(err as Error).message} — review skipped`],
      suggestions: [],
    }
  }
}

// ── Pre-commit Review ──

async function runPreCommit(config: ReviewConfig): Promise<void> {
  // strict mode: even --no-verify can't skip; we inject our own check
  const mycompanyDir = findMycompanyDir()

  if (!mycompanyDir) {
    // No .mycompany/ = no acceptance criteria to check against → skip silently
    process.exit(0)
  }

  const diff = getStagedDiff()
  if (!diff) {
    // No staged changes → nothing to review
    process.exit(0)
  }

  // Check if running under strict mode via FORGE_REVIEW_ACTIVE env
  const isStrictOverride = process.env.FORGE_REVIEW_STRICT === "1"

  if (config.preCommit === "disabled") {
    process.exit(0)
  }

  const criteria = readAcceptanceCriteria(mycompanyDir)
  const productDefs = readProductDefinitions(mycompanyDir)
  const reviewerMd = readReviewerPlaybook(mycompanyDir)

  console.error(EOL + "━━━ Review Agent — Checking staged changes... ━━━" + EOL)

  const result = await callReviewLLM(diff, criteria, productDefs, reviewerMd)

  // Display results
  const passed = result.passed || (result.score ?? 0) >= 70
  const icon = passed ? "✅" : "❌"

  console.error(`${icon} Review: ${passed ? "PASSED" : "FAILED"} (score: ${result.score}/100)`)
  if (result.reasons.length) {
    for (const r of result.reasons) console.error(`  ${r}`)
  }
  if (result.suggestions.length) {
    console.error("")
    console.error("📝 Suggestions:")
    for (const s of result.suggestions) console.error(`  • ${s}`)
  }

  if (passed) {
    console.error(EOL + "✅ Review passed, commit allowed." + EOL)

    // Generate test doc on pass if enabled
    if (config.generateTestDoc && result.testPlan) {
      const hash = getCommitHash()
      writeTestPlan(mycompanyDir, hash, `# Test Plan: ${hash}\n\n${result.testPlan}`)
      console.error(`📋 Test plan written to .mycompany/tasks/test-plan/${hash}.md`)
    }

    process.exit(0)
  } else {
    console.error(EOL + "❌ Review FAILED — commit blocked.")
    if (config.preCommit === "strict" || isStrictOverride) {
      console.error("   (strict mode: --no-verify cannot bypass)")
      appendLeaderDiary(mycompanyDir, `Blocked commit (strict):\n${result.reasons.join("\n")}`)
    } else {
      console.error("   Use --no-verify to bypass (will be recorded)")
      appendLeaderDiary(mycompanyDir, `Bypassed commit (--no-verify):\n${result.reasons.join("\n")}`)
    }
    process.exit(1)
  }
}

// ── Test Plan Generation ──

async function runTestPlan(): Promise<void> {
  const mycompanyDir = findMycompanyDir()
  const diff = getStagedDiff()
  const changedFiles = getChangedFiles()

  console.error(EOL + "━━━ Review Agent — Generating test plan... ━━━" + EOL)

  const result = await callReviewLLM(diff, "", "", "")

  const testPlan = `# Test Plan: ${getCommitHash()}

## Changed Files
${changedFiles.map((f) => `- ${f}`).join("\n") || "(none)"}

## Test Summary
${result.testPlan || "N/A"}

## Review Notes
${result.reasons.join("\n") || "None"}

## Suggestions
${result.suggestions.map((s) => `- ${s}`).join("\n") || "None"}

---

*Generated by Forge Review Agent at ${new Date().toISOString()}*
`

  if (mycompanyDir) {
    writeTestPlan(mycompanyDir, getCommitHash(), testPlan)
    console.error(`📋 Test plan written to .mycompany/tasks/test-plan/${getCommitHash()}.md`)
  } else {
    // Print to stdout for piping
    process.stdout.write(testPlan)
  }
}

// ── Hook Script Generation ──

function generateHookScripts(targetDir: string): void {
  const hooksDir = path.join(targetDir, ".mycompany", "git-hooks")
  fs.mkdirSync(hooksDir, { recursive: true })

  // pre-commit hook
  const preCommitScript = `#!/bin/sh
# Forge Code Review Agent — pre-commit hook
# Installed by forge init. Uses core.hooksPath.
# Config: ~/.config/forge/settings.json → review.preCommit

FORGE="${process.argv[0]} ${process.argv[1]}"
if command -v forge >/dev/null 2>&1; then
  forge review --pre-commit
  exit $?
elif [ -f "${process.argv[0]}" ]; then
  $FORGE review --pre-commit
  exit $?
else
  echo "⚠️  forge not found in PATH — review skipped"
  echo "   Install forge: brew install forge-code"
  exit 0
fi
`

  // pre-push hook
  const prePushScript = `#!/bin/sh
# Forge Code Review Agent — pre-push hook
# Generates test plan for pushed changes.

FORGE="${process.argv[0]} ${process.argv[1]}"
if command -v forge >/dev/null 2>&1; then
  forge review --test-plan
elif [ -f "${process.argv[0]}" ]; then
  $FORGE review --test-plan
else
  echo "⚠️  forge not found in PATH — test plan skipped"
  exit 0
fi
`

  fs.writeFileSync(path.join(hooksDir, "pre-commit"), preCommitScript, "utf-8")
  fs.writeFileSync(path.join(hooksDir, "pre-push"), prePushScript, "utf-8")
  fs.chmodSync(path.join(hooksDir, "pre-commit"), 0o755)
  fs.chmodSync(path.join(hooksDir, "pre-push"), 0o755)

  console.error(`✅ Git hooks installed: ${hooksDir}`)
}

function installGitHooks(targetDir: string): void {
  try {
    execSync(`git config core.hooksPath .mycompany/git-hooks/`, { cwd: targetDir, encoding: "utf-8" })
    console.error("✅ Git hooksPath configured to .mycompany/git-hooks/")
  } catch (err) {
    console.error("⚠️  Failed to set hooksPath:", (err as Error).message)
  }
}

// ── Command ──

export const ReviewCommand = {
  command: "review",
  describe: "Review Agent: code review gate and test plan generation",
  builder: (yargs: any) => {
    return yargs
      .option("pre-commit", {
        type: "boolean",
        describe: "Run pre-commit review check against staged diff",
      })
      .option("test-plan", {
        type: "boolean",
        describe: "Generate test plan for staged changes",
      })
      .option("override", {
        type: "boolean",
        describe: "Override a failed review (records to Leader diary)",
      })
      .option("install-hooks", {
        type: "boolean",
        describe: "Install git hook scripts and configure hooksPath",
      })
  },
  handler: async (args: any) => {
    const config = loadReviewConfig()

    if (args.installHooks) {
      const targetDir = process.cwd()
      generateHookScripts(targetDir)
      installGitHooks(targetDir)
      // Also update config
      const settingsPath = path.join(osHomedir(), ".config", "forge", "settings.json")
      try {
        const existing = JSON.parse(fs.readFileSync(settingsPath, "utf-8"))
        existing.review = existing.review || {}
        existing.review.autoInstallHooks = true
        fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2), "utf-8")
      } catch {
        /* settings may not exist */
      }
      return
    }

    if (args.override) {
      const mycompanyDir = findMycompanyDir()
      if (mycompanyDir) {
        appendLeaderDiary(mycompanyDir, "User override: review failed but commit was forced.\nReason not provided.")
      }
      console.error("⚠️  Review override recorded.")
      return
    }

    if (args.testPlan) {
      await runTestPlan()
      return
    }

    // Default: pre-commit check
    await runPreCommit(config)
  },
} as any
