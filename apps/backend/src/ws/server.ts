import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { homedir, tmpdir } from "node:os";
import { extname, join } from "node:path";
import { anthropicOAuthProvider } from "@mariozechner/pi-ai/dist/utils/oauth/anthropic.js";
import { openaiCodexOAuthProvider } from "@mariozechner/pi-ai/dist/utils/oauth/openai-codex.js";
import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
  OAuthProviderInterface
} from "@mariozechner/pi-ai/dist/utils/oauth/types.js";
import { AuthStorage, type AuthCredential } from "@mariozechner/pi-coding-agent";
import { WebSocketServer, type RawData, WebSocket } from "ws";
import type { GsuiteIntegrationService } from "../integrations/gsuite/gsuite-integration.js";
import type { IntegrationRegistryService } from "../integrations/registry.js";
import type { ClientCommand, ServerEvent } from "../protocol/ws-types.js";
import { getScheduleFilePath } from "../scheduler/schedule-storage.js";
import {
  isPathWithinRoots,
  normalizeAllowlistRoots,
  resolveDirectoryPath
} from "../swarm/cwd-policy.js";
import { describeSwarmModelPresets, isSwarmModelPreset } from "../swarm/model-presets.js";
import type { SwarmManager } from "../swarm/swarm-manager.js";
import type { ConversationAttachment } from "../swarm/types.js";

const REBOOT_ENDPOINT_PATH = "/api/reboot";
const READ_FILE_ENDPOINT_PATH = "/api/read-file";
const TRANSCRIBE_ENDPOINT_PATH = "/api/transcribe";
const MANAGER_SCHEDULES_ENDPOINT_PATTERN = /^\/api\/managers\/([^/]+)\/schedules$/;
const AGENT_COMPACT_ENDPOINT_PATTERN = /^\/api\/agents\/([^/]+)\/compact$/;
const SETTINGS_ENV_ENDPOINT_PATH = "/api/settings/env";
const SETTINGS_AUTH_ENDPOINT_PATH = "/api/settings/auth";
const SETTINGS_MODELS_ENDPOINT_PATH = "/api/settings/models";
const SETTINGS_AUTH_LOGIN_ENDPOINT_PATH = "/api/settings/auth/login";
const MANAGER_SLACK_INTEGRATION_ENDPOINT_PATTERN = /^\/api\/managers\/([^/]+)\/integrations\/slack$/;
const MANAGER_SLACK_INTEGRATION_TEST_ENDPOINT_PATTERN =
  /^\/api\/managers\/([^/]+)\/integrations\/slack\/test$/;
const MANAGER_SLACK_INTEGRATION_CHANNELS_ENDPOINT_PATTERN =
  /^\/api\/managers\/([^/]+)\/integrations\/slack\/channels$/;
const MANAGER_TELEGRAM_INTEGRATION_ENDPOINT_PATTERN = /^\/api\/managers\/([^/]+)\/integrations\/telegram$/;
const MANAGER_TELEGRAM_INTEGRATION_TEST_ENDPOINT_PATTERN =
  /^\/api\/managers\/([^/]+)\/integrations\/telegram\/test$/;
const GSUITE_INTEGRATION_ENDPOINT_PATH = "/api/integrations/gsuite";
const GSUITE_INTEGRATION_OAUTH_CREDENTIALS_ENDPOINT_PATH = "/api/integrations/gsuite/oauth/credentials";
const GSUITE_INTEGRATION_OAUTH_START_ENDPOINT_PATH = "/api/integrations/gsuite/oauth/start";
const GSUITE_INTEGRATION_OAUTH_COMPLETE_ENDPOINT_PATH = "/api/integrations/gsuite/oauth/complete";
const GSUITE_INTEGRATION_TEST_ENDPOINT_PATH = "/api/integrations/gsuite/test";
const RESTART_SIGNAL: NodeJS.Signals = "SIGUSR1";
const MAX_HTTP_BODY_SIZE_BYTES = 64 * 1024;
const MAX_READ_FILE_BODY_BYTES = 64 * 1024;
const MAX_READ_FILE_CONTENT_BYTES = 2 * 1024 * 1024;
const MAX_TRANSCRIBE_FILE_BYTES = 4_000_000;
const MAX_TRANSCRIBE_BODY_BYTES = MAX_TRANSCRIBE_FILE_BYTES + 512 * 1024;
const OPENAI_TRANSCRIPTION_URL = "https://api.openai.com/v1/audio/transcriptions";
const OPENAI_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
const OPENAI_TRANSCRIPTION_TIMEOUT_MS = 30_000;
const ALLOWED_TRANSCRIBE_MIME_TYPES = new Set([
  "audio/webm",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg"
]);
const READ_FILE_METHODS = "GET, POST, OPTIONS";
const TRANSCRIBE_METHODS = "POST, OPTIONS";
const SETTINGS_AUTH_LOGIN_METHODS = "POST, OPTIONS";
const SETTINGS_AUTH_METHODS = "GET, PUT, DELETE, POST, OPTIONS";
const BOOTSTRAP_SUBSCRIPTION_AGENT_ID = "__bootstrap_manager__";

type OAuthLoginProviderId = "anthropic" | "openai-codex";

type SettingsAuthLoginEventName = "auth_url" | "prompt" | "progress" | "complete" | "error";

type SettingsAuthLoginEventPayload = {
  auth_url: { url: string; instructions?: string };
  prompt: { message: string; placeholder?: string };
  progress: { message: string };
  complete: { provider: OAuthLoginProviderId; status: "connected" };
  error: { message: string };
};

interface ScheduleHttpRecord {
  id: string;
  name: string;
  cron: string;
  message: string;
  oneShot: boolean;
  timezone: string;
  createdAt: string;
  nextFireAt: string;
  lastFiredAt?: string;
}

interface SettingsAuthLoginFlow {
  providerId: OAuthLoginProviderId;
  pendingPrompt:
    | {
        resolve: (value: string) => void;
        reject: (error: Error) => void;
      }
    | null;
  abortController: AbortController;
  closed: boolean;
}

const SETTINGS_AUTH_LOGIN_PROVIDERS: Record<OAuthLoginProviderId, OAuthProviderInterface> = {
  anthropic: anthropicOAuthProvider,
  "openai-codex": openaiCodexOAuthProvider
};

export class SwarmWebSocketServer {
  private readonly swarmManager: SwarmManager;
  private readonly host: string;
  private readonly port: number;
  private readonly allowNonManagerSubscriptions: boolean;
  private readonly authToken: string | undefined;
  private readonly allowedOrigins: Set<string> | undefined;
  private readonly integrationRegistry: IntegrationRegistryService | null;
  private readonly gsuiteIntegration: GsuiteIntegrationService | null;

  private httpServer: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private readonly subscriptions = new Map<WebSocket, string>();
  private readonly activeSettingsAuthLoginFlows = new Map<OAuthLoginProviderId, SettingsAuthLoginFlow>();

  private readonly onConversationMessage = (event: ServerEvent): void => {
    if (event.type !== "conversation_message") return;
    this.broadcastToSubscribed(event);
  };

  private readonly onConversationLog = (event: ServerEvent): void => {
    if (event.type !== "conversation_log") return;
    this.broadcastToSubscribed(event);
  };

  private readonly onAgentMessage = (event: ServerEvent): void => {
    if (event.type !== "agent_message") return;
    this.broadcastToSubscribed(event);
  };

  private readonly onAgentToolCall = (event: ServerEvent): void => {
    if (event.type !== "agent_tool_call") return;
    this.broadcastToSubscribed(event);
  };

  private readonly onConversationReset = (event: ServerEvent): void => {
    if (event.type !== "conversation_reset") return;
    this.broadcastToSubscribed(event);
  };

  private readonly onAgentStatus = (event: ServerEvent): void => {
    if (event.type !== "agent_status") return;
    this.broadcastToSubscribed(event);
  };

  private readonly onAgentsSnapshot = (event: ServerEvent): void => {
    if (event.type !== "agents_snapshot") return;
    this.broadcastToSubscribed(event);
  };

  private readonly onSlackStatus = (event: ServerEvent): void => {
    if (event.type !== "slack_status") return;
    this.broadcastToSubscribed(event);
  };

  private readonly onTelegramStatus = (event: ServerEvent): void => {
    if (event.type !== "telegram_status") return;
    this.broadcastToSubscribed(event);
  };

  constructor(options: {
    swarmManager: SwarmManager;
    host: string;
    port: number;
    allowNonManagerSubscriptions: boolean;
    authToken?: string;
    allowedOrigins?: string[];
    integrationRegistry?: IntegrationRegistryService;
    gsuiteIntegration?: GsuiteIntegrationService;
  }) {
    this.swarmManager = options.swarmManager;
    this.host = options.host;
    this.port = options.port;
    this.allowNonManagerSubscriptions = options.allowNonManagerSubscriptions;
    this.authToken = normalizeAuthToken(options.authToken);
    this.allowedOrigins =
      options.allowedOrigins && options.allowedOrigins.length > 0
        ? new Set(options.allowedOrigins.map((origin) => origin.trim()).filter((origin) => origin.length > 0))
        : undefined;
    this.integrationRegistry = options.integrationRegistry ?? null;
    this.gsuiteIntegration = options.gsuiteIntegration ?? null;
  }

  async start(): Promise<void> {
    if (this.httpServer || this.wss) return;

    const httpServer = createServer((request, response) => {
      void this.handleHttpRequest(request, response);
    });
    const wss = new WebSocketServer({
      server: httpServer
    });

    this.httpServer = httpServer;
    this.wss = wss;

    this.wss.on("connection", (socket, request) => {
      if (!this.isOriginAllowed(request.headers.origin)) {
        socket.close(1008, "Forbidden");
        return;
      }

      if (this.authToken && !this.isAuthorizedRequest(request, true)) {
        socket.close(1008, "Unauthorized");
        return;
      }

      socket.on("message", (raw) => {
        void this.handleSocketMessage(socket, raw);
      });

      socket.on("close", () => {
        this.subscriptions.delete(socket);
      });

      socket.on("error", () => {
        this.subscriptions.delete(socket);
      });
    });

    await new Promise<void>((resolve, reject) => {
      const onListening = (): void => {
        cleanup();
        resolve();
      };

      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };

      const cleanup = (): void => {
        httpServer.off("listening", onListening);
        httpServer.off("error", onError);
      };

      httpServer.on("listening", onListening);
      httpServer.on("error", onError);
      httpServer.listen(this.port, this.host);
    });

    this.swarmManager.on("conversation_message", this.onConversationMessage);
    this.swarmManager.on("conversation_log", this.onConversationLog);
    this.swarmManager.on("agent_message", this.onAgentMessage);
    this.swarmManager.on("agent_tool_call", this.onAgentToolCall);
    this.swarmManager.on("conversation_reset", this.onConversationReset);
    this.swarmManager.on("agent_status", this.onAgentStatus);
    this.swarmManager.on("agents_snapshot", this.onAgentsSnapshot);
    this.integrationRegistry?.on("slack_status", this.onSlackStatus);
    this.integrationRegistry?.on("telegram_status", this.onTelegramStatus);
  }

  async stop(): Promise<void> {
    this.swarmManager.off("conversation_message", this.onConversationMessage);
    this.swarmManager.off("conversation_log", this.onConversationLog);
    this.swarmManager.off("agent_message", this.onAgentMessage);
    this.swarmManager.off("agent_tool_call", this.onAgentToolCall);
    this.swarmManager.off("conversation_reset", this.onConversationReset);
    this.swarmManager.off("agent_status", this.onAgentStatus);
    this.swarmManager.off("agents_snapshot", this.onAgentsSnapshot);
    this.integrationRegistry?.off("slack_status", this.onSlackStatus);
    this.integrationRegistry?.off("telegram_status", this.onTelegramStatus);

    const currentWss = this.wss;
    const currentHttpServer = this.httpServer;

    this.wss = null;
    this.httpServer = null;
    this.subscriptions.clear();
    this.cancelAllActiveSettingsAuthLoginFlows();

    if (currentWss) {
      await closeWebSocketServer(currentWss);
    }

    if (currentHttpServer) {
      await closeHttpServer(currentHttpServer);
    }
  }

  private async handleHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestUrl = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? `${this.host}:${this.port}`}`
    );

    const allowedMethods = this.resolveAllowedHttpMethods(requestUrl.pathname);

    if (!this.isOriginAllowed(request.headers.origin)) {
      this.applyCorsHeaders(request, response, allowedMethods);
      this.sendJson(response, 403, { error: "Origin is not allowed." });
      return;
    }

    if (this.authToken && request.method !== "OPTIONS" && !this.isAuthorizedRequest(request, false)) {
      this.applyCorsHeaders(request, response, allowedMethods);
      this.sendJson(response, 401, { error: "Unauthorized" });
      return;
    }

    try {
      if (requestUrl.pathname === REBOOT_ENDPOINT_PATH) {
        this.handleRebootHttpRequest(request, response);
        return;
      }

      if (requestUrl.pathname === READ_FILE_ENDPOINT_PATH) {
        await this.handleReadFileHttpRequest(request, response, requestUrl);
        return;
      }

      if (requestUrl.pathname === TRANSCRIBE_ENDPOINT_PATH) {
        await this.handleTranscribeHttpRequest(request, response);
        return;
      }

      const schedulesRoute = resolveSchedulesRoute(requestUrl.pathname);
      if (schedulesRoute) {
        await this.handleSchedulesHttpRequest(request, response, schedulesRoute);
        return;
      }

      if (AGENT_COMPACT_ENDPOINT_PATTERN.test(requestUrl.pathname)) {
        await this.handleCompactAgentHttpRequest(request, response, requestUrl);
        return;
      }

      if (
        requestUrl.pathname === SETTINGS_ENV_ENDPOINT_PATH ||
        requestUrl.pathname.startsWith(`${SETTINGS_ENV_ENDPOINT_PATH}/`)
      ) {
        await this.handleSettingsEnvHttpRequest(request, response, requestUrl);
        return;
      }

      if (requestUrl.pathname === SETTINGS_MODELS_ENDPOINT_PATH) {
        await this.handleSettingsModelsHttpRequest(request, response);
        return;
      }

      if (
        requestUrl.pathname === SETTINGS_AUTH_ENDPOINT_PATH ||
        requestUrl.pathname.startsWith(`${SETTINGS_AUTH_ENDPOINT_PATH}/`)
      ) {
        await this.handleSettingsAuthHttpRequest(request, response, requestUrl);
        return;
      }

      if (isSlackIntegrationPath(requestUrl.pathname)) {
        await this.handleSlackIntegrationHttpRequest(request, response, requestUrl);
        return;
      }

      if (isTelegramIntegrationPath(requestUrl.pathname)) {
        await this.handleTelegramIntegrationHttpRequest(request, response, requestUrl);
        return;
      }

      if (
        requestUrl.pathname === GSUITE_INTEGRATION_ENDPOINT_PATH ||
        requestUrl.pathname === GSUITE_INTEGRATION_OAUTH_CREDENTIALS_ENDPOINT_PATH ||
        requestUrl.pathname === GSUITE_INTEGRATION_OAUTH_START_ENDPOINT_PATH ||
        requestUrl.pathname === GSUITE_INTEGRATION_OAUTH_COMPLETE_ENDPOINT_PATH ||
        requestUrl.pathname === GSUITE_INTEGRATION_TEST_ENDPOINT_PATH
      ) {
        await this.handleGsuiteIntegrationHttpRequest(request, response, requestUrl);
        return;
      }

      response.statusCode = 404;
      response.end("Not Found");
    } catch (error) {
      if (response.writableEnded || response.headersSent) {
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      const statusCode =
        message.includes("must be") ||
        message.includes("Invalid") ||
        message.includes("Missing") ||
        message.includes("too large")
          ? 400
          : 500;

      if (
        requestUrl.pathname === SETTINGS_ENV_ENDPOINT_PATH ||
        requestUrl.pathname.startsWith(`${SETTINGS_ENV_ENDPOINT_PATH}/`)
      ) {
        this.applyCorsHeaders(request, response, "GET, PUT, DELETE, OPTIONS");
      } else if (requestUrl.pathname === SETTINGS_MODELS_ENDPOINT_PATH) {
        this.applyCorsHeaders(request, response, "GET, OPTIONS");
      } else if (
        requestUrl.pathname === SETTINGS_AUTH_ENDPOINT_PATH ||
        requestUrl.pathname.startsWith(`${SETTINGS_AUTH_ENDPOINT_PATH}/`)
      ) {
        this.applyCorsHeaders(request, response, SETTINGS_AUTH_METHODS);
      } else if (requestUrl.pathname === READ_FILE_ENDPOINT_PATH) {
        this.applyCorsHeaders(request, response, READ_FILE_METHODS);
      } else if (requestUrl.pathname === TRANSCRIBE_ENDPOINT_PATH) {
        this.applyCorsHeaders(request, response, TRANSCRIBE_METHODS);
      } else if (isSchedulesPath(requestUrl.pathname)) {
        this.applyCorsHeaders(request, response, "GET, OPTIONS");
      } else if (AGENT_COMPACT_ENDPOINT_PATTERN.test(requestUrl.pathname)) {
        this.applyCorsHeaders(request, response, "POST, OPTIONS");
      } else if (isSlackIntegrationPath(requestUrl.pathname)) {
        this.applyCorsHeaders(request, response, "GET, PUT, DELETE, POST, OPTIONS");
      } else if (isTelegramIntegrationPath(requestUrl.pathname)) {
        this.applyCorsHeaders(request, response, "GET, PUT, DELETE, POST, OPTIONS");
      } else if (
        requestUrl.pathname === GSUITE_INTEGRATION_ENDPOINT_PATH ||
        requestUrl.pathname === GSUITE_INTEGRATION_OAUTH_CREDENTIALS_ENDPOINT_PATH ||
        requestUrl.pathname === GSUITE_INTEGRATION_OAUTH_START_ENDPOINT_PATH ||
        requestUrl.pathname === GSUITE_INTEGRATION_OAUTH_COMPLETE_ENDPOINT_PATH ||
        requestUrl.pathname === GSUITE_INTEGRATION_TEST_ENDPOINT_PATH
      ) {
        this.applyCorsHeaders(request, response, "GET, PUT, DELETE, POST, OPTIONS");
      }

      this.sendJson(response, statusCode, { error: message });
    }
  }

  private handleRebootHttpRequest(request: IncomingMessage, response: ServerResponse): void {
    if (request.method === "OPTIONS") {
      this.applyCorsHeaders(request, response, "POST, OPTIONS");
      response.statusCode = 204;
      response.end();
      return;
    }

    if (request.method !== "POST") {
      this.applyCorsHeaders(request, response, "POST, OPTIONS");
      response.setHeader("Allow", "POST, OPTIONS");
      this.sendJson(response, 405, { error: "Method Not Allowed" });
      return;
    }

    this.applyCorsHeaders(request, response, "POST, OPTIONS");
    this.sendJson(response, 200, { ok: true });

    const rebootTimer = setTimeout(() => {
      this.triggerRebootSignal();
    }, 25);
    rebootTimer.unref();
  }

  private async handleReadFileHttpRequest(
    request: IncomingMessage,
    response: ServerResponse,
    requestUrl: URL
  ): Promise<void> {
    if (request.method === "OPTIONS") {
      this.applyCorsHeaders(request, response, READ_FILE_METHODS);
      response.statusCode = 204;
      response.end();
      return;
    }

    if (request.method !== "POST" && request.method !== "GET") {
      this.applyCorsHeaders(request, response, READ_FILE_METHODS);
      response.setHeader("Allow", READ_FILE_METHODS);
      this.sendJson(response, 405, { error: "Method Not Allowed" });
      return;
    }

    this.applyCorsHeaders(request, response, READ_FILE_METHODS);

    try {
      let requestedPath = "";

      if (request.method === "GET") {
        const pathFromQuery = requestUrl.searchParams.get("path");
        if (typeof pathFromQuery !== "string" || pathFromQuery.trim().length === 0) {
          this.sendJson(response, 400, { error: "path must be a non-empty string." });
          return;
        }
        requestedPath = pathFromQuery;
      } else {
        const payload = await this.parseJsonBody(request, MAX_READ_FILE_BODY_BYTES);
        if (!payload || typeof payload !== "object") {
          this.sendJson(response, 400, { error: "Request body must be a JSON object." });
          return;
        }

        const pathFromBody = (payload as { path?: unknown }).path;
        if (typeof pathFromBody !== "string" || pathFromBody.trim().length === 0) {
          this.sendJson(response, 400, { error: "path must be a non-empty string." });
          return;
        }

        requestedPath = pathFromBody;
      }

      if (requestedPath.trim().length === 0) {
        this.sendJson(response, 400, { error: "path must be a non-empty string." });
        return;
      }

      const config = this.swarmManager.getConfig();
      const resolvedPath = resolveDirectoryPath(requestedPath, config.paths.rootDir);
      const allowedRoots = normalizeAllowlistRoots([
        ...config.cwdAllowlistRoots,
        config.paths.rootDir,
        homedir(),
        "/tmp"
      ]);

      if (!isPathWithinRoots(resolvedPath, allowedRoots)) {
        this.sendJson(response, 403, { error: "Path is outside allowed roots." });
        return;
      }

      let fileStats;
      try {
        fileStats = await stat(resolvedPath);
      } catch {
        this.sendJson(response, 404, { error: "File not found." });
        return;
      }

      if (!fileStats.isFile()) {
        this.sendJson(response, 400, { error: "Requested path must point to a file." });
        return;
      }

      if (fileStats.size > MAX_READ_FILE_CONTENT_BYTES) {
        this.sendJson(response, 413, {
          error: `File is too large. Maximum supported size is ${MAX_READ_FILE_CONTENT_BYTES} bytes.`
        });
        return;
      }

      if (request.method === "GET") {
        const content = await readFile(resolvedPath);
        response.statusCode = 200;
        response.setHeader("Content-Type", resolveReadFileContentType(resolvedPath));
        response.setHeader("Content-Length", String(content.byteLength));
        response.setHeader("Cache-Control", "no-store");
        response.end(content);
        return;
      }

      const content = await readFile(resolvedPath, "utf8");
      this.sendJson(response, 200, {
        path: resolvedPath,
        content
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to read file.";

      if (message.includes("Request body exceeds")) {
        this.sendJson(response, 413, { error: message });
        return;
      }

      if (message.includes("valid JSON")) {
        this.sendJson(response, 400, { error: message });
        return;
      }

      this.sendJson(response, 500, { error: message });
    }
  }

  private async handleTranscribeHttpRequest(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    if (request.method === "OPTIONS") {
      this.applyCorsHeaders(request, response, TRANSCRIBE_METHODS);
      response.statusCode = 204;
      response.end();
      return;
    }

    if (request.method !== "POST") {
      this.applyCorsHeaders(request, response, TRANSCRIBE_METHODS);
      response.setHeader("Allow", TRANSCRIBE_METHODS);
      this.sendJson(response, 405, { error: "Method Not Allowed" });
      return;
    }

    this.applyCorsHeaders(request, response, TRANSCRIBE_METHODS);

    const contentType = request.headers["content-type"];
    if (typeof contentType !== "string" || !contentType.toLowerCase().includes("multipart/form-data")) {
      this.sendJson(response, 400, { error: "Content-Type must be multipart/form-data" });
      return;
    }

    let rawBody: Buffer;
    try {
      rawBody = await this.readRequestBody(request, MAX_TRANSCRIBE_BODY_BYTES);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes("too large")) {
        this.sendJson(response, 413, { error: "Audio file too large. Max size is 4MB." });
        return;
      }
      throw error;
    }

    const formData = await parseMultipartFormData(rawBody, contentType);

    const fileValue = formData.get("file");
    if (!(fileValue instanceof File)) {
      this.sendJson(response, 400, { error: "Missing audio file upload (field name: file)." });
      return;
    }

    if (fileValue.size === 0) {
      this.sendJson(response, 400, { error: "Audio file is empty." });
      return;
    }

    if (fileValue.size > MAX_TRANSCRIBE_FILE_BYTES) {
      this.sendJson(response, 413, { error: "Audio file too large. Max size is 4MB." });
      return;
    }

    const normalizedMimeType = normalizeMimeType(fileValue.type);
    if (normalizedMimeType && !ALLOWED_TRANSCRIBE_MIME_TYPES.has(normalizedMimeType)) {
      this.sendJson(response, 415, { error: "Unsupported audio format." });
      return;
    }

    const apiKey = this.resolveOpenAiApiKey();
    if (!apiKey) {
      this.sendJson(response, 400, { error: "OpenAI API key required — add it in Settings." });
      return;
    }

    const payload = new FormData();
    payload.set("model", OPENAI_TRANSCRIPTION_MODEL);
    payload.set("response_format", "json");
    payload.set("file", fileValue, resolveUploadFileName(fileValue));

    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), OPENAI_TRANSCRIPTION_TIMEOUT_MS);

    try {
      const upstreamResponse = await fetch(OPENAI_TRANSCRIPTION_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`
        },
        body: payload,
        signal: timeoutController.signal
      });

      if (!upstreamResponse.ok) {
        const statusCode = upstreamResponse.status === 401 || upstreamResponse.status === 403 ? 401 : 502;

        this.sendJson(response, statusCode, {
          error:
            statusCode === 401
              ? "OpenAI API key rejected — update it in Settings."
              : "Transcription failed. Please try again."
        });
        return;
      }

      const result = (await upstreamResponse.json()) as { text?: unknown };
      if (typeof result.text !== "string") {
        this.sendJson(response, 502, { error: "Invalid transcription response." });
        return;
      }

      this.sendJson(response, 200, { text: result.text });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        this.sendJson(response, 504, { error: "Transcription timed out." });
        return;
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private resolveOpenAiApiKey(): string | undefined {
    const authStorage = AuthStorage.create(this.swarmManager.getConfig().paths.authFile);
    const credential = authStorage.get("openai-codex");
    return extractAuthCredentialToken(credential as AuthCredential | undefined);
  }

  private async handleSchedulesHttpRequest(
    request: IncomingMessage,
    response: ServerResponse,
    route: SchedulesRoute
  ): Promise<void> {
    const methods = "GET, OPTIONS";

    if (request.method === "OPTIONS") {
      this.applyCorsHeaders(request, response, methods);
      response.statusCode = 204;
      response.end();
      return;
    }

    if (request.method !== "GET") {
      this.applyCorsHeaders(request, response, methods);
      response.setHeader("Allow", methods);
      this.sendJson(response, 405, { error: "Method Not Allowed" });
      return;
    }

    this.applyCorsHeaders(request, response, methods);

    if (!this.isManagerAgent(route.managerId)) {
      this.sendJson(response, 404, { error: `Unknown manager: ${route.managerId}` });
      return;
    }

    try {
      const schedulesFile = getScheduleFilePath(this.swarmManager.getConfig().paths.dataDir, route.managerId);
      const raw = await readFile(schedulesFile, "utf8");
      const parsed = JSON.parse(raw) as { schedules?: unknown };

      if (!parsed || !Array.isArray(parsed.schedules)) {
        this.sendJson(response, 200, { schedules: [] });
        return;
      }

      const schedules = parsed.schedules
        .map((entry) => normalizeScheduleRecord(entry))
        .filter((entry): entry is ScheduleHttpRecord => entry !== undefined);

      this.sendJson(response, 200, { schedules });
    } catch (error) {
      if (isEnoentError(error)) {
        this.sendJson(response, 200, { schedules: [] });
        return;
      }

      const message = error instanceof Error ? error.message : "Unable to load schedules";
      this.sendJson(response, 500, { error: message });
    }
  }

  private async handleCompactAgentHttpRequest(
    request: IncomingMessage,
    response: ServerResponse,
    requestUrl: URL
  ): Promise<void> {
    const methods = "POST, OPTIONS";
    const matched = requestUrl.pathname.match(AGENT_COMPACT_ENDPOINT_PATTERN);
    const rawAgentId = matched?.[1] ?? "";

    if (request.method === "OPTIONS") {
      this.applyCorsHeaders(request, response, methods);
      response.statusCode = 204;
      response.end();
      return;
    }

    if (request.method !== "POST") {
      this.applyCorsHeaders(request, response, methods);
      response.setHeader("Allow", methods);
      this.sendJson(response, 405, { error: "Method Not Allowed" });
      return;
    }

    this.applyCorsHeaders(request, response, methods);

    const agentId = decodeURIComponent(rawAgentId).trim();
    if (!agentId) {
      this.sendJson(response, 400, { error: "Missing agent id" });
      return;
    }

    const payload = await this.readJsonBody(request);
    const customInstructions = parseCompactCustomInstructionsBody(payload);

    try {
      const result = await this.swarmManager.compactAgentContext(agentId, {
        customInstructions,
        sourceContext: { channel: "web" },
        trigger: "api"
      });

      this.sendJson(response, 200, {
        ok: true,
        agentId,
        result
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusCode =
        message.includes("Unknown target agent")
          ? 404
          : message.includes("not running") ||
              message.includes("does not support") ||
              message.includes("only supported")
            ? 409
            : message.includes("Invalid") || message.includes("Missing")
              ? 400
              : 500;

      this.sendJson(response, statusCode, { error: message });
    }
  }

  private async handleSettingsEnvHttpRequest(
    request: IncomingMessage,
    response: ServerResponse,
    requestUrl: URL
  ): Promise<void> {
    const methods = "GET, PUT, DELETE, OPTIONS";

    if (request.method === "OPTIONS") {
      this.applyCorsHeaders(request, response, methods);
      response.statusCode = 204;
      response.end();
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === SETTINGS_ENV_ENDPOINT_PATH) {
      this.applyCorsHeaders(request, response, methods);
      const variables = await this.swarmManager.listSettingsEnv();
      this.sendJson(response, 200, { variables });
      return;
    }

    if (request.method === "PUT" && requestUrl.pathname === SETTINGS_ENV_ENDPOINT_PATH) {
      this.applyCorsHeaders(request, response, methods);
      const payload = parseSettingsEnvUpdateBody(await this.readJsonBody(request));
      await this.swarmManager.updateSettingsEnv(payload);
      const variables = await this.swarmManager.listSettingsEnv();
      this.sendJson(response, 200, { ok: true, variables });
      return;
    }

    if (request.method === "DELETE" && requestUrl.pathname.startsWith(`${SETTINGS_ENV_ENDPOINT_PATH}/`)) {
      this.applyCorsHeaders(request, response, methods);
      const variableName = decodeURIComponent(requestUrl.pathname.slice(SETTINGS_ENV_ENDPOINT_PATH.length + 1));
      if (!variableName) {
        this.sendJson(response, 400, { error: "Missing environment variable name" });
        return;
      }

      await this.swarmManager.deleteSettingsEnv(variableName);
      const variables = await this.swarmManager.listSettingsEnv();
      this.sendJson(response, 200, { ok: true, variables });
      return;
    }

    this.applyCorsHeaders(request, response, methods);
    response.setHeader("Allow", methods);
    this.sendJson(response, 405, { error: "Method Not Allowed" });
  }

  private async handleSettingsModelsHttpRequest(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const methods = "GET, OPTIONS";

    if (request.method === "OPTIONS") {
      this.applyCorsHeaders(request, response, methods);
      response.statusCode = 204;
      response.end();
      return;
    }

    if (request.method !== "GET") {
      this.applyCorsHeaders(request, response, methods);
      response.setHeader("Allow", methods);
      this.sendJson(response, 405, { error: "Method Not Allowed" });
      return;
    }

    this.applyCorsHeaders(request, response, methods);
    const payload = await this.swarmManager.listSettingsModels();
    this.sendJson(response, 200, {
      ok: true,
      defaultModelPreset: payload.defaultModelPreset,
      models: payload.models
    });
  }

  private async handleSettingsAuthHttpRequest(
    request: IncomingMessage,
    response: ServerResponse,
    requestUrl: URL
  ): Promise<void> {
    if (
      requestUrl.pathname === SETTINGS_AUTH_LOGIN_ENDPOINT_PATH ||
      requestUrl.pathname.startsWith(`${SETTINGS_AUTH_LOGIN_ENDPOINT_PATH}/`)
    ) {
      await this.handleSettingsAuthLoginHttpRequest(request, response, requestUrl);
      return;
    }

    const methods = SETTINGS_AUTH_METHODS;

    if (request.method === "OPTIONS") {
      this.applyCorsHeaders(request, response, methods);
      response.statusCode = 204;
      response.end();
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === SETTINGS_AUTH_ENDPOINT_PATH) {
      this.applyCorsHeaders(request, response, methods);
      const providers = await this.swarmManager.listSettingsAuth();
      this.sendJson(response, 200, { providers });
      return;
    }

    if (request.method === "PUT" && requestUrl.pathname === SETTINGS_AUTH_ENDPOINT_PATH) {
      this.applyCorsHeaders(request, response, methods);
      const payload = parseSettingsAuthUpdateBody(await this.readJsonBody(request));
      await this.swarmManager.updateSettingsAuth(payload);
      const providers = await this.swarmManager.listSettingsAuth();
      this.sendJson(response, 200, { ok: true, providers });
      return;
    }

    if (request.method === "DELETE" && requestUrl.pathname.startsWith(`${SETTINGS_AUTH_ENDPOINT_PATH}/`)) {
      this.applyCorsHeaders(request, response, methods);
      const provider = decodeURIComponent(requestUrl.pathname.slice(SETTINGS_AUTH_ENDPOINT_PATH.length + 1));
      if (!provider) {
        this.sendJson(response, 400, { error: "Missing auth provider" });
        return;
      }

      await this.swarmManager.deleteSettingsAuth(provider);
      const providers = await this.swarmManager.listSettingsAuth();
      this.sendJson(response, 200, { ok: true, providers });
      return;
    }

    this.applyCorsHeaders(request, response, methods);
    response.setHeader("Allow", methods);
    this.sendJson(response, 405, { error: "Method Not Allowed" });
  }

  private async handleSettingsAuthLoginHttpRequest(
    request: IncomingMessage,
    response: ServerResponse,
    requestUrl: URL
  ): Promise<void> {
    if (request.method === "OPTIONS") {
      this.applyCorsHeaders(request, response, SETTINGS_AUTH_LOGIN_METHODS);
      response.statusCode = 204;
      response.end();
      return;
    }

    const relativePath = requestUrl.pathname.startsWith(`${SETTINGS_AUTH_LOGIN_ENDPOINT_PATH}/`)
      ? requestUrl.pathname.slice(SETTINGS_AUTH_LOGIN_ENDPOINT_PATH.length + 1)
      : "";
    const pathSegments = relativePath.split("/").filter((segment) => segment.length > 0);
    const rawProvider = pathSegments[0] ?? "";
    const providerId = resolveSettingsAuthLoginProviderId(rawProvider);
    const action = pathSegments[1];

    this.applyCorsHeaders(request, response, SETTINGS_AUTH_LOGIN_METHODS);

    if (!providerId) {
      this.sendJson(response, 400, { error: "Invalid OAuth provider" });
      return;
    }

    if (action === "respond") {
      if (request.method !== "POST") {
        response.setHeader("Allow", SETTINGS_AUTH_LOGIN_METHODS);
        this.sendJson(response, 405, { error: "Method Not Allowed" });
        return;
      }

      if (pathSegments.length !== 2) {
        this.sendJson(response, 400, { error: "Invalid OAuth login respond path" });
        return;
      }

      const payload = parseSettingsAuthLoginRespondBody(await this.readJsonBody(request));
      const flow = this.activeSettingsAuthLoginFlows.get(providerId);
      if (!flow) {
        this.sendJson(response, 409, { error: "No active OAuth login flow for provider" });
        return;
      }

      if (!flow.pendingPrompt) {
        this.sendJson(response, 409, { error: "OAuth login flow is not waiting for input" });
        return;
      }

      const pendingPrompt = flow.pendingPrompt;
      flow.pendingPrompt = null;
      pendingPrompt.resolve(payload.value);
      this.sendJson(response, 200, { ok: true });
      return;
    }

    if (action !== undefined || pathSegments.length !== 1) {
      this.sendJson(response, 400, { error: "Invalid OAuth login path" });
      return;
    }

    if (request.method !== "POST") {
      response.setHeader("Allow", SETTINGS_AUTH_LOGIN_METHODS);
      this.sendJson(response, 405, { error: "Method Not Allowed" });
      return;
    }

    if (this.activeSettingsAuthLoginFlows.has(providerId)) {
      this.sendJson(response, 409, { error: "OAuth login already in progress for provider" });
      return;
    }

    const flow: SettingsAuthLoginFlow = {
      providerId,
      pendingPrompt: null,
      abortController: new AbortController(),
      closed: false
    };
    this.activeSettingsAuthLoginFlows.set(providerId, flow);

    const provider = SETTINGS_AUTH_LOGIN_PROVIDERS[providerId];
    const authStorage = AuthStorage.create(this.swarmManager.getConfig().paths.authFile);

    response.statusCode = 200;
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("X-Accel-Buffering", "no");

    if (typeof response.flushHeaders === "function") {
      response.flushHeaders();
    }

    const sendSseEvent = <TEventName extends SettingsAuthLoginEventName>(
      eventName: TEventName,
      data: SettingsAuthLoginEventPayload[TEventName]
    ): void => {
      if (flow.closed || response.writableEnded || response.destroyed) {
        return;
      }

      response.write(`event: ${eventName}\n`);
      response.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const closeFlow = (reason: string): void => {
      if (flow.closed) {
        return;
      }

      flow.closed = true;
      flow.abortController.abort();

      if (flow.pendingPrompt) {
        const pendingPrompt = flow.pendingPrompt;
        flow.pendingPrompt = null;
        pendingPrompt.reject(new Error(reason));
      }

      const activeFlow = this.activeSettingsAuthLoginFlows.get(providerId);
      if (activeFlow === flow) {
        this.activeSettingsAuthLoginFlows.delete(providerId);
      }
    };

    const requestPromptInput = (prompt: {
      message: string;
      placeholder?: string;
    }): Promise<string> =>
      new Promise<string>((resolve, reject) => {
        if (flow.closed) {
          reject(new Error("OAuth login flow is closed"));
          return;
        }

        if (flow.pendingPrompt) {
          const previousPrompt = flow.pendingPrompt;
          flow.pendingPrompt = null;
          previousPrompt.reject(new Error("OAuth login prompt replaced by a newer request"));
        }

        const wrappedResolve = (value: string): void => {
          if (flow.pendingPrompt?.resolve === wrappedResolve) {
            flow.pendingPrompt = null;
          }
          resolve(value);
        };

        const wrappedReject = (error: Error): void => {
          if (flow.pendingPrompt?.reject === wrappedReject) {
            flow.pendingPrompt = null;
          }
          reject(error);
        };

        flow.pendingPrompt = {
          resolve: wrappedResolve,
          reject: wrappedReject
        };

        sendSseEvent("prompt", prompt);
      });

    const onClose = (): void => {
      closeFlow("OAuth login stream closed");
    };

    request.on("close", onClose);
    response.on("close", onClose);

    sendSseEvent("progress", { message: `Starting ${provider.name} OAuth login...` });

    try {
      const callbacks: OAuthLoginCallbacks = {
        onAuth: (info) => {
          sendSseEvent("auth_url", {
            url: info.url,
            instructions: info.instructions
          });
        },
        onPrompt: (prompt) =>
          requestPromptInput({
            message: prompt.message,
            placeholder: prompt.placeholder
          }),
        onProgress: (message) => {
          sendSseEvent("progress", { message });
        },
        signal: flow.abortController.signal
      };

      if (provider.usesCallbackServer) {
        callbacks.onManualCodeInput = () =>
          requestPromptInput({
            message: "Paste redirect URL below, or complete login in browser:",
            placeholder: "http://localhost:1455/auth/callback?code=..."
          });
      }

      const credentials = (await provider.login(callbacks)) as OAuthCredentials;
      if (flow.closed) {
        return;
      }

      authStorage.set(providerId, {
        type: "oauth",
        ...credentials
      });

      sendSseEvent("complete", {
        provider: flow.providerId,
        status: "connected"
      });
    } catch (error) {
      if (!flow.closed) {
        const message = error instanceof Error ? error.message : String(error);
        sendSseEvent("error", { message });
      }
    } finally {
      request.off("close", onClose);
      response.off("close", onClose);
      closeFlow("OAuth login flow closed");
      if (!response.writableEnded) {
        response.end();
      }
    }
  }

  private cancelAllActiveSettingsAuthLoginFlows(): void {
    for (const flow of this.activeSettingsAuthLoginFlows.values()) {
      flow.closed = true;
      flow.abortController.abort();
      if (flow.pendingPrompt) {
        const pendingPrompt = flow.pendingPrompt;
        flow.pendingPrompt = null;
        pendingPrompt.reject(new Error("OAuth login flow cancelled"));
      }
    }
    this.activeSettingsAuthLoginFlows.clear();
  }

  private async handleSlackIntegrationHttpRequest(
    request: IncomingMessage,
    response: ServerResponse,
    requestUrl: URL
  ): Promise<void> {
    const methods = "GET, PUT, DELETE, POST, OPTIONS";

    if (request.method === "OPTIONS") {
      this.applyCorsHeaders(request, response, methods);
      response.statusCode = 204;
      response.end();
      return;
    }

    this.applyCorsHeaders(request, response, methods);

    if (!this.integrationRegistry) {
      this.sendJson(response, 501, { error: "Slack integration is unavailable" });
      return;
    }

    const route = resolveSlackIntegrationRoute(requestUrl.pathname);
    if (!route) {
      response.setHeader("Allow", methods);
      this.sendJson(response, 405, { error: "Method Not Allowed" });
      return;
    }

    if (!this.isManagerAgent(route.managerId)) {
      this.sendJson(response, 404, { error: `Unknown manager: ${route.managerId}` });
      return;
    }

    if (route.action === "config") {
      if (request.method === "GET") {
        const snapshot = await this.integrationRegistry.getSlackSnapshot(route.managerId);
        this.sendJson(response, 200, snapshot);
        return;
      }

      if (request.method === "PUT") {
        const payload = await this.readJsonBody(request);
        const updated = await this.integrationRegistry.updateSlackConfig(route.managerId, payload);
        this.sendJson(response, 200, { ok: true, ...updated });
        return;
      }

      if (request.method === "DELETE") {
        const disabled = await this.integrationRegistry.disableSlack(route.managerId);
        this.sendJson(response, 200, { ok: true, ...disabled });
        return;
      }
    }

    if (route.action === "test" && request.method === "POST") {
      const payload = await this.readJsonBody(request);
      const result = await this.integrationRegistry.testSlackConnection(route.managerId, payload);
      this.sendJson(response, 200, { ok: true, result });
      return;
    }

    if (route.action === "channels" && request.method === "GET") {
      const includePrivate = parseOptionalBoolean(requestUrl.searchParams.get("includePrivateChannels"));

      const channels = await this.integrationRegistry.listSlackChannels(route.managerId, {
        includePrivateChannels: includePrivate
      });

      this.sendJson(response, 200, { channels });
      return;
    }

    response.setHeader("Allow", methods);
    this.sendJson(response, 405, { error: "Method Not Allowed" });
  }

  private async handleTelegramIntegrationHttpRequest(
    request: IncomingMessage,
    response: ServerResponse,
    requestUrl: URL
  ): Promise<void> {
    const methods = "GET, PUT, DELETE, POST, OPTIONS";

    if (request.method === "OPTIONS") {
      this.applyCorsHeaders(request, response, methods);
      response.statusCode = 204;
      response.end();
      return;
    }

    this.applyCorsHeaders(request, response, methods);

    if (!this.integrationRegistry) {
      this.sendJson(response, 501, { error: "Telegram integration is unavailable" });
      return;
    }

    const route = resolveTelegramIntegrationRoute(requestUrl.pathname);
    if (!route) {
      response.setHeader("Allow", methods);
      this.sendJson(response, 405, { error: "Method Not Allowed" });
      return;
    }

    if (!this.isManagerAgent(route.managerId)) {
      this.sendJson(response, 404, { error: `Unknown manager: ${route.managerId}` });
      return;
    }

    if (route.action === "config") {
      if (request.method === "GET") {
        const snapshot = await this.integrationRegistry.getTelegramSnapshot(route.managerId);
        this.sendJson(response, 200, snapshot);
        return;
      }

      if (request.method === "PUT") {
        const payload = await this.readJsonBody(request);
        const updated = await this.integrationRegistry.updateTelegramConfig(route.managerId, payload);
        this.sendJson(response, 200, { ok: true, ...updated });
        return;
      }

      if (request.method === "DELETE") {
        const disabled = await this.integrationRegistry.disableTelegram(route.managerId);
        this.sendJson(response, 200, { ok: true, ...disabled });
        return;
      }
    }

    if (route.action === "test" && request.method === "POST") {
      const payload = await this.readJsonBody(request);
      const result = await this.integrationRegistry.testTelegramConnection(route.managerId, payload);
      this.sendJson(response, 200, { ok: true, result });
      return;
    }

    response.setHeader("Allow", methods);
    this.sendJson(response, 405, { error: "Method Not Allowed" });
  }

  private isManagerAgent(managerId: string): boolean {
    const descriptor = this.swarmManager.getAgent(managerId);
    return Boolean(descriptor && descriptor.role === "manager");
  }

  private async handleGsuiteIntegrationHttpRequest(
    request: IncomingMessage,
    response: ServerResponse,
    requestUrl: URL
  ): Promise<void> {
    const methods = "GET, PUT, DELETE, POST, OPTIONS";

    if (request.method === "OPTIONS") {
      this.applyCorsHeaders(request, response, methods);
      response.statusCode = 204;
      response.end();
      return;
    }

    this.applyCorsHeaders(request, response, methods);

    if (!this.gsuiteIntegration) {
      this.sendJson(response, 501, { error: "G Suite integration is unavailable" });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === GSUITE_INTEGRATION_ENDPOINT_PATH) {
      const snapshot = await this.gsuiteIntegration.getSnapshot();
      this.sendJson(response, 200, { ...snapshot });
      return;
    }

    if (request.method === "PUT" && requestUrl.pathname === GSUITE_INTEGRATION_ENDPOINT_PATH) {
      const payload = parseGsuiteConfigUpdateBody(await this.readJsonBody(request));
      const snapshot = await this.gsuiteIntegration.updateConfig(payload);
      this.sendJson(response, 200, { ok: true, ...snapshot });
      return;
    }

    if (request.method === "DELETE" && requestUrl.pathname === GSUITE_INTEGRATION_ENDPOINT_PATH) {
      const snapshot = await this.gsuiteIntegration.disable();
      this.sendJson(response, 200, { ok: true, ...snapshot });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === GSUITE_INTEGRATION_OAUTH_CREDENTIALS_ENDPOINT_PATH) {
      const payload = parseGsuiteOAuthCredentialsBody(await this.readJsonBody(request));
      const snapshot = await this.gsuiteIntegration.storeOAuthCredentials(payload);
      this.sendJson(response, 200, { ok: true, ...snapshot });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === GSUITE_INTEGRATION_OAUTH_START_ENDPOINT_PATH) {
      const payload = parseGsuiteOAuthStartBody(await this.readJsonBody(request));
      const started = await this.gsuiteIntegration.startOAuth(payload);
      this.sendJson(response, 200, { ok: true, ...started.snapshot, result: started.result });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === GSUITE_INTEGRATION_OAUTH_COMPLETE_ENDPOINT_PATH) {
      const payload = parseGsuiteOAuthCompleteBody(await this.readJsonBody(request));
      const completed = await this.gsuiteIntegration.completeOAuth(payload);
      this.sendJson(response, 200, { ok: true, ...completed.snapshot, result: completed.result });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === GSUITE_INTEGRATION_TEST_ENDPOINT_PATH) {
      const payload = parseGsuiteConnectionTestBody(await this.readJsonBody(request));
      const result = await this.gsuiteIntegration.testConnection(payload);
      const snapshot = await this.gsuiteIntegration.getSnapshot();
      this.sendJson(response, 200, { ok: true, ...snapshot, result });
      return;
    }

    response.setHeader("Allow", methods);
    this.sendJson(response, 405, { error: "Method Not Allowed" });
  }

  private resolveAllowedHttpMethods(pathname: string): string {
    if (pathname === REBOOT_ENDPOINT_PATH) {
      return "POST, OPTIONS";
    }

    if (pathname === READ_FILE_ENDPOINT_PATH) {
      return READ_FILE_METHODS;
    }

    if (pathname === TRANSCRIBE_ENDPOINT_PATH) {
      return TRANSCRIBE_METHODS;
    }

    if (isSchedulesPath(pathname)) {
      return "GET, OPTIONS";
    }

    if (AGENT_COMPACT_ENDPOINT_PATTERN.test(pathname)) {
      return "POST, OPTIONS";
    }

    if (pathname === SETTINGS_ENV_ENDPOINT_PATH || pathname.startsWith(`${SETTINGS_ENV_ENDPOINT_PATH}/`)) {
      return "GET, PUT, DELETE, OPTIONS";
    }

    if (pathname === SETTINGS_MODELS_ENDPOINT_PATH) {
      return "GET, OPTIONS";
    }

    if (pathname === SETTINGS_AUTH_ENDPOINT_PATH || pathname.startsWith(`${SETTINGS_AUTH_ENDPOINT_PATH}/`)) {
      return SETTINGS_AUTH_METHODS;
    }

    if (isSlackIntegrationPath(pathname) || isTelegramIntegrationPath(pathname)) {
      return "GET, PUT, DELETE, POST, OPTIONS";
    }

    if (
      pathname === GSUITE_INTEGRATION_ENDPOINT_PATH ||
      pathname === GSUITE_INTEGRATION_OAUTH_CREDENTIALS_ENDPOINT_PATH ||
      pathname === GSUITE_INTEGRATION_OAUTH_START_ENDPOINT_PATH ||
      pathname === GSUITE_INTEGRATION_OAUTH_COMPLETE_ENDPOINT_PATH ||
      pathname === GSUITE_INTEGRATION_TEST_ENDPOINT_PATH
    ) {
      return "GET, PUT, DELETE, POST, OPTIONS";
    }

    return "GET, POST, PUT, PATCH, DELETE, OPTIONS";
  }

  private isOriginAllowed(originHeader: string | string[] | undefined): boolean {
    if (!this.allowedOrigins || this.allowedOrigins.size === 0) {
      return true;
    }

    if (typeof originHeader !== "string") {
      return true;
    }

    return this.allowedOrigins.has(originHeader.trim());
  }

  private isAuthorizedRequest(request: IncomingMessage, allowQueryParamToken: boolean): boolean {
    if (!this.authToken) {
      return true;
    }

    const authHeader = request.headers.authorization;
    if (typeof authHeader === "string") {
      const token = parseBearerToken(authHeader);
      if (token && token === this.authToken) {
        return true;
      }
    }

    if (allowQueryParamToken) {
      try {
        const requestUrl = new URL(
          request.url ?? "/",
          `http://${request.headers.host ?? `${this.host}:${this.port}`}`
        );

        const queryToken = requestUrl.searchParams.get("authToken")?.trim();
        if (queryToken && queryToken === this.authToken) {
          return true;
        }
      } catch {
        return false;
      }
    }

    return false;
  }

  private async readJsonBody(request: IncomingMessage): Promise<unknown> {
    const body = await this.readRequestBody(request, MAX_HTTP_BODY_SIZE_BYTES);

    if (body.length === 0) {
      return {};
    }

    const raw = body.toString("utf8").trim();
    if (!raw) {
      return {};
    }

    try {
      return JSON.parse(raw);
    } catch {
      throw new Error("Request body must be valid JSON");
    }
  }

  private async readRequestBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    for await (const chunk of request) {
      const chunkBuffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      totalBytes += chunkBuffer.length;

      if (totalBytes > maxBytes) {
        throw new Error(`Request body too large. Max ${maxBytes} bytes.`);
      }

      chunks.push(chunkBuffer);
    }

    return Buffer.concat(chunks);
  }

  private applyCorsHeaders(request: IncomingMessage, response: ServerResponse, methods: string): void {
    const origin = typeof request.headers.origin === "string" ? request.headers.origin.trim() : undefined;

    if (origin && this.isOriginAllowed(origin)) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
    } else if (!this.allowedOrigins || this.allowedOrigins.size === 0) {
      response.setHeader("Access-Control-Allow-Origin", "*");
    }

    response.setHeader("Access-Control-Allow-Methods", methods);
    response.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  }

  private async parseJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
    const chunks: Buffer[] = [];
    let byteLength = 0;

    for await (const chunk of request) {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      byteLength += buffer.byteLength;

      if (byteLength > maxBytes) {
        throw new Error(`Request body exceeds ${maxBytes} bytes.`);
      }

      chunks.push(buffer);
    }

    if (chunks.length === 0) {
      return {};
    }

    const rawBody = Buffer.concat(chunks).toString("utf8");

    try {
      return JSON.parse(rawBody);
    } catch {
      throw new Error("Request body must be valid JSON.");
    }
  }

  private sendJson(response: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
    response.statusCode = statusCode;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify(body));
  }

  private triggerRebootSignal(): void {
    try {
      const daemonPid = resolveProdDaemonPid(this.swarmManager.getConfig().paths.rootDir);
      const targetPid = daemonPid ?? process.pid;

      process.kill(targetPid, RESTART_SIGNAL);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[reboot] Failed to send ${RESTART_SIGNAL}: ${message}`);
    }
  }

  private async handleSocketMessage(socket: WebSocket, raw: RawData): Promise<void> {
    const parsed = this.parseClientCommand(raw);
    if (!parsed.ok) {
      this.logDebug("command:invalid", {
        message: parsed.error
      });
      this.send(socket, {
        type: "error",
        code: "INVALID_COMMAND",
        message: parsed.error
      });
      return;
    }

    const command = parsed.command;
    this.logDebug("command:received", {
      type: command.type,
      requestId: this.extractRequestId(command)
    });

    if (command.type === "ping") {
      this.send(socket, {
        type: "ready",
        serverTime: new Date().toISOString(),
        subscribedAgentId: this.subscriptions.get(socket) ?? this.resolveDefaultSubscriptionAgentId()
      });
      return;
    }

    if (command.type === "subscribe") {
      await this.handleSubscribe(socket, command.agentId);
      return;
    }

    const subscribedAgentId = this.resolveSubscribedAgentId(socket);
    if (!subscribedAgentId) {
      this.logDebug("command:rejected:not_subscribed", {
        type: command.type
      });
      this.send(socket, {
        type: "error",
        code: "NOT_SUBSCRIBED",
        message: `Send subscribe before ${command.type}.`,
        requestId: this.extractRequestId(command)
      });
      return;
    }

    if (command.type === "kill_agent") {
      const managerContextId = this.resolveManagerContextAgentId(subscribedAgentId);
      if (!managerContextId) {
        this.send(socket, {
          type: "error",
          code: "UNKNOWN_AGENT",
          message: `Agent ${subscribedAgentId} does not exist.`
        });
        return;
      }

      try {
        await this.swarmManager.killAgent(managerContextId, command.agentId);
      } catch (error) {
        this.send(socket, {
          type: "error",
          code: "KILL_AGENT_FAILED",
          message: error instanceof Error ? error.message : String(error)
        });
      }
      return;
    }

    if (command.type === "stop_all_agents") {
      const managerContextId = this.resolveManagerContextAgentId(subscribedAgentId);
      if (!managerContextId) {
        this.send(socket, {
          type: "error",
          code: "UNKNOWN_AGENT",
          message: `Agent ${subscribedAgentId} does not exist.`,
          requestId: command.requestId
        });
        return;
      }

      try {
        const stopped = await this.swarmManager.stopAllAgents(managerContextId, command.managerId);
        this.send(socket, {
          type: "stop_all_agents_result",
          managerId: stopped.managerId,
          stoppedWorkerIds: stopped.stoppedWorkerIds,
          managerStopped: stopped.managerStopped,
          // Backward compatibility for older clients still expecting terminated-oriented fields.
          terminatedWorkerIds: stopped.terminatedWorkerIds,
          managerTerminated: stopped.managerTerminated,
          requestId: command.requestId
        });
      } catch (error) {
        this.send(socket, {
          type: "error",
          code: "STOP_ALL_AGENTS_FAILED",
          message: error instanceof Error ? error.message : String(error),
          requestId: command.requestId
        });
      }
      return;
    }

    if (command.type === "create_manager") {
      const managerContextId = this.resolveManagerContextAgentId(subscribedAgentId);
      if (!managerContextId) {
        this.send(socket, {
          type: "error",
          code: "UNKNOWN_AGENT",
          message: `Agent ${subscribedAgentId} does not exist.`,
          requestId: command.requestId
        });
        return;
      }

      try {
        const manager = await this.swarmManager.createManager(managerContextId, {
          name: command.name,
          cwd: command.cwd,
          model: command.model
        });

        this.broadcastToSubscribed({
          type: "manager_created",
          manager,
          requestId: command.requestId
        });
      } catch (error) {
        this.send(socket, {
          type: "error",
          code: "CREATE_MANAGER_FAILED",
          message: error instanceof Error ? error.message : String(error),
          requestId: command.requestId
        });
      }
      return;
    }

    if (command.type === "delete_manager") {
      const managerContextId = this.resolveManagerContextAgentId(subscribedAgentId);
      if (!managerContextId) {
        this.send(socket, {
          type: "error",
          code: "UNKNOWN_AGENT",
          message: `Agent ${subscribedAgentId} does not exist.`,
          requestId: command.requestId
        });
        return;
      }

      try {
        const deleted = await this.swarmManager.deleteManager(managerContextId, command.managerId);
        this.handleDeletedAgentSubscriptions(new Set([deleted.managerId, ...deleted.terminatedWorkerIds]));

        this.broadcastToSubscribed({
          type: "manager_deleted",
          managerId: deleted.managerId,
          terminatedWorkerIds: deleted.terminatedWorkerIds,
          requestId: command.requestId
        });
      } catch (error) {
        this.send(socket, {
          type: "error",
          code: "DELETE_MANAGER_FAILED",
          message: error instanceof Error ? error.message : String(error),
          requestId: command.requestId
        });
      }
      return;
    }

    if (command.type === "list_directories") {
      try {
        const listed = await this.swarmManager.listDirectories(command.path);
        this.send(socket, {
          type: "directories_listed",
          path: listed.resolvedPath,
          directories: listed.directories.map((entry) => entry.path),
          requestId: command.requestId,
          requestedPath: listed.requestedPath,
          resolvedPath: listed.resolvedPath,
          roots: listed.roots,
          entries: listed.directories
        });
      } catch (error) {
        this.send(socket, {
          type: "error",
          code: "LIST_DIRECTORIES_FAILED",
          message: error instanceof Error ? error.message : String(error),
          requestId: command.requestId
        });
      }
      return;
    }

    if (command.type === "validate_directory") {
      try {
        const validation = await this.swarmManager.validateDirectory(command.path);
        this.send(socket, {
          type: "directory_validated",
          path: validation.requestedPath,
          valid: validation.valid,
          message: validation.message,
          requestId: command.requestId,
          requestedPath: validation.requestedPath,
          roots: validation.roots,
          resolvedPath: validation.resolvedPath
        });
      } catch (error) {
        this.send(socket, {
          type: "error",
          code: "VALIDATE_DIRECTORY_FAILED",
          message: error instanceof Error ? error.message : String(error),
          requestId: command.requestId
        });
      }
      return;
    }

    if (command.type === "pick_directory") {
      try {
        const pickedPath = await this.swarmManager.pickDirectory(command.defaultPath);
        this.send(socket, {
          type: "directory_picked",
          path: pickedPath,
          requestId: command.requestId
        });
      } catch (error) {
        this.send(socket, {
          type: "error",
          code: "PICK_DIRECTORY_FAILED",
          message: error instanceof Error ? error.message : String(error),
          requestId: command.requestId
        });
      }
      return;
    }

    if (command.type === "user_message") {
      const config = this.swarmManager.getConfig();
      const managerId = this.resolveConfiguredManagerId();
      const targetAgentId = command.agentId ?? subscribedAgentId;

      this.logDebug("user_message:received", {
        subscribedAgentId,
        targetAgentId,
        managerId,
        requestedDelivery: command.delivery ?? "auto",
        textPreview: previewForLog(command.text),
        attachmentCount: command.attachments?.length ?? 0
      });

      if (!this.allowNonManagerSubscriptions && managerId && targetAgentId !== managerId) {
        this.logDebug("user_message:rejected:subscription_not_supported", {
          targetAgentId,
          managerId
        });
        this.send(socket, {
          type: "error",
          code: "SUBSCRIPTION_NOT_SUPPORTED",
          message: `Messages are currently limited to ${managerId}.`
        });
        return;
      }

      const targetDescriptor = this.swarmManager.getAgent(targetAgentId);
      if (!targetDescriptor) {
        this.logDebug("user_message:rejected:unknown_agent", {
          targetAgentId
        });
        this.send(socket, {
          type: "error",
          code: "UNKNOWN_AGENT",
          message: `Agent ${targetAgentId} does not exist.`
        });
        return;
      }

      try {
        if (targetDescriptor.role === "manager" && command.text.trim() === "/new") {
          this.logDebug("user_message:manager_reset", {
            targetAgentId: targetDescriptor.agentId
          });
          await this.swarmManager.resetManagerSession(targetDescriptor.agentId, "user_new_command");
          return;
        }

        const persistedAttachments =
          command.attachments && command.attachments.length > 0
            ? await persistConversationAttachments(command.attachments, config.paths.uploadsDir)
            : undefined;

        this.logDebug("user_message:dispatch:start", {
          targetAgentId,
          targetRole: targetDescriptor.role,
          persistedAttachmentCount: persistedAttachments?.length ?? 0
        });

        await this.swarmManager.handleUserMessage(command.text, {
          targetAgentId,
          delivery: command.delivery,
          attachments: persistedAttachments,
          sourceContext: { channel: "web" }
        });

        this.logDebug("user_message:dispatch:complete", {
          targetAgentId,
          targetRole: targetDescriptor.role
        });
      } catch (error) {
        this.logDebug("user_message:dispatch:error", {
          targetAgentId,
          targetRole: targetDescriptor.role,
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        });
        this.send(socket, {
          type: "error",
          code: "USER_MESSAGE_FAILED",
          message: error instanceof Error ? error.message : String(error)
        });
      }
      return;
    }
  }

  private async handleSubscribe(socket: WebSocket, requestedAgentId?: string): Promise<void> {
    const managerId = this.resolveConfiguredManagerId();
    const targetAgentId =
      requestedAgentId ?? this.resolvePreferredManagerSubscriptionId() ?? this.resolveDefaultSubscriptionAgentId();

    if (!this.allowNonManagerSubscriptions && managerId && targetAgentId !== managerId) {
      this.send(socket, {
        type: "error",
        code: "SUBSCRIPTION_NOT_SUPPORTED",
        message: `Subscriptions are currently limited to ${managerId}.`
      });
      return;
    }

    const targetDescriptor = this.swarmManager.getAgent(targetAgentId);
    const canBootstrapSubscription =
      !targetDescriptor &&
      !this.hasRunningManagers() &&
      (managerId ? requestedAgentId === managerId : requestedAgentId === undefined);

    if (!targetDescriptor && requestedAgentId && !canBootstrapSubscription) {
      this.send(socket, {
        type: "error",
        code: "UNKNOWN_AGENT",
        message: `Agent ${targetAgentId} does not exist.`
      });
      return;
    }

    this.subscriptions.set(socket, targetAgentId);
    this.sendSubscriptionBootstrap(socket, targetAgentId);
  }

  private resolveSubscribedAgentId(socket: WebSocket): string | undefined {
    const subscribedAgentId = this.subscriptions.get(socket);
    if (!subscribedAgentId) {
      return undefined;
    }

    if (this.swarmManager.getAgent(subscribedAgentId)) {
      return subscribedAgentId;
    }

    const fallbackAgentId = this.resolvePreferredManagerSubscriptionId();
    if (!fallbackAgentId) {
      return subscribedAgentId;
    }

    this.subscriptions.set(socket, fallbackAgentId);
    this.sendSubscriptionBootstrap(socket, fallbackAgentId);

    return fallbackAgentId;
  }

  private resolveManagerContextAgentId(subscribedAgentId: string): string | undefined {
    const descriptor = this.swarmManager.getAgent(subscribedAgentId);
    if (!descriptor) {
      if (!this.hasRunningManagers()) {
        return this.resolveConfiguredManagerId() ?? subscribedAgentId;
      }
      return undefined;
    }

    return descriptor.role === "manager" ? descriptor.agentId : descriptor.managerId;
  }

  private handleDeletedAgentSubscriptions(deletedAgentIds: Set<string>): void {
    for (const [socket, subscribedAgentId] of this.subscriptions.entries()) {
      if (!deletedAgentIds.has(subscribedAgentId)) {
        continue;
      }

      const fallbackAgentId = this.resolvePreferredManagerSubscriptionId();
      if (!fallbackAgentId) {
        this.subscriptions.set(socket, this.resolveDefaultSubscriptionAgentId());
        continue;
      }

      this.subscriptions.set(socket, fallbackAgentId);
      this.sendSubscriptionBootstrap(socket, fallbackAgentId);
    }
  }

  private sendSubscriptionBootstrap(socket: WebSocket, targetAgentId: string): void {
    this.send(socket, {
      type: "ready",
      serverTime: new Date().toISOString(),
      subscribedAgentId: targetAgentId
    });
    this.send(socket, {
      type: "agents_snapshot",
      agents: this.swarmManager.listAgents()
    });
    this.send(socket, {
      type: "conversation_history",
      agentId: targetAgentId,
      messages: this.swarmManager.getConversationHistory(targetAgentId)
    });

    const managerContextId = this.resolveManagerContextAgentId(targetAgentId);
    if (this.integrationRegistry && managerContextId) {
      this.send(socket, this.integrationRegistry.getStatus(managerContextId, "slack"));
      this.send(socket, this.integrationRegistry.getStatus(managerContextId, "telegram"));
    }
  }

  private resolveDefaultSubscriptionAgentId(): string {
    return (
      this.resolvePreferredManagerSubscriptionId() ??
      this.resolveConfiguredManagerId() ??
      BOOTSTRAP_SUBSCRIPTION_AGENT_ID
    );
  }

  private resolvePreferredManagerSubscriptionId(): string | undefined {
    const managerId = this.resolveConfiguredManagerId();
    if (managerId) {
      const configuredManager = this.swarmManager.getAgent(managerId);
      if (configuredManager && this.isSubscribable(configuredManager.status)) {
        return managerId;
      }
    }

    const firstManager = this.swarmManager
      .listAgents()
      .find((agent) => agent.role === "manager" && this.isSubscribable(agent.status));

    return firstManager?.agentId;
  }

  private resolveConfiguredManagerId(): string | undefined {
    const managerId = this.swarmManager.getConfig().managerId;
    if (typeof managerId !== "string") {
      return undefined;
    }

    const normalized = managerId.trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  private hasRunningManagers(): boolean {
    return this.swarmManager
      .listAgents()
      .some((agent) => agent.role === "manager" && this.isSubscribable(agent.status));
  }

  private isSubscribable(status: string): boolean {
    return status === "idle" || status === "streaming";
  }

  private logDebug(message: string, details?: unknown): void {
    if (!this.swarmManager.getConfig().debug) return;

    const prefix = `[swarm][${new Date().toISOString()}] ws:${message}`;
    if (details === undefined) {
      console.log(prefix);
      return;
    }

    console.log(prefix, details);
  }

  private extractRequestId(command: ClientCommand): string | undefined {
    switch (command.type) {
      case "create_manager":
      case "delete_manager":
      case "stop_all_agents":
      case "list_directories":
      case "validate_directory":
      case "pick_directory":
        return command.requestId;

      case "subscribe":
      case "user_message":
      case "kill_agent":
      case "ping":
        return undefined;
    }
  }

  private broadcastToSubscribed(event: ServerEvent): void {
    if (!this.wss) return;

    for (const client of this.wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;

      const subscribedAgent = this.subscriptions.get(client);
      if (!subscribedAgent) continue;

      if (
        event.type === "conversation_message" ||
        event.type === "conversation_log" ||
        event.type === "agent_message" ||
        event.type === "agent_tool_call" ||
        event.type === "conversation_reset"
      ) {
        if (subscribedAgent !== event.agentId) {
          continue;
        }
      }

      if (event.type === "slack_status" || event.type === "telegram_status") {
        if (event.managerId) {
          const subscribedManagerId = this.resolveManagerContextAgentId(subscribedAgent);
          if (subscribedManagerId !== event.managerId) {
            continue;
          }
        }
      }

      this.send(client, event);
    }
  }

  private send(socket: WebSocket, event: ServerEvent): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(event));
  }

  private parseClientCommand(raw: RawData):
    | { ok: true; command: ClientCommand }
    | { ok: false; error: string } {
    const text = typeof raw === "string" ? raw : raw.toString("utf8");

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, error: "Command must be valid JSON" };
    }

    if (!parsed || typeof parsed !== "object") {
      return { ok: false, error: "Command must be a JSON object" };
    }

    const maybe = parsed as Partial<ClientCommand> & { type?: unknown };

    if (maybe.type === "ping") {
      return { ok: true, command: { type: "ping" } };
    }

    if (maybe.type === "subscribe") {
      if (maybe.agentId !== undefined && typeof maybe.agentId !== "string") {
        return { ok: false, error: "subscribe.agentId must be a string when provided" };
      }
      return { ok: true, command: { type: "subscribe", agentId: maybe.agentId } };
    }

    if (maybe.type === "kill_agent") {
      if (typeof maybe.agentId !== "string" || maybe.agentId.trim().length === 0) {
        return { ok: false, error: "kill_agent.agentId must be a non-empty string" };
      }

      return {
        ok: true,
        command: {
          type: "kill_agent",
          agentId: maybe.agentId.trim()
        }
      };
    }

    if (maybe.type === "stop_all_agents") {
      const managerId = (maybe as { managerId?: unknown }).managerId;
      const requestId = (maybe as { requestId?: unknown }).requestId;

      if (typeof managerId !== "string" || managerId.trim().length === 0) {
        return { ok: false, error: "stop_all_agents.managerId must be a non-empty string" };
      }
      if (requestId !== undefined && typeof requestId !== "string") {
        return { ok: false, error: "stop_all_agents.requestId must be a string when provided" };
      }

      return {
        ok: true,
        command: {
          type: "stop_all_agents",
          managerId: managerId.trim(),
          requestId
        }
      };
    }

    if (maybe.type === "create_manager") {
      const name = (maybe as { name?: unknown }).name;
      const cwd = (maybe as { cwd?: unknown }).cwd;
      const model = (maybe as { model?: unknown }).model;
      const requestId = (maybe as { requestId?: unknown }).requestId;

      if (typeof name !== "string" || name.trim().length === 0) {
        return { ok: false, error: "create_manager.name must be a non-empty string" };
      }
      if (typeof cwd !== "string" || cwd.trim().length === 0) {
        return { ok: false, error: "create_manager.cwd must be a non-empty string" };
      }
      if (model !== undefined && !isSwarmModelPreset(model)) {
        return {
          ok: false,
          error: `create_manager.model must be one of ${describeSwarmModelPresets()}`
        };
      }
      if (requestId !== undefined && typeof requestId !== "string") {
        return { ok: false, error: "create_manager.requestId must be a string when provided" };
      }

      return {
        ok: true,
        command: {
          type: "create_manager",
          name: name.trim(),
          cwd,
          model,
          requestId
        }
      };
    }

    if (maybe.type === "delete_manager") {
      const managerId = (maybe as { managerId?: unknown }).managerId;
      const requestId = (maybe as { requestId?: unknown }).requestId;

      if (typeof managerId !== "string" || managerId.trim().length === 0) {
        return { ok: false, error: "delete_manager.managerId must be a non-empty string" };
      }
      if (requestId !== undefined && typeof requestId !== "string") {
        return { ok: false, error: "delete_manager.requestId must be a string when provided" };
      }

      return {
        ok: true,
        command: {
          type: "delete_manager",
          managerId: managerId.trim(),
          requestId
        }
      };
    }

    if (maybe.type === "list_directories") {
      const path = (maybe as { path?: unknown }).path;
      const requestId = (maybe as { requestId?: unknown }).requestId;

      if (path !== undefined && typeof path !== "string") {
        return { ok: false, error: "list_directories.path must be a string when provided" };
      }
      if (requestId !== undefined && typeof requestId !== "string") {
        return { ok: false, error: "list_directories.requestId must be a string when provided" };
      }

      return {
        ok: true,
        command: {
          type: "list_directories",
          path,
          requestId
        }
      };
    }

    if (maybe.type === "validate_directory") {
      const path = (maybe as { path?: unknown }).path;
      const requestId = (maybe as { requestId?: unknown }).requestId;

      if (typeof path !== "string" || path.trim().length === 0) {
        return { ok: false, error: "validate_directory.path must be a non-empty string" };
      }
      if (requestId !== undefined && typeof requestId !== "string") {
        return { ok: false, error: "validate_directory.requestId must be a string when provided" };
      }

      return {
        ok: true,
        command: {
          type: "validate_directory",
          path,
          requestId
        }
      };
    }

    if (maybe.type === "pick_directory") {
      const defaultPath = (maybe as { defaultPath?: unknown }).defaultPath;
      const requestId = (maybe as { requestId?: unknown }).requestId;

      if (defaultPath !== undefined && typeof defaultPath !== "string") {
        return { ok: false, error: "pick_directory.defaultPath must be a string when provided" };
      }
      if (requestId !== undefined && typeof requestId !== "string") {
        return { ok: false, error: "pick_directory.requestId must be a string when provided" };
      }

      return {
        ok: true,
        command: {
          type: "pick_directory",
          defaultPath: defaultPath?.trim() ? defaultPath : undefined,
          requestId
        }
      };
    }

    if (maybe.type === "user_message") {
      if (typeof maybe.text !== "string") {
        return { ok: false, error: "user_message.text must be a string" };
      }

      const normalizedText = maybe.text.trim();
      const parsedAttachments = parseConversationAttachments(
        (maybe as { attachments?: unknown }).attachments,
        "user_message.attachments"
      );
      if (!parsedAttachments.ok) {
        return { ok: false, error: parsedAttachments.error };
      }

      if (!normalizedText && parsedAttachments.attachments.length === 0) {
        return {
          ok: false,
          error: "user_message must include non-empty text or at least one attachment"
        };
      }

      if (maybe.agentId !== undefined && typeof maybe.agentId !== "string") {
        return { ok: false, error: "user_message.agentId must be a string when provided" };
      }

      if (
        maybe.delivery !== undefined &&
        maybe.delivery !== "auto" &&
        maybe.delivery !== "followUp" &&
        maybe.delivery !== "steer"
      ) {
        return { ok: false, error: "user_message.delivery must be one of auto|followUp|steer" };
      }

      return {
        ok: true,
        command: {
          type: "user_message",
          text: normalizedText,
          attachments: parsedAttachments.attachments.length > 0 ? parsedAttachments.attachments : undefined,
          agentId: maybe.agentId,
          delivery: maybe.delivery
        }
      };
    }

    return { ok: false, error: "Unknown command type" };
  }
}

async function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function resolveProdDaemonPid(repoRoot: string): number | null {
  const pidFile = getProdDaemonPidFile(repoRoot);
  if (!existsSync(pidFile)) {
    return null;
  }

  const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }

  try {
    process.kill(pid, 0);
    return pid;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ESRCH"
    ) {
      rmSync(pidFile, { force: true });
    }

    return null;
  }
}

function getProdDaemonPidFile(repoRoot: string): string {
  const repoHash = createHash("sha1").update(repoRoot).digest("hex").slice(0, 10);
  return join(tmpdir(), `swarm-prod-daemon-${repoHash}.pid`);
}

async function parseMultipartFormData(rawBody: Buffer, contentType: string): Promise<FormData> {
  const request = new Request("http://127.0.0.1/api/transcribe", {
    method: "POST",
    headers: {
      "content-type": contentType
    },
    body: rawBody
  });

  try {
    return await request.formData();
  } catch {
    throw new Error("Request body must be valid multipart form data");
  }
}

function resolveUploadFileName(file: File): string {
  const trimmed = file.name.trim();
  return trimmed.length > 0 ? trimmed : "voice-input.webm";
}

function normalizeMimeType(value: string): string {
  return value.split(";")[0]?.trim().toLowerCase() ?? "";
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

function parseBearerToken(headerValue: string): string | undefined {
  const trimmed = headerValue.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) {
    return undefined;
  }

  const token = trimmed.slice("bearer ".length).trim();
  return token.length > 0 ? token : undefined;
}

function normalizeAuthToken(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseOptionalBoolean(value: string | null): boolean | undefined {
  if (value === null) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }

  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }

  return undefined;
}

function parseCompactCustomInstructionsBody(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object");
  }

  const customInstructions = (value as { customInstructions?: unknown }).customInstructions;
  if (customInstructions === undefined) {
    return undefined;
  }

  if (typeof customInstructions !== "string") {
    throw new Error("customInstructions must be a string");
  }

  const trimmed = customInstructions.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseSettingsEnvUpdateBody(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object");
  }

  const maybeValues = "values" in value ? (value as { values?: unknown }).values : value;
  if (!maybeValues || typeof maybeValues !== "object" || Array.isArray(maybeValues)) {
    throw new Error("settings env payload must be an object map");
  }

  const updates: Record<string, string> = {};

  for (const [name, rawValue] of Object.entries(maybeValues)) {
    if (typeof rawValue !== "string") {
      throw new Error(`settings env value for ${name} must be a string`);
    }

    const normalized = rawValue.trim();
    if (!normalized) {
      throw new Error(`settings env value for ${name} must be a non-empty string`);
    }

    updates[name] = normalized;
  }

  return updates;
}

function parseSettingsAuthUpdateBody(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object");
  }

  const updates: Record<string, string> = {};

  for (const [provider, rawValue] of Object.entries(value)) {
    if (typeof rawValue !== "string") {
      throw new Error(`settings auth value for ${provider} must be a string`);
    }

    const normalized = rawValue.trim();
    if (!normalized) {
      throw new Error(`settings auth value for ${provider} must be a non-empty string`);
    }

    updates[provider] = normalized;
  }

  return updates;
}

function parseSettingsAuthLoginRespondBody(value: unknown): { value: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object");
  }

  const rawValue = (value as { value?: unknown }).value;
  if (typeof rawValue !== "string") {
    throw new Error("OAuth response value must be a string");
  }

  const normalized = rawValue.trim();
  if (!normalized) {
    throw new Error("OAuth response value must be a non-empty string");
  }

  return { value: normalized };
}

function parseGsuiteConfigUpdateBody(value: unknown): {
  enabled?: boolean;
  accountEmail?: string;
  services?: string[];
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object");
  }

  const patch = value as {
    enabled?: unknown;
    accountEmail?: unknown;
    services?: unknown;
  };

  const normalized: {
    enabled?: boolean;
    accountEmail?: string;
    services?: string[];
  } = {};

  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== "boolean") {
      throw new Error("gsuite.enabled must be a boolean");
    }
    normalized.enabled = patch.enabled;
  }

  if (patch.accountEmail !== undefined) {
    if (typeof patch.accountEmail !== "string") {
      throw new Error("gsuite.accountEmail must be a string");
    }
    normalized.accountEmail = patch.accountEmail.trim();
  }

  if (patch.services !== undefined) {
    if (!Array.isArray(patch.services)) {
      throw new Error("gsuite.services must be an array of strings");
    }

    const services = patch.services
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0);

    if (services.length === 0) {
      throw new Error("gsuite.services must include at least one service");
    }

    normalized.services = [...new Set(services)];
  }

  return normalized;
}

function parseGsuiteOAuthCredentialsBody(value: unknown): {
  oauthClientJson: string;
  clientName?: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object");
  }

  const payload = value as { oauthClientJson?: unknown; clientName?: unknown };
  if (typeof payload.oauthClientJson !== "string" || payload.oauthClientJson.trim().length === 0) {
    throw new Error("oauthClientJson must be a non-empty string");
  }

  if (payload.clientName !== undefined && typeof payload.clientName !== "string") {
    throw new Error("clientName must be a string when provided");
  }

  return {
    oauthClientJson: payload.oauthClientJson,
    clientName: typeof payload.clientName === "string" ? payload.clientName.trim() || undefined : undefined
  };
}

function parseGsuiteOAuthStartBody(value: unknown): {
  email?: string;
  services?: string[];
  forceConsent?: boolean;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const payload = value as {
    email?: unknown;
    services?: unknown;
    forceConsent?: unknown;
  };

  if (payload.email !== undefined && typeof payload.email !== "string") {
    throw new Error("email must be a string when provided");
  }

  if (payload.forceConsent !== undefined && typeof payload.forceConsent !== "boolean") {
    throw new Error("forceConsent must be a boolean when provided");
  }

  let services: string[] | undefined;
  if (payload.services !== undefined) {
    if (!Array.isArray(payload.services)) {
      throw new Error("services must be an array of strings when provided");
    }
    services = payload.services
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0);
  }

  return {
    email: typeof payload.email === "string" ? payload.email.trim() : undefined,
    services,
    forceConsent: payload.forceConsent
  };
}

function parseGsuiteOAuthCompleteBody(value: unknown): {
  email?: string;
  authUrl: string;
  services?: string[];
  forceConsent?: boolean;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object");
  }

  const payload = value as {
    email?: unknown;
    authUrl?: unknown;
    services?: unknown;
    forceConsent?: unknown;
  };

  if (typeof payload.authUrl !== "string" || payload.authUrl.trim().length === 0) {
    throw new Error("authUrl must be a non-empty string");
  }

  if (payload.email !== undefined && typeof payload.email !== "string") {
    throw new Error("email must be a string when provided");
  }

  if (payload.forceConsent !== undefined && typeof payload.forceConsent !== "boolean") {
    throw new Error("forceConsent must be a boolean when provided");
  }

  let services: string[] | undefined;
  if (payload.services !== undefined) {
    if (!Array.isArray(payload.services)) {
      throw new Error("services must be an array of strings when provided");
    }
    services = payload.services
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0);
  }

  return {
    email: typeof payload.email === "string" ? payload.email.trim() : undefined,
    authUrl: payload.authUrl.trim(),
    services,
    forceConsent: payload.forceConsent
  };
}

function parseGsuiteConnectionTestBody(value: unknown): { email?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const payload = value as { email?: unknown };
  if (payload.email !== undefined && typeof payload.email !== "string") {
    throw new Error("email must be a string when provided");
  }

  return {
    email: typeof payload.email === "string" ? payload.email.trim() : undefined
  };
}

type SlackIntegrationRoute = {
  managerId: string;
  action: "config" | "test" | "channels";
};

type SchedulesRoute = {
  managerId: string;
};

type TelegramIntegrationRoute = {
  managerId: string;
  action: "config" | "test";
};

function isSlackIntegrationPath(pathname: string): boolean {
  return (
    MANAGER_SLACK_INTEGRATION_ENDPOINT_PATTERN.test(pathname) ||
    MANAGER_SLACK_INTEGRATION_TEST_ENDPOINT_PATTERN.test(pathname) ||
    MANAGER_SLACK_INTEGRATION_CHANNELS_ENDPOINT_PATTERN.test(pathname)
  );
}

function isTelegramIntegrationPath(pathname: string): boolean {
  return (
    MANAGER_TELEGRAM_INTEGRATION_ENDPOINT_PATTERN.test(pathname) ||
    MANAGER_TELEGRAM_INTEGRATION_TEST_ENDPOINT_PATTERN.test(pathname)
  );
}

function isSchedulesPath(pathname: string): boolean {
  return MANAGER_SCHEDULES_ENDPOINT_PATTERN.test(pathname);
}

function resolveSchedulesRoute(pathname: string): SchedulesRoute | null {
  const managerMatch = pathname.match(MANAGER_SCHEDULES_ENDPOINT_PATTERN);
  if (!managerMatch) {
    return null;
  }

  const managerId = decodePathSegment(managerMatch[1]);
  if (!managerId) {
    return null;
  }

  return { managerId };
}

function resolveSlackIntegrationRoute(pathname: string): SlackIntegrationRoute | null {

  const configMatch = pathname.match(MANAGER_SLACK_INTEGRATION_ENDPOINT_PATTERN);
  if (configMatch) {
    const managerId = decodePathSegment(configMatch[1]);
    if (!managerId) {
      return null;
    }

    return { managerId, action: "config" };
  }

  const testMatch = pathname.match(MANAGER_SLACK_INTEGRATION_TEST_ENDPOINT_PATTERN);
  if (testMatch) {
    const managerId = decodePathSegment(testMatch[1]);
    if (!managerId) {
      return null;
    }

    return { managerId, action: "test" };
  }

  const channelsMatch = pathname.match(MANAGER_SLACK_INTEGRATION_CHANNELS_ENDPOINT_PATTERN);
  if (channelsMatch) {
    const managerId = decodePathSegment(channelsMatch[1]);
    if (!managerId) {
      return null;
    }

    return { managerId, action: "channels" };
  }

  return null;
}

function resolveTelegramIntegrationRoute(pathname: string): TelegramIntegrationRoute | null {

  const configMatch = pathname.match(MANAGER_TELEGRAM_INTEGRATION_ENDPOINT_PATTERN);
  if (configMatch) {
    const managerId = decodePathSegment(configMatch[1]);
    if (!managerId) {
      return null;
    }

    return { managerId, action: "config" };
  }

  const testMatch = pathname.match(MANAGER_TELEGRAM_INTEGRATION_TEST_ENDPOINT_PATTERN);
  if (testMatch) {
    const managerId = decodePathSegment(testMatch[1]);
    if (!managerId) {
      return null;
    }

    return { managerId, action: "test" };
  }

  return null;
}

function decodePathSegment(rawSegment: string | undefined): string | undefined {
  if (!rawSegment) {
    return undefined;
  }

  try {
    const decoded = decodeURIComponent(rawSegment).trim();
    return decoded.length > 0 ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function resolveSettingsAuthLoginProviderId(rawProvider: string): OAuthLoginProviderId | undefined {
  const normalized = rawProvider.trim().toLowerCase();
  if (normalized === "anthropic" || normalized === "openai-codex") {
    return normalized;
  }

  return undefined;
}

function resolveReadFileContentType(path: string): string {
  const extension = extname(path).toLowerCase();

  switch (extension) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function normalizeScheduleRecord(entry: unknown): ScheduleHttpRecord | undefined {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return undefined;
  }

  const maybe = entry as Partial<ScheduleHttpRecord>;
  const id = normalizeScheduleRequiredString(maybe.id);
  const name = normalizeScheduleRequiredString(maybe.name);
  const cron = normalizeScheduleRequiredString(maybe.cron);
  const message = normalizeScheduleRequiredString(maybe.message);
  const timezone = normalizeScheduleRequiredString(maybe.timezone);
  const createdAt = normalizeScheduleRequiredString(maybe.createdAt);
  const nextFireAt = normalizeScheduleRequiredString(maybe.nextFireAt);
  const lastFiredAt = normalizeScheduleRequiredString(maybe.lastFiredAt);

  if (!id || !name || !cron || !message || !timezone || !createdAt || !nextFireAt) {
    return undefined;
  }

  return {
    id,
    name,
    cron,
    message,
    oneShot: typeof maybe.oneShot === "boolean" ? maybe.oneShot : false,
    timezone,
    createdAt,
    nextFireAt,
    lastFiredAt
  };
}

function normalizeScheduleRequiredString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function parseConversationAttachments(
  value: unknown,
  fieldName: string
):
  | {
      ok: true;
      attachments: ConversationAttachment[];
    }
  | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true, attachments: [] };
  }

  if (!Array.isArray(value)) {
    return { ok: false, error: `${fieldName} must be an array when provided` };
  }

  const attachments: ConversationAttachment[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!item || typeof item !== "object") {
      return { ok: false, error: `${fieldName}[${index}] must be an object` };
    }

    const maybe = item as {
      type?: unknown;
      mimeType?: unknown;
      data?: unknown;
      text?: unknown;
      fileName?: unknown;
    };

    if (maybe.type !== undefined && typeof maybe.type !== "string") {
      return { ok: false, error: `${fieldName}[${index}].type must be a string when provided` };
    }

    if (typeof maybe.mimeType !== "string" || maybe.mimeType.trim().length === 0) {
      return { ok: false, error: `${fieldName}[${index}].mimeType must be a non-empty string` };
    }

    if (maybe.fileName !== undefined && typeof maybe.fileName !== "string") {
      return { ok: false, error: `${fieldName}[${index}].fileName must be a string when provided` };
    }

    const attachmentType = typeof maybe.type === "string" ? maybe.type.trim() : "";
    const mimeType = maybe.mimeType.trim();
    const fileName = typeof maybe.fileName === "string" ? maybe.fileName.trim() : "";

    if (attachmentType === "text") {
      if (typeof maybe.text !== "string" || maybe.text.trim().length === 0) {
        return { ok: false, error: `${fieldName}[${index}].text must be a non-empty string` };
      }

      attachments.push({
        type: "text",
        mimeType,
        text: maybe.text,
        fileName: fileName || undefined
      });
      continue;
    }

    if (attachmentType === "binary") {
      if (typeof maybe.data !== "string" || maybe.data.trim().length === 0) {
        return { ok: false, error: `${fieldName}[${index}].data must be a non-empty base64 string` };
      }

      attachments.push({
        type: "binary",
        mimeType,
        data: maybe.data.trim(),
        fileName: fileName || undefined
      });
      continue;
    }

    if (attachmentType !== "" && attachmentType !== "image") {
      return {
        ok: false,
        error: `${fieldName}[${index}].type must be image|text|binary when provided`
      };
    }

    if (!mimeType.startsWith("image/")) {
      return { ok: false, error: `${fieldName}[${index}].mimeType must start with image/` };
    }

    if (typeof maybe.data !== "string" || maybe.data.trim().length === 0) {
      return { ok: false, error: `${fieldName}[${index}].data must be a non-empty base64 string` };
    }

    attachments.push({
      mimeType,
      data: maybe.data.trim(),
      fileName: fileName || undefined
    });
  }

  return { ok: true, attachments };
}

async function persistConversationAttachments(
  attachments: ConversationAttachment[],
  uploadsDir: string
): Promise<ConversationAttachment[]> {
  if (attachments.length === 0) {
    return [];
  }

  await mkdir(uploadsDir, { recursive: true });

  const persisted: ConversationAttachment[] = [];
  for (const attachment of attachments) {
    if (attachment.type === "text") {
      const extension = resolveAttachmentExtension({
        mimeType: attachment.mimeType,
        fileName: attachment.fileName,
        fallbackExtension: "txt"
      });
      const filePath = buildUploadFilePath(uploadsDir, extension);
      await writeFile(filePath, attachment.text, "utf8");
      persisted.push({
        ...attachment,
        filePath
      });
      continue;
    }

    const extension = resolveAttachmentExtension({
      mimeType: attachment.mimeType,
      fileName: attachment.fileName,
      fallbackExtension: attachment.type === "binary" ? "bin" : "png"
    });
    const filePath = buildUploadFilePath(uploadsDir, extension);
    await writeFile(filePath, Buffer.from(attachment.data, "base64"));
    persisted.push({
      ...attachment,
      filePath
    });
  }

  return persisted;
}

function buildUploadFilePath(uploadsDir: string, extension: string): string {
  const safeExtension = extension.trim().toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
  return join(uploadsDir, `${Date.now()}-${randomUUID()}.${safeExtension}`);
}

function resolveAttachmentExtension(options: {
  mimeType: string;
  fileName?: string;
  fallbackExtension: string;
}): string {
  const fromMimeType = extensionFromMimeType(options.mimeType);
  if (fromMimeType) {
    return fromMimeType;
  }

  const fromFileName = extensionFromFileName(options.fileName);
  if (fromFileName) {
    return fromFileName;
  }

  return options.fallbackExtension;
}

function extensionFromMimeType(mimeType: string): string | undefined {
  const normalized = mimeType.trim().toLowerCase().split(";", 1)[0]?.trim() ?? "";
  if (!normalized) {
    return undefined;
  }

  const mapped = MIME_TYPE_EXTENSIONS[normalized];
  if (mapped) {
    return mapped;
  }

  const slashIndex = normalized.indexOf("/");
  if (slashIndex < 0 || slashIndex === normalized.length - 1) {
    return undefined;
  }

  const subtype = normalized.slice(slashIndex + 1);
  const plusIndex = subtype.indexOf("+");
  const candidate = (plusIndex >= 0 ? subtype.slice(0, plusIndex) : subtype).replace(/[^a-z0-9]/g, "");
  return candidate.length > 0 ? candidate : undefined;
}

function extensionFromFileName(fileName: string | undefined): string | undefined {
  if (typeof fileName !== "string" || fileName.trim().length === 0) {
    return undefined;
  }

  const extension = extname(fileName).trim().toLowerCase().replace(/^\./, "").replace(/[^a-z0-9]/g, "");
  return extension.length > 0 ? extension : undefined;
}

function previewForLog(value: string, maxLength = 180): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength)}…`;
}

const MIME_TYPE_EXTENSIONS: Record<string, string> = {
  "image/apng": "apng",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/tiff": "tiff",
  "image/webp": "webp",
  "application/gzip": "gz",
  "application/json": "json",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "text/csv": "csv",
  "text/html": "html",
  "text/markdown": "md",
  "text/plain": "txt",
  "text/xml": "xml"
};
