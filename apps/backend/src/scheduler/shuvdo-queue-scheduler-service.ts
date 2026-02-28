import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { SwarmManager } from "../swarm/swarm-manager.js";
import { createShuvdoClient, type ShuvdoClient } from "../swarm/shuvdo-client.js";

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const MIN_POLL_INTERVAL_MS = 2_000;
const MAX_DEDUPE_KEYS = 5_000;

export interface ShuvdoQueueSchedulerServiceOptions {
  swarmManager: SwarmManager;
  managerId: string;
  dataDir: string;
  shuvdoApi: string;
  shuvdoToken: string;
  pollIntervalMs?: number;
  now?: () => Date;
}

interface DedupeCacheFile {
  delivered: string[];
}

interface QueueReminder {
  id: string;
  text: string;
  dueAt?: string;
  listName?: string;
  repeatRule?: string;
}

export class ShuvdoQueueSchedulerService {
  private readonly swarmManager: SwarmManager;
  private readonly managerId: string;
  private readonly pollIntervalMs: number;
  private readonly now: () => Date;
  private readonly dedupeCacheFile: string;
  private readonly client: ShuvdoClient;

  private readonly deliveredKeys = new Set<string>();
  private running = false;
  private pollTimer: NodeJS.Timeout | undefined;
  private processing = false;

  constructor(options: ShuvdoQueueSchedulerServiceOptions) {
    this.swarmManager = options.swarmManager;
    this.managerId = options.managerId.trim();
    this.pollIntervalMs = Math.max(
      MIN_POLL_INTERVAL_MS,
      Math.floor(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
    );
    this.now = options.now ?? (() => new Date());
    this.dedupeCacheFile = resolve(
      options.dataDir,
      "scheduler",
      "shuvdo",
      `${this.managerId}-dedupe.json`
    );

    this.client = createShuvdoClient({
      baseUrl: options.shuvdoApi,
      token: options.shuvdoToken,
      onTelemetry: (event) => {
        console.info(`[telemetry][shuvdo-scheduler] ${JSON.stringify(event)}`);
      }
    });
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    await this.loadDedupeCache();
    await this.runPollCycle("startup");

    this.pollTimer = setInterval(() => {
      void this.runPollCycle("interval");
    }, this.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    await this.persistDedupeCache();
  }

  private async runPollCycle(reason: "startup" | "interval"): Promise<void> {
    if (!this.running || this.processing) {
      return;
    }

    this.processing = true;
    const startedAt = Date.now();

    try {
      const queue = await this.client.getAgentQueue({
        managerId: this.managerId,
        agentId: this.managerId,
        limit: 100
      });

      const reminders = normalizeQueueReminders(queue);
      let dispatched = 0;
      let acked = 0;
      for (const reminder of reminders) {
        const dedupeKey = buildDedupeKey(reminder);
        if (this.deliveredKeys.has(dedupeKey)) {
          continue;
        }

        const delivered = await this.dispatchReminder(reminder);
        if (!delivered) {
          continue;
        }

        dispatched += 1;

        const ackedReminder = await this.completeReminder(reminder, dedupeKey);
        if (ackedReminder) {
          acked += 1;
          this.deliveredKeys.add(dedupeKey);
          if (this.deliveredKeys.size > MAX_DEDUPE_KEYS) {
            const keys = [...this.deliveredKeys];
            this.deliveredKeys.clear();
            for (const key of keys.slice(-Math.floor(MAX_DEDUPE_KEYS / 2))) {
              this.deliveredKeys.add(key);
            }
          }
        }
      }

      await this.persistDedupeCache();

      console.info(
        `[scheduler][shuvdo][${this.managerId}] poll cycle complete`,
        JSON.stringify({
          reason,
          queueReminders: reminders.length,
          dispatched,
          acked,
          latencyMs: Date.now() - startedAt
        })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[scheduler][shuvdo][${this.managerId}] poll cycle failed: ${message}`,
        JSON.stringify({ reason, latencyMs: Date.now() - startedAt })
      );
    } finally {
      this.processing = false;
    }
  }

  private async dispatchReminder(reminder: QueueReminder): Promise<boolean> {
    const payload = {
      reminderId: reminder.id,
      listName: reminder.listName,
      dueAt: reminder.dueAt,
      repeatRule: reminder.repeatRule,
      managerId: this.managerId,
      deliveredAt: this.now().toISOString()
    };

    const message = [
      `[Shuvdo Reminder] ${reminder.text}`,
      `[shuvdoReminder] ${JSON.stringify(payload)}`
    ].join("\n");

    try {
      await this.swarmManager.handleUserMessage(message, {
        targetAgentId: this.managerId,
        sourceContext: {
          channel: "web",
          userId: "shuvdo-scheduler"
        }
      });
      return true;
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      console.error(
        `[scheduler][shuvdo][${this.managerId}] dispatch failed for reminder ${reminder.id}: ${messageText}`
      );
      return false;
    }
  }

  private async completeReminder(reminder: QueueReminder, dedupeKey: string): Promise<boolean> {
    try {
      await this.client.completeReminder({
        managerId: this.managerId,
        reminderId: reminder.id,
        idempotencyKey: `shuvlr-reminder-${this.managerId}-${dedupeKey}`
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[scheduler][shuvdo][${this.managerId}] complete failed for reminder ${reminder.id}: ${message}`
      );
      return false;
    }
  }

  private async loadDedupeCache(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.dedupeCacheFile, "utf8");
    } catch {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return;
    }

    const delivered = (parsed as DedupeCacheFile).delivered;
    if (!Array.isArray(delivered)) {
      return;
    }

    for (const key of delivered) {
      if (typeof key === "string" && key.trim()) {
        this.deliveredKeys.add(key);
      }
    }
  }

  private async persistDedupeCache(): Promise<void> {
    const file = this.dedupeCacheFile;
    const temp = `${file}.tmp`;

    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      temp,
      `${JSON.stringify({ delivered: [...this.deliveredKeys] }, null, 2)}\n`,
      "utf8"
    );
    await rename(temp, file);
  }
}

function normalizeQueueReminders(payload: Record<string, unknown>): QueueReminder[] {
  const reminders = payload.reminders;
  if (!Array.isArray(reminders)) {
    return [];
  }

  const result: QueueReminder[] = [];
  for (const entry of reminders) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }

    const item = entry as {
      id?: unknown;
      text?: unknown;
      dueAt?: unknown;
      listName?: unknown;
      repeatRule?: unknown;
      itemId?: unknown;
      title?: unknown;
    };

    const id = normalizeString(item.id) ?? normalizeString(item.itemId);
    const text = normalizeString(item.text) ?? normalizeString(item.title) ?? "(untitled reminder)";

    if (!id) {
      continue;
    }

    result.push({
      id,
      text,
      dueAt: normalizeString(item.dueAt),
      listName: normalizeString(item.listName),
      repeatRule: normalizeString(item.repeatRule)
    });
  }

  return result;
}

function buildDedupeKey(reminder: QueueReminder): string {
  const dueAt = reminder.dueAt?.trim() || "none";
  return `${reminder.id}:${dueAt}`;
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
