/**
 * forge init — Agent Hub 自动配置流程
 *
 * 交互式引导完成：
 *   1. 注册/登录 Agent Hub
 *   2. 设备授权 (OAuth)
 *   3. 创建项目 (Business)
 *   4. 写入 ~/.config/forge/settings.json
 *   5. 初始化 .mycompany/ 目录
 *   6. 安装 git hooks
 *
 * 整个流程只需要用户输入邮箱和密码，其余自动完成。
 */

import { EOL } from "os"
import fs from "fs"
import path from "path"
import { createInterface } from "readline"
import { execSync } from "child_process"

// ── Interactive Input ──

function question(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close()
      resolve(answer)
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── File Helpers ──

function osHomedir(): string {
  return process.env.HOME || process.env.USERPROFILE || "/root"
}

function readSettings(): Record<string, unknown> {
  try {
    const p = path.join(osHomedir(), ".config", "forge", "settings.json")
    return JSON.parse(fs.readFileSync(p, "utf-8"))
  } catch {
    return {}
  }
}

function writeSettings(data: Record<string, unknown>): void {
  const dir = path.join(osHomedir(), ".config", "forge")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(data, null, 2), "utf-8")
}

function createMycompany(targetDir: string, projectName: string, businessCode: string, hubUrl: string): void {
  const mycompanyDir = path.join(targetDir, ".mycompany")
  fs.mkdirSync(path.join(mycompanyDir, "product"), { recursive: true })
  fs.mkdirSync(path.join(mycompanyDir, "playbook"), { recursive: true })
  fs.mkdirSync(path.join(mycompanyDir, "leader", "diary"), { recursive: true })
  fs.mkdirSync(path.join(mycompanyDir, "memory"), { recursive: true })
  fs.mkdirSync(path.join(mycompanyDir, "tasks", "test-plan"), { recursive: true })

  // config.json
  fs.writeFileSync(
    path.join(mycompanyDir, "config.json"),
    JSON.stringify(
      {
        projectName,
        businessCode,
        hubUrl,
        sessionId: `${businessCode}-init`,
        leaderMode: true,
        lang: "zh",
      },
      null,
      2,
    ),
    "utf-8",
  )

  // identity.json (gitignored)
  fs.writeFileSync(
    path.join(mycompanyDir, "identity.json"),
    JSON.stringify({ userId: "", name: "" }, null, 2),
    "utf-8",
  )

  // .gitignore
  fs.writeFileSync(path.join(mycompanyDir, ".gitignore"), "identity.json\n", "utf-8")

  // playbook/worker.md (default worker playbook)
  fs.writeFileSync(
    path.join(mycompanyDir, "playbook", "worker.md"),
    "# Worker 执行标准\n\n- 理解任务的目标和验收标准\n- 修改前先阅读相关文件\n- 完成所有验收标准后才算完成\n- 记录踩坑和发现\n",
    "utf-8",
  )

  // playbook/reviewer.md (default reviewer playbook)
  fs.writeFileSync(
    path.join(mycompanyDir, "playbook", "reviewer.md"),
    "# Review Agent 审查标准\n\n- 检查 acceptance criteria 是否全部满足\n- 检查是否有明显 bug 或安全漏洞\n- 检查是否违反 product definition 的不变规则\n- 检查测试覆盖率是否合理\n- 误报时用户 override 会记录到 Leader diary\n",
    "utf-8",
  )

  // memory/project.md
  fs.writeFileSync(
    path.join(mycompanyDir, "memory", "project.md"),
    `# ${projectName}\n\n项目初始化于 ${new Date().toISOString()}\n`,
    "utf-8",
  )

  console.error(`✅ .mycompany/ 初始化完成 (${mycompanyDir})`)
}

function createMcpConfig(targetDir: string, hubUrl: string, apiKey: string): void {
  const mcpPath = path.join(targetDir, ".mcp.json")
  const config = {
    mcpServers: {
      "agent-hub": {
        type: "http",
        url: `${hubUrl}/v1/hub/mcp`,
        headers: { "X-API-Key": apiKey },
      },
    },
  }
  fs.writeFileSync(mcpPath, JSON.stringify(config, null, 2), "utf-8")
  console.error(`✅ .mcp.json 配置完成`)
}

function installGitHooks(targetDir: string): void {
  const hooksDir = path.join(targetDir, ".mycompany", "git-hooks")
  fs.mkdirSync(hooksDir, { recursive: true })

  // pre-commit hook
  fs.writeFileSync(
    path.join(hooksDir, "pre-commit"),
    `#!/bin/sh
# Forge Code Review Agent — pre-commit hook
forge review --pre-commit 2>/dev/null || forge review --pre-commit
exit $?
`,
    "utf-8",
  )
  fs.chmodSync(path.join(hooksDir, "pre-commit"), 0o755)

  // pre-push hook
  fs.writeFileSync(
    path.join(hooksDir, "pre-push"),
    `#!/bin/sh
# Forge Code Review Agent — pre-push hook (test plan generation)
forge review --test-plan 2>/dev/null || forge review --test-plan
exit 0
`,
    "utf-8",
  )
  fs.chmodSync(path.join(hooksDir, "pre-push"), 0o755)

  try {
    execSync("git config core.hooksPath .mycompany/git-hooks/", { cwd: targetDir })
    console.error("✅ Git hooksPath 已配置为 .mycompany/git-hooks/")
  } catch {
    console.error("⚠️  无法设置 git hooksPath (可能不是 git 仓库)")
  }
}

// ── Command ──

export const InitCommand = {
  command: "init",
  describe: "初始化 Agent Hub 工作空间",
  builder: (yargs: any) => {
    return yargs
      .option("hub-url", {
        type: "string",
        describe: "Agent Hub 地址",
        default: "https://hub.stifer.xyz",
      })
      .option("project-name", {
        type: "string",
        describe: "项目名称 (默认: 当前目录名)",
      })
      .option("email", {
        type: "string",
        describe: "注册邮箱 (跳过交互输入)",
      })
      .option("password", {
        type: "string",
        describe: "密码 (跳过交互输入)",
      })
  },
  handler: async (args: any) => {
    const hubUrl = args.hubUrl || "https://hub.stifer.xyz"
    const targetDir = process.cwd()
    const projectName = args.projectName || path.basename(targetDir)

    console.error(EOL + "\x1b[36m━━━ Forge Code — Agent Hub 初始化 ━━━\x1b[0m" + EOL)

    // ── Step 1: Register / Login ──
    console.error("\x1b[33mStep 1/5: 注册 / 登录 Agent Hub\x1b[0m")
    const email = args.email || (await question("  邮箱: "))
    const password = args.password || (await question("  密码: "))

    // Dynamic import of HubClient
    const { HubClient } = await import("@opencode-ai/hub-leader")
    const hub = new HubClient({
      base_url: hubUrl,
      business_code: "",
    })

    let token: string
    let userEmail = email
    try {
      const result = await hub.register(email, password)
      token = result.token
      console.error("  ✅ 注册成功")
    } catch (err) {
      // Try login if register fails (user already exists)
      const msg = (err as Error).message
      if (msg.includes("duplicate") || msg.includes("already exists") || msg.includes("409") || msg.includes("Conflict")) {
        try {
          const result = await hub.login(email, password)
          token = result.token
          console.error("  ✅ 登录成功")
        } catch (loginErr) {
          console.error("  ❌ 登录失败:", (loginErr as Error).message)
          process.exit(1)
        }
      } else {
        console.error("  ❌ 注册失败:", msg)
        process.exit(1)
      }
    }

    // ── Step 2: Device Auth ──
    console.error(EOL + "\x1b[33mStep 2/5: 设备授权\x1b[0m")
    try {
      const { verification_url, code } = await hub.loginStep1()
      console.error(`  请在浏览器中打开以下链接并点击"授权":`)
      console.error(`  \x1b[36m${verification_url}\x1b[0m`)
      console.error(`  验证码: ${code}`)
      console.error("  等待授权（最长 5 分钟）...")

      // Poll for approval
      const start = Date.now()
      let authed = false
      while (Date.now() - start < 300_000) {
        await sleep(2000)
        try {
          const newToken = await hub.loginStep2(code)
          token = newToken
          authed = true
          break
        } catch {
          process.stderr.write(".")
        }
      }
      process.stderr.write("\n")
      if (!authed) {
        console.error("  ❌ 授权超时")
        process.exit(1)
      }
      console.error("  ✅ 设备授权成功")
    } catch (err) {
      console.error("  ⚠️  设备授权跳过:", (err as Error).message)
    }

    // ── Step 3: Create Project ──
    console.error(EOL + "\x1b[33mStep 3/5: 创建项目\x1b[0m")
    const businessCode = (args.projectName || projectName).toLowerCase().replace(/[^a-z0-9-]/g, "-")
    let apiKey: string | undefined

    try {
      const biz = await hub.createBusiness(businessCode, projectName)
      apiKey = (biz as any).api_key
      console.error(`  ✅ 项目创建成功: ${businessCode}`)
    } catch (err) {
      // Business may already exist
      if ((err as Error).message.includes("already exists") || (err as Error).message.includes("409")) {
        console.error(`  ⚠️  项目 ${businessCode} 已存在，跳过创建`)
      } else {
        console.error(`  ⚠️  项目创建跳过: ${(err as Error).message}`)
      }
    }

    // ── Step 4: Save Config ──
    console.error(EOL + "\x1b[33mStep 4/5: 保存配置\x1b[0m")
    const settings = readSettings()
    settings.token = token
    settings.hubUrl = hubUrl
    settings.businessCode = businessCode
    settings.projectName = projectName
    if (apiKey) settings.apiKey = apiKey
    settings.hubSetupComplete = true
    writeSettings(settings)
    console.error("  ✅ 配置已保存到 ~/.config/forge/settings.json")
    console.error(`     Token: ${token.slice(0, 20)}...`)

    // ── Step 5: Init Workspace ──
    console.error(EOL + "\x1b[33mStep 5/5: 初始化工作空间\x1b[0m")
    createMycompany(targetDir, projectName, businessCode, hubUrl)

    // .mcp.json
    if (apiKey) {
      createMcpConfig(targetDir, hubUrl, apiKey)
    } else {
      console.error("  ⚠️  跳过 .mcp.json (无 API key)")
    }

    // Git hooks
    installGitHooks(targetDir)

    // ── Done ──
    console.error(EOL + "\x1b[32m━━━ ✅ Forge Code 配置完成! ━━━\x1b[0m" + EOL)
    console.error("现在可以运行 forge 进入 Leader 模式了。")
    console.error("或者输入一个目标开始工作。")
    console.error("")
    console.error(`  forge --goal "你的目标" --business ${businessCode}`)
    console.error("")
  },
} as any
