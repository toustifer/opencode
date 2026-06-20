import fs from "fs"
import path from "path"
import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { RunCommand } from "./cli/cmd/run"
import { GenerateCommand } from "./cli/cmd/generate"
import { ConsoleCommand } from "./cli/cmd/account"
import { ProvidersCommand } from "./cli/cmd/providers"
import { AgentCommand } from "./cli/cmd/agent"
import { UpgradeCommand } from "./cli/cmd/upgrade"
import { UninstallCommand } from "./cli/cmd/uninstall"
import { ModelsCommand } from "./cli/cmd/models"
import { UI } from "./cli/ui"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { FormatError } from "./cli/error"
import { ServeCommand } from "./cli/cmd/serve"
import { DebugCommand } from "./cli/cmd/debug"
import { StatsCommand } from "./cli/cmd/stats"
import { McpCommand } from "./cli/cmd/mcp"
import { GithubCommand } from "./cli/cmd/github"
import { ExportCommand } from "./cli/cmd/export"
import { ImportCommand } from "./cli/cmd/import"
import { AttachCommand } from "./cli/cmd/attach"
import { TuiThreadCommand } from "./cli/cmd/tui"
import { AcpCommand } from "./cli/cmd/acp"
import { WebCommand } from "./cli/cmd/web"
import { PrCommand } from "./cli/cmd/pr"
import { SessionCommand } from "./cli/cmd/session"
import { DbCommand } from "./cli/cmd/db"
import { errorMessage } from "./util/error"
import { PluginCommand } from "./cli/cmd/plug"
import { ReviewCommand } from "./cli/cmd/review"
import { InitCommand } from "./cli/cmd/init"
import { Heap } from "./cli/heap"
import { EOL } from "os"
import { createInterface } from "readline"

// ── Agent Hub 检测 ──

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

function readMycompanyCfg(dir: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, ".mycompany", "config.json"), "utf-8"))
  } catch {
    return {}
  }
}

function goalFromArgs(rawArgs: string[]): string | undefined {
  const idx = rawArgs.indexOf("--goal")
  if (idx === -1) return undefined
  const val = rawArgs[idx + 1]
  return val && !val.startsWith("-") ? val : undefined
}

function businessFromArgs(rawArgs: string[]): string | undefined {
  const idx = rawArgs.indexOf("--business")
  if (idx === -1) return undefined
  const val = rawArgs[idx + 1]
  return val && !val.startsWith("-") ? val : undefined
}

// ── 模式判断（在 yargs 之前执行）──

const rawArgs = process.argv.slice(2)
const mycompanyDir = findMycompanyDir()
const mycompanyCfg = mycompanyDir ? readMycompanyCfg(mycompanyDir) : {}
const isHelp = rawArgs.includes("-h") || rawArgs.includes("--help")
const isVersion = rawArgs.includes("-v") || rawArgs.includes("--version")
const hasGoal = rawArgs.includes("--goal")
const firstArg = rawArgs[0] || ""
const hasSubcommand = firstArg.length > 0 && !firstArg.startsWith("-")

// 无 .mycompany/ + 无参数 → 自动进入对话模式
if (!mycompanyDir && !hasGoal && !isHelp && !isVersion && !hasSubcommand) {
  process.argv = [process.argv[0], process.argv[1], "run", "-i"]
}

const args = hideBin(process.argv)

// ── yargs 配置 ──

function show(out: string) {
  const text = out.trimStart()
  if (!text.startsWith("forge ")) {
    process.stderr.write(UI.logo() + EOL + EOL)
    process.stderr.write(text + EOL)
    return
  }
  process.stderr.write(out)
}

const cli = yargs(args)
  .parserConfiguration({ "populate--": true })
  .scriptName("forge")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", InstallationVersion)
  .alias("version", "v")
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .option("goal", {
    describe: '启动 Leader 模式: forge --goal "添加功能" --business my-project',
    type: "string",
  })
  .option("business", {
    describe: "Agent Hub 项目代号 (与 --goal 配合使用)",
    type: "string",
  })
  .option("pure", {
    describe: "run without external plugins",
    type: "boolean",
  })
  .middleware(async (opts) => {
    if (opts.printLogs) process.env.OPENCODE_PRINT_LOGS = "1"
    if (opts.logLevel) process.env.OPENCODE_LOG_LEVEL = opts.logLevel
    if (opts.pure) {
      process.env.OPENCODE_PURE = "1"
    }

    Heap.start()

    process.env.AGENT = "1"
    process.env.OPENCODE = "1"
    process.env.OPENCODE_PID = String(process.pid)
  })
  .usage("")
  .completion("completion", "generate shell completion script")
  .command(AcpCommand)
  .command(McpCommand)
  .command(TuiThreadCommand)
  .command(AttachCommand)
  .command(RunCommand)
  .command(GenerateCommand)
  .command(DebugCommand)
  .command(ConsoleCommand)
  .command(ProvidersCommand)
  .command(AgentCommand)
  .command(UpgradeCommand)
  .command(UninstallCommand)
  .command(ServeCommand)
  .command(WebCommand)
  .command(ModelsCommand)
  .command(StatsCommand)
  .command(ExportCommand)
  .command(ImportCommand)
  .command(InitCommand)
  .command(GithubCommand)
  .command(PrCommand)
  .command(SessionCommand)
  .command(PluginCommand)
  .command(ReviewCommand)
  .command(DbCommand)
  .fail((msg, err) => {
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      if (err) throw err
      cli.showHelp(show)
    }
    if (err) throw err
    process.exit(1)
  })
  .strict()

try {
  // ── Leader 模式（--goal）──
  if (hasGoal && !isHelp && !isVersion) {
    const { runGoal } = await import("@opencode-ai/hub-leader")
    const goal = goalFromArgs(rawArgs)
    if (!goal) {
      UI.error("请提供目标: forge --goal \"你的目标\" --business 项目代号" + EOL)
      process.exit(1)
    }
    const business = businessFromArgs(rawArgs) ?? (mycompanyCfg.businessCode as string) ?? (mycompanyCfg.projectName as string)
    if (!business) {
      UI.error("请提供 --business 项目代号，或在 .mycompany/config.json 中设置 businessCode" + EOL)
      process.exit(1)
    }

    console.log(EOL + "\x1b[36m━━━ Forge Code — Leader 模式 ━━━\x1b[0m" + EOL)
    await runGoal({
      goal,
      business,
      baseUrl: (mycompanyCfg.hubUrl as string) ?? "https://hub.stifer.xyz",
      cwd: mycompanyDir ?? process.cwd(),
      opencodeBin: "forge",
    })
    process.exit(0)
  }

  // ── Leader 交互模式（有 .mycompany/，无 --goal）──
  if (mycompanyDir && !hasGoal && !isHelp && !isVersion && !hasSubcommand) {
    const { runGoal } = await import("@opencode-ai/hub-leader")
    const projectName = (mycompanyCfg.projectName as string) ?? path.basename(mycompanyDir)

    console.log(EOL + "\x1b[36m━━━ Forge Code — Leader 模式 ━━━\x1b[0m")
    console.log(`  项目: ${projectName}`)
    console.log(`  目录: ${mycompanyDir}${EOL}`)

    const goal = await askForGoal()
    if (!goal) {
      console.log("未输入目标，退出。")
      process.exit(0)
    }

    await runGoal({
      goal,
      business: (mycompanyCfg.businessCode as string) ?? projectName,
      baseUrl: (mycompanyCfg.hubUrl as string) ?? "https://hub.stifer.xyz",
      cwd: mycompanyDir,
      opencodeBin: "forge",
    })
    process.exit(0)
  }

  // ── 正常 yargs 流程 ──
  const yargsIsHelp = args.includes("-h") || args.includes("--help")
  const yargsIsVersion = args.includes("-v") || args.includes("--version")

  if (yargsIsHelp) {
    await cli.parse(args, (err: Error | undefined, _argv: unknown, out: string) => {
      if (err) throw err
      if (!out) return
      show(out)
    })
  } else if (yargsIsVersion) {
    await cli.parse()
  } else {
    await cli.parse()
  }
} catch (e) {
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("Unexpected error" + EOL)
    process.stderr.write(errorMessage(e) + EOL)
  }
  process.exitCode = 1
} finally {
  process.exit()
}

// ── 交互式输入 ──

async function askForGoal(): Promise<string | null> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  })
  return new Promise((resolve) => {
    process.stderr.write("\x1b[33m? 输入目标（回车确认，Ctrl+C 取消）:\x1b[0m\n")
    rl.question("> ", (answer) => {
      rl.close()
      resolve(answer.trim() || null)
    })
    rl.on("SIGINT", () => {
      rl.close()
      resolve(null)
    })
  })
}
