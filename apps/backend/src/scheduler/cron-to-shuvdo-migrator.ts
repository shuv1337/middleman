import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { createShuvdoClient } from "../swarm/shuvdo-client.js";
import { getScheduleFilePath } from "./schedule-storage.js";

interface LegacyScheduleRecord {
  id: string;
  name: string;
  cron: string;
  message: string;
  oneShot: boolean;
  timezone: string;
  nextFireAt: string;
}

export interface CronMigrationReport {
  managerId: string;
  sourceFile: string;
  total: number;
  migrated: Array<{ id: string; repeatRule?: string; dueAt: string }>;
  unsupported: Array<{ id: string; cron: string; reason: string }>;
  errors: Array<{ id: string; message: string }>;
}

export async function migrateCronSchedulesToShuvdo(options: {
  managerId: string;
  dataDir: string;
  shuvdoApi: string;
  shuvdoToken: string;
  listName?: string;
}): Promise<CronMigrationReport> {
  const sourceFile = getScheduleFilePath(options.dataDir, options.managerId);
  const report: CronMigrationReport = {
    managerId: options.managerId,
    sourceFile,
    total: 0,
    migrated: [],
    unsupported: [],
    errors: []
  };

  let schedules = await readSchedules(sourceFile);
  report.total = schedules.length;

  if (schedules.length === 0) {
    await writeMigrationReport(options.dataDir, report);
    return report;
  }

  const client = createShuvdoClient({
    baseUrl: options.shuvdoApi,
    token: options.shuvdoToken,
    onTelemetry: (event) => {
      console.info(`[telemetry][cron-migration] ${JSON.stringify(event)}`);
    }
  });

  const listName = options.listName?.trim() || `manager-${options.managerId}-migrated`;

  for (const schedule of schedules) {
    try {
      const mapping = mapScheduleToReminder(schedule);
      if (!mapping) {
        report.unsupported.push({
          id: schedule.id,
          cron: schedule.cron,
          reason: "Unsupported cron expression for automatic repeatRule conversion"
        });
        continue;
      }

      await client.createReminder({
        managerId: options.managerId,
        listName,
        body: {
          text: schedule.message,
          dueAt: mapping.dueAt,
          ...(mapping.repeatRule ? { repeatRule: mapping.repeatRule } : {}),
          note: `Migrated from legacy cron schedule ${schedule.id} (${schedule.name})`
        }
      });

      report.migrated.push({
        id: schedule.id,
        repeatRule: mapping.repeatRule,
        dueAt: mapping.dueAt
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.errors.push({ id: schedule.id, message });
    }
  }

  await writeMigrationReport(options.dataDir, report);
  return report;
}

async function readSchedules(sourceFile: string): Promise<LegacyScheduleRecord[]> {
  let raw: string;
  try {
    raw = await readFile(sourceFile, "utf8");
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [];
  }

  const records = (parsed as { schedules?: unknown }).schedules;
  if (!Array.isArray(records)) {
    return [];
  }

  const result: LegacyScheduleRecord[] = [];
  for (const record of records) {
    const normalized = normalizeSchedule(record);
    if (normalized) {
      result.push(normalized);
    }
  }

  return result;
}

function normalizeSchedule(record: unknown): LegacyScheduleRecord | undefined {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return undefined;
  }

  const typed = record as Partial<LegacyScheduleRecord>;
  const id = normalizeString(typed.id);
  const name = normalizeString(typed.name);
  const cron = normalizeString(typed.cron);
  const message = normalizeString(typed.message);
  const timezone = normalizeString(typed.timezone);
  const nextFireAt = normalizeString(typed.nextFireAt);

  if (!id || !name || !cron || !message || !timezone || !nextFireAt) {
    return undefined;
  }

  return {
    id,
    name,
    cron,
    message,
    timezone,
    nextFireAt,
    oneShot: typed.oneShot === true
  };
}

function mapScheduleToReminder(schedule: LegacyScheduleRecord):
  | {
      dueAt: string;
      repeatRule?: string;
    }
  | undefined {
  if (schedule.oneShot) {
    return {
      dueAt: schedule.nextFireAt
    };
  }

  const cron = schedule.cron.trim().replace(/\s+/g, " ");
  const parts = cron.split(" ");
  if (parts.length !== 5) {
    return undefined;
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  if (dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    if (/^\*\/\d+$/.test(minute) && hour === "*") {
      return {
        dueAt: schedule.nextFireAt,
        repeatRule: `every ${minute.slice(2)} minutes`
      };
    }

    if (minute === "0" && /^\*\/\d+$/.test(hour)) {
      return {
        dueAt: schedule.nextFireAt,
        repeatRule: `every ${hour.slice(2)} hours`
      };
    }

    return {
      dueAt: schedule.nextFireAt,
      repeatRule: "daily"
    };
  }

  if (dayOfMonth === "*" && month === "*" && dayOfWeek !== "*") {
    return {
      dueAt: schedule.nextFireAt,
      repeatRule: "weekly"
    };
  }

  if (dayOfMonth !== "*" && month === "*" && dayOfWeek === "*") {
    return {
      dueAt: schedule.nextFireAt,
      repeatRule: "monthly"
    };
  }

  return undefined;
}

async function writeMigrationReport(dataDir: string, report: CronMigrationReport): Promise<void> {
  const reportFile = resolve(dataDir, "scheduler", "shuvdo", `cron-migration-${report.managerId}.json`);
  await mkdir(dirname(reportFile), { recursive: true });
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
