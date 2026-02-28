import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { createConfig } from "./config.js";
import { GsuiteIntegrationService } from "./integrations/gsuite/gsuite-integration.js";
import { IntegrationRegistryService } from "./integrations/registry.js";
import { CronSchedulerService } from "./scheduler/cron-scheduler-service.js";
import { getScheduleFilePath } from "./scheduler/schedule-storage.js";
import { ShuvdoQueueSchedulerService } from "./scheduler/shuvdo-queue-scheduler-service.js";
import { SwarmManager } from "./swarm/swarm-manager.js";
import type { AgentDescriptor } from "./swarm/types.js";
import { SwarmWebSocketServer } from "./ws/server.js";

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(backendRoot, "..", "..");
loadDotenv({ path: resolve(repoRoot, ".env") });

async function main(): Promise<void> {
  const config = createConfig();
  warnIfInsecureHostBinding(config.host, config.authToken);

  const schedulerFlags = {
    enableLegacyCron: parseBooleanEnv(process.env.SHUVLR_ENABLE_LEGACY_CRON, true),
    enableShuvdoQueue: parseBooleanEnv(process.env.SHUVLR_ENABLE_SHUVDO_QUEUE_SCHEDULER, false),
    shuvdoPollIntervalMs: parseIntegerEnv(process.env.SHUVLR_SHUVDO_QUEUE_POLL_INTERVAL_MS)
  };

  const shuvdoApi = process.env.SHUVDO_API?.trim();
  const shuvdoToken = process.env.SHUVDO_TOKEN?.trim();

  if (schedulerFlags.enableShuvdoQueue && (!shuvdoApi || !shuvdoToken)) {
    console.warn(
      "[scheduler] SHUVLR_ENABLE_SHUVDO_QUEUE_SCHEDULER is enabled but SHUVDO_API/SHUVDO_TOKEN are missing. " +
        "Shuvdo queue scheduler will be disabled."
    );
    schedulerFlags.enableShuvdoQueue = false;
  }

  const swarmManager = new SwarmManager(config);
  await swarmManager.boot();

  const cronSchedulersByManagerId = new Map<string, CronSchedulerService>();
  const shuvdoSchedulersByManagerId = new Map<string, ShuvdoQueueSchedulerService>();
  let schedulerLifecycle: Promise<void> = Promise.resolve();

  const syncSchedulers = async (managerIds: Set<string>): Promise<void> => {
    if (schedulerFlags.enableLegacyCron) {
      for (const managerId of managerIds) {
        if (cronSchedulersByManagerId.has(managerId)) {
          continue;
        }

        const scheduler = new CronSchedulerService({
          swarmManager,
          schedulesFile: getScheduleFilePath(config.paths.dataDir, managerId),
          managerId
        });
        await scheduler.start();
        cronSchedulersByManagerId.set(managerId, scheduler);
      }
    }

    if (schedulerFlags.enableShuvdoQueue && shuvdoApi && shuvdoToken) {
      for (const managerId of managerIds) {
        if (shuvdoSchedulersByManagerId.has(managerId)) {
          continue;
        }

        const scheduler = new ShuvdoQueueSchedulerService({
          swarmManager,
          managerId,
          dataDir: config.paths.dataDir,
          shuvdoApi,
          shuvdoToken,
          pollIntervalMs: schedulerFlags.shuvdoPollIntervalMs
        });
        await scheduler.start();
        shuvdoSchedulersByManagerId.set(managerId, scheduler);
      }
    }

    for (const [managerId, scheduler] of cronSchedulersByManagerId.entries()) {
      if (managerIds.has(managerId) && schedulerFlags.enableLegacyCron) {
        continue;
      }

      await scheduler.stop();
      cronSchedulersByManagerId.delete(managerId);
    }

    for (const [managerId, scheduler] of shuvdoSchedulersByManagerId.entries()) {
      if (managerIds.has(managerId) && schedulerFlags.enableShuvdoQueue) {
        continue;
      }

      await scheduler.stop();
      shuvdoSchedulersByManagerId.delete(managerId);
    }
  };

  const queueSchedulerSync = (managerIds: Set<string>): Promise<void> => {
    const next = schedulerLifecycle.then(
      () => syncSchedulers(managerIds),
      () => syncSchedulers(managerIds)
    );

    schedulerLifecycle = next.then(
      () => undefined,
      () => undefined
    );

    return next;
  };

  await queueSchedulerSync(collectManagerIds(swarmManager.listAgents(), config.managerId));

  const handleAgentsSnapshot = (event: unknown): void => {
    if (!event || typeof event !== "object") {
      return;
    }

    const payload = event as { type?: string; agents?: unknown };
    if (payload.type !== "agents_snapshot" || !Array.isArray(payload.agents)) {
      return;
    }

    const managerIds = collectManagerIds(payload.agents, config.managerId);
    void queueSchedulerSync(managerIds).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[scheduler] Failed to sync scheduler instances: ${message}`);
    });
  };

  swarmManager.on("agents_snapshot", handleAgentsSnapshot);

  const integrationRegistry = new IntegrationRegistryService({
    swarmManager,
    dataDir: config.paths.dataDir,
    defaultManagerId: config.managerId
  });
  await integrationRegistry.start();

  const gsuiteIntegration = new GsuiteIntegrationService({
    dataDir: config.paths.dataDir
  });
  await gsuiteIntegration.start();

  const wsServer = new SwarmWebSocketServer({
    swarmManager,
    host: config.host,
    port: config.port,
    allowNonManagerSubscriptions: config.allowNonManagerSubscriptions,
    authToken: config.authToken,
    allowedOrigins: config.allowedOrigins,
    integrationRegistry,
    gsuiteIntegration
  });
  await wsServer.start();

  console.log(`Shuvlr backend listening on ws://${config.host}:${config.port}`);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`Received ${signal}. Shutting down...`);
    swarmManager.off("agents_snapshot", handleAgentsSnapshot);
    await Promise.allSettled([
      queueSchedulerSync(new Set<string>()),
      integrationRegistry.stop(),
      gsuiteIntegration.stop(),
      wsServer.stop()
    ]);
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

function collectManagerIds(agents: unknown[], fallbackManagerId?: string): Set<string> {
  const managerIds = new Set<string>();

  for (const agent of agents) {
    if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
      continue;
    }

    const descriptor = agent as Partial<AgentDescriptor>;
    if (descriptor.role !== "manager") {
      continue;
    }

    if (typeof descriptor.agentId !== "string" || descriptor.agentId.trim().length === 0) {
      continue;
    }

    managerIds.add(descriptor.agentId.trim());
  }

  const normalizedFallbackManagerId =
    typeof fallbackManagerId === "string" ? fallbackManagerId.trim() : "";
  if (managerIds.size === 0 && normalizedFallbackManagerId.length > 0) {
    managerIds.add(normalizedFallbackManagerId);
  }

  return managerIds;
}

function parseBooleanEnv(rawValue: string | undefined, fallback: boolean): boolean {
  if (typeof rawValue !== "string") {
    return fallback;
  }

  const normalized = rawValue.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function parseIntegerEnv(rawValue: string | undefined): number | undefined {
  if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
    return undefined;
  }

  const parsed = Number.parseInt(rawValue.trim(), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}

function warnIfInsecureHostBinding(host: string, authToken: string | undefined): void {
  const normalizedHost = host.trim();
  const isLoopback =
    normalizedHost === "127.0.0.1" ||
    normalizedHost === "localhost" ||
    normalizedHost === "::1" ||
    normalizedHost === "[::1]";

  if (!isLoopback && !authToken?.trim()) {
    console.warn(
      "[security] Shuvlr is binding to a non-loopback host without SHUVLR_AUTH_TOKEN. " +
        "HTTP/WS control surfaces may be exposed."
    );
  }
}

void main().catch((error) => {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: string }).code === "EADDRINUSE"
  ) {
    const config = createConfig();
    console.error(
      `Failed to start backend: ws://${config.host}:${config.port} is already in use. ` +
        `Stop the other process or run with SHUVLR_PORT=<port>.`
    );
  } else {
    console.error(error);
  }
  process.exit(1);
});
