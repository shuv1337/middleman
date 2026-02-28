import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { normalizeAllowlistRoots } from "./swarm/cwd-policy.js";
import { getMemoryDirPath } from "./swarm/memory-paths.js";
import {
  DEFAULT_SWARM_MODEL_PRESET,
  isSwarmModelPreset,
  resolveModelDescriptorFromPreset
} from "./swarm/model-presets.js";
import {
  SWARM_CODEX_APPROVAL_POLICIES,
  SWARM_CODEX_SANDBOX_MODES,
  type SwarmCodexApprovalPolicy,
  type SwarmCodexSandboxMode,
  type SwarmConfig,
  type SwarmModelPreset
} from "./swarm/types.js";

const DEFAULT_SHUVLR_PORT = 47187;
const DEFAULT_SHUVLR_HOST = "127.0.0.1";
const DEFAULT_SHUVLR_DATA_DIR_NAME = ".shuvlr";
const DEFAULT_SHUVLR_CODEX_SANDBOX_MODE: SwarmCodexSandboxMode = "danger-full-access";
const DEFAULT_SHUVLR_CODEX_APPROVAL_POLICY: SwarmCodexApprovalPolicy = "auto_accept";

export function createConfig(): SwarmConfig {
  const rootDir = detectRootDir();
  const dataDir = resolveDataDir(process.env.SHUVLR_DATA_DIR);
  const managerId = undefined;
  const swarmDir = resolve(dataDir, "swarm");
  const sessionsDir = resolve(dataDir, "sessions");
  const uploadsDir = resolve(dataDir, "uploads");
  const authDir = resolve(dataDir, "auth");
  const authFile = resolve(authDir, "auth.json");
  migrateLegacyPiAuthFileIfNeeded(authFile);
  const agentDir = resolve(dataDir, "agent");
  const managerAgentDir = resolve(agentDir, "manager");
  const repoArchetypesDir = resolve(rootDir, ".swarm", "archetypes");
  const memoryDir = getMemoryDirPath(dataDir);
  const memoryFile = undefined;
  const repoMemorySkillFile = resolve(rootDir, ".swarm", "skills", "memory", "SKILL.md");
  const secretsFile = resolve(dataDir, "secrets.json");
  const defaultCwd = rootDir;
  const defaultModelPreset = resolveDefaultModelPreset(process.env.SHUVLR_DEFAULT_MODEL_PRESET);
  const defaultModel = resolveModelDescriptorFromPreset(defaultModelPreset);

  const cwdAllowlistRoots = normalizeAllowlistRoots([rootDir, resolve(homedir(), "worktrees")]);

  return {
    host: normalizeNonEmptyString(process.env.SHUVLR_HOST) ?? DEFAULT_SHUVLR_HOST,
    port: parsePort(process.env.SHUVLR_PORT, DEFAULT_SHUVLR_PORT),
    debug: true,
    allowNonManagerSubscriptions: true,
    authToken: normalizeNonEmptyString(process.env.SHUVLR_AUTH_TOKEN),
    allowedOrigins: parseAllowedOrigins(process.env.SHUVLR_ALLOWED_ORIGINS),
    managerId,
    managerDisplayName: "Manager",
    defaultModel,
    defaultModelPreset,
    codexSandboxMode: resolveCodexSandboxMode(process.env.SHUVLR_CODEX_SANDBOX_MODE),
    codexApprovalPolicy: resolveCodexApprovalPolicy(process.env.SHUVLR_CODEX_APPROVAL_POLICY),
    defaultCwd,
    cwdAllowlistRoots,
    paths: {
      rootDir,
      dataDir,
      swarmDir,
      sessionsDir,
      uploadsDir,
      authDir,
      authFile,
      agentDir,
      managerAgentDir,
      repoArchetypesDir,
      memoryDir,
      memoryFile,
      repoMemorySkillFile,
      agentsStoreFile: resolve(swarmDir, "agents.json"),
      secretsFile,
      schedulesFile: undefined
    }
  };
}

function detectRootDir(): string {
  let current = resolve(process.cwd());

  while (true) {
    if (isSwarmRepoRoot(current)) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      break;
    }

    current = parent;
  }

  return resolve(process.cwd(), "../..");
}

function isSwarmRepoRoot(path: string): boolean {
  return existsSync(resolve(path, "pnpm-workspace.yaml")) && existsSync(resolve(path, "apps"));
}

function migrateLegacyPiAuthFileIfNeeded(targetAuthFile: string): void {
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return;
  }

  const legacyPiAuthFile = resolve(homedir(), ".pi", "agent", "auth.json");
  if (existsSync(targetAuthFile) || !existsSync(legacyPiAuthFile)) {
    return;
  }

  try {
    mkdirSync(dirname(targetAuthFile), { recursive: true });
    copyFileSync(legacyPiAuthFile, targetAuthFile);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[shuvlr] Failed to migrate legacy Pi auth file: ${message}`);
  }
}

function normalizeNonEmptyString(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parsePort(rawValue: string | undefined, fallback: number): number {
  const normalized = normalizeNonEmptyString(rawValue);
  if (!normalized) {
    return fallback;
  }

  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`SHUVLR_PORT must be a positive integer (received: ${rawValue ?? ""})`);
  }

  return parsed;
}

function resolveDataDir(rawValue: string | undefined): string {
  const normalized = normalizeNonEmptyString(rawValue);
  if (!normalized) {
    return resolve(homedir(), DEFAULT_SHUVLR_DATA_DIR_NAME);
  }

  const resolved = resolve(normalized);
  if (resolved.trim().length === 0) {
    throw new Error("SHUVLR_DATA_DIR must resolve to a non-empty path");
  }

  return resolved;
}

function parseAllowedOrigins(rawValue: string | undefined): string[] | undefined {
  const normalized = normalizeNonEmptyString(rawValue);
  if (!normalized) {
    return undefined;
  }

  const values = normalized
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (values.length === 0) {
    throw new Error("SHUVLR_ALLOWED_ORIGINS must include at least one origin");
  }

  return [...new Set(values)];
}

function resolveDefaultModelPreset(rawValue: string | undefined): SwarmModelPreset {
  const normalized = normalizeNonEmptyString(rawValue);
  if (!normalized) {
    return DEFAULT_SWARM_MODEL_PRESET;
  }

  if (!isSwarmModelPreset(normalized)) {
    throw new Error(
      `SHUVLR_DEFAULT_MODEL_PRESET must be one of pi-codex|pi-opus|codex-app (received: ${rawValue ?? ""})`
    );
  }

  return normalized;
}

function resolveCodexSandboxMode(rawValue: string | undefined): SwarmCodexSandboxMode {
  const normalized = normalizeNonEmptyString(rawValue);
  if (!normalized) {
    return DEFAULT_SHUVLR_CODEX_SANDBOX_MODE;
  }

  if (!SWARM_CODEX_SANDBOX_MODES.includes(normalized as SwarmCodexSandboxMode)) {
    throw new Error(
      `SHUVLR_CODEX_SANDBOX_MODE must be one of ${SWARM_CODEX_SANDBOX_MODES.join("|")} (received: ${rawValue ?? ""})`
    );
  }

  return normalized as SwarmCodexSandboxMode;
}

function resolveCodexApprovalPolicy(rawValue: string | undefined): SwarmCodexApprovalPolicy {
  const normalized = normalizeNonEmptyString(rawValue);
  if (!normalized) {
    return DEFAULT_SHUVLR_CODEX_APPROVAL_POLICY;
  }

  if (!SWARM_CODEX_APPROVAL_POLICIES.includes(normalized as SwarmCodexApprovalPolicy)) {
    throw new Error(
      `SHUVLR_CODEX_APPROVAL_POLICY must be one of ${SWARM_CODEX_APPROVAL_POLICIES.join("|")} (received: ${rawValue ?? ""})`
    );
  }

  return normalized as SwarmCodexApprovalPolicy;
}
