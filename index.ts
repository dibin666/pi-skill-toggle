/**
 * pi-skill-toggle
 *
 * Extension to enable/disable skills from loading into pi context.
 * Usage: /skills-toggle (or /skills) - Opens the skill toggle UI.
 *
 * Disabled skills are persisted through Pi's resource filtering settings.
 * Hidden skills remain available to /skill:name but are omitted from the
 * model's automatically available skill list.
 */

import {
  CONFIG_DIR_NAME,
  DefaultPackageManager,
  getAgentDir,
  parseFrontmatter,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type PackageSource,
  type ResolvedResource,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

type DisableMode = "enabled" | "hidden" | "disabled";
type SettingsScope = "global" | "project";
type ResourceMetadata = ResolvedResource["metadata"];
type PiSettings = ReturnType<SettingsManager["getGlobalSettings"]>;

interface ParsedSkill {
  name: string;
  description: string;
  disableModelInvocation: boolean;
}

interface SkillResource {
  filePath: string;
  enabled: boolean;
  metadata: ResourceMetadata;
  parsed: ParsedSkill;
}

interface SkillInfo {
  name: string;
  description: string;
  filePath: string; // Primary path (the active winner when available)
  allPaths: string[]; // All paths with this name (for disabling all)
  resources: SkillResource[];
  mode: DisableMode;
  disableModelInvocation: boolean;
  hasDuplicates: boolean;
}

interface SkillCatalog {
  skills: SkillInfo[];
  byName: Map<string, SkillInfo>;
  settingsManager: SettingsManager;
}

interface SkillToggleResult {
  action: "toggle" | "cancel" | "apply";
  changes: Map<string, DisableMode>; // skill name -> new mode
}

// ═══════════════════════════════════════════════════════════════════════════
// Theme
// ═══════════════════════════════════════════════════════════════════════════

interface ToggleTheme {
  border: string;
  title: string;
  enabled: string;
  hidden: string;
  disabled: string;
  selected: string;
  selectedText: string;
  searchIcon: string;
  placeholder: string;
  description: string;
  hint: string;
  changed: string;
  duplicate: string;
}

const DEFAULT_THEME: ToggleTheme = {
  border: "2", // dim
  title: "2", // dim
  enabled: "32", // green
  hidden: "33", // yellow
  disabled: "31", // red
  selected: "36", // cyan
  selectedText: "36", // cyan
  searchIcon: "2", // dim
  placeholder: "2;3", // dim italic
  description: "2", // dim
  hint: "2", // dim
  changed: "33", // yellow
  duplicate: "35", // magenta
};

function loadTheme(): ToggleTheme {
  const candidates = new Set<string>();

  // A theme.json next to the extension works for git/local installs.
  try {
    candidates.add(path.join(path.dirname(fileURLToPath(import.meta.url)), "theme.json"));
  } catch {
    // Some transpilers do not expose import.meta.url; use the legacy path below.
  }

  const agentDir = getAgentDir();
  candidates.add(path.join(agentDir, "extensions", "skill-toggle", "theme.json"));
  candidates.add(path.join(agentDir, "extensions", "pi-skill-toggle", "theme.json"));

  for (const configPath of candidates) {
    try {
      if (fs.existsSync(configPath)) {
        const custom = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Partial<ToggleTheme>;
        return { ...DEFAULT_THEME, ...custom };
      }
    } catch {
      // Ignore malformed/missing theme files and keep trying other candidates.
    }
  }

  return DEFAULT_THEME;
}

function fg(code: string, text: string): string {
  if (!code) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

const toggleTheme = loadTheme();

// ═══════════════════════════════════════════════════════════════════════════
// Skill discovery
// ═══════════════════════════════════════════════════════════════════════════

const AGENT_DIR = getAgentDir();

function canonicalPath(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function resolveSkillFilePath(resourcePath: string): string | undefined {
  const resolved = path.resolve(resourcePath);

  try {
    const stats = fs.statSync(resolved);
    if (stats.isFile() && resolved.toLowerCase().endsWith(".md")) {
      return resolved;
    }
    if (stats.isDirectory()) {
      const skillFile = path.join(resolved, "SKILL.md");
      if (fs.statSync(skillFile).isFile()) return skillFile;
    }
  } catch {
    // The package manager can retain a stale resource entry; ignore it.
  }

  return undefined;
}

function parseSkillFile(filePath: string): ParsedSkill | undefined {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
    const fallbackName = path.basename(path.dirname(filePath));
    const name = typeof frontmatter.name === "string" && frontmatter.name.trim()
      ? frontmatter.name.trim()
      : fallbackName;
    const description = typeof frontmatter.description === "string"
      ? frontmatter.description.trim()
      : "";

    // Pi follows the Agent Skills format and treats this as a YAML boolean.
    // Accept the string form too so older skill files remain understandable.
    const rawDisable = frontmatter["disable-model-invocation"];
    const disableModelInvocation = rawDisable === true ||
      (typeof rawDisable === "string" && rawDisable.toLowerCase() === "true");

    if (!description) return undefined;
    return { name, description, disableModelInvocation };
  } catch {
    return undefined;
  }
}

function metadataForLoadedSkill(skill: Skill): ResourceMetadata {
  return {
    source: skill.sourceInfo.source,
    scope: skill.sourceInfo.scope,
    origin: skill.sourceInfo.origin,
    // Top-level skills from an explicit extension path should be persisted
    // using the normal Pi scope base, not the skill's own directory.
    baseDir: skill.sourceInfo.origin === "package" ? skill.sourceInfo.baseDir : undefined,
  };
}

/**
 * Use Pi's own package/resource resolver instead of maintaining a second list
 * of skill locations. This includes project/.agents ancestors, package skills,
 * local settings paths, and disabled resources, and preserves Pi precedence.
 * Missing packages are skipped so opening this UI never installs anything.
 */
async function loadAllSkills(ctx: ExtensionCommandContext): Promise<SkillCatalog> {
  const settingsManager = SettingsManager.create(ctx.cwd, AGENT_DIR, {
    projectTrusted: ctx.isProjectTrusted(),
  });
  const resources: SkillResource[] = [];
  const resourceByPath = new Map<string, SkillResource>();

  const addResource = (
    resourcePath: string,
    enabled: boolean,
    metadata: ResourceMetadata,
  ): void => {
    const filePath = resolveSkillFilePath(resourcePath);
    if (!filePath) return;

    const parsed = parseSkillFile(filePath);
    if (!parsed) return;

    const key = canonicalPath(filePath);
    const existing = resourceByPath.get(key);
    if (existing) {
      // A skill supplied by an explicit path is active even if the same path
      // also appeared in a stale/disabled resolver entry.
      existing.enabled = existing.enabled || enabled;
      return;
    }

    const entry: SkillResource = { filePath, enabled, metadata, parsed };
    resources.push(entry);
    resourceByPath.set(key, entry);
  };


  try {
    const packageManager = new DefaultPackageManager({
      cwd: ctx.cwd,
      agentDir: AGENT_DIR,
      settingsManager,
    });
    const resolved = await packageManager.resolve(async () => "skip");
    for (const resource of resolved.skills) {
      addResource(resource.path, resource.enabled, resource.metadata);
    }
  } catch (error) {
    // Keep the command useful even when a third-party package has a broken
    // manifest. The currently loaded skills are still available below.
    console.error(`pi-skill-toggle: failed to resolve configured skills: ${String(error)}`);
  }

  // Include temporary/extension-provided skills that are active in this Pi
  // session but are not represented by settings/package resolution.
  for (const skill of ctx.getSystemPromptOptions().skills ?? []) {
    addResource(skill.filePath, true, metadataForLoadedSkill(skill));
  }

  const byName = new Map<string, SkillInfo>();
  for (const resource of resources) {
    let skill = byName.get(resource.parsed.name);
    if (!skill) {
      skill = {
        name: resource.parsed.name,
        description: resource.parsed.description,
        filePath: resource.filePath,
        allPaths: [],
        resources: [],
        mode: "enabled",
        disableModelInvocation: resource.parsed.disableModelInvocation,
        hasDuplicates: false,
      };
      byName.set(resource.parsed.name, skill);
    }

    skill.resources.push(resource);
    if (!skill.allPaths.some((p) => canonicalPath(p) === canonicalPath(resource.filePath))) {
      skill.allPaths.push(resource.filePath);
    }

    // The first enabled resource is the same winner Pi uses after resource
    // precedence and path deduplication have been applied.
    if (skill.resources.filter((item) => item.enabled).length === 1 && resource.enabled) {
      skill.filePath = resource.filePath;
      skill.description = resource.parsed.description;
      skill.disableModelInvocation = resource.parsed.disableModelInvocation;
    }
  }

  for (const skill of byName.values()) {
    skill.hasDuplicates = skill.allPaths.length > 1;
    const enabledResources = skill.resources.filter((resource) => resource.enabled);
    if (enabledResources.length === 0) {
      skill.mode = "disabled";
    } else if (enabledResources[0].parsed.disableModelInvocation) {
      skill.mode = "hidden";
    } else {
      skill.mode = "enabled";
    }
  }

  const skills = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
  return { skills, byName, settingsManager };
}

// ═══════════════════════════════════════════════════════════════════════════
// Settings and frontmatter updates
// ═══════════════════════════════════════════════════════════════════════════

function normalizePath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
  if (trimmed.startsWith("~")) return path.join(os.homedir(), trimmed.slice(1));
  return path.resolve(trimmed);
}

function resolveSettingsPath(value: string, baseDir: string): string {
  if (path.isAbsolute(value)) return path.normalize(value);
  if (value.startsWith("~")) return normalizePath(value);
  return path.resolve(baseDir, value);
}

function settingsBaseDir(scope: SettingsScope, cwd: string): string {
  return scope === "global" ? AGENT_DIR : path.join(cwd, CONFIG_DIR_NAME);
}

function resourceSettingsScope(resource: SkillResource): SettingsScope | undefined {
  if (resource.metadata.origin === "package") return undefined;
  if (resource.metadata.scope === "user") return "global";
  if (resource.metadata.scope === "project") return "project";
  return undefined;
}

function resourcePatternBaseDir(resource: SkillResource, scope: SettingsScope, cwd: string): string {
  return resource.metadata.baseDir
    ? path.resolve(resource.metadata.baseDir)
    : settingsBaseDir(scope, cwd);
}

function resourceFilterPath(resource: SkillResource): string {
  return path.basename(resource.filePath) === "SKILL.md"
    ? path.dirname(resource.filePath)
    : resource.filePath;
}

function resourceSettingsPattern(resource: SkillResource, scope: SettingsScope, cwd: string): string {
  const filterPath = resourceFilterPath(resource);
  const relative = path.relative(resourcePatternBaseDir(resource, scope, cwd), filterPath);

  if (relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join("/");
  }
  return filterPath;
}

function entryTargetsSkill(entry: string, prefix: "-" | "+", resource: SkillResource, scope: SettingsScope, cwd: string): boolean {
  if (!entry.startsWith(prefix)) return false;
  const target = resolveSettingsPath(entry.slice(1), resourcePatternBaseDir(resource, scope, cwd));
  return target === resource.filePath || target === path.dirname(resource.filePath);
}


function updateSkillPathSettings(
  settings: PiSettings,
  scope: SettingsScope,
  resources: SkillResource[],
  desiredEnabled: boolean,
  cwd: string,
): boolean {
  const current = Array.isArray(settings.skills) ? [...settings.skills] : [];
  let next = current;
  let changed = false;

  for (const resource of resources) {
    const pattern = resourceSettingsPattern(resource, scope, cwd);
    const disableEntry = `-${pattern}`;
    const enableEntry = `+${pattern}`;

    if (!desiredEnabled) {
      const withoutExactIncludes = next.filter((entry) =>
        typeof entry !== "string" || !entryTargetsSkill(entry, "+", resource, scope, cwd));
      changed = changed || withoutExactIncludes.length !== next.length;
      next = withoutExactIncludes;

      const alreadyDisabled = next.some((entry) =>
        typeof entry === "string" && entryTargetsSkill(entry, "-", resource, scope, cwd));
      if (!alreadyDisabled) {
        next.push(disableEntry);
        changed = true;
      }
      continue;
    }

    const withoutExactDisables = next.filter((entry) =>
      typeof entry !== "string" || !entryTargetsSkill(entry, "-", resource, scope, cwd));
    changed = changed || withoutExactDisables.length !== next.length;
    next = withoutExactDisables;

    // `!pattern` exclusions can still disable a skill after an exact `-path`
    // is removed. A `+path` is Pi's supported force-include escape hatch.
    if (!resource.enabled && !next.some((entry) =>
      typeof entry === "string" && entry === enableEntry)) {
      next.push(enableEntry);
      changed = true;
    }
  }

  if (changed) settings.skills = next;
  return changed;
}

function packageSkillPattern(resource: SkillResource): string | undefined {
  const baseDir = resource.metadata.baseDir;
  if (!baseDir) return undefined;
  const relative = path.relative(baseDir, resourceFilterPath(resource));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return relative.split(path.sep).join("/");
}

function packageSource(entry: PackageSource): string {
  return typeof entry === "string" ? entry : entry.source;
}

function packagePatternTargetsSkill(pattern: string, relativeSkillDir: string): boolean {
  if (!pattern.startsWith("-") && !pattern.startsWith("+")) return false;
  const target = pattern.slice(1).replace(/\/$/, "");
  return target === relativeSkillDir || target === `${relativeSkillDir}/SKILL.md`;
}

function updatePackageSkillSettings(
  packages: PackageSource[],
  resource: SkillResource,
  desiredEnabled: boolean,
): boolean {
  const relativeSkillDir = packageSkillPattern(resource);
  if (!relativeSkillDir) return false;

  const source = resource.metadata.source;
  const index = packages.findIndex((entry) => packageSource(entry) === source);
  if (index === -1) return false;

  const existing = packages[index];
  if (!desiredEnabled) {
    const pattern = `-${relativeSkillDir}`;
    if (typeof existing === "string") {
      packages[index] = { source: existing, skills: [pattern] };
      return true;
    }

    const skills = [...(existing.skills ?? [])];
    // An empty package filter explicitly disables every skill; adding a
    // negative pattern would accidentally re-enable the other skills.
    if (skills.length === 0) return false;
    if (skills.some((item) => item === pattern || packagePatternTargetsSkill(item, relativeSkillDir) && item.startsWith("-"))) {
      return false;
    }
    packages[index] = { ...existing, skills: [...skills, pattern] };
    return true;
  }

  if (typeof existing === "string" || existing.skills === undefined) return false;

  const skills = existing.skills;
  if (skills.length === 0) {
    packages[index] = { ...existing, skills: [`!*`, `+${relativeSkillDir}`] };
    return true;
  }

  const filtered = skills.filter((item) =>
    !(item.startsWith("-") && packagePatternTargetsSkill(item, relativeSkillDir)));
  const wasChanged = filtered.length !== skills.length;
  const needsForceInclude = !resource.enabled && !filtered.includes(`+${relativeSkillDir}`);
  if (needsForceInclude) filtered.push(`+${relativeSkillDir}`);
  if (!wasChanged && !needsForceInclude) return false;

  // If this object only contained the plugin's exact exclusion, returning to
  // string form restores Pi's normal "load all package resources" behavior.
  const onlySourceAndSkills = Object.keys(existing).every((key) => key === "source" || key === "skills");
  if (filtered.length === 0 && onlySourceAndSkills && existing.autoload === undefined) {
    packages[index] = existing.source;
  } else {
    packages[index] = filtered.length > 0 ? { ...existing, skills: filtered } : (() => {
      const { skills: _skills, ...rest } = existing;
      return rest;
    })();
  }
  return true;
}

function updateSkillFrontmatter(filePath: string, disableModelInvocation: boolean): void {
  const original = fs.readFileSync(filePath, "utf-8");
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const hasFrontmatter = lines[0] === "---";
  let closingIndex = -1;
  if (hasFrontmatter) {
    closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  }

  let nextLines = lines;
  if (!hasFrontmatter || closingIndex === -1) {
    if (!disableModelInvocation) return;
    nextLines = ["---", "disable-model-invocation: true", "---", ...lines];
  } else {
    const field = /^\s*disable-model-invocation\s*:/;
    const fieldIndex = lines.findIndex((line, index) => index > 0 && index < closingIndex && field.test(line));
    if (disableModelInvocation) {
      nextLines = [...lines];
      if (fieldIndex === -1) {
        nextLines.splice(closingIndex, 0, "disable-model-invocation: true");
      } else {
        nextLines[fieldIndex] = "disable-model-invocation: true";
      }
    } else {
      nextLines = lines.filter((line, index) => index !== fieldIndex);
    }
  }

  const next = nextLines.join(newline);
  if (next === original) return;

  // Keep the old backup behavior for recoverability, but write atomically so a
  // cancelled/failed process cannot leave a truncated SKILL.md behind.
  const backupPath = `${filePath}.bak`;
  const tempPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(backupPath, original, "utf-8");
  try {
    fs.writeFileSync(tempPath, next, "utf-8");
    fs.renameSync(tempPath, filePath);
    fs.unlinkSync(backupPath);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch { /* ignore cleanup failure */ }
    throw error;
  }
}

function settingsForScope(settingsManager: SettingsManager, scope: SettingsScope): PiSettings {
  return scope === "global"
    ? settingsManager.getGlobalSettings()
    : settingsManager.getProjectSettings();
}

async function applyChanges(
  changes: Map<string, DisableMode>,
  skillsByName: Map<string, SkillInfo>,
  ctx: ExtensionCommandContext,
  settingsManager: SettingsManager,
): Promise<void> {
  const globalSettings = settingsForScope(settingsManager, "global");
  const projectSettings = settingsForScope(settingsManager, "project");
  const globalPackages = [...(globalSettings.packages ?? [])];
  const projectPackages = [...(projectSettings.packages ?? [])];
  const settingsChanged = new Map<SettingsScope, boolean>([
    ["global", false],
    ["project", false],
  ]);
  let globalPackagesChanged = false;
  let projectPackagesChanged = false;

  for (const [skillName, newMode] of changes) {
    const skill = skillsByName.get(skillName);
    if (!skill) continue;

    const desiredEnabled = newMode !== "disabled";
    const resourcesByScope = new Map<SettingsScope, SkillResource[]>([
      ["global", []],
      ["project", []],
    ]);

    for (const resource of skill.resources) {
      if (resource.metadata.origin === "package") {
        const packages = resource.metadata.scope === "project" ? projectPackages : globalPackages;
        const changed = updatePackageSkillSettings(packages, resource, desiredEnabled);
        if (resource.metadata.scope === "project") projectPackagesChanged ||= changed;
        else globalPackagesChanged ||= changed;
        continue;
      }

      const scope = resourceSettingsScope(resource);
      if (scope) resourcesByScope.get(scope)!.push(resource);
    }

    for (const scope of ["global", "project"] as const) {
      const scopedResources = resourcesByScope.get(scope)!;
      if (scopedResources.length === 0) continue;
      const settings = scope === "global" ? globalSettings : projectSettings;
      const changed = updateSkillPathSettings(settings, scope, scopedResources, desiredEnabled, ctx.cwd);
      settingsChanged.set(scope, settingsChanged.get(scope)! || changed);
    }

    for (const filePath of skill.allPaths) {
      updateSkillFrontmatter(filePath, newMode === "hidden");
    }
  }

  if (settingsChanged.get("global")) {
    settingsManager.setSkillPaths(globalSettings.skills ?? []);
  }
  if (settingsChanged.get("project")) {
    settingsManager.setProjectSkillPaths(projectSettings.skills ?? []);
  }
  if (globalPackagesChanged) settingsManager.setPackages(globalPackages);
  if (projectPackagesChanged) settingsManager.setProjectPackages(projectPackages);

  await settingsManager.flush();
  const errors = settingsManager.drainErrors();
  if (errors.length > 0) {
    throw new Error(errors.map((item) => `${item.scope}: ${item.error.message}`).join("; "));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Fuzzy Filter
// ═══════════════════════════════════════════════════════════════════════════

function fuzzyScore(query: string, text: string): number {
	const lowerQuery = query.toLowerCase();
	const lowerText = text.toLowerCase();

	if (lowerText.includes(lowerQuery)) {
		return 100 + (lowerQuery.length / lowerText.length) * 50;
	}

	let score = 0;
	let queryIndex = 0;
	let consecutiveBonus = 0;

	for (let i = 0; i < lowerText.length && queryIndex < lowerQuery.length; i++) {
		if (lowerText[i] === lowerQuery[queryIndex]) {
			score += 10 + consecutiveBonus;
			consecutiveBonus += 5;
			queryIndex++;
		} else {
			consecutiveBonus = 0;
		}
	}

	return queryIndex === lowerQuery.length ? score : 0;
}

function filterSkills(skills: SkillInfo[], query: string): SkillInfo[] {
	if (!query.trim()) return skills;

	const scored = skills
		.map((skill) => ({
			skill,
			score: Math.max(
				fuzzyScore(query, skill.name),
				fuzzyScore(query, skill.description) * 0.8
			),
		}))
		.filter((item) => item.score > 0)
		.sort((a, b) => b.score - a.score);

	return scored.map((item) => item.skill);
}

// ═══════════════════════════════════════════════════════════════════════════
// UI Component
// ═══════════════════════════════════════════════════════════════════════════

class SkillToggleComponent {
	private allSkills: SkillInfo[];
	private filtered: SkillInfo[];
	private selected = 0;
	private query = "";
	private changes = new Map<string, DisableMode>(); // skill NAME -> new mode
	private inactivityTimeout: ReturnType<typeof setTimeout> | null = null;
	private static readonly INACTIVITY_MS = 120000; // 2 minutes

  constructor(
    skills: SkillInfo[],
    private done: (result: SkillToggleResult) => void,
    private requestRender: () => void = () => {},
  ) {
    this.allSkills = skills;
    this.filtered = skills;
    this.resetInactivityTimeout();
  }

	private resetInactivityTimeout(): void {
		if (this.inactivityTimeout) clearTimeout(this.inactivityTimeout);
		this.inactivityTimeout = setTimeout(() => {
			this.cleanup();
			this.done({ action: "cancel", changes: new Map() });
		}, SkillToggleComponent.INACTIVITY_MS);
	}

	private getEffectiveMode(skill: SkillInfo): DisableMode {
		if (this.changes.has(skill.name)) {
			return this.changes.get(skill.name)!;
		}
		return skill.mode;
	}

  handleInput(data: string): void {
    this.resetInactivityTimeout();

    if (matchesKey(data, "escape")) {
      this.cleanup();
      this.done({ action: "cancel", changes: new Map() });
      return;
    }

    // Enter/Space toggles between enabled <-> hidden (default action).
    if (matchesKey(data, "enter") || data === " ") {
      const skill = this.filtered[this.selected];
      if (skill) {
        const currentMode = this.getEffectiveMode(skill);
        const originalMode = skill.mode;
        const newMode: DisableMode = currentMode === "enabled" ? "hidden" : "enabled";

        if (newMode === originalMode) {
          this.changes.delete(skill.name);
        } else {
          this.changes.set(skill.name, newMode);
        }
        this.requestRender();
      }
      return;
    }

    // 'd' or Ctrl+D toggles full disable (enabled/hidden <-> disabled).
    const printable = decodeKittyPrintable(data) ?? data;
    if (printable === "d" || matchesKey(data, "ctrl+d")) {
      const skill = this.filtered[this.selected];
      if (skill) {
        const currentMode = this.getEffectiveMode(skill);
        const originalMode = skill.mode;
        const newMode: DisableMode = currentMode === "disabled" ? "enabled" : "disabled";

        if (newMode === originalMode) {
          this.changes.delete(skill.name);
        } else {
          this.changes.set(skill.name, newMode);
        }
        this.requestRender();
      }
      return;
    }

    // Ctrl+S to save and exit.
    if (matchesKey(data, "ctrl+s")) {
      this.cleanup();
      this.done({ action: "apply", changes: this.changes });
      return;
    }

    if (matchesKey(data, "up")) {
      if (this.filtered.length > 0) {
        this.selected = this.selected === 0 ? this.filtered.length - 1 : this.selected - 1;
        this.requestRender();
      }
      return;
    }

    if (matchesKey(data, "down")) {
      if (this.filtered.length > 0) {
        this.selected = this.selected === this.filtered.length - 1 ? 0 : this.selected + 1;
        this.requestRender();
      }
      return;
    }

    if (matchesKey(data, "backspace")) {
      if (this.query.length > 0) {
        this.query = this.query.slice(0, -1);
        this.updateFilter();
        this.requestRender();
      }
      return;
    }

    // Printable characters. decodeKittyPrintable also handles Kitty keyboard
    // protocol sequences used by current Pi/TUI versions.
    if (printable.length === 1 && printable.charCodeAt(0) >= 32) {
      this.query += printable;
      this.updateFilter();
      this.requestRender();
    }
  }

	private updateFilter(): void {
		this.filtered = filterSkills(this.allSkills, this.query);
		this.selected = 0;
	}

	render(width: number): string[] {
    const innerW = Math.max(1, width - 2);
		const lines: string[] = [];

		const t = toggleTheme;
		const border = (s: string) => fg(t.border, s);
		const title = (s: string) => fg(t.title, s);
		const enabled = (s: string) => fg(t.enabled, s);
		const disabled = (s: string) => fg(t.disabled, s);
		const selected = (s: string) => fg(t.selected, s);
		const selectedText = (s: string) => fg(t.selectedText, s);
		const searchIcon = (s: string) => fg(t.searchIcon, s);
		const placeholder = (s: string) => fg(t.placeholder, s);
		const description = (s: string) => fg(t.description, s);
		const hint = (s: string) => fg(t.hint, s);
		const changed = (s: string) => fg(t.changed, s);
		const duplicate = (s: string) => fg(t.duplicate, s);
		const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
		const italic = (s: string) => `\x1b[3m${s}\x1b[23m`;

		const visLen = visibleWidth;

		const row = (content: string) => border("│") + truncateToWidth(" " + content, innerW, "…", true) + border("│");
		const emptyRow = () => border("│") + " ".repeat(innerW) + border("│");

		// Count pending changes
		const pendingCount = this.changes.size;
		const enabledCount = this.allSkills.filter(s => this.getEffectiveMode(s) === "enabled").length;
		const hiddenCount = this.allSkills.filter(s => this.getEffectiveMode(s) === "hidden").length;
		const disabledCount = this.allSkills.filter(s => this.getEffectiveMode(s) === "disabled").length;

    // Top border with title. Keep the component valid on narrow terminals too.
    const titleText = ` Skills (${enabledCount} on, ${hiddenCount} hidden, ${disabledCount} off) `;
    const visibleTitle = truncateToWidth(titleText, innerW, "", true);
    const borderLen = Math.max(0, innerW - visLen(visibleTitle));
    const leftBorder = Math.floor(borderLen / 2);
    const rightBorder = borderLen - leftBorder;
    lines.push(border("╭" + "─".repeat(leftBorder)) + title(visibleTitle) + border("─".repeat(rightBorder) + "╮"));

		lines.push(emptyRow());

		// Search input
		const cursor = selected("│");
		const searchIconChar = searchIcon("◎");
		const queryDisplay = this.query
			? `${this.query}${cursor}`
			: `${cursor}${placeholder(italic("type to filter..."))}`;
		lines.push(row(`${searchIconChar}  ${queryDisplay}`));

		lines.push(emptyRow());

		// Pending changes indicator
		if (pendingCount > 0) {
			lines.push(row(changed(`⚠ ${pendingCount} pending change${pendingCount === 1 ? "" : "s"} (Ctrl+S to save)`)));
			lines.push(emptyRow());
		}

		// Divider
		lines.push(border("├" + "─".repeat(innerW) + "┤"));

		// Skills list
		const maxVisible = 12;
		const startIndex = Math.max(0, Math.min(this.selected - Math.floor(maxVisible / 2), this.filtered.length - maxVisible));
		const endIndex = Math.min(startIndex + maxVisible, this.filtered.length);

		if (this.filtered.length === 0) {
			lines.push(emptyRow());
			lines.push(row(hint(italic("No matching skills"))));
			lines.push(emptyRow());
		} else {
			lines.push(emptyRow());
			for (let i = startIndex; i < endIndex; i++) {
				const skill = this.filtered[i];
				const isSelected = i === this.selected;
				const mode = this.getEffectiveMode(skill);
				const hasChanged = this.changes.has(skill.name);
				
				// Build the skill line - icons: ● enabled, ◐ hidden, ○ disabled
				const prefix = isSelected ? selected("▸") : border("·");
				let statusIcon: string;
				if (mode === "enabled") {
					statusIcon = enabled("●");
				} else if (mode === "hidden") {
					statusIcon = fg(t.hidden, "◐");
				} else {
					statusIcon = disabled("○");
				}
				const changedMarker = hasChanged ? changed("*") : " ";
				const dupMarker = skill.hasDuplicates ? duplicate("²") : " ";
				const nameStr = isSelected ? bold(selectedText(skill.name)) : skill.name;
				const maxDescLen = Math.max(0, innerW - visLen(skill.name) - 18);
				const descStr = maxDescLen > 3 ? description(truncateToWidth(skill.description, maxDescLen, "…")) : "";
				
				const separator = descStr ? `  ${border("—")}  ` : "";
				const skillLine = `${prefix} ${statusIcon}${changedMarker}${dupMarker}${nameStr}${separator}${descStr}`;
				lines.push(row(skillLine));
			}
			lines.push(emptyRow());

			// Scroll indicator
			if (this.filtered.length > maxVisible) {
				const countStr = `${this.selected + 1}/${this.filtered.length}`;
				lines.push(row(hint(countStr)));
				lines.push(emptyRow());
			}
		}

		// Divider
		lines.push(border("├" + "─".repeat(innerW) + "┤"));

		lines.push(emptyRow());

		// Footer hints
		const baseHints = `${italic("↑↓")} navigate  ${italic("enter/space")} hide  ${italic("d")} disable  ${italic("ctrl+s")} save  ${italic("esc")} cancel`;
		lines.push(row(hint(baseHints)));
		
		// Legend for markers
		lines.push(row(hint(`${enabled("●")} on  ${fg(t.hidden, "◐")} hidden (manual only)  ${disabled("○")} disabled  ${duplicate("²")} duplicates`)));

		// Bottom border
		lines.push(border(`╰${"─".repeat(innerW)}╯`));

		return lines;
	}

	private cleanup(): void {
		if (this.inactivityTimeout) {
			clearTimeout(this.inactivityTimeout);
			this.inactivityTimeout = null;
		}
	}

	invalidate(): void {}
	
	dispose(): void {
		this.cleanup();
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Extension Entry Point
// ═══════════════════════════════════════════════════════════════════════════

async function openSkillToggle(_args: string, ctx: ExtensionCommandContext): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("Skill toggle requires interactive TUI mode", "warning");
    return;
  }

  let catalog: SkillCatalog;
  try {
    catalog = await loadAllSkills(ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Failed to load skills: ${message}`, "error");
    return;
  }

  const { skills, byName, settingsManager } = catalog;
  if (skills.length === 0) {
    ctx.ui.notify("No skills found", "warning");
    return;
  }

  const result = await ctx.ui.custom<SkillToggleResult>(
    (tui, _theme, _keybindings, done) => new SkillToggleComponent(
      skills,
      (value) => done(value),
      () => tui.requestRender(),
    ),
    { overlay: true, overlayOptions: { anchor: "center", width: 80 } },
  );

  if (!result || result.action !== "apply" || result.changes.size === 0) return;

  try {
    await applyChanges(result.changes, byName, ctx, settingsManager);

    const enabledCount = Array.from(result.changes.values()).filter((value) => value === "enabled").length;
    const hiddenCount = Array.from(result.changes.values()).filter((value) => value === "hidden").length;
    const disabledCount = Array.from(result.changes.values()).filter((value) => value === "disabled").length;

    const parts: string[] = [];
    if (enabledCount > 0) parts.push(`${enabledCount} enabled`);
    if (hiddenCount > 0) parts.push(`${hiddenCount} hidden`);
    if (disabledCount > 0) parts.push(`${disabledCount} disabled`);

    ctx.ui.notify(`Skills updated: ${parts.join(", ")}. Use /reload or restart for changes to take effect.`, "info");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    ctx.ui.notify(`Failed to save settings: ${message}`, "error");
  }
}

export default function skillToggleExtension(pi: ExtensionAPI): void {
  const command = {
    description: "Toggle skills on/off (changes require /reload or restart)",
    handler: openSkillToggle,
  };

  pi.registerCommand("skills-toggle", command);
  // Keep the short command mentioned by the original extension's header.
  pi.registerCommand("skills", command);
}
