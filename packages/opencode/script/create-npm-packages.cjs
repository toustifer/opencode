#!/usr/bin/env node
// create-npm-packages.cjs — 配置所有平台包和根包发布

const fs = require("fs")
const path = require("path")

const distDir = path.join(__dirname, "..", "dist")
const rootPkg = require("../package.json")
const version = rootPkg.version

// Collect all platform packages
const platformDirs = fs.readdirSync(distDir).filter(d => d.startsWith("forge-code-"))
const optionalDeps = {}
const allPlatformNames = []

for (const dir of platformDirs) {
  const pkgPath = path.join(distDir, dir, "package.json")
  if (!fs.existsSync(pkgPath)) continue

  // Update version
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"))
  pkg.version = version
  pkg.license = "MIT"
  pkg.description = `Forge Code — ${dir.replace("forge-code-", "")} binary`
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2))

  optionalDeps[pkg.name] = version
  allPlatformNames.push(pkg.name)
}

// Update root package.json
rootPkg.private = false
rootPkg.publishConfig = { access: "public" }
rootPkg.description = rootPkg.description || "Forge Code — AI-powered multi-agent coding CLI"
rootPkg.homepage = "https://hub.stifer.xyz"
rootPkg.repository = { type: "git", url: "https://github.com/toustifer/opencode.git" }
rootPkg.optionalDependencies = optionalDeps

// Remove fields that block publishing
delete rootPkg.workspaces

fs.writeFileSync(path.join(__dirname, "..", "package.json"), JSON.stringify(rootPkg, null, 2))

console.log(`✅ Prepared ${platformDirs.length} platform packages for npm publish:`)
console.log(`   Root: forge-code@${version}`)
for (const name of allPlatformNames) {
  console.log(`   ├─ ${name}@${version}`)
}
console.log(`\n   Optional deps added to root package.json`)
