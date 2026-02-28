import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AuthStorage,
  DefaultResourceLoader,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  type AgentSession,
  type AuthCredential
} from "@mariozechner/pi-coding-agent";
import type { ServerEvent } from "../protocol/ws-types.js";
import {
  loadArchetypePromptRegistry,
  normalizeArchetypeId,
  type ArchetypePromptRegistry
} from "./archetypes/archetype-prompt-registry.js";
import { AgentRuntime } from "./agent-runtime.js";
import { CodexAgentRuntime } from "./codex-agent-runtime.js";
import { getAgentMemoryPath as getAgentMemoryPathForDataDir } from "./memory-paths.js";
import {
  listDirectories,
  normalizeAllowlistRoots,
  validateDirectory as validateDirectoryInput,
  validateDirectoryPath,
  type DirectoryListingResult,
  type DirectoryValidationResult
} from "./cwd-policy.js";
import { pickDirectory as pickNativeDirectory } from "./directory-picker.js";
import {
  DEFAULT_SWARM_MODEL_PRESET,
  inferSwarmModelPresetFromDescriptor,
  normalizeSwarmModelDescriptor,
  parseSwarmModelPreset,
  resolveModelDescriptorFromPreset
} from "./model-presets.js";
import { getModelAvailabilityHints, resolveModelWithMeta } from "./model-resolution.js";
import type {
  RuntimeImageAttachment,
  RuntimeErrorEvent,
  RuntimeSessionEvent,
  RuntimeUserMessage,
  SwarmAgentRuntime
} from "./runtime-types.js";
import { buildSwarmTools, type SwarmToolHost } from "./swarm-tools.js";
import { createShuvdoClient, type ShuvdoClient } from "./shuvdo-client.js";
import type {
  AcceptedDeliveryMode,
  AgentMessageEvent,
  AgentToolCallEvent,
  AgentContextUsage,
  AgentDescriptor,
  AgentModelDescriptor,
  AgentStatus,
  AgentStatusEvent,
  AgentsSnapshotEvent,
  AgentsStoreFile,
  ConversationAttachment,
  ConversationBinaryAttachment,
  ConversationEntryEvent,
  ConversationImageAttachment,
  ConversationLogEvent,
  ConversationMessageEvent,
  ConversationTextAttachment,
  MessageSourceContext,
  MessageTargetContext,
  RequestedDeliveryMode,
  SendMessageReceipt,
  SettingsAuthProvider,
  SettingsAuthProviderName,
  SkillEnvRequirement,
  SpawnAgentInput,
  SwarmConfig,
  SwarmModelPreset
} from "./types.js";

const DEFAULT_WORKER_SYSTEM_PROMPT = `You are a worker agent in a swarm.
- You can list agents and send messages to other agents.
- Use coding tools (read/bash/edit/write) to execute implementation tasks.
- Report progress and outcomes back to the manager using send_message_to_agent.
- You are not user-facing.
- End users only see messages they send and manager speak_to_user outputs.
- Your plain assistant text is not directly visible to end users.
- Incoming messages prefixed with "SYSTEM:" are internal control/context updates, not direct end-user chat.
- Persistent memory for this runtime is at \${SWARM_MEMORY_FILE} and is auto-loaded into context.
- Workers read their owning manager's memory file.
- Only write memory when explicitly asked to remember/update/forget durable information.
- Follow the memory skill workflow before editing the memory file, and never store secrets in memory.`;
const MANAGER_ARCHETYPE_ID = "manager";
const MERGER_ARCHETYPE_ID = "merger";
const INTERNAL_MODEL_MESSAGE_PREFIX = "SYSTEM: ";
const MANAGER_BOOTSTRAP_INTERVIEW_MESSAGE = `You are a newly created manager agent for this user.

Send a warm welcome via speak_to_user and explain that you orchestrate worker agents to get work done quickly and safely.

Then run a short onboarding interview. Ask:
1. What kinds of projects/tasks they expect to work on most.
2. Whether they prefer delegation-heavy execution or hands-on collaboration.
3. Which tools/integrations matter most (Slack, Telegram, cron scheduling, web search, etc.).
4. Any coding/process preferences (style conventions, testing expectations, branching/PR habits).
5. Communication style preferences (concise vs detailed, formal vs casual, update cadence).

Offer this example workflow to show what's possible:

"The Delegator" workflow:
- User describes a feature or task.
- Manager spawns a codex worker in a git worktree branch.
- Worker implements and validates (typecheck, build, tests).
- Merger agent merges the branch to main.
- Multiple independent tasks can run in parallel across separate workers.
- Use different model workers for different strengths (e.g. opus for UI polish, codex for backend).
- Manager focuses on orchestration and concise status updates.
- Memory file tracks preferences, decisions, and project context across sessions.

This is just one example — ask the user how they'd like to work and adapt to their style.

Close by asking if they want you to save their preferences to memory for future sessions.
If they agree, summarize the choices and persist them using the memory workflow.`;
const MAX_CONVERSATION_HISTORY = 2000;
const CONVERSATION_ENTRY_TYPE = "swarm_conversation_entry";
const SWARM_CONTEXT_FILE_NAME = "SWARM.md";
const REPO_BRAVE_SEARCH_SKILL_RELATIVE_PATH = ".swarm/skills/brave-search/SKILL.md";
const REPO_CRON_SCHEDULING_SKILL_RELATIVE_PATH = ".swarm/skills/cron-scheduling/SKILL.md";
const REPO_AGENT_BROWSER_SKILL_RELATIVE_PATH = ".swarm/skills/agent-browser/SKILL.md";
const REPO_IMAGE_GENERATION_SKILL_RELATIVE_PATH = ".swarm/skills/image-generation/SKILL.md";
const REPO_GSUITE_SKILL_RELATIVE_PATH = ".swarm/skills/gsuite/SKILL.md";
const REPO_SHUVDO_SKILL_RELATIVE_PATH = ".swarm/skills/shuvdo/SKILL.md";
const BUILT_IN_MEMORY_SKILL_RELATIVE_PATH = "apps/backend/src/swarm/skills/builtins/memory/SKILL.md";
const BUILT_IN_BRAVE_SEARCH_SKILL_RELATIVE_PATH =
  "apps/backend/src/swarm/skills/builtins/brave-search/SKILL.md";
const BUILT_IN_CRON_SCHEDULING_SKILL_RELATIVE_PATH =
  "apps/backend/src/swarm/skills/builtins/cron-scheduling/SKILL.md";
const BUILT_IN_AGENT_BROWSER_SKILL_RELATIVE_PATH =
  "apps/backend/src/swarm/skills/builtins/agent-browser/SKILL.md";
const BUILT_IN_IMAGE_GENERATION_SKILL_RELATIVE_PATH =
  "apps/backend/src/swarm/skills/builtins/image-generation/SKILL.md";
const BUILT_IN_GSUITE_SKILL_RELATIVE_PATH = "apps/backend/src/swarm/skills/builtins/gsuite/SKILL.md";
const BUILT_IN_SHUVDO_SKILL_RELATIVE_PATH = "apps/backend/src/swarm/skills/builtins/shuvdo/SKILL.md";
const SWARM_MANAGER_DIR = fileURLToPath(new URL(".", import.meta.url));
const BACKEND_PACKAGE_DIR = resolve(SWARM_MANAGER_DIR, "..", "..");
const BUILT_IN_MEMORY_SKILL_FALLBACK_PATH = resolve(
  BACKEND_PACKAGE_DIR,
  "src",
  "swarm",
  "skills",
  "builtins",
  "memory",
  "SKILL.md"
);
const BUILT_IN_BRAVE_SEARCH_SKILL_FALLBACK_PATH = resolve(
  BACKEND_PACKAGE_DIR,
  "src",
  "swarm",
  "skills",
  "builtins",
  "brave-search",
  "SKILL.md"
);
const BUILT_IN_CRON_SCHEDULING_SKILL_FALLBACK_PATH = resolve(
  BACKEND_PACKAGE_DIR,
  "src",
  "swarm",
  "skills",
  "builtins",
  "cron-scheduling",
  "SKILL.md"
);
const BUILT_IN_AGENT_BROWSER_SKILL_FALLBACK_PATH = resolve(
  BACKEND_PACKAGE_DIR,
  "src",
  "swarm",
  "skills",
  "builtins",
  "agent-browser",
  "SKILL.md"
);
const BUILT_IN_IMAGE_GENERATION_SKILL_FALLBACK_PATH = resolve(
  BACKEND_PACKAGE_DIR,
  "src",
  "swarm",
  "skills",
  "builtins",
  "image-generation",
  "SKILL.md"
);
const BUILT_IN_GSUITE_SKILL_FALLBACK_PATH = resolve(
  BACKEND_PACKAGE_DIR,
  "src",
  "swarm",
  "skills",
  "builtins",
  "gsuite",
  "SKILL.md"
);
const BUILT_IN_SHUVDO_SKILL_FALLBACK_PATH = resolve(
  BACKEND_PACKAGE_DIR,
  "src",
  "swarm",
  "skills",
  "builtins",
  "shuvdo",
  "SKILL.md"
);
const DEFAULT_MEMORY_FILE_CONTENT = `# Shuvlr Memory

## User Preferences
- (none yet)

## Project Facts
- (none yet)

## Decisions
- (none yet)
`;
const SKILL_FRONTMATTER_BLOCK_PATTERN = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;
const SETTINGS_ENV_MASK = "********";
const SETTINGS_AUTH_MASK = "********";
const SWARM_MANAGER_MAX_EVENT_LISTENERS = 64;
const MANAGER_ERROR_CONTEXT_HINT = "Try compacting the conversation to free up context space.";
const MANAGER_ERROR_GENERIC_HINT = "Please retry. If this persists, check provider auth and rate limits.";
const VALID_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SETTINGS_AUTH_PROVIDER_DEFINITIONS: Array<{
  provider: SettingsAuthProviderName;
  storageProvider: string;
}> = [
  {
    provider: "anthropic",
    storageProvider: "anthropic"
  },
  {
    provider: "openai-codex",
    storageProvider: "openai-codex"
  }
];

interface ParsedSkillEnvDeclaration {
  name: string;
  description?: string;
  required: boolean;
  helpUrl?: string;
}

interface SkillMetadata {
  skillName: string;
  path: string;
  env: ParsedSkillEnvDeclaration[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function createEmptyArchetypePromptRegistry(): ArchetypePromptRegistry {
  return {
    resolvePrompt: () => undefined,
    listArchetypeIds: () => []
  };
}

function cloneContextUsage(contextUsage: AgentContextUsage | undefined): AgentContextUsage | undefined {
  if (!contextUsage) {
    return undefined;
  }

  return {
    tokens: contextUsage.tokens,
    contextWindow: contextUsage.contextWindow,
    percent: contextUsage.percent
  };
}

function cloneDescriptor(descriptor: AgentDescriptor): AgentDescriptor {
  return {
    ...descriptor,
    model: { ...descriptor.model },
    contextUsage: cloneContextUsage(descriptor.contextUsage)
  };
}

function normalizeContextUsage(contextUsage: AgentContextUsage | undefined): AgentContextUsage | undefined {
  if (!contextUsage) {
    return undefined;
  }

  if (
    typeof contextUsage.tokens !== "number" ||
    !Number.isFinite(contextUsage.tokens) ||
    contextUsage.tokens < 0
  ) {
    return undefined;
  }

  if (
    typeof contextUsage.contextWindow !== "number" ||
    !Number.isFinite(contextUsage.contextWindow) ||
    contextUsage.contextWindow <= 0
  ) {
    return undefined;
  }

  if (typeof contextUsage.percent !== "number" || !Number.isFinite(contextUsage.percent)) {
    return undefined;
  }

  return {
    tokens: Math.round(contextUsage.tokens),
    contextWindow: Math.max(1, Math.round(contextUsage.contextWindow)),
    percent: Math.max(0, Math.min(100, contextUsage.percent))
  };
}

function areContextUsagesEqual(
  left: AgentContextUsage | undefined,
  right: AgentContextUsage | undefined
): boolean {
  if (!left && !right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return (
    left.tokens === right.tokens &&
    left.contextWindow === right.contextWindow &&
    left.percent === right.percent
  );
}

export class SwarmManager extends EventEmitter implements SwarmToolHost {
  private readonly config: SwarmConfig;
  private readonly now: () => string;
  private readonly defaultModelPreset: SwarmModelPreset;

  private readonly descriptors = new Map<string, AgentDescriptor>();
  private readonly runtimes = new Map<string, SwarmAgentRuntime>();
  private readonly conversationEntriesByAgentId = new Map<string, ConversationEntryEvent[]>();
  private readonly originalProcessEnvByName = new Map<string, string | undefined>();
  private skillMetadata: SkillMetadata[] = [];
  private secrets: Record<string, string> = {};
  private shuvdoClient: ShuvdoClient | undefined;

  private archetypePromptRegistry: ArchetypePromptRegistry = createEmptyArchetypePromptRegistry();

  constructor(config: SwarmConfig, options?: { now?: () => string }) {
    super();

    this.defaultModelPreset =
      inferSwarmModelPresetFromDescriptor(config.defaultModel) ?? DEFAULT_SWARM_MODEL_PRESET;
    this.config = {
      ...config,
      defaultModel: resolveModelDescriptorFromPreset(this.defaultModelPreset)
    };
    this.now = options?.now ?? nowIso;
    this.setMaxListeners(SWARM_MANAGER_MAX_EVENT_LISTENERS);
  }

  async boot(): Promise<void> {
    this.logDebug("boot:start", {
      host: this.config.host,
      port: this.config.port,
      authFile: this.config.paths.authFile,
      managerId: this.config.managerId
    });

    await this.ensureDirectories();
    await this.loadSecretsStore();
    this.refreshShuvdoClient();
    await this.reloadSkillMetadata();

    try {
      this.config.defaultCwd = await this.resolveAndValidateCwd(this.config.defaultCwd);
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Invalid default working directory: ${error.message}`);
      }
      throw error;
    }

    this.archetypePromptRegistry = await loadArchetypePromptRegistry({
      repoOverridesDir: this.config.paths.repoArchetypesDir
    });

    const loaded = await this.loadStore();
    for (const descriptor of loaded.agents) {
      this.descriptors.set(descriptor.agentId, descriptor);
    }

    this.ensurePrimaryManagerForBoot();
    await this.ensureMemoryFilesForBoot();
    await this.saveStore();

    this.loadConversationHistoriesFromStore();
    await this.restoreRuntimesForBoot();

    const managerDescriptor = this.getBootLogManagerDescriptor();
    this.emitAgentsSnapshot();

    this.logDebug("boot:ready", {
      managerId: managerDescriptor?.agentId,
      managerStatus: managerDescriptor?.status,
      model: managerDescriptor?.model,
      cwd: managerDescriptor?.cwd,
      managerAgentDir: this.config.paths.managerAgentDir,
      managerSystemPromptSource: managerDescriptor ? `archetype:${MANAGER_ARCHETYPE_ID}` : undefined,
      loadedArchetypeIds: this.archetypePromptRegistry.listArchetypeIds(),
      restoredAgentIds: Array.from(this.runtimes.keys())
    });
  }

  listAgents(): AgentDescriptor[] {
    return this.sortedDescriptors().map((descriptor) => cloneDescriptor(descriptor));
  }

  getConversationHistory(agentId?: string): ConversationEntryEvent[] {
    const resolvedAgentId = normalizeOptionalAgentId(agentId) ?? this.resolvePreferredManagerId();
    if (!resolvedAgentId) {
      return [];
    }

    let history = this.conversationEntriesByAgentId.get(resolvedAgentId);
    if (!history) {
      const descriptor = this.descriptors.get(resolvedAgentId);
      if (descriptor && !this.shouldPreloadHistoryForDescriptor(descriptor)) {
        history = this.loadConversationHistoryForDescriptor(descriptor);
      }
    }

    return (history ?? []).map((entry) => ({ ...entry }));
  }

  async spawnAgent(callerAgentId: string, input: SpawnAgentInput): Promise<AgentDescriptor> {
    const manager = this.assertManager(callerAgentId, "spawn agents");

    const requestedAgentId = input.agentId?.trim();
    if (!requestedAgentId) {
      throw new Error("spawn_agent requires a non-empty agentId");
    }

    const agentId = this.generateUniqueAgentId(requestedAgentId);
    const createdAt = this.now();

    const model = this.resolveSpawnModel(input.model, manager.model);
    const archetypeId = this.resolveSpawnWorkerArchetypeId(input, agentId);

    const descriptor: AgentDescriptor = {
      agentId,
      displayName: agentId,
      role: "worker",
      managerId: manager.agentId,
      archetypeId,
      status: "idle",
      createdAt,
      updatedAt: createdAt,
      cwd: input.cwd ? await this.resolveAndValidateCwd(input.cwd) : manager.cwd,
      model,
      sessionFile: join(this.config.paths.sessionsDir, `${agentId}.jsonl`)
    };

    this.descriptors.set(agentId, descriptor);
    await this.saveStore();

    this.logDebug("agent:spawn", {
      callerAgentId,
      agentId,
      managerId: descriptor.managerId,
      displayName: descriptor.displayName,
      archetypeId: descriptor.archetypeId,
      model: descriptor.model,
      cwd: descriptor.cwd
    });

    const explicitSystemPrompt = input.systemPrompt?.trim();
    const runtimeSystemPrompt =
      explicitSystemPrompt && explicitSystemPrompt.length > 0
        ? explicitSystemPrompt
        : this.resolveSystemPromptForDescriptor(descriptor);

    const runtime = await this.createRuntimeForDescriptor(descriptor, runtimeSystemPrompt);
    this.runtimes.set(agentId, runtime);

    const contextUsage = runtime.getContextUsage();
    descriptor.contextUsage = contextUsage;

    this.emitStatus(agentId, descriptor.status, runtime.getPendingCount(), contextUsage);
    this.emitAgentsSnapshot();

    if (input.initialMessage && input.initialMessage.trim().length > 0) {
      await this.sendMessage(callerAgentId, agentId, input.initialMessage, "auto", { origin: "internal" });
    }

    return cloneDescriptor(descriptor);
  }

  async killAgent(callerAgentId: string, targetAgentId: string): Promise<void> {
    const manager = this.assertManager(callerAgentId, "kill agents");

    const target = this.descriptors.get(targetAgentId);
    if (!target) {
      throw new Error(`Unknown agent: ${targetAgentId}`);
    }
    if (target.role === "manager") {
      throw new Error("Manager cannot be killed");
    }

    if (target.managerId !== manager.agentId) {
      throw new Error(`Only owning manager can kill agent ${targetAgentId}`);
    }

    await this.terminateDescriptor(target, { abort: true, emitStatus: false });
    await this.saveStore();

    this.logDebug("agent:kill", {
      callerAgentId,
      targetAgentId,
      managerId: manager.agentId
    });

    this.emitStatus(targetAgentId, target.status, 0);
    this.emitAgentsSnapshot();
  }

  async stopAllAgents(
    callerAgentId: string,
    targetManagerId: string
  ): Promise<{
    managerId: string;
    stoppedWorkerIds: string[];
    managerStopped: boolean;
    terminatedWorkerIds: string[];
    managerTerminated: boolean;
  }> {
    const manager = this.assertManager(callerAgentId, "stop all agents");

    const target = this.descriptors.get(targetManagerId);
    if (!target || target.role !== "manager") {
      throw new Error(`Unknown manager: ${targetManagerId}`);
    }

    if (target.agentId !== manager.agentId) {
      throw new Error(`Only selected manager can stop all agents for ${targetManagerId}`);
    }

    const stoppedWorkerIds: string[] = [];

    for (const descriptor of Array.from(this.descriptors.values())) {
      if (descriptor.role !== "worker") {
        continue;
      }

      if (descriptor.managerId !== targetManagerId) {
        continue;
      }

      if (descriptor.status === "terminated" || descriptor.status === "stopped_on_restart") {
        continue;
      }

      const runtime = this.runtimes.get(descriptor.agentId);
      if (runtime) {
        await runtime.stopInFlight({ abort: true });
      } else {
        descriptor.status = "idle";
        descriptor.updatedAt = this.now();
        this.descriptors.set(descriptor.agentId, descriptor);
        this.emitStatus(descriptor.agentId, descriptor.status, 0, descriptor.contextUsage);
      }

      stoppedWorkerIds.push(descriptor.agentId);
    }

    let managerStopped = false;
    if (target.status !== "terminated" && target.status !== "stopped_on_restart") {
      const managerRuntime = this.runtimes.get(target.agentId);
      if (managerRuntime) {
        await managerRuntime.stopInFlight({ abort: true });
      } else {
        target.status = "idle";
        target.updatedAt = this.now();
        this.descriptors.set(target.agentId, target);
        this.emitStatus(target.agentId, target.status, 0, target.contextUsage);
      }

      managerStopped = true;
    }

    await this.saveStore();
    this.emitAgentsSnapshot();

    this.logDebug("manager:stop_all", {
      callerAgentId,
      targetManagerId,
      stoppedWorkerIds,
      managerStopped
    });

    return {
      managerId: targetManagerId,
      stoppedWorkerIds,
      managerStopped,
      // Backward compatibility for older clients still expecting terminated-oriented fields.
      terminatedWorkerIds: stoppedWorkerIds,
      managerTerminated: managerStopped
    };
  }

  async createManager(
    callerAgentId: string,
    input: { name: string; cwd: string; model?: SwarmModelPreset }
  ): Promise<AgentDescriptor> {
    const callerDescriptor = this.descriptors.get(callerAgentId);
    if (!callerDescriptor || callerDescriptor.role !== "manager") {
      const canBootstrap = !this.hasRunningManagers();
      if (!canBootstrap) {
        throw new Error("Only manager can create managers");
      }
    } else if (callerDescriptor.status === "terminated" || callerDescriptor.status === "stopped_on_restart") {
      throw new Error(`Manager is not running: ${callerAgentId}`);
    }

    const requestedName = input.name?.trim();
    if (!requestedName) {
      throw new Error("create_manager requires a non-empty name");
    }

    const requestedModelPreset = parseSwarmModelPreset(input.model, "create_manager.model");
    const managerId = this.generateUniqueManagerId(requestedName);
    const createdAt = this.now();
    const cwd = await this.resolveAndValidateCwd(input.cwd);

    const descriptor: AgentDescriptor = {
      agentId: managerId,
      displayName: managerId,
      role: "manager",
      managerId,
      archetypeId: MANAGER_ARCHETYPE_ID,
      status: "idle",
      createdAt,
      updatedAt: createdAt,
      cwd,
      model: requestedModelPreset
        ? resolveModelDescriptorFromPreset(requestedModelPreset)
        : this.resolveDefaultModelDescriptor(),
      sessionFile: join(this.config.paths.sessionsDir, `${managerId}.jsonl`)
    };

    this.descriptors.set(descriptor.agentId, descriptor);

    let runtime: SwarmAgentRuntime;
    try {
      runtime = await this.createRuntimeForDescriptor(
        descriptor,
        this.resolveSystemPromptForDescriptor(descriptor)
      );
    } catch (error) {
      this.descriptors.delete(descriptor.agentId);
      throw error;
    }

    this.runtimes.set(managerId, runtime);
    await this.saveStore();

    const contextUsage = runtime.getContextUsage();
    descriptor.contextUsage = contextUsage;

    this.emitStatus(managerId, descriptor.status, runtime.getPendingCount(), contextUsage);
    this.emitAgentsSnapshot();

    this.logDebug("manager:create", {
      callerAgentId,
      managerId,
      cwd: descriptor.cwd
    });

    await this.sendManagerBootstrapMessage(managerId);

    return cloneDescriptor(descriptor);
  }

  async deleteManager(
    callerAgentId: string,
    targetManagerId: string
  ): Promise<{ managerId: string; terminatedWorkerIds: string[] }> {
    this.assertManager(callerAgentId, "delete managers");

    const target = this.descriptors.get(targetManagerId);
    if (!target || target.role !== "manager") {
      throw new Error(`Unknown manager: ${targetManagerId}`);
    }

    const terminatedWorkerIds: string[] = [];

    for (const descriptor of Array.from(this.descriptors.values())) {
      if (descriptor.role !== "worker") {
        continue;
      }
      if (descriptor.managerId !== targetManagerId) {
        continue;
      }

      terminatedWorkerIds.push(descriptor.agentId);
      await this.terminateDescriptor(descriptor, { abort: true, emitStatus: true });
      this.descriptors.delete(descriptor.agentId);
      this.conversationEntriesByAgentId.delete(descriptor.agentId);
    }

    await this.terminateDescriptor(target, { abort: true, emitStatus: true });
    this.descriptors.delete(targetManagerId);
    this.conversationEntriesByAgentId.delete(targetManagerId);

    await this.saveStore();
    this.emitAgentsSnapshot();

    this.logDebug("manager:delete", {
      callerAgentId,
      targetManagerId,
      terminatedWorkerIds
    });

    return { managerId: targetManagerId, terminatedWorkerIds };
  }

  getAgent(agentId: string): AgentDescriptor | undefined {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor) {
      return undefined;
    }

    return cloneDescriptor(descriptor);
  }

  async listDirectories(path?: string): Promise<DirectoryListingResult> {
    return listDirectories(path, this.getCwdPolicy());
  }

  async validateDirectory(path: string): Promise<DirectoryValidationResult> {
    return validateDirectoryInput(path, this.getCwdPolicy());
  }

  async pickDirectory(defaultPath?: string): Promise<string | null> {
    const pickedPath = await pickNativeDirectory({
      defaultPath,
      prompt: "Select a manager working directory"
    });

    if (!pickedPath) {
      return null;
    }

    return validateDirectoryPath(pickedPath, this.getCwdPolicy());
  }

  private resolveActivityManagerContextIds(...agents: AgentDescriptor[]): string[] {
    const managerContextIds = new Set<string>();

    for (const descriptor of agents) {
      if (descriptor.role === "manager") {
        managerContextIds.add(descriptor.agentId);
        continue;
      }

      const managerId = descriptor.managerId.trim();
      if (managerId.length > 0) {
        managerContextIds.add(managerId);
      }
    }

    return Array.from(managerContextIds);
  }

  async sendMessage(
    fromAgentId: string,
    targetAgentId: string,
    message: string,
    delivery: RequestedDeliveryMode = "auto",
    options?: { origin?: "user" | "internal"; attachments?: ConversationAttachment[] }
  ): Promise<SendMessageReceipt> {
    const sender = this.descriptors.get(fromAgentId);
    if (!sender || sender.status === "terminated") {
      throw new Error(`Unknown or terminated sender agent: ${fromAgentId}`);
    }

    const target = this.descriptors.get(targetAgentId);
    if (!target) {
      throw new Error(`Unknown target agent: ${targetAgentId}`);
    }
    if (target.status === "terminated" || target.status === "stopped_on_restart") {
      throw new Error(`Target agent is not running: ${targetAgentId}`);
    }

    if (sender.role === "manager" && target.role === "worker" && target.managerId !== sender.agentId) {
      throw new Error(`Manager ${sender.agentId} does not own worker ${targetAgentId}`);
    }

    const managerContextIds = this.resolveActivityManagerContextIds(sender, target);
    const runtime = this.runtimes.get(targetAgentId);
    if (!runtime) {
      throw new Error(`Target runtime is not available: ${targetAgentId}`);
    }

    const origin = options?.origin ?? "internal";
    const attachments = normalizeConversationAttachments(options?.attachments);
    const modelMessage = await this.prepareModelInboundMessage(
      targetAgentId,
      {
        text: message,
        attachments
      },
      origin
    );
    const receipt = await runtime.sendMessage(modelMessage, delivery);

    this.logDebug("agent:send_message", {
      fromAgentId,
      targetAgentId,
      origin,
      requestedDelivery: delivery,
      acceptedMode: receipt.acceptedMode,
      textPreview: previewForLog(message),
      attachmentCount: attachments.length,
      modelTextPreview: previewForLog(extractRuntimeMessageText(modelMessage))
    });

    if (origin !== "user" && fromAgentId !== targetAgentId) {
      for (const managerContextId of managerContextIds) {
        this.emitAgentMessage({
          type: "agent_message",
          agentId: managerContextId,
          timestamp: this.now(),
          source: "agent_to_agent",
          fromAgentId,
          toAgentId: targetAgentId,
          text: message,
          requestedDelivery: delivery,
          acceptedMode: receipt.acceptedMode,
          attachmentCount: attachments.length > 0 ? attachments.length : undefined
        });
      }
    }

    return receipt;
  }

  private async prepareModelInboundMessage(
    targetAgentId: string,
    input: { text: string; attachments: ConversationAttachment[] },
    origin: "user" | "internal"
  ): Promise<string | RuntimeUserMessage> {
    let text = input.text;

    if (origin !== "user") {
      if (text.trim().length > 0 && !/^system:/i.test(text.trimStart())) {
        text = `${INTERNAL_MODEL_MESSAGE_PREFIX}${text}`;
      }
    }

    const runtimeAttachments = await this.prepareRuntimeAttachments(targetAgentId, input.attachments);

    if (runtimeAttachments.attachmentMessage.length > 0) {
      text = text.trim().length > 0 ? `${text}\n\n${runtimeAttachments.attachmentMessage}` : runtimeAttachments.attachmentMessage;
    }

    if (runtimeAttachments.images.length === 0) {
      return text;
    }

    return {
      text,
      images: runtimeAttachments.images
    };
  }

  private async prepareRuntimeAttachments(
    targetAgentId: string,
    attachments: ConversationAttachment[]
  ): Promise<{ images: RuntimeImageAttachment[]; attachmentMessage: string }> {
    if (attachments.length === 0) {
      return {
        images: [],
        attachmentMessage: ""
      };
    }

    const images = toRuntimeImageAttachments(attachments);
    const fileMessages: string[] = [];
    const attachmentPathMessages: string[] = [];
    let binaryAttachmentDir: string | undefined;

    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index];
      const persistedPath = normalizeOptionalAttachmentPath(attachment.filePath);

      if (persistedPath) {
        attachmentPathMessages.push(`[Attached file saved to: ${persistedPath}]`);
      }

      if (isConversationImageAttachment(attachment)) {
        continue;
      }

      if (isConversationTextAttachment(attachment)) {
        fileMessages.push(formatTextAttachmentForPrompt(attachment, index + 1));
        continue;
      }

      if (isConversationBinaryAttachment(attachment)) {
        let storedPath = persistedPath;
        if (!storedPath) {
          const directory = binaryAttachmentDir ?? (await this.createBinaryAttachmentDir(targetAgentId));
          binaryAttachmentDir = directory;
          storedPath = await this.writeBinaryAttachmentToDisk(directory, attachment, index + 1);
        }
        fileMessages.push(formatBinaryAttachmentForPrompt(attachment, storedPath, index + 1));
      }
    }

    if (fileMessages.length === 0 && attachmentPathMessages.length === 0) {
      return {
        images,
        attachmentMessage: ""
      };
    }

    const attachmentMessageSections: string[] = [];
    if (fileMessages.length > 0) {
      attachmentMessageSections.push("The user attached the following files:", "", ...fileMessages);
    }
    if (attachmentPathMessages.length > 0) {
      if (attachmentMessageSections.length > 0) {
        attachmentMessageSections.push("");
      }
      attachmentMessageSections.push(...attachmentPathMessages);
    }

    return {
      images,
      attachmentMessage: attachmentMessageSections.join("\n")
    };
  }

  private async createBinaryAttachmentDir(targetAgentId: string): Promise<string> {
    const agentSegment = sanitizePathSegment(targetAgentId, "agent");
    const batchId = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    const directory = join(this.config.paths.dataDir, "attachments", agentSegment, batchId);
    await mkdir(directory, { recursive: true });
    return directory;
  }

  private async writeBinaryAttachmentToDisk(
    directory: string,
    attachment: ConversationBinaryAttachment,
    attachmentIndex: number
  ): Promise<string> {
    const safeName = sanitizeAttachmentFileName(attachment.fileName, `attachment-${attachmentIndex}.bin`);
    const filePath = join(directory, `${String(attachmentIndex).padStart(2, "0")}-${safeName}`);
    const buffer = Buffer.from(attachment.data, "base64");
    await writeFile(filePath, buffer);
    return filePath;
  }

  async publishToUser(
    agentId: string,
    text: string,
    source: "speak_to_user" | "system" = "speak_to_user",
    targetContext?: MessageTargetContext
  ): Promise<{ targetContext: MessageSourceContext }> {
    let resolvedTargetContext: MessageSourceContext;

    if (source === "speak_to_user") {
      this.assertManager(agentId, "speak to user");
      resolvedTargetContext = this.resolveReplyTargetContext(targetContext);
    } else {
      resolvedTargetContext = normalizeMessageSourceContext(targetContext ?? { channel: "web" });
    }

    const payload: ConversationMessageEvent = {
      type: "conversation_message",
      agentId,
      role: source === "system" ? "system" : "assistant",
      text,
      timestamp: this.now(),
      source,
      sourceContext: resolvedTargetContext
    };

    this.emitConversationMessage(payload);
    this.logDebug("manager:publish_to_user", {
      source,
      agentId,
      targetContext: resolvedTargetContext,
      textPreview: previewForLog(text)
    });

    return {
      targetContext: resolvedTargetContext
    };
  }

  async compactAgentContext(
    agentId: string,
    options?: {
      customInstructions?: string;
      sourceContext?: MessageSourceContext;
      trigger?: "api" | "slash_command";
    }
  ): Promise<unknown> {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor) {
      throw new Error(`Unknown target agent: ${agentId}`);
    }

    if (descriptor.status === "terminated" || descriptor.status === "stopped_on_restart") {
      throw new Error(`Target agent is not running: ${agentId}`);
    }

    if (descriptor.role !== "manager") {
      throw new Error(`Compaction is only supported for manager agents: ${agentId}`);
    }

    const runtime = this.runtimes.get(agentId);
    if (!runtime) {
      throw new Error(`Target runtime is not available: ${agentId}`);
    }

    const sourceContext = normalizeMessageSourceContext(options?.sourceContext ?? { channel: "web" });
    const customInstructions = options?.customInstructions?.trim() || undefined;

    this.logDebug("manager:compact:start", {
      agentId,
      trigger: options?.trigger ?? "api",
      sourceContext,
      customInstructionsPreview: previewForLog(customInstructions ?? "")
    });

    this.emitConversationMessage({
      type: "conversation_message",
      agentId,
      role: "system",
      text: "Compacting manager context...",
      timestamp: this.now(),
      source: "system",
      sourceContext
    });

    try {
      const result = await runtime.compact(customInstructions);

      this.emitConversationMessage({
        type: "conversation_message",
        agentId,
        role: "system",
        text: "Compaction complete.",
        timestamp: this.now(),
        source: "system",
        sourceContext
      });

      this.logDebug("manager:compact:complete", {
        agentId,
        trigger: options?.trigger ?? "api"
      });

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.emitConversationMessage({
        type: "conversation_message",
        agentId,
        role: "system",
        text: `Compaction failed: ${message}`,
        timestamp: this.now(),
        source: "system",
        sourceContext
      });

      this.logDebug("manager:compact:error", {
        agentId,
        trigger: options?.trigger ?? "api",
        message
      });

      throw error;
    }
  }

  async handleUserMessage(
    text: string,
    options?: {
      targetAgentId?: string;
      delivery?: RequestedDeliveryMode;
      attachments?: ConversationAttachment[];
      sourceContext?: MessageSourceContext;
    }
  ): Promise<void> {
    const trimmed = text.trim();
    const attachments = normalizeConversationAttachments(options?.attachments);
    if (!trimmed && attachments.length === 0) return;

    const sourceContext = normalizeMessageSourceContext(options?.sourceContext ?? { channel: "web" });

    const targetAgentId = options?.targetAgentId ?? this.resolvePreferredManagerId();
    if (!targetAgentId) {
      throw new Error("No manager is available. Create a manager first.");
    }
    const target = this.descriptors.get(targetAgentId);
    if (!target) {
      throw new Error(`Unknown target agent: ${targetAgentId}`);
    }
    if (target.status === "terminated" || target.status === "stopped_on_restart") {
      throw new Error(`Target agent is not running: ${targetAgentId}`);
    }

    const compactCommand =
      target.role === "manager" && attachments.length === 0 ? parseCompactSlashCommand(trimmed) : undefined;
    if (compactCommand) {
      this.logDebug("manager:user_message_compact_command", {
        targetAgentId: target.agentId,
        sourceContext,
        customInstructionsPreview: previewForLog(compactCommand.customInstructions ?? "")
      });
      await this.compactAgentContext(target.agentId, {
        customInstructions: compactCommand.customInstructions,
        sourceContext,
        trigger: "slash_command"
      });
      return;
    }

    const managerContextId = target.role === "manager" ? target.agentId : target.managerId;
    const receivedAt = this.now();

    this.logDebug("manager:user_message_received", {
      targetAgentId,
      managerContextId,
      sourceContext,
      textPreview: previewForLog(trimmed),
      attachmentCount: attachments.length
    });

    const userEvent: ConversationMessageEvent = {
      type: "conversation_message",
      agentId: targetAgentId,
      role: "user",
      text: trimmed,
      attachments: attachments.length > 0 ? attachments : undefined,
      timestamp: receivedAt,
      source: "user_input",
      sourceContext
    };
    this.emitConversationMessage(userEvent);

    if (target.role !== "manager") {
      const requestedDelivery = options?.delivery ?? "auto";
      let receipt: SendMessageReceipt;
      try {
        receipt = await this.sendMessage(managerContextId, targetAgentId, trimmed, requestedDelivery, {
          origin: "user",
          attachments
        });
      } catch (error) {
        this.logDebug("manager:user_message_dispatch_error", {
          managerContextId,
          targetAgentId,
          targetRole: target.role,
          requestedDelivery,
          sourceContext,
          textPreview: previewForLog(trimmed),
          attachmentCount: attachments.length,
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        });
        throw error;
      }

      this.logDebug("manager:user_message_dispatch_complete", {
        managerContextId,
        targetAgentId,
        targetRole: target.role,
        requestedDelivery,
        acceptedMode: receipt.acceptedMode,
        sourceContext,
        attachmentCount: attachments.length
      });

      this.emitAgentMessage({
        type: "agent_message",
        agentId: managerContextId,
        timestamp: this.now(),
        source: "user_to_agent",
        toAgentId: targetAgentId,
        text: trimmed,
        sourceContext,
        requestedDelivery,
        acceptedMode: receipt.acceptedMode,
        attachmentCount: attachments.length > 0 ? attachments.length : undefined
      });
      return;
    }

    const managerRuntime = this.runtimes.get(managerContextId);
    if (!managerRuntime) {
      this.logDebug("manager:user_message_dispatch_error", {
        managerContextId,
        targetAgentId: managerContextId,
        targetRole: target.role,
        requestedDelivery: "steer",
        sourceContext,
        textPreview: previewForLog(trimmed),
        attachmentCount: attachments.length,
        message: `Manager runtime is not initialized: ${managerContextId}`
      });
      throw new Error(`Manager runtime is not initialized: ${managerContextId}`);
    }

    const managerVisibleMessage = formatInboundUserMessageForManager(trimmed, sourceContext);

    // User messages to managers should always steer in-flight work.
    const runtimeMessage = await this.prepareModelInboundMessage(
      managerContextId,
      {
        text: managerVisibleMessage,
        attachments
      },
      "user"
    );

    this.logDebug("manager:user_message_dispatch_start", {
      managerContextId,
      targetAgentId: managerContextId,
      targetRole: target.role,
      requestedDelivery: "steer",
      sourceContext,
      textPreview: previewForLog(trimmed),
      attachmentCount: attachments.length,
      runtimeTextPreview: previewForLog(extractRuntimeMessageText(runtimeMessage)),
      runtimeImageCount: typeof runtimeMessage === "string" ? 0 : (runtimeMessage.images?.length ?? 0)
    });

    try {
      const receipt = await managerRuntime.sendMessage(runtimeMessage, "steer");
      this.logDebug("manager:user_message_dispatch_complete", {
        managerContextId,
        targetAgentId: managerContextId,
        targetRole: target.role,
        requestedDelivery: "steer",
        acceptedMode: receipt.acceptedMode,
        sourceContext,
        attachmentCount: attachments.length
      });
    } catch (error) {
      this.logDebug("manager:user_message_dispatch_error", {
        managerContextId,
        targetAgentId: managerContextId,
        targetRole: target.role,
        requestedDelivery: "steer",
        sourceContext,
        textPreview: previewForLog(trimmed),
        attachmentCount: attachments.length,
        runtimeTextPreview: previewForLog(extractRuntimeMessageText(runtimeMessage)),
        runtimeImageCount: typeof runtimeMessage === "string" ? 0 : (runtimeMessage.images?.length ?? 0),
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      throw error;
    }
  }

  async resetManagerSession(
    managerIdOrReason: string | "user_new_command" | "api_reset" = "api_reset",
    maybeReason?: "user_new_command" | "api_reset"
  ): Promise<void> {
    const parsed = this.parseResetManagerSessionArgs(managerIdOrReason, maybeReason);
    const managerId = parsed.managerId;
    const reason = parsed.reason;
    const managerDescriptor = this.getRequiredManagerDescriptor(managerId);

    this.logDebug("manager:reset:start", {
      managerId,
      reason,
      sessionFile: managerDescriptor.sessionFile
    });

    const existingRuntime = this.runtimes.get(managerId);
    if (existingRuntime) {
      await existingRuntime.terminate({ abort: true });
      this.runtimes.delete(managerId);
    }

    this.conversationEntriesByAgentId.set(managerId, []);
    await this.deleteManagerSessionFile(managerDescriptor.sessionFile);

    managerDescriptor.status = "idle";
    managerDescriptor.contextUsage = undefined;
    managerDescriptor.updatedAt = this.now();
    this.descriptors.set(managerId, managerDescriptor);
    await this.saveStore();

    const managerRuntime = await this.createRuntimeForDescriptor(
      managerDescriptor,
      this.resolveSystemPromptForDescriptor(managerDescriptor)
    );
    this.runtimes.set(managerId, managerRuntime);

    const contextUsage = managerRuntime.getContextUsage();
    managerDescriptor.contextUsage = contextUsage;

    this.emitConversationReset(managerId, reason);
    this.emitStatus(managerId, managerDescriptor.status, managerRuntime.getPendingCount(), contextUsage);
    this.emitAgentsSnapshot();

    this.logDebug("manager:reset:ready", {
      managerId,
      reason,
      sessionFile: managerDescriptor.sessionFile
    });
  }

  getConfig(): SwarmConfig {
    return this.config;
  }

  async listSettingsModels(): Promise<{
    defaultModelPreset: SwarmModelPreset;
    models: Array<{
      preset: SwarmModelPreset;
      provider: string;
      modelId: string;
      thinkingLevel: string;
      available: boolean;
    }>;
  }> {
    const authStorage = AuthStorage.create(this.config.paths.authFile);
    const modelRegistry = new ModelRegistry(authStorage);
    const modelHints = getModelAvailabilityHints(modelRegistry);

    return {
      defaultModelPreset: this.config.defaultModelPreset ?? DEFAULT_SWARM_MODEL_PRESET,
      models: modelHints.map((hint) => ({
        preset: hint.preset,
        provider: hint.descriptor.provider,
        modelId: hint.descriptor.modelId,
        thinkingLevel: hint.descriptor.thinkingLevel,
        available: hint.available
      }))
    };
  }

  async listSettingsEnv(): Promise<SkillEnvRequirement[]> {
    if (this.skillMetadata.length === 0) {
      await this.reloadSkillMetadata();
    }

    const requirements: SkillEnvRequirement[] = [];

    for (const skill of this.skillMetadata) {
      for (const declaration of skill.env) {
        const resolvedValue = this.resolveEnvValue(declaration.name);
        requirements.push({
          name: declaration.name,
          description: declaration.description,
          required: declaration.required,
          helpUrl: declaration.helpUrl,
          skillName: skill.skillName,
          isSet: typeof resolvedValue === "string" && resolvedValue.trim().length > 0,
          maskedValue: resolvedValue ? SETTINGS_ENV_MASK : undefined
        });
      }
    }

    if (!requirements.some((requirement) => requirement.name === "CODEX_API_KEY")) {
      const codexApiKey = this.resolveEnvValue("CODEX_API_KEY");
      requirements.push({
        name: "CODEX_API_KEY",
        description: "API key used by the codex-app runtime when no existing Codex login session is available.",
        required: false,
        helpUrl: "https://platform.openai.com/api-keys",
        skillName: "codex-app-runtime",
        isSet: typeof codexApiKey === "string" && codexApiKey.trim().length > 0,
        maskedValue: codexApiKey ? SETTINGS_ENV_MASK : undefined
      });
    }

    requirements.sort((left, right) => {
      const byName = left.name.localeCompare(right.name);
      if (byName !== 0) return byName;
      return left.skillName.localeCompare(right.skillName);
    });

    return requirements;
  }

  async updateSettingsEnv(values: Record<string, string>): Promise<void> {
    const entries = Object.entries(values);
    if (entries.length === 0) {
      return;
    }

    for (const [rawName, rawValue] of entries) {
      const normalizedName = normalizeEnvVarName(rawName);
      if (!normalizedName) {
        throw new Error(`Invalid environment variable name: ${rawName}`);
      }

      const normalizedValue = typeof rawValue === "string" ? rawValue.trim() : "";
      if (!normalizedValue) {
        throw new Error(`Environment variable ${normalizedName} must be a non-empty string`);
      }

      this.secrets[normalizedName] = normalizedValue;
      this.applySecretToProcessEnv(normalizedName, normalizedValue);
    }

    await this.saveSecretsStore();
    this.refreshShuvdoClient();
  }

  async deleteSettingsEnv(name: string): Promise<void> {
    const normalizedName = normalizeEnvVarName(name);
    if (!normalizedName) {
      throw new Error(`Invalid environment variable name: ${name}`);
    }

    if (!(normalizedName in this.secrets)) {
      return;
    }

    delete this.secrets[normalizedName];
    this.restoreProcessEnvForSecret(normalizedName);
    await this.saveSecretsStore();
    this.refreshShuvdoClient();
  }

  async listSettingsAuth(): Promise<SettingsAuthProvider[]> {
    const authStorage = AuthStorage.create(this.config.paths.authFile);

    return SETTINGS_AUTH_PROVIDER_DEFINITIONS.map((definition) => {
      const credential = authStorage.get(definition.storageProvider);
      const resolvedToken = extractAuthCredentialToken(credential);

      return {
        provider: definition.provider,
        configured: typeof resolvedToken === "string" && resolvedToken.length > 0,
        authType: resolveAuthCredentialType(credential),
        maskedValue: resolvedToken ? maskSettingsAuthValue(resolvedToken) : undefined
      } satisfies SettingsAuthProvider;
    });
  }

  async updateSettingsAuth(values: Record<string, string>): Promise<void> {
    const entries = Object.entries(values);
    if (entries.length === 0) {
      return;
    }

    const authStorage = AuthStorage.create(this.config.paths.authFile);

    for (const [rawProvider, rawValue] of entries) {
      const resolvedProvider = resolveSettingsAuthProvider(rawProvider);
      if (!resolvedProvider) {
        throw new Error(`Invalid auth provider: ${rawProvider}`);
      }

      const normalizedValue = typeof rawValue === "string" ? rawValue.trim() : "";
      if (!normalizedValue) {
        throw new Error(`Auth value for ${resolvedProvider.provider} must be a non-empty string`);
      }

      const credential = {
        type: "api_key",
        key: normalizedValue,
        access: normalizedValue,
        refresh: "",
        expires: ""
      };

      authStorage.set(resolvedProvider.storageProvider, credential as unknown as AuthCredential);
    }
  }

  async deleteSettingsAuth(provider: string): Promise<void> {
    const resolvedProvider = resolveSettingsAuthProvider(provider);
    if (!resolvedProvider) {
      throw new Error(`Invalid auth provider: ${provider}`);
    }

    const authStorage = AuthStorage.create(this.config.paths.authFile);
    authStorage.remove(resolvedProvider.storageProvider);
  }

  private emitConversationMessage(event: ConversationMessageEvent): void {
    this.emitConversationEntry(event);
    this.emit("conversation_message", event satisfies ServerEvent);
  }

  private emitConversationLog(event: ConversationLogEvent): void {
    this.emitConversationEntry(event);
    this.emit("conversation_log", event satisfies ServerEvent);
  }

  private emitAgentMessage(event: AgentMessageEvent): void {
    this.emitConversationEntry(event);
    this.emit("agent_message", event satisfies ServerEvent);
  }

  private emitAgentToolCall(event: AgentToolCallEvent): void {
    this.emitConversationEntry(event);
    this.emit("agent_tool_call", event satisfies ServerEvent);
  }

  private emitConversationEntry(event: ConversationEntryEvent): void {
    const history = this.conversationEntriesByAgentId.get(event.agentId) ?? [];
    history.push(event);
    if (history.length > MAX_CONVERSATION_HISTORY) {
      history.splice(0, history.length - MAX_CONVERSATION_HISTORY);
    }
    this.conversationEntriesByAgentId.set(event.agentId, history);

    const runtime = this.runtimes.get(event.agentId);
    if (!runtime) {
      return;
    }

    try {
      runtime.appendCustomEntry(CONVERSATION_ENTRY_TYPE, event);
    } catch (error) {
      this.logDebug("history:save:error", {
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private emitConversationReset(agentId: string, reason: "user_new_command" | "api_reset"): void {
    this.emit(
      "conversation_reset",
      {
        type: "conversation_reset",
        agentId,
        timestamp: this.now(),
        reason
      } satisfies ServerEvent
    );
  }

  private logDebug(message: string, details?: unknown): void {
    if (!this.config.debug) return;

    const prefix = `[swarm][${this.now()}] ${message}`;
    if (details === undefined) {
      console.log(prefix);
      return;
    }
    console.log(prefix, details);
  }

  private getConfiguredManagerId(): string | undefined {
    return normalizeOptionalAgentId(this.config.managerId);
  }

  private ensurePrimaryManagerForBoot(): void {
    const hasActiveManager = Array.from(this.descriptors.values()).some(
      (descriptor) => descriptor.role === "manager" && descriptor.status !== "terminated"
    );

    if (hasActiveManager) {
      return;
    }

    const configuredManagerId = this.getConfiguredManagerId() ?? "manager";
    const managerId = this.generateUniqueManagerId(configuredManagerId);
    const createdAt = this.now();

    const descriptor: AgentDescriptor = {
      agentId: managerId,
      displayName: managerId,
      role: "manager",
      managerId,
      archetypeId: MANAGER_ARCHETYPE_ID,
      status: "idle",
      createdAt,
      updatedAt: createdAt,
      cwd: this.config.defaultCwd,
      model: this.resolveDefaultModelDescriptor(),
      sessionFile: join(this.config.paths.sessionsDir, `${managerId}.jsonl`)
    };

    this.descriptors.set(managerId, descriptor);
  }

  private resolvePreferredManagerId(options?: { includeStoppedOnRestart?: boolean }): string | undefined {
    const includeStoppedOnRestart = options?.includeStoppedOnRestart ?? false;
    const configuredManagerId = this.getConfiguredManagerId();
    if (configuredManagerId) {
      const configuredManager = this.descriptors.get(configuredManagerId);
      if (configuredManager && this.isAvailableManagerDescriptor(configuredManager, includeStoppedOnRestart)) {
        return configuredManagerId;
      }
    }

    const firstManager = Array.from(this.descriptors.values())
      .filter((descriptor) => this.isAvailableManagerDescriptor(descriptor, includeStoppedOnRestart))
      .sort((left, right) => {
        if (left.createdAt !== right.createdAt) {
          return left.createdAt.localeCompare(right.createdAt);
        }
        return left.agentId.localeCompare(right.agentId);
      })[0];

    return firstManager?.agentId;
  }

  private isAvailableManagerDescriptor(
    descriptor: AgentDescriptor,
    includeStoppedOnRestart: boolean
  ): boolean {
    if (descriptor.role !== "manager") {
      return false;
    }

    if (descriptor.status === "terminated") {
      return false;
    }

    if (!includeStoppedOnRestart && descriptor.status === "stopped_on_restart") {
      return false;
    }

    return true;
  }

  private sortedDescriptors(): AgentDescriptor[] {
    const configuredManagerId = this.getConfiguredManagerId();
    return Array.from(this.descriptors.values()).sort((a, b) => {
      if (configuredManagerId) {
        if (a.agentId === configuredManagerId) return -1;
        if (b.agentId === configuredManagerId) return 1;
      }

      if (a.role === "manager" && b.role !== "manager") return -1;
      if (b.role === "manager" && a.role !== "manager") return 1;

      if (a.createdAt !== b.createdAt) {
        return a.createdAt.localeCompare(b.createdAt);
      }

      return a.agentId.localeCompare(b.agentId);
    });
  }

  private async sendManagerBootstrapMessage(managerId: string): Promise<void> {
    const manager = this.descriptors.get(managerId);
    if (!manager || manager.role !== "manager") {
      return;
    }

    if (manager.status === "terminated" || manager.status === "stopped_on_restart") {
      return;
    }

    if (!this.runtimes.has(managerId)) {
      return;
    }

    try {
      await this.sendMessage(managerId, managerId, MANAGER_BOOTSTRAP_INTERVIEW_MESSAGE, "auto", {
        origin: "internal"
      });
      this.logDebug("manager:bootstrap_message:sent", { managerId });
    } catch (error) {
      this.logDebug("manager:bootstrap_message:error", {
        managerId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async restoreRuntimesForBoot(): Promise<void> {
    let shouldPersist = false;
    const configuredManagerId = this.getConfiguredManagerId();

    for (const descriptor of this.sortedDescriptors()) {
      if (!this.shouldRestoreRuntimeForDescriptor(descriptor)) {
        continue;
      }

      const systemPrompt = this.resolveSystemPromptForDescriptor(descriptor);

      try {
        const runtime = await this.createRuntimeForDescriptor(descriptor, systemPrompt);
        this.runtimes.set(descriptor.agentId, runtime);

        if (descriptor.status !== "idle") {
          descriptor.status = "idle";
          descriptor.updatedAt = this.now();
          shouldPersist = true;
        }

        const contextUsage = runtime.getContextUsage();
        descriptor.contextUsage = contextUsage;
        this.emitStatus(descriptor.agentId, descriptor.status, runtime.getPendingCount(), contextUsage);
      } catch (error) {
        if (
          descriptor.role === "manager" &&
          configuredManagerId &&
          descriptor.agentId === configuredManagerId
        ) {
          throw error;
        }

        descriptor.status = "stopped_on_restart";
        descriptor.contextUsage = undefined;
        descriptor.updatedAt = this.now();
        this.descriptors.set(descriptor.agentId, descriptor);
        shouldPersist = true;

        this.emitStatus(descriptor.agentId, descriptor.status, 0);
        this.logDebug("boot:restore_runtime:error", {
          agentId: descriptor.agentId,
          role: descriptor.role,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }

    if (shouldPersist) {
      await this.saveStore();
    }

    if (configuredManagerId) {
      const primaryManager = this.descriptors.get(configuredManagerId);
      if (
        primaryManager &&
        primaryManager.role === "manager" &&
        primaryManager.status !== "terminated" &&
        !this.runtimes.has(configuredManagerId)
      ) {
        throw new Error("Primary manager runtime is not initialized");
      }
    }
  }

  private shouldRestoreRuntimeForDescriptor(descriptor: AgentDescriptor): boolean {
    return descriptor.status === "idle" || descriptor.status === "streaming";
  }

  private getBootLogManagerDescriptor(): AgentDescriptor | undefined {
    const configuredManagerId = this.getConfiguredManagerId();
    if (configuredManagerId) {
      const configuredManager = this.descriptors.get(configuredManagerId);
      if (configuredManager && configuredManager.role === "manager" && configuredManager.status !== "terminated") {
        return configuredManager;
      }
    }

    return Array.from(this.descriptors.values()).find(
      (descriptor) => descriptor.role === "manager" && descriptor.status !== "terminated"
    );
  }

  private getRequiredManagerDescriptor(managerId: string): AgentDescriptor {
    const descriptor = this.descriptors.get(managerId);
    if (!descriptor || descriptor.role !== "manager") {
      throw new Error(`Unknown manager: ${managerId}`);
    }

    return descriptor;
  }

  private resolveDefaultModelDescriptor(): AgentModelDescriptor {
    return resolveModelDescriptorFromPreset(this.defaultModelPreset);
  }

  private normalizePersistedModelDescriptor(
    descriptor: Pick<AgentModelDescriptor, "provider" | "modelId"> | undefined
  ): AgentModelDescriptor {
    return normalizeSwarmModelDescriptor(descriptor, this.defaultModelPreset);
  }

  private resolveSpawnModel(
    requested: SpawnAgentInput["model"] | undefined,
    fallback: AgentModelDescriptor
  ): AgentModelDescriptor {
    const requestedPreset = parseSwarmModelPreset(requested, "spawn_agent.model");
    if (requestedPreset) {
      return resolveModelDescriptorFromPreset(requestedPreset);
    }

    return this.normalizePersistedModelDescriptor(fallback);
  }

  private resolveSpawnWorkerArchetypeId(
    input: SpawnAgentInput,
    normalizedAgentId: string
  ): string | undefined {
    if (input.archetypeId !== undefined) {
      const explicit = normalizeArchetypeId(input.archetypeId);
      if (!explicit) {
        throw new Error("spawn_agent archetypeId must include at least one letter or number");
      }
      if (!this.archetypePromptRegistry.resolvePrompt(explicit)) {
        throw new Error(`Unknown archetypeId: ${explicit}`);
      }
      return explicit;
    }

    if (
      normalizedAgentId === MERGER_ARCHETYPE_ID ||
      normalizedAgentId.startsWith(`${MERGER_ARCHETYPE_ID}-`)
    ) {
      return MERGER_ARCHETYPE_ID;
    }

    return undefined;
  }

  private resolveSystemPromptForDescriptor(descriptor: AgentDescriptor): string {
    if (descriptor.role === "manager") {
      return this.resolveRequiredArchetypePrompt(MANAGER_ARCHETYPE_ID);
    }

    if (descriptor.archetypeId) {
      const archetypePrompt = this.archetypePromptRegistry.resolvePrompt(descriptor.archetypeId);
      if (archetypePrompt) {
        return archetypePrompt;
      }
    }

    return DEFAULT_WORKER_SYSTEM_PROMPT;
  }

  private resolveRequiredArchetypePrompt(archetypeId: string): string {
    const prompt = this.archetypePromptRegistry.resolvePrompt(archetypeId);
    if (!prompt) {
      throw new Error(`Missing archetype prompt: ${archetypeId}`);
    }
    return prompt;
  }

  private async resolveAndValidateCwd(cwd: string): Promise<string> {
    return validateDirectoryPath(cwd, this.getCwdPolicy());
  }

  private getCwdPolicy(): { rootDir: string; allowlistRoots: string[] } {
    return {
      rootDir: this.config.paths.rootDir,
      allowlistRoots: normalizeAllowlistRoots(this.config.cwdAllowlistRoots)
    };
  }

  private generateUniqueAgentId(source: string): string {
    const base = normalizeAgentId(source);

    if (!base) {
      throw new Error("spawn_agent agentId must include at least one letter or number");
    }

    const configuredManagerId = this.getConfiguredManagerId();
    if (configuredManagerId && base === configuredManagerId) {
      throw new Error(`spawn_agent agentId \"${configuredManagerId}\" is reserved`);
    }

    if (!this.descriptors.has(base)) {
      return base;
    }

    let index = 2;
    while (this.descriptors.has(`${base}-${index}`)) {
      index += 1;
    }

    return `${base}-${index}`;
  }

  private generateUniqueManagerId(source: string): string {
    const base = normalizeAgentId(source);
    if (!base) {
      throw new Error("create_manager name must include at least one letter or number");
    }

    if (!this.descriptors.has(base)) {
      return base;
    }

    let index = 2;
    while (this.descriptors.has(`${base}-${index}`)) {
      index += 1;
    }

    return `${base}-${index}`;
  }

  private assertManager(agentId: string, action: string): AgentDescriptor {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "manager") {
      throw new Error(`Only manager can ${action}`);
    }

    if (descriptor.status === "terminated" || descriptor.status === "stopped_on_restart") {
      throw new Error(`Manager is not running: ${agentId}`);
    }

    return descriptor;
  }

  private hasRunningManagers(): boolean {
    for (const descriptor of this.descriptors.values()) {
      if (descriptor.role !== "manager") {
        continue;
      }

      if (descriptor.status === "terminated" || descriptor.status === "stopped_on_restart") {
        continue;
      }

      return true;
    }

    return false;
  }

  private resolveReplyTargetContext(explicitTargetContext?: MessageTargetContext): MessageSourceContext {
    if (!explicitTargetContext) {
      return { channel: "web" };
    }

    const normalizedExplicitTarget = normalizeMessageTargetContext(explicitTargetContext);

    if (
      (normalizedExplicitTarget.channel === "slack" ||
        normalizedExplicitTarget.channel === "telegram") &&
      !normalizedExplicitTarget.channelId
    ) {
      throw new Error(
        'speak_to_user target.channelId is required when target.channel is "slack" or "telegram"'
      );
    }

    return normalizeMessageSourceContext(normalizedExplicitTarget);
  }

  private parseResetManagerSessionArgs(
    managerIdOrReason: string | "user_new_command" | "api_reset",
    maybeReason?: "user_new_command" | "api_reset"
  ): { managerId: string; reason: "user_new_command" | "api_reset" } {
    if (managerIdOrReason === "user_new_command" || managerIdOrReason === "api_reset") {
      const managerId = this.resolvePreferredManagerId({ includeStoppedOnRestart: true });
      if (!managerId) {
        throw new Error("No manager is available.");
      }

      return {
        managerId,
        reason: managerIdOrReason
      };
    }

    return {
      managerId: managerIdOrReason,
      reason: maybeReason ?? "api_reset"
    };
  }

  private async terminateDescriptor(
    descriptor: AgentDescriptor,
    options: { abort: boolean; emitStatus: boolean }
  ): Promise<void> {
    const runtime = this.runtimes.get(descriptor.agentId);
    if (runtime) {
      await runtime.terminate({ abort: options.abort });
      this.runtimes.delete(descriptor.agentId);
    }

    descriptor.status = "terminated";
    descriptor.contextUsage = undefined;
    descriptor.updatedAt = this.now();
    this.descriptors.set(descriptor.agentId, descriptor);

    if (options.emitStatus) {
      this.emitStatus(descriptor.agentId, descriptor.status, 0);
    }
  }

  protected async getMemoryRuntimeResources(descriptor: AgentDescriptor): Promise<{
    memoryContextFile: { path: string; content: string };
    additionalSkillPaths: string[];
  }> {
    await this.ensureAgentMemoryFile(descriptor.agentId);

    const memoryOwnerAgentId = this.resolveMemoryOwnerAgentId(descriptor);
    const memoryFilePath = this.getAgentMemoryPath(memoryOwnerAgentId);
    await this.ensureAgentMemoryFile(memoryOwnerAgentId);

    if (this.skillMetadata.length === 0) {
      await this.reloadSkillMetadata();
    }

    const memoryContextFile = {
      path: memoryFilePath,
      content: await readFile(memoryFilePath, "utf8")
    };

    return {
      memoryContextFile,
      additionalSkillPaths: this.skillMetadata.map((skill) => skill.path)
    };
  }

  private resolveMemorySkillPath(): string {
    return this.resolveBuiltInSkillPath({
      skillName: "memory",
      repoOverridePath: this.config.paths.repoMemorySkillFile,
      repositoryRelativePath: BUILT_IN_MEMORY_SKILL_RELATIVE_PATH,
      fallbackPath: BUILT_IN_MEMORY_SKILL_FALLBACK_PATH
    });
  }

  private resolveBraveSearchSkillPath(): string {
    return this.resolveBuiltInSkillPath({
      skillName: "brave-search",
      repoOverridePath: resolve(this.config.paths.rootDir, REPO_BRAVE_SEARCH_SKILL_RELATIVE_PATH),
      repositoryRelativePath: BUILT_IN_BRAVE_SEARCH_SKILL_RELATIVE_PATH,
      fallbackPath: BUILT_IN_BRAVE_SEARCH_SKILL_FALLBACK_PATH
    });
  }

  private resolveCronSchedulingSkillPath(): string {
    return this.resolveBuiltInSkillPath({
      skillName: "cron-scheduling",
      repoOverridePath: resolve(this.config.paths.rootDir, REPO_CRON_SCHEDULING_SKILL_RELATIVE_PATH),
      repositoryRelativePath: BUILT_IN_CRON_SCHEDULING_SKILL_RELATIVE_PATH,
      fallbackPath: BUILT_IN_CRON_SCHEDULING_SKILL_FALLBACK_PATH
    });
  }

  private resolveAgentBrowserSkillPath(): string {
    return this.resolveBuiltInSkillPath({
      skillName: "agent-browser",
      repoOverridePath: resolve(this.config.paths.rootDir, REPO_AGENT_BROWSER_SKILL_RELATIVE_PATH),
      repositoryRelativePath: BUILT_IN_AGENT_BROWSER_SKILL_RELATIVE_PATH,
      fallbackPath: BUILT_IN_AGENT_BROWSER_SKILL_FALLBACK_PATH
    });
  }

  private resolveImageGenerationSkillPath(): string {
    return this.resolveBuiltInSkillPath({
      skillName: "image-generation",
      repoOverridePath: resolve(this.config.paths.rootDir, REPO_IMAGE_GENERATION_SKILL_RELATIVE_PATH),
      repositoryRelativePath: BUILT_IN_IMAGE_GENERATION_SKILL_RELATIVE_PATH,
      fallbackPath: BUILT_IN_IMAGE_GENERATION_SKILL_FALLBACK_PATH
    });
  }

  private resolveGsuiteSkillPath(): string {
    return this.resolveBuiltInSkillPath({
      skillName: "gsuite",
      repoOverridePath: resolve(this.config.paths.rootDir, REPO_GSUITE_SKILL_RELATIVE_PATH),
      repositoryRelativePath: BUILT_IN_GSUITE_SKILL_RELATIVE_PATH,
      fallbackPath: BUILT_IN_GSUITE_SKILL_FALLBACK_PATH
    });
  }

  private resolveShuvdoSkillPath(): string {
    return this.resolveBuiltInSkillPath({
      skillName: "shuvdo",
      repoOverridePath: resolve(this.config.paths.rootDir, REPO_SHUVDO_SKILL_RELATIVE_PATH),
      repositoryRelativePath: BUILT_IN_SHUVDO_SKILL_RELATIVE_PATH,
      fallbackPath: BUILT_IN_SHUVDO_SKILL_FALLBACK_PATH
    });
  }

  private async reloadSkillMetadata(): Promise<void> {
    const skillPaths = [
      {
        fallbackSkillName: "memory",
        path: this.resolveMemorySkillPath()
      },
      {
        fallbackSkillName: "brave-search",
        path: this.resolveBraveSearchSkillPath()
      },
      {
        fallbackSkillName: "cron-scheduling",
        path: this.resolveCronSchedulingSkillPath()
      },
      {
        fallbackSkillName: "agent-browser",
        path: this.resolveAgentBrowserSkillPath()
      },
      {
        fallbackSkillName: "image-generation",
        path: this.resolveImageGenerationSkillPath()
      },
      {
        fallbackSkillName: "gsuite",
        path: this.resolveGsuiteSkillPath()
      },
      {
        fallbackSkillName: "shuvdo",
        path: this.resolveShuvdoSkillPath()
      }
    ];

    const metadata: SkillMetadata[] = [];

    for (const skillPath of skillPaths) {
      const markdown = await readFile(skillPath.path, "utf8");
      const parsed = parseSkillFrontmatter(markdown);

      metadata.push({
        skillName: parsed.name ?? skillPath.fallbackSkillName,
        path: skillPath.path,
        env: parsed.env
      });
    }

    this.skillMetadata = metadata;
  }

  private resolveEnvValue(name: string): string | undefined {
    const secretValue = this.secrets[name];
    if (typeof secretValue === "string" && secretValue.trim().length > 0) {
      return secretValue;
    }

    const processValue = process.env[name];
    if (typeof processValue !== "string" || processValue.trim().length === 0) {
      return undefined;
    }

    return processValue;
  }

  private refreshShuvdoClient(): void {
    const baseUrl = this.resolveEnvValue("SHUVDO_API")?.trim();
    const token = this.resolveEnvValue("SHUVDO_TOKEN")?.trim();

    if (!baseUrl || !token) {
      this.shuvdoClient = undefined;
      return;
    }

    this.shuvdoClient = createShuvdoClient({
      baseUrl,
      token,
      onTelemetry: (event) => {
        this.logDebug("telemetry:shuvdo_tool", event);
      }
    });
  }

  private async loadSecretsStore(): Promise<void> {
    this.secrets = await this.readSecretsStore();

    for (const [name, value] of Object.entries(this.secrets)) {
      this.applySecretToProcessEnv(name, value);
    }
  }

  private async readSecretsStore(): Promise<Record<string, string>> {
    let raw: string;

    try {
      raw = await readFile(this.config.paths.secretsFile, "utf8");
    } catch (error) {
      if (isEnoentError(error)) {
        return {};
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {};
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const normalized: Record<string, string> = {};

    for (const [rawName, rawValue] of Object.entries(parsed)) {
      const normalizedName = normalizeEnvVarName(rawName);
      if (!normalizedName) {
        continue;
      }

      if (typeof rawValue !== "string") {
        continue;
      }

      const normalizedValue = rawValue.trim();
      if (!normalizedValue) {
        continue;
      }

      normalized[normalizedName] = normalizedValue;
    }

    return normalized;
  }

  private async saveSecretsStore(): Promise<void> {
    const target = this.config.paths.secretsFile;
    const tmp = `${target}.tmp`;

    await mkdir(dirname(target), { recursive: true });
    await writeFile(tmp, `${JSON.stringify(this.secrets, null, 2)}\n`, "utf8");
    await rename(tmp, target);
  }

  private applySecretToProcessEnv(name: string, value: string): void {
    if (!this.originalProcessEnvByName.has(name)) {
      this.originalProcessEnvByName.set(name, process.env[name]);
    }

    process.env[name] = value;
  }

  private restoreProcessEnvForSecret(name: string): void {
    const original = this.originalProcessEnvByName.get(name);

    if (original === undefined) {
      delete process.env[name];
      return;
    }

    process.env[name] = original;
  }

  private resolveBuiltInSkillPath(options: {
    skillName: string;
    repoOverridePath: string;
    repositoryRelativePath: string;
    fallbackPath: string;
  }): string {
    const { skillName, repoOverridePath, repositoryRelativePath, fallbackPath } = options;

    if (existsSync(repoOverridePath)) {
      return repoOverridePath;
    }

    const candidatePaths = [resolve(this.config.paths.rootDir, repositoryRelativePath), fallbackPath];

    for (const candidatePath of candidatePaths) {
      if (existsSync(candidatePath)) {
        return candidatePath;
      }
    }

    throw new Error(`Missing built-in ${skillName} skill file: ${candidatePaths[0]}`);
  }

  protected async getSwarmContextFiles(cwd: string): Promise<Array<{ path: string; content: string }>> {
    const contextFiles: Array<{ path: string; content: string }> = [];
    const seenPaths = new Set<string>();
    const rootDir = resolve("/");
    let currentDir = resolve(cwd);

    while (true) {
      const candidatePath = join(currentDir, SWARM_CONTEXT_FILE_NAME);
      if (!seenPaths.has(candidatePath) && existsSync(candidatePath)) {
        try {
          contextFiles.unshift({
            path: candidatePath,
            content: await readFile(candidatePath, "utf8")
          });
          seenPaths.add(candidatePath);
        } catch (error) {
          this.logDebug("runtime:swarm_context:read:error", {
            cwd,
            path: candidatePath,
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }

      if (currentDir === rootDir) {
        break;
      }

      const parentDir = resolve(currentDir, "..");
      if (parentDir === currentDir) {
        break;
      }
      currentDir = parentDir;
    }

    return contextFiles;
  }

  private mergeRuntimeContextFiles(
    baseAgentsFiles: Array<{ path: string; content: string }>,
    options: {
      memoryContextFile: { path: string; content: string };
      swarmContextFiles: Array<{ path: string; content: string }>;
    }
  ): Array<{ path: string; content: string }> {
    const swarmContextPaths = new Set(options.swarmContextFiles.map((entry) => entry.path));
    const withoutSwarmAndMemory = baseAgentsFiles.filter(
      (entry) => entry.path !== options.memoryContextFile.path && !swarmContextPaths.has(entry.path)
    );

    return [...withoutSwarmAndMemory, ...options.swarmContextFiles, options.memoryContextFile];
  }

  protected async createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string
  ): Promise<SwarmAgentRuntime> {
    if (isCodexAppServerModelDescriptor(descriptor.model)) {
      return this.createCodexRuntimeForDescriptor(descriptor, systemPrompt);
    }

    return this.createPiRuntimeForDescriptor(descriptor, systemPrompt);
  }

  private async createPiRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string
  ): Promise<SwarmAgentRuntime> {
    const swarmTools = buildSwarmTools(this, descriptor, {
      shuvdoClient: this.shuvdoClient
    });
    const thinkingLevel = normalizeThinkingLevel(descriptor.model.thinkingLevel);
    const runtimeAgentDir =
      descriptor.role === "manager" ? this.config.paths.managerAgentDir : this.config.paths.agentDir;
    const memoryResources = await this.getMemoryRuntimeResources(descriptor);

    this.logDebug("runtime:create:start", {
      runtime: "pi",
      agentId: descriptor.agentId,
      role: descriptor.role,
      model: descriptor.model,
      archetypeId: descriptor.archetypeId,
      cwd: descriptor.cwd,
      authFile: this.config.paths.authFile,
      agentDir: runtimeAgentDir,
      memoryFile: memoryResources.memoryContextFile.path,
      managerSystemPromptSource:
        descriptor.role === "manager" ? `archetype:${MANAGER_ARCHETYPE_ID}` : undefined
    });

    const authStorage = AuthStorage.create(this.config.paths.authFile);
    const modelRegistry = new ModelRegistry(authStorage);
    const swarmContextFiles = await this.getSwarmContextFiles(descriptor.cwd);
    const applyRuntimeContext = (base: { agentsFiles: Array<{ path: string; content: string }> }) => ({
      agentsFiles: this.mergeRuntimeContextFiles(base.agentsFiles, {
        memoryContextFile: memoryResources.memoryContextFile,
        swarmContextFiles
      })
    });

    const resourceLoader =
      descriptor.role === "manager"
        ? new DefaultResourceLoader({
            cwd: descriptor.cwd,
            agentDir: runtimeAgentDir,
            additionalSkillPaths: memoryResources.additionalSkillPaths,
            agentsFilesOverride: applyRuntimeContext,
            // Manager prompt comes from the archetype prompt registry.
            systemPrompt,
            appendSystemPromptOverride: () => []
          })
        : new DefaultResourceLoader({
            cwd: descriptor.cwd,
            agentDir: runtimeAgentDir,
            additionalSkillPaths: memoryResources.additionalSkillPaths,
            agentsFilesOverride: applyRuntimeContext,
            appendSystemPromptOverride: (base) => [...base, systemPrompt]
          });
    await resourceLoader.reload();

    const { resolvedModel, resolutionMeta } = this.resolveModel(modelRegistry, descriptor.model);
    if (!resolvedModel) {
      const availableOptions = resolutionMeta.available
        .map((entry) => `${entry.preset} (${entry.descriptor.provider}/${entry.descriptor.modelId})`)
        .join(", ");
      throw new Error(
        `Unable to resolve requested model ${descriptor.model.provider}/${descriptor.model.modelId}. ` +
          `${resolutionMeta.reason} Available presets: ${availableOptions || "none"}. ` +
          "Set SHUVLR_DEFAULT_MODEL_PRESET or choose a valid manager model preset."
      );
    }

    if (resolutionMeta.strategy === "fallback_exact") {
      this.logDebug("runtime:model_resolution:fallback", {
        agentId: descriptor.agentId,
        requestedModel: descriptor.model,
        resolvedModel: resolutionMeta.resolvedModel,
        reason: resolutionMeta.reason
      });
    }

    const { session } = await createAgentSession({
      cwd: descriptor.cwd,
      agentDir: runtimeAgentDir,
      authStorage,
      modelRegistry,
      model: resolvedModel,
      thinkingLevel: thinkingLevel as any,
      sessionManager: SessionManager.open(descriptor.sessionFile),
      resourceLoader,
      customTools: swarmTools
    });

    const activeToolNames = new Set(session.getActiveToolNames());
    for (const tool of swarmTools) {
      activeToolNames.add(tool.name);
    }
    session.setActiveToolsByName(Array.from(activeToolNames));

    this.logDebug("runtime:create:ready", {
      runtime: "pi",
      agentId: descriptor.agentId,
      activeTools: session.getActiveToolNames(),
      systemPromptPreview: previewForLog(session.systemPrompt, 240),
      containsSpeakToUserRule:
        descriptor.role === "manager" ? session.systemPrompt.includes("speak_to_user") : undefined
    });

    return new AgentRuntime({
      descriptor,
      session: session as AgentSession,
      callbacks: {
        onStatusChange: async (agentId, status, pendingCount, contextUsage) => {
          await this.handleRuntimeStatus(agentId, status, pendingCount, contextUsage);
        },
        onSessionEvent: async (agentId, event) => {
          await this.handleRuntimeSessionEvent(agentId, event);
        },
        onAgentEnd: async (agentId) => {
          await this.handleRuntimeAgentEnd(agentId);
        },
        onRuntimeError: async (agentId, error) => {
          await this.handleRuntimeError(agentId, error);
        }
      },
      now: this.now
    });
  }

  private async createCodexRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string
  ): Promise<SwarmAgentRuntime> {
    const swarmTools = buildSwarmTools(this, descriptor, {
      shuvdoClient: this.shuvdoClient
    });
    const memoryResources = await this.getMemoryRuntimeResources(descriptor);
    const swarmContextFiles = await this.getSwarmContextFiles(descriptor.cwd);

    const codexSystemPrompt = this.buildCodexRuntimeSystemPrompt(systemPrompt, {
      memoryContextFile: memoryResources.memoryContextFile,
      swarmContextFiles
    });

    this.logDebug("runtime:create:start", {
      runtime: "codex-app-server",
      agentId: descriptor.agentId,
      role: descriptor.role,
      model: descriptor.model,
      archetypeId: descriptor.archetypeId,
      cwd: descriptor.cwd
    });

    const runtime = await CodexAgentRuntime.create({
      descriptor,
      callbacks: {
        onStatusChange: async (agentId, status, pendingCount, contextUsage) => {
          await this.handleRuntimeStatus(agentId, status, pendingCount, contextUsage);
        },
        onSessionEvent: async (agentId, event) => {
          await this.handleRuntimeSessionEvent(agentId, event);
        },
        onAgentEnd: async (agentId) => {
          await this.handleRuntimeAgentEnd(agentId);
        },
        onRuntimeError: async (agentId, error) => {
          await this.handleRuntimeError(agentId, error);
        }
      },
      now: this.now,
      systemPrompt: codexSystemPrompt,
      tools: swarmTools,
      runtimeEnv: {
        SWARM_DATA_DIR: this.config.paths.dataDir,
        SWARM_MEMORY_FILE: memoryResources.memoryContextFile.path,
        SHUVDO_API: this.resolveEnvValue("SHUVDO_API"),
        SHUVDO_TOKEN: this.resolveEnvValue("SHUVDO_TOKEN")
      },
      sandboxMode: this.config.codexSandboxMode,
      approvalPolicy: this.config.codexApprovalPolicy
    });

    this.logDebug("runtime:create:ready", {
      runtime: "codex-app-server",
      agentId: descriptor.agentId,
      activeTools: swarmTools.map((tool) => tool.name),
      systemPromptPreview: previewForLog(codexSystemPrompt, 240)
    });

    return runtime;
  }

  private buildCodexRuntimeSystemPrompt(
    baseSystemPrompt: string,
    options: {
      memoryContextFile: { path: string; content: string };
      swarmContextFiles: Array<{ path: string; content: string }>;
    }
  ): string {
    const sections: string[] = [];

    const trimmedBase = baseSystemPrompt.trim();
    if (trimmedBase.length > 0) {
      sections.push(trimmedBase);
    }

    for (const contextFile of options.swarmContextFiles) {
      const content = contextFile.content.trim();
      if (!content) {
        continue;
      }

      sections.push(
        [
          `Repository swarm policy (${contextFile.path}):`,
          "----- BEGIN SWARM CONTEXT -----",
          content,
          "----- END SWARM CONTEXT -----"
        ].join("\n")
      );
    }

    const memoryContent = options.memoryContextFile.content.trim();
    if (memoryContent) {
      sections.push(
        [
          `Persistent swarm memory (${options.memoryContextFile.path}):`,
          "----- BEGIN SWARM MEMORY -----",
          memoryContent,
          "----- END SWARM MEMORY -----"
        ].join("\n")
      );
    }

    return sections.join("\n\n");
  }

  private resolveModel(
    modelRegistry: ModelRegistry,
    descriptor: AgentModelDescriptor
  ): ReturnType<typeof resolveModelWithMeta> {
    return resolveModelWithMeta(modelRegistry, descriptor, this.config.defaultModel);
  }

  private async handleRuntimeStatus(
    agentId: string,
    status: AgentStatus,
    pendingCount: number,
    contextUsage?: AgentContextUsage
  ): Promise<void> {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor) return;

    const normalizedContextUsage = normalizeContextUsage(contextUsage);
    let shouldPersist = false;

    if (!areContextUsagesEqual(descriptor.contextUsage, normalizedContextUsage)) {
      descriptor.contextUsage = normalizedContextUsage;
    }

    if (descriptor.status !== status) {
      descriptor.status = status;
      descriptor.updatedAt = this.now();
      shouldPersist = true;
    }

    if ((status === "terminated" || status === "stopped_on_restart") && descriptor.contextUsage) {
      descriptor.contextUsage = undefined;
      shouldPersist = true;
    }

    this.descriptors.set(agentId, descriptor);

    if (shouldPersist) {
      await this.saveStore();
    }

    this.emitStatus(agentId, status, pendingCount, descriptor.contextUsage);
    this.logDebug("runtime:status", {
      agentId,
      status,
      pendingCount,
      contextUsage: descriptor.contextUsage
    });
  }

  private async handleRuntimeSessionEvent(agentId: string, event: RuntimeSessionEvent): Promise<void> {
    this.captureConversationEventFromRuntime(agentId, event);

    if (!this.config.debug) return;

    const descriptor = this.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "manager") {
      return;
    }

    switch (event.type) {
      case "agent_start":
      case "agent_end":
      case "turn_start":
        this.logDebug(`manager:event:${event.type}`);
        return;

      case "turn_end":
        this.logDebug("manager:event:turn_end", {
          toolResults: event.toolResults.length
        });
        return;

      case "tool_execution_start":
        this.logDebug("manager:tool:start", {
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          args: previewForLog(safeJson(event.args), 240)
        });
        return;

      case "tool_execution_end":
        this.logDebug("manager:tool:end", {
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          isError: event.isError,
          result: previewForLog(safeJson(event.result), 240)
        });
        return;

      case "message_start":
      case "message_end":
        this.logDebug(`manager:event:${event.type}`, {
          role: extractRole(event.message),
          textPreview: previewForLog(extractMessageText(event.message) ?? "")
        });
        return;

      case "message_update":
      case "tool_execution_update":
      case "auto_compaction_start":
      case "auto_compaction_end":
      case "auto_retry_start":
      case "auto_retry_end":
        return;
    }
  }

  private async handleRuntimeError(agentId: string, error: RuntimeErrorEvent): Promise<void> {
    const descriptor = this.descriptors.get(agentId);
    if (!descriptor) {
      return;
    }

    const message = error.message.trim().length > 0 ? error.message.trim() : "Unknown runtime error";
    const attempt = readPositiveIntegerDetail(error.details, "attempt");
    const maxAttempts = readPositiveIntegerDetail(error.details, "maxAttempts");
    const droppedPendingCount = readPositiveIntegerDetail(error.details, "droppedPendingCount");

    this.logDebug("runtime:error", {
      agentId,
      runtime: descriptor.model.provider.includes("codex-app") ? "codex-app-server" : "pi",
      phase: error.phase,
      message,
      stack: error.stack,
      details: error.details
    });

    const retryLabel =
      attempt && maxAttempts && maxAttempts > 1 ? ` (attempt ${attempt}/${maxAttempts})` : "";

    const text =
      error.phase === "compaction"
        ? `⚠️ Compaction error${retryLabel}: ${message}. Continuing without compaction.`
        : droppedPendingCount && droppedPendingCount > 0
          ? `⚠️ Agent error${retryLabel}: ${message}. ${droppedPendingCount} queued message${droppedPendingCount === 1 ? "" : "s"} could not be delivered and were dropped. Please resend.`
          : `⚠️ Agent error${retryLabel}: ${message}. Message may need to be resent.`;

    this.emitConversationMessage({
      type: "conversation_message",
      agentId,
      role: "system",
      text,
      timestamp: this.now(),
      source: "system"
    });
  }

  private captureManagerRuntimeErrorConversationEvent(agentId: string, event: RuntimeSessionEvent): void {
    if (event.type !== "message_end") {
      return;
    }

    const role = extractRole(event.message);
    if (role !== "assistant") {
      return;
    }

    const stopReason = extractMessageStopReason(event.message);
    const hasStructuredErrorMessage = hasMessageErrorMessageField(event.message);
    if (stopReason !== "error" && !hasStructuredErrorMessage) {
      return;
    }

    const messageText = extractMessageText(event.message);
    const normalizedErrorMessage = normalizeProviderErrorMessage(extractMessageErrorMessage(event.message) ?? messageText);
    const isContextOverflow = isStrictContextOverflowMessage(normalizedErrorMessage);

    this.emitConversationMessage({
      type: "conversation_message",
      agentId,
      role: "system",
      text: buildManagerErrorConversationText({
        errorMessage: normalizedErrorMessage,
        isContextOverflow
      }),
      timestamp: this.now(),
      source: "system"
    });
  }

  private captureToolCallActivityFromRuntime(
    managerContextId: string,
    actorAgentId: string,
    event: RuntimeSessionEvent,
    timestamp: string
  ): void {
    switch (event.type) {
      case "tool_execution_start":
        this.emitAgentToolCall({
          type: "agent_tool_call",
          agentId: managerContextId,
          actorAgentId,
          timestamp,
          kind: "tool_execution_start",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          text: safeJson(event.args)
        });
        return;

      case "tool_execution_update":
        this.emitAgentToolCall({
          type: "agent_tool_call",
          agentId: managerContextId,
          actorAgentId,
          timestamp,
          kind: "tool_execution_update",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          text: safeJson(event.partialResult)
        });
        return;

      case "tool_execution_end":
        this.emitAgentToolCall({
          type: "agent_tool_call",
          agentId: managerContextId,
          actorAgentId,
          timestamp,
          kind: "tool_execution_end",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          text: safeJson(event.result),
          isError: event.isError
        });
        return;

      case "agent_start":
      case "agent_end":
      case "turn_start":
      case "turn_end":
      case "message_start":
      case "message_update":
      case "message_end":
      case "auto_compaction_start":
      case "auto_compaction_end":
      case "auto_retry_start":
      case "auto_retry_end":
        return;
    }
  }

  private captureConversationEventFromRuntime(agentId: string, event: RuntimeSessionEvent): void {
    const descriptor = this.descriptors.get(agentId);
    const timestamp = this.now();
    if (descriptor) {
      const managerContextId = descriptor.role === "manager" ? descriptor.agentId : descriptor.managerId;
      this.captureToolCallActivityFromRuntime(managerContextId, agentId, event, timestamp);
    }

    if (descriptor?.role === "manager") {
      this.captureManagerRuntimeErrorConversationEvent(agentId, event);
      return;
    }

    switch (event.type) {
      case "message_start": {
        const role = extractRole(event.message);
        if (role !== "user" && role !== "assistant" && role !== "system") {
          return;
        }

        this.emitConversationLog({
          type: "conversation_log",
          agentId,
          timestamp,
          source: "runtime_log",
          kind: "message_start",
          role,
          text: extractMessageText(event.message) ?? "(non-text message)"
        });
        return;
      }

      case "message_end": {
        const role = extractRole(event.message);
        if (role !== "user" && role !== "assistant" && role !== "system") {
          return;
        }

        const extractedText = extractMessageText(event.message);
        const text = extractedText ?? "(non-text message)";
        const attachments = extractMessageImageAttachments(event.message);

        if ((role === "assistant" || role === "system") && (extractedText || attachments.length > 0)) {
          this.emitConversationMessage({
            type: "conversation_message",
            agentId,
            role,
            text: extractedText ?? "",
            attachments: attachments.length > 0 ? attachments : undefined,
            timestamp,
            source: "system"
          });
        }

        this.emitConversationLog({
          type: "conversation_log",
          agentId,
          timestamp,
          source: "runtime_log",
          kind: "message_end",
          role,
          text
        });
        return;
      }

      case "tool_execution_start":
        this.emitConversationLog({
          type: "conversation_log",
          agentId,
          timestamp,
          source: "runtime_log",
          kind: "tool_execution_start",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          text: safeJson(event.args)
        });
        return;

      case "tool_execution_update":
        this.emitConversationLog({
          type: "conversation_log",
          agentId,
          timestamp,
          source: "runtime_log",
          kind: "tool_execution_update",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          text: safeJson(event.partialResult)
        });
        return;

      case "tool_execution_end":
        this.emitConversationLog({
          type: "conversation_log",
          agentId,
          timestamp,
          source: "runtime_log",
          kind: "tool_execution_end",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          text: safeJson(event.result),
          isError: event.isError
        });
        return;

      case "agent_start":
      case "agent_end":
      case "turn_start":
      case "turn_end":
      case "message_update":
      case "auto_compaction_start":
      case "auto_compaction_end":
      case "auto_retry_start":
      case "auto_retry_end":
        return;
    }
  }

  private emitStatus(
    agentId: string,
    status: AgentStatus,
    pendingCount: number,
    contextUsage?: AgentContextUsage
  ): void {
    const resolvedContextUsage = normalizeContextUsage(contextUsage ?? this.descriptors.get(agentId)?.contextUsage);
    const payload: AgentStatusEvent = {
      type: "agent_status",
      agentId,
      status,
      pendingCount,
      ...(resolvedContextUsage ? { contextUsage: resolvedContextUsage } : {})
    };

    this.emit("agent_status", payload satisfies ServerEvent);
  }

  private emitAgentsSnapshot(): void {
    const payload: AgentsSnapshotEvent = {
      type: "agents_snapshot",
      agents: this.listAgents()
    };

    this.emit("agents_snapshot", payload satisfies ServerEvent);
  }

  private async handleRuntimeAgentEnd(_agentId: string): Promise<void> {
    // No-op: managers now receive all inbound messages with sourceContext metadata
    // and decide whether to respond without pending-reply bookkeeping.
  }

  private async ensureDirectories(): Promise<void> {
    const dirs = [
      this.config.paths.dataDir,
      this.config.paths.swarmDir,
      this.config.paths.sessionsDir,
      this.config.paths.uploadsDir,
      this.config.paths.authDir,
      this.config.paths.memoryDir,
      this.config.paths.agentDir,
      this.config.paths.managerAgentDir
    ];

    for (const dir of dirs) {
      await mkdir(dir, { recursive: true });
    }
  }

  private getAgentMemoryPath(agentId: string): string {
    return getAgentMemoryPathForDataDir(this.config.paths.dataDir, agentId);
  }

  private resolveMemoryOwnerAgentId(descriptor: AgentDescriptor): string {
    if (descriptor.role === "manager") {
      return descriptor.agentId;
    }

    const managerId = normalizeOptionalAgentId(descriptor.managerId);
    if (managerId) {
      return managerId;
    }

    return this.resolvePreferredManagerId({ includeStoppedOnRestart: true }) ?? descriptor.agentId;
  }

  private async ensureMemoryFilesForBoot(): Promise<void> {
    const memoryAgentIds = new Set<string>();
    const configuredManagerId = this.getConfiguredManagerId();
    if (configuredManagerId) {
      memoryAgentIds.add(configuredManagerId);
    }

    for (const descriptor of this.descriptors.values()) {
      memoryAgentIds.add(descriptor.agentId);
      if (descriptor.role === "worker") {
        memoryAgentIds.add(this.resolveMemoryOwnerAgentId(descriptor));
      }
    }

    for (const agentId of memoryAgentIds) {
      await this.ensureAgentMemoryFile(agentId);
    }
  }

  private async ensureAgentMemoryFile(agentId: string): Promise<void> {
    const memoryFilePath = this.getAgentMemoryPath(agentId);

    try {
      await readFile(memoryFilePath, "utf8");
      return;
    } catch (error) {
      if (!isEnoentError(error)) {
        throw error;
      }
    }

    await mkdir(dirname(memoryFilePath), { recursive: true });
    await writeFile(memoryFilePath, DEFAULT_MEMORY_FILE_CONTENT, "utf8");
  }

  private async deleteManagerSessionFile(sessionFile: string): Promise<void> {
    try {
      await unlink(sessionFile);
    } catch (error) {
      if (typeof error === "object" && error && "code" in error && (error as { code?: string }).code === "ENOENT") {
        return;
      }
      throw error;
    }
  }

  private async loadStore(): Promise<AgentsStoreFile> {
    try {
      const raw = await readFile(this.config.paths.agentsStoreFile, "utf8");
      const parsed = JSON.parse(raw) as AgentsStoreFile;
      if (!Array.isArray(parsed.agents)) {
        return { agents: [] };
      }

      const validAgents: AgentDescriptor[] = [];
      for (const [index, candidate] of parsed.agents.entries()) {
        const validated = validateAgentDescriptor(candidate);
        if (typeof validated === "string") {
          const maybeAgentId = extractDescriptorAgentId(candidate);
          const descriptorHint = maybeAgentId ? `agentId=${maybeAgentId}` : `index=${index}`;
          console.warn(
            `[swarm] Skipping invalid descriptor (${descriptorHint}) in ${this.config.paths.agentsStoreFile}: ${validated}`
          );
          continue;
        }

        validAgents.push(validated);
      }

      return {
        agents: validAgents
      };
    } catch {
      return { agents: [] };
    }
  }

  private loadConversationHistoriesFromStore(): void {
    this.conversationEntriesByAgentId.clear();

    for (const descriptor of this.descriptors.values()) {
      if (!this.shouldPreloadHistoryForDescriptor(descriptor)) {
        continue;
      }
      this.loadConversationHistoryForDescriptor(descriptor);
    }
  }

  private shouldPreloadHistoryForDescriptor(descriptor: AgentDescriptor): boolean {
    return descriptor.status === "idle" || descriptor.status === "streaming";
  }

  private loadConversationHistoryForDescriptor(descriptor: AgentDescriptor): ConversationEntryEvent[] {
    const entriesForAgent: ConversationEntryEvent[] = [];

    try {
      const sessionManager = SessionManager.open(descriptor.sessionFile);
      const entries = sessionManager.getEntries();

      for (const entry of entries) {
        if (entry.type !== "custom") {
          continue;
        }

        if (entry.customType !== CONVERSATION_ENTRY_TYPE) {
          continue;
        }
        if (!isConversationEntryEvent(entry.data)) {
          continue;
        }
        entriesForAgent.push(entry.data);
      }

      if (entriesForAgent.length > MAX_CONVERSATION_HISTORY) {
        entriesForAgent.splice(0, entriesForAgent.length - MAX_CONVERSATION_HISTORY);
      }

      this.logDebug("history:load:ready", {
        agentId: descriptor.agentId,
        messageCount: entriesForAgent.length
      });
    } catch (error) {
      this.logDebug("history:load:error", {
        agentId: descriptor.agentId,
        message: error instanceof Error ? error.message : String(error)
      });
    }

    this.conversationEntriesByAgentId.set(descriptor.agentId, entriesForAgent);
    return entriesForAgent;
  }

  private async saveStore(): Promise<void> {
    const payload: AgentsStoreFile = {
      agents: this.sortedDescriptors()
    };

    const target = this.config.paths.agentsStoreFile;
    const tmp = `${target}.tmp`;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(tmp, target);
  }
}

const VALID_PERSISTED_AGENT_ROLES = new Set(["manager", "worker"]);
const VALID_PERSISTED_AGENT_STATUSES = new Set(["idle", "streaming", "terminated", "stopped_on_restart"]);

function validateAgentDescriptor(value: unknown): AgentDescriptor | string {
  if (!isRecord(value)) {
    return "descriptor must be an object";
  }

  if (!isNonEmptyString(value.agentId)) {
    return "agentId must be a non-empty string";
  }

  if (typeof value.displayName !== "string") {
    return "displayName must be a string";
  }

  if (!isNonEmptyString(value.role) || !VALID_PERSISTED_AGENT_ROLES.has(value.role)) {
    return "role must be one of manager|worker";
  }

  if (!isNonEmptyString(value.managerId)) {
    return "managerId must be a non-empty string";
  }

  if (!isNonEmptyString(value.status) || !VALID_PERSISTED_AGENT_STATUSES.has(value.status)) {
    return "status must be one of idle|streaming|terminated|stopped_on_restart";
  }

  if (!isNonEmptyString(value.createdAt)) {
    return "createdAt must be a non-empty string";
  }

  if (!isNonEmptyString(value.updatedAt)) {
    return "updatedAt must be a non-empty string";
  }

  if (!isNonEmptyString(value.cwd)) {
    return "cwd must be a non-empty string";
  }

  if (!isNonEmptyString(value.sessionFile)) {
    return "sessionFile must be a non-empty string";
  }

  const model = value.model;
  if (!isRecord(model)) {
    return "model must be an object";
  }

  if (!isNonEmptyString(model.provider)) {
    return "model.provider must be a non-empty string";
  }

  if (!isNonEmptyString(model.modelId)) {
    return "model.modelId must be a non-empty string";
  }

  if (!isNonEmptyString(model.thinkingLevel)) {
    return "model.thinkingLevel must be a non-empty string";
  }

  if (value.archetypeId !== undefined && typeof value.archetypeId !== "string") {
    return "archetypeId must be a string when provided";
  }

  return value as unknown as AgentDescriptor;
}

function extractDescriptorAgentId(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return isNonEmptyString(value.agentId) ? value.agentId.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function normalizeAgentId(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function normalizeOptionalAgentId(input: string | undefined): string | undefined {
  if (typeof input !== "string") {
    return undefined;
  }

  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeEnvVarName(name: string): string | undefined {
  const normalized = name.trim();
  if (!VALID_ENV_NAME_PATTERN.test(normalized)) {
    return undefined;
  }

  return normalized;
}

function resolveSettingsAuthProvider(
  provider: string
): { provider: SettingsAuthProviderName; storageProvider: string } | undefined {
  const normalizedProvider = provider.trim().toLowerCase();
  if (!normalizedProvider) {
    return undefined;
  }

  const definition = SETTINGS_AUTH_PROVIDER_DEFINITIONS.find(
    (entry) => entry.provider === normalizedProvider
  );
  if (!definition) {
    return undefined;
  }

  return {
    provider: definition.provider,
    storageProvider: definition.storageProvider
  };
}

function resolveAuthCredentialType(
  credential: AuthCredential | undefined
): SettingsAuthProvider["authType"] | undefined {
  if (!credential) {
    return undefined;
  }

  if (credential.type === "api_key" || credential.type === "oauth") {
    return credential.type;
  }

  return "unknown";
}

function extractAuthCredentialToken(credential: AuthCredential | undefined): string | undefined {
  if (!credential || typeof credential !== "object") {
    return undefined;
  }

  if (credential.type === "api_key") {
    const apiKey = normalizeAuthToken((credential as { key?: unknown }).key);
    if (apiKey) {
      return apiKey;
    }
  }

  const accessToken = normalizeAuthToken((credential as { access?: unknown }).access);
  if (accessToken) {
    return accessToken;
  }

  return undefined;
}

function normalizeAuthToken(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function maskSettingsAuthValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return SETTINGS_AUTH_MASK;
  }

  const suffix = trimmed.slice(-4);
  if (!suffix) {
    return SETTINGS_AUTH_MASK;
  }

  return `${SETTINGS_AUTH_MASK}${suffix}`;
}

function parseSkillFrontmatter(markdown: string): { name?: string; env: ParsedSkillEnvDeclaration[] } {
  const match = SKILL_FRONTMATTER_BLOCK_PATTERN.exec(markdown);
  if (!match) {
    return { env: [] };
  }

  const lines = match[1].split(/\r?\n/);
  let skillName: string | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || countLeadingSpaces(line) > 0) {
      continue;
    }

    const parsed = parseYamlKeyValue(trimmed);
    if (!parsed) {
      continue;
    }

    if (parsed.key === "name") {
      const candidate = parseYamlStringValue(parsed.value);
      if (candidate) {
        skillName = candidate;
      }
      break;
    }
  }

  return {
    name: skillName,
    env: parseSkillEnvDeclarations(lines)
  };
}

function parseSkillEnvDeclarations(lines: string[]): ParsedSkillEnvDeclaration[] {
  const envIndex = lines.findIndex((line) => {
    const trimmed = line.trim();
    return trimmed === "env:" || trimmed === "envVars:";
  });
  if (envIndex < 0) {
    return [];
  }

  const envIndent = countLeadingSpaces(lines[envIndex]);
  const declarations: ParsedSkillEnvDeclaration[] = [];
  let current: Partial<ParsedSkillEnvDeclaration> | undefined;

  const flushCurrent = (): void => {
    if (!current) {
      return;
    }

    const normalizedName =
      typeof current.name === "string" ? normalizeEnvVarName(current.name) : undefined;
    if (!normalizedName) {
      current = undefined;
      return;
    }

    declarations.push({
      name: normalizedName,
      description:
        typeof current.description === "string" && current.description.trim().length > 0
          ? current.description.trim()
          : undefined,
      required: current.required === true,
      helpUrl:
        typeof current.helpUrl === "string" && current.helpUrl.trim().length > 0
          ? current.helpUrl.trim()
          : undefined
    });

    current = undefined;
  };

  for (let index = envIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      continue;
    }

    const lineIndent = countLeadingSpaces(line);
    if (lineIndent <= envIndent) {
      break;
    }

    if (trimmed.startsWith("-")) {
      flushCurrent();
      current = {};

      const inline = trimmed.slice(1).trim();
      if (inline.length > 0) {
        const parsedInline = parseYamlKeyValue(inline);
        if (parsedInline) {
          assignSkillEnvField(current, parsedInline.key, parsedInline.value);
        }
      }

      continue;
    }

    if (!current) {
      continue;
    }

    const parsed = parseYamlKeyValue(trimmed);
    if (!parsed) {
      continue;
    }

    assignSkillEnvField(current, parsed.key, parsed.value);
  }

  flushCurrent();

  return declarations;
}

function assignSkillEnvField(target: Partial<ParsedSkillEnvDeclaration>, key: string, value: string): void {
  switch (key) {
    case "name":
      target.name = parseYamlStringValue(value);
      return;

    case "description":
      target.description = parseYamlStringValue(value);
      return;

    case "required": {
      const parsed = parseYamlBooleanValue(value);
      if (parsed !== undefined) {
        target.required = parsed;
      }
      return;
    }

    case "helpUrl":
      target.helpUrl = parseYamlStringValue(value);
      return;

    default:
      return;
  }
}

function parseYamlKeyValue(line: string): { key: string; value: string } | undefined {
  const separatorIndex = line.indexOf(":");
  if (separatorIndex <= 0) {
    return undefined;
  }

  const key = line.slice(0, separatorIndex).trim();
  if (!key) {
    return undefined;
  }

  return {
    key,
    value: line.slice(separatorIndex + 1).trim()
  };
}

function parseYamlStringValue(value: string): string {
  const trimmed = value.trim();

  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

function parseYamlBooleanValue(value: string): boolean | undefined {
  const normalized = parseYamlStringValue(value).toLowerCase();
  if (normalized === "true" || normalized === "yes" || normalized === "on" || normalized === "1") {
    return true;
  }

  if (normalized === "false" || normalized === "no" || normalized === "off" || normalized === "0") {
    return false;
  }

  return undefined;
}

function countLeadingSpaces(value: string): number {
  const match = /^\s*/.exec(value);
  return match ? match[0].length : 0;
}

function previewForLog(text: string, maxLength = 160): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function readPositiveIntegerDetail(details: Record<string, unknown> | undefined, key: string): number | undefined {
  if (!details) {
    return undefined;
  }

  const value = details[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return undefined;
  }

  return value;
}

function extractMessageStopReason(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const stopReason = (message as { stopReason?: unknown }).stopReason;
  return typeof stopReason === "string" ? stopReason : undefined;
}

function extractMessageErrorMessage(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const errorMessage = (message as { errorMessage?: unknown }).errorMessage;
  if (typeof errorMessage !== "string") {
    return undefined;
  }

  const trimmed = errorMessage.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function hasMessageErrorMessageField(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }

  return Object.prototype.hasOwnProperty.call(message, "errorMessage");
}

function normalizeProviderErrorMessage(errorMessage: string | undefined): string | undefined {
  if (!errorMessage) {
    return undefined;
  }

  const trimmed = errorMessage.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const jsonStart = trimmed.indexOf("{");
  if (jsonStart >= 0) {
    const jsonCandidate = trimmed.slice(jsonStart);
    try {
      const parsed = JSON.parse(jsonCandidate) as { message?: unknown; error?: { message?: unknown } };
      const nestedMessage = parseErrorMessageCandidate(parsed.error?.message) ?? parseErrorMessageCandidate(parsed.message);
      if (nestedMessage) {
        return nestedMessage;
      }
    } catch {
      // fall through to regex and plain-text handling.
    }
  }

  const overflowMatch = /prompt is too long:[^"}\n]+/i.exec(trimmed);
  if (overflowMatch?.[0]) {
    return overflowMatch[0];
  }

  return trimmed.length > 240 ? previewForLog(trimmed, 240) : trimmed;
}

function parseErrorMessageCandidate(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "");
  return normalized.length > 0 ? normalized : undefined;
}

function isStrictContextOverflowMessage(message: string | undefined): boolean {
  if (!message) {
    return false;
  }

  return /\bprompt is too long\b/i.test(message) || /\bmaximum context length\b/i.test(message);
}

function buildManagerErrorConversationText(options: {
  errorMessage?: string;
  isContextOverflow: boolean;
}): string {
  if (options.isContextOverflow) {
    if (options.errorMessage) {
      return `⚠️ Manager reply failed because the prompt exceeded the model context window (${options.errorMessage}). ${MANAGER_ERROR_CONTEXT_HINT}`;
    }

    return `⚠️ Manager reply failed because the prompt exceeded the model context window. ${MANAGER_ERROR_CONTEXT_HINT}`;
  }

  if (options.errorMessage) {
    return `⚠️ Manager reply failed: ${options.errorMessage}. ${MANAGER_ERROR_GENERIC_HINT}`;
  }

  return `⚠️ Manager reply failed. ${MANAGER_ERROR_GENERIC_HINT}`;
}

function extractRole(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const maybeRole = (message as { role?: unknown }).role;
  return typeof maybeRole === "string" ? maybeRole : undefined;
}

function extractMessageText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;

  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  const text = content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const maybeText = item as { type?: unknown; text?: unknown };
      return maybeText.type === "text" && typeof maybeText.text === "string" ? maybeText.text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();

  return text.length > 0 ? text : undefined;
}

function extractMessageImageAttachments(message: unknown): ConversationImageAttachment[] {
  if (!message || typeof message !== "object") {
    return [];
  }

  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return [];
  }

  const attachments: ConversationImageAttachment[] = [];

  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const maybeImage = item as { type?: unknown; data?: unknown; mimeType?: unknown };
    if (maybeImage.type !== "image") {
      continue;
    }

    if (typeof maybeImage.mimeType !== "string" || !maybeImage.mimeType.startsWith("image/")) {
      continue;
    }

    if (typeof maybeImage.data !== "string" || maybeImage.data.length === 0) {
      continue;
    }

    attachments.push({
      mimeType: maybeImage.mimeType,
      data: maybeImage.data
    });
  }

  return attachments;
}

function normalizeConversationAttachments(
  attachments: ConversationAttachment[] | undefined
): ConversationAttachment[] {
  if (!attachments || attachments.length === 0) {
    return [];
  }

  const normalized: ConversationAttachment[] = [];

  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== "object") {
      continue;
    }

    const mimeType = typeof attachment.mimeType === "string" ? attachment.mimeType.trim() : "";
    const fileName = typeof attachment.fileName === "string" ? attachment.fileName.trim() : "";
    const filePath = typeof attachment.filePath === "string" ? attachment.filePath.trim() : "";

    if (attachment.type === "text") {
      const text = typeof attachment.text === "string" ? attachment.text : "";
      if (!mimeType || text.trim().length === 0) {
        continue;
      }

      normalized.push({
        type: "text",
        mimeType,
        text,
        fileName: fileName || undefined,
        filePath: filePath || undefined
      });
      continue;
    }

    if (attachment.type === "binary") {
      const data = typeof attachment.data === "string" ? attachment.data.trim() : "";
      if (!mimeType || data.length === 0) {
        continue;
      }

      normalized.push({
        type: "binary",
        mimeType,
        data,
        fileName: fileName || undefined,
        filePath: filePath || undefined
      });
      continue;
    }

    const data = typeof attachment.data === "string" ? attachment.data.trim() : "";
    if (!mimeType || !mimeType.startsWith("image/") || !data) {
      continue;
    }

    normalized.push({
      mimeType,
      data,
      fileName: fileName || undefined,
      filePath: filePath || undefined
    });
  }

  return normalized;
}

function toRuntimeImageAttachments(attachments: ConversationAttachment[]): RuntimeImageAttachment[] {
  const images: RuntimeImageAttachment[] = [];

  for (const attachment of attachments) {
    if (!isConversationImageAttachment(attachment)) {
      continue;
    }

    images.push({
      mimeType: attachment.mimeType,
      data: attachment.data
    });
  }

  return images;
}

function formatTextAttachmentForPrompt(attachment: ConversationTextAttachment, index: number): string {
  const fileName = attachment.fileName?.trim() || `attachment-${index}.txt`;

  return [
    `[Attachment ${index}]`,
    `Name: ${fileName}`,
    `MIME type: ${attachment.mimeType}`,
    "Content:",
    "----- BEGIN FILE -----",
    attachment.text,
    "----- END FILE -----"
  ].join("\n");
}

function formatBinaryAttachmentForPrompt(
  attachment: ConversationBinaryAttachment,
  storedPath: string,
  index: number
): string {
  const fileName = attachment.fileName?.trim() || `attachment-${index}.bin`;

  return [
    `[Attachment ${index}]`,
    `Name: ${fileName}`,
    `MIME type: ${attachment.mimeType}`,
    `Saved to: ${storedPath}`,
    "Use read/bash tools to inspect the file directly from disk."
  ].join("\n");
}

function sanitizeAttachmentFileName(fileName: string | undefined, fallback: string): string {
  const fallbackName = fallback.trim() || "attachment.bin";
  const trimmed = typeof fileName === "string" ? fileName.trim() : "";

  if (!trimmed) {
    return fallbackName;
  }

  const cleaned = trimmed
    .replace(/[\\/]+/g, "-")
    .replace(/[\0-\x1f\x7f]+/g, "")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .slice(0, 120);

  return cleaned || fallbackName;
}

function sanitizePathSegment(value: string, fallback: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

  return cleaned || fallback;
}

function normalizeOptionalAttachmentPath(path: string | undefined): string | undefined {
  if (typeof path !== "string") {
    return undefined;
  }

  const trimmed = path.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function extractRuntimeMessageText(message: string | RuntimeUserMessage): string {
  if (typeof message === "string") {
    return message;
  }

  return message.text;
}

function formatInboundUserMessageForManager(text: string, sourceContext: MessageSourceContext): string {
  const sourceMetadataLine = `[sourceContext] ${JSON.stringify(sourceContext)}`;
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return sourceMetadataLine;
  }

  return `${sourceMetadataLine}\n\n${trimmed}`;
}

function parseCompactSlashCommand(text: string): { customInstructions?: string } | undefined {
  const match = text.trim().match(/^\/compact(?:\s+([\s\S]+))?$/i);
  if (!match) {
    return undefined;
  }

  const customInstructions = match[1]?.trim();
  if (!customInstructions) {
    return {};
  }

  return {
    customInstructions
  };
}

function normalizeMessageTargetContext(input: MessageTargetContext): MessageTargetContext {
  return {
    channel:
      input.channel === "slack" || input.channel === "telegram"
        ? input.channel
        : "web",
    channelId: normalizeOptionalMetadataValue(input.channelId),
    userId: normalizeOptionalMetadataValue(input.userId),
    threadTs: normalizeOptionalMetadataValue(input.threadTs),
    integrationProfileId: normalizeOptionalMetadataValue(input.integrationProfileId)
  };
}

function normalizeMessageSourceContext(input: MessageSourceContext): MessageSourceContext {
  return {
    channel:
      input.channel === "slack" || input.channel === "telegram"
        ? input.channel
        : "web",
    channelId: normalizeOptionalMetadataValue(input.channelId),
    userId: normalizeOptionalMetadataValue(input.userId),
    messageId: normalizeOptionalMetadataValue(input.messageId),
    threadTs: normalizeOptionalMetadataValue(input.threadTs),
    integrationProfileId: normalizeOptionalMetadataValue(input.integrationProfileId),
    channelType:
      input.channelType === "dm" ||
      input.channelType === "channel" ||
      input.channelType === "group" ||
      input.channelType === "mpim"
        ? input.channelType
        : undefined,
    teamId: normalizeOptionalMetadataValue(input.teamId)
  };
}

function normalizeOptionalMetadataValue(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isCodexAppServerModelDescriptor(descriptor: Pick<AgentModelDescriptor, "provider">): boolean {
  return descriptor.provider.trim().toLowerCase() === "openai-codex-app-server";
}

function normalizeThinkingLevel(level: string): string {
  return level === "x-high" ? "xhigh" : level;
}

function isConversationEntryEvent(value: unknown): value is ConversationEntryEvent {
  return (
    isConversationMessageEvent(value) ||
    isConversationLogEvent(value) ||
    isAgentMessageEvent(value) ||
    isAgentToolCallEvent(value)
  );
}

function isConversationMessageEvent(value: unknown): value is ConversationMessageEvent {
  if (!value || typeof value !== "object") return false;

  const maybe = value as Partial<ConversationMessageEvent>;
  if (maybe.type !== "conversation_message") return false;
  if (typeof maybe.agentId !== "string" || maybe.agentId.length === 0) return false;
  if (maybe.role !== "user" && maybe.role !== "assistant" && maybe.role !== "system") return false;
  if (typeof maybe.text !== "string") return false;
  if (typeof maybe.timestamp !== "string") return false;
  if (maybe.source !== "user_input" && maybe.source !== "speak_to_user" && maybe.source !== "system") return false;

  if (maybe.attachments !== undefined) {
    if (!Array.isArray(maybe.attachments)) {
      return false;
    }

    for (const attachment of maybe.attachments) {
      if (!isConversationAttachment(attachment)) {
        return false;
      }
    }
  }

  if (maybe.sourceContext !== undefined && !isMessageSourceContext(maybe.sourceContext)) {
    return false;
  }

  return true;
}

function isMessageSourceContext(value: unknown): value is MessageSourceContext {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybe = value as Partial<MessageSourceContext>;

  if (maybe.channel !== "web" && maybe.channel !== "slack" && maybe.channel !== "telegram") {
    return false;
  }

  if (maybe.channelId !== undefined && typeof maybe.channelId !== "string") {
    return false;
  }

  if (maybe.userId !== undefined && typeof maybe.userId !== "string") {
    return false;
  }

  if (maybe.messageId !== undefined && typeof maybe.messageId !== "string") {
    return false;
  }

  if (maybe.threadTs !== undefined && typeof maybe.threadTs !== "string") {
    return false;
  }

  if (maybe.integrationProfileId !== undefined && typeof maybe.integrationProfileId !== "string") {
    return false;
  }

  if (
    maybe.channelType !== undefined &&
    maybe.channelType !== "dm" &&
    maybe.channelType !== "channel" &&
    maybe.channelType !== "group" &&
    maybe.channelType !== "mpim"
  ) {
    return false;
  }

  if (maybe.teamId !== undefined && typeof maybe.teamId !== "string") {
    return false;
  }

  return true;
}

function isConversationAttachment(value: unknown): value is ConversationAttachment {
  return (
    isConversationImageAttachment(value) ||
    isConversationTextAttachment(value) ||
    isConversationBinaryAttachment(value)
  );
}

function isConversationImageAttachment(value: unknown): value is ConversationImageAttachment {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybe = value as Partial<ConversationImageAttachment> & { type?: unknown };
  if (maybe.type !== undefined && maybe.type !== "image") {
    return false;
  }

  if (typeof maybe.mimeType !== "string" || !maybe.mimeType.startsWith("image/")) {
    return false;
  }

  if (typeof maybe.data !== "string" || maybe.data.length === 0) {
    return false;
  }

  if (maybe.fileName !== undefined && typeof maybe.fileName !== "string") {
    return false;
  }

  if (maybe.filePath !== undefined && typeof maybe.filePath !== "string") {
    return false;
  }

  return true;
}

function isConversationTextAttachment(value: unknown): value is ConversationTextAttachment {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybe = value as Partial<ConversationTextAttachment>;
  if (maybe.type !== "text") {
    return false;
  }

  if (typeof maybe.mimeType !== "string" || maybe.mimeType.trim().length === 0) {
    return false;
  }

  if (typeof maybe.text !== "string" || maybe.text.trim().length === 0) {
    return false;
  }

  if (maybe.fileName !== undefined && typeof maybe.fileName !== "string") {
    return false;
  }

  if (maybe.filePath !== undefined && typeof maybe.filePath !== "string") {
    return false;
  }

  return true;
}

function isConversationBinaryAttachment(value: unknown): value is ConversationBinaryAttachment {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybe = value as Partial<ConversationBinaryAttachment>;
  if (maybe.type !== "binary") {
    return false;
  }

  if (typeof maybe.mimeType !== "string" || maybe.mimeType.trim().length === 0) {
    return false;
  }

  if (typeof maybe.data !== "string" || maybe.data.trim().length === 0) {
    return false;
  }

  if (maybe.fileName !== undefined && typeof maybe.fileName !== "string") {
    return false;
  }

  if (maybe.filePath !== undefined && typeof maybe.filePath !== "string") {
    return false;
  }

  return true;
}

function isConversationLogEvent(value: unknown): value is ConversationLogEvent {
  if (!value || typeof value !== "object") return false;

  const maybe = value as Partial<ConversationLogEvent>;
  if (maybe.type !== "conversation_log") return false;
  if (typeof maybe.agentId !== "string" || maybe.agentId.length === 0) return false;
  if (typeof maybe.timestamp !== "string") return false;
  if (maybe.source !== "runtime_log") return false;

  if (
    maybe.kind !== "message_start" &&
    maybe.kind !== "message_end" &&
    maybe.kind !== "tool_execution_start" &&
    maybe.kind !== "tool_execution_update" &&
    maybe.kind !== "tool_execution_end"
  ) {
    return false;
  }

  if (maybe.role !== undefined && maybe.role !== "user" && maybe.role !== "assistant" && maybe.role !== "system") {
    return false;
  }

  if (maybe.toolName !== undefined && typeof maybe.toolName !== "string") return false;
  if (maybe.toolCallId !== undefined && typeof maybe.toolCallId !== "string") return false;
  if (typeof maybe.text !== "string") return false;
  if (maybe.isError !== undefined && typeof maybe.isError !== "boolean") return false;

  return true;
}

function isAgentMessageEvent(value: unknown): value is AgentMessageEvent {
  if (!value || typeof value !== "object") return false;

  const maybe = value as Partial<AgentMessageEvent>;
  if (maybe.type !== "agent_message") return false;
  if (typeof maybe.agentId !== "string" || maybe.agentId.length === 0) return false;
  if (typeof maybe.timestamp !== "string") return false;
  if (maybe.source !== "user_to_agent" && maybe.source !== "agent_to_agent") return false;
  if (maybe.fromAgentId !== undefined && typeof maybe.fromAgentId !== "string") return false;
  if (typeof maybe.toAgentId !== "string" || maybe.toAgentId.length === 0) return false;
  if (typeof maybe.text !== "string") return false;
  if (maybe.sourceContext !== undefined && !isMessageSourceContext(maybe.sourceContext)) return false;
  if (
    maybe.requestedDelivery !== undefined &&
    maybe.requestedDelivery !== "auto" &&
    maybe.requestedDelivery !== "followUp" &&
    maybe.requestedDelivery !== "steer"
  ) {
    return false;
  }
  if (
    maybe.acceptedMode !== undefined &&
    maybe.acceptedMode !== "prompt" &&
    maybe.acceptedMode !== "followUp" &&
    maybe.acceptedMode !== "steer"
  ) {
    return false;
  }
  if (
    maybe.attachmentCount !== undefined &&
    (typeof maybe.attachmentCount !== "number" ||
      !Number.isFinite(maybe.attachmentCount) ||
      maybe.attachmentCount < 0)
  ) {
    return false;
  }

  return true;
}

function isAgentToolCallEvent(value: unknown): value is AgentToolCallEvent {
  if (!value || typeof value !== "object") return false;

  const maybe = value as Partial<AgentToolCallEvent>;
  if (maybe.type !== "agent_tool_call") return false;
  if (typeof maybe.agentId !== "string" || maybe.agentId.length === 0) return false;
  if (typeof maybe.actorAgentId !== "string" || maybe.actorAgentId.length === 0) return false;
  if (typeof maybe.timestamp !== "string") return false;
  if (
    maybe.kind !== "tool_execution_start" &&
    maybe.kind !== "tool_execution_update" &&
    maybe.kind !== "tool_execution_end"
  ) {
    return false;
  }
  if (maybe.toolName !== undefined && typeof maybe.toolName !== "string") return false;
  if (maybe.toolCallId !== undefined && typeof maybe.toolCallId !== "string") return false;
  if (typeof maybe.text !== "string") return false;
  if (maybe.isError !== undefined && typeof maybe.isError !== "boolean") return false;

  return true;
}
