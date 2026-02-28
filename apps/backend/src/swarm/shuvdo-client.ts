import { randomUUID } from "node:crypto";

export interface ShuvdoTelemetryEvent {
  toolName: string;
  managerId: string;
  endpoint: string;
  method: string;
  latencyMs: number;
  success: boolean;
  statusCode?: number;
  errorType?: string;
  errorMessage?: string;
}

export class ShuvdoClientError extends Error {
  readonly statusCode: number;
  readonly endpoint: string;
  readonly method: string;
  readonly payload?: unknown;

  constructor(options: {
    message: string;
    statusCode: number;
    endpoint: string;
    method: string;
    payload?: unknown;
  }) {
    super(options.message);
    this.name = "ShuvdoClientError";
    this.statusCode = options.statusCode;
    this.endpoint = options.endpoint;
    this.method = options.method;
    this.payload = options.payload;
  }
}

export interface ShuvdoClient {
  createTask(options: {
    managerId: string;
    listName: string;
    body: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
  completeTask(options: {
    managerId: string;
    listName: string;
    itemId: string;
    body?: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
  listTasks(options: { managerId: string; listName: string }): Promise<Record<string, unknown>>;
  createReminder(options: {
    managerId: string;
    listName: string;
    body: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
  listDueReminders(options: {
    managerId: string;
    limit?: number;
    consumer?: "bot" | "signal";
  }): Promise<Record<string, unknown>>;
  completeReminder(options: {
    managerId: string;
    reminderId: string;
    idempotencyKey?: string;
    body?: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
  listProjects(options: { managerId: string }): Promise<Record<string, unknown>>;
  createProject(options: { managerId: string; body: Record<string, unknown> }): Promise<Record<string, unknown>>;
  showProject(options: { managerId: string; projectId: string }): Promise<Record<string, unknown>>;
  updateProject(options: {
    managerId: string;
    projectId: string;
    body: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
  createMilestone(options: {
    managerId: string;
    projectId: string;
    body: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
  updateMilestone(options: {
    managerId: string;
    projectId: string;
    milestoneId: string;
    body: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
  getAgentQueue(options: {
    managerId: string;
    agentId: string;
    limit?: number;
  }): Promise<Record<string, unknown>>;
}

export function createShuvdoClient(options: {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  onTelemetry?: (event: ShuvdoTelemetryEvent) => void;
}): ShuvdoClient {
  const baseUrl = options.baseUrl.trim().replace(/\/$/, "");
  const token = options.token.trim();
  const fetchImpl = options.fetchImpl ?? fetch;

  const requestJson = async (input: {
    managerId: string;
    toolName: string;
    endpoint: string;
    method: "GET" | "POST" | "PATCH" | "DELETE";
    query?: Record<string, string | number | boolean | undefined>;
    body?: Record<string, unknown>;
    idempotencyKey?: string;
  }): Promise<Record<string, unknown>> => {
    const startedAt = Date.now();
    const url = new URL(`${baseUrl}${input.endpoint}`);

    for (const [key, value] of Object.entries(input.query ?? {})) {
      if (value === undefined) {
        continue;
      }
      url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    };

    if (input.idempotencyKey) {
      headers["x-idempotency-key"] = input.idempotencyKey;
    }

    try {
      const response = await fetchImpl(url.toString(), {
        method: input.method,
        headers,
        body: input.body ? JSON.stringify(input.body) : undefined
      });

      const payload = await readJsonOrText(response);

      if (!response.ok) {
        const message = extractPayloadErrorMessage(payload) ?? `Shuvdo request failed (${response.status})`;
        const error = new ShuvdoClientError({
          message,
          statusCode: response.status,
          endpoint: input.endpoint,
          method: input.method,
          payload
        });

        options.onTelemetry?.({
          toolName: input.toolName,
          managerId: input.managerId,
          endpoint: input.endpoint,
          method: input.method,
          latencyMs: Date.now() - startedAt,
          success: false,
          statusCode: response.status,
          errorType: "http_error",
          errorMessage: message
        });

        throw error;
      }

      const normalized =
        payload && typeof payload === "object" && !Array.isArray(payload)
          ? (payload as Record<string, unknown>)
          : { result: payload };

      options.onTelemetry?.({
        toolName: input.toolName,
        managerId: input.managerId,
        endpoint: input.endpoint,
        method: input.method,
        latencyMs: Date.now() - startedAt,
        success: true,
        statusCode: response.status
      });

      return normalized;
    } catch (error) {
      if (error instanceof ShuvdoClientError) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);

      options.onTelemetry?.({
        toolName: input.toolName,
        managerId: input.managerId,
        endpoint: input.endpoint,
        method: input.method,
        latencyMs: Date.now() - startedAt,
        success: false,
        errorType: "network_error",
        errorMessage: message
      });

      throw new Error(`Failed to reach Shuvdo API: ${message}`);
    }
  };

  return {
    async createTask(options) {
      return requestJson({
        managerId: options.managerId,
        toolName: "create_task",
        endpoint: `/api/list/${encodeURIComponent(options.listName)}/add`,
        method: "POST",
        body: options.body
      });
    },
    async completeTask(options) {
      return requestJson({
        managerId: options.managerId,
        toolName: "complete_task",
        endpoint: `/api/list/${encodeURIComponent(options.listName)}/${encodeURIComponent(options.itemId)}/done`,
        method: "POST",
        body: options.body ?? {}
      });
    },
    async listTasks(options) {
      return requestJson({
        managerId: options.managerId,
        toolName: "list_tasks",
        endpoint: `/api/list/${encodeURIComponent(options.listName)}`,
        method: "GET"
      });
    },
    async createReminder(options) {
      return requestJson({
        managerId: options.managerId,
        toolName: "create_reminder",
        endpoint: `/api/list/${encodeURIComponent(options.listName)}/add`,
        method: "POST",
        body: options.body
      });
    },
    async listDueReminders(options) {
      return requestJson({
        managerId: options.managerId,
        toolName: "list_due_reminders",
        endpoint: "/api/reminders/next",
        method: "GET",
        query: {
          limit: options.limit,
          consumer: options.consumer
        }
      });
    },
    async completeReminder(options) {
      return requestJson({
        managerId: options.managerId,
        toolName: "complete_reminder",
        endpoint: `/api/reminders/${encodeURIComponent(options.reminderId)}/complete`,
        method: "POST",
        body: options.body ?? {},
        idempotencyKey:
          options.idempotencyKey?.trim() ||
          `shuvlr-reminder-complete-${options.reminderId}-${randomUUID()}`
      });
    },
    async listProjects(options) {
      return requestJson({
        managerId: options.managerId,
        toolName: "list_projects",
        endpoint: "/api/projects",
        method: "GET"
      });
    },
    async createProject(options) {
      return requestJson({
        managerId: options.managerId,
        toolName: "create_project",
        endpoint: "/api/projects/add",
        method: "POST",
        body: options.body
      });
    },
    async showProject(options) {
      return requestJson({
        managerId: options.managerId,
        toolName: "show_project",
        endpoint: `/api/projects/${encodeURIComponent(options.projectId)}`,
        method: "GET"
      });
    },
    async updateProject(options) {
      return requestJson({
        managerId: options.managerId,
        toolName: "update_project",
        endpoint: `/api/projects/${encodeURIComponent(options.projectId)}`,
        method: "PATCH",
        body: options.body
      });
    },
    async createMilestone(options) {
      return requestJson({
        managerId: options.managerId,
        toolName: "create_milestone",
        endpoint: `/api/projects/${encodeURIComponent(options.projectId)}/milestones/add`,
        method: "POST",
        body: options.body
      });
    },
    async updateMilestone(options) {
      return requestJson({
        managerId: options.managerId,
        toolName: "update_milestone",
        endpoint: `/api/projects/${encodeURIComponent(options.projectId)}/milestones/${encodeURIComponent(options.milestoneId)}`,
        method: "PATCH",
        body: options.body
      });
    },
    async getAgentQueue(options) {
      return requestJson({
        managerId: options.managerId,
        toolName: "get_agent_queue",
        endpoint: `/api/agents/${encodeURIComponent(options.agentId)}/queue`,
        method: "GET",
        query: {
          limit: options.limit
        }
      });
    }
  };
}

async function readJsonOrText(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    try {
      return await response.json();
    } catch {
      return { error: `Invalid JSON response (${response.status})` };
    }
  }

  try {
    const text = await response.text();
    return text.length > 0 ? { message: text } : {};
  } catch {
    return {};
  }
}

function extractPayloadErrorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }

  const typed = payload as { error?: unknown; message?: unknown };
  if (typeof typed.error === "string" && typed.error.trim().length > 0) {
    return typed.error;
  }

  if (typeof typed.message === "string" && typed.message.trim().length > 0) {
    return typed.message;
  }

  return undefined;
}
