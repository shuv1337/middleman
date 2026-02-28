import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { parseSwarmModelPreset } from "./model-presets.js";
import type { ShuvdoClient } from "./shuvdo-client.js";
import {
  type AgentDescriptor,
  type MessageChannel,
  type MessageSourceContext,
  type MessageTargetContext,
  type RequestedDeliveryMode,
  type SendMessageReceipt,
  type SpawnAgentInput
} from "./types.js";

export interface SwarmToolHost {
  listAgents(): AgentDescriptor[];
  spawnAgent(callerAgentId: string, input: SpawnAgentInput): Promise<AgentDescriptor>;
  killAgent(callerAgentId: string, targetAgentId: string): Promise<void>;
  sendMessage(
    fromAgentId: string,
    targetAgentId: string,
    message: string,
    delivery?: RequestedDeliveryMode
  ): Promise<SendMessageReceipt>;
  publishToUser(
    agentId: string,
    text: string,
    source?: "speak_to_user" | "system",
    targetContext?: MessageTargetContext
  ): Promise<{ targetContext: MessageSourceContext }>;
}

const deliveryModeSchema = Type.Union([
  Type.Literal("auto"),
  Type.Literal("followUp"),
  Type.Literal("steer")
]);

const spawnModelPresetSchema = Type.Union([
  Type.Literal("pi-codex"),
  Type.Literal("pi-opus"),
  Type.Literal("codex-app")
]);

const messageChannelSchema = Type.Union([
  Type.Literal("web"),
  Type.Literal("slack"),
  Type.Literal("telegram")
]);

const speakToUserTargetSchema = Type.Object({
  channel: messageChannelSchema,
  channelId: Type.Optional(
    Type.String({ description: "Required when channel is 'slack' or 'telegram'." })
  ),
  userId: Type.Optional(Type.String()),
  threadTs: Type.Optional(Type.String()),
  integrationProfileId: Type.Optional(
    Type.String({ description: "Optional integration profile id for provider-targeted delivery." })
  )
});

const genericRecordSchema = Type.Record(Type.String(), Type.Any());

export function buildSwarmTools(
  host: SwarmToolHost,
  descriptor: AgentDescriptor,
  options?: { shuvdoClient?: ShuvdoClient }
): ToolDefinition[] {
  const shared: ToolDefinition[] = [
    {
      name: "list_agents",
      label: "List Agents",
      description: "List swarm agents with ids, roles, status, model, and workspace.",
      parameters: Type.Object({}),
      async execute() {
        const agents = host.listAgents();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ agents }, null, 2)
            }
          ],
          details: { agents }
        };
      }
    },
    {
      name: "send_message_to_agent",
      label: "Send Message To Agent",
      description:
        "Send a message to another agent by id. Returns immediately with a delivery receipt. If target is busy, queued delivery is accepted as steer.",
      parameters: Type.Object({
        targetAgentId: Type.String({ description: "Agent id to receive the message." }),
        message: Type.String({ description: "Message text to deliver." }),
        delivery: Type.Optional(deliveryModeSchema)
      }),
      async execute(_toolCallId, params) {
        const parsed = params as {
          targetAgentId: string;
          message: string;
          delivery?: RequestedDeliveryMode;
        };

        const receipt = await host.sendMessage(
          descriptor.agentId,
          parsed.targetAgentId,
          parsed.message,
          parsed.delivery
        );

        return {
          content: [
            {
              type: "text",
              text: `Queued message for ${receipt.targetAgentId}. deliveryId=${receipt.deliveryId}, mode=${receipt.acceptedMode}`
            }
          ],
          details: receipt
        };
      }
    }
  ];

  if (descriptor.role !== "manager") {
    return shared;
  }

  const managerOnly: ToolDefinition[] = [
    {
      name: "spawn_agent",
      label: "Spawn Agent",
      description:
        "Create and start a new worker agent. agentId is required and normalized to lowercase kebab-case; if taken, a numeric suffix (-2, -3, …) is appended. archetypeId, systemPrompt, model, cwd, and initialMessage are optional. model accepts pi-codex|pi-opus|codex-app.",
      parameters: Type.Object({
        agentId: Type.String({
          description:
            "Required agent identifier. Normalized to lowercase kebab-case; collisions are suffixed numerically."
        }),
        archetypeId: Type.Optional(
          Type.String({ description: "Optional archetype id (for example: merger)." })
        ),
        systemPrompt: Type.Optional(Type.String({ description: "Optional system prompt override." })),
        model: Type.Optional(spawnModelPresetSchema),
        cwd: Type.Optional(Type.String({ description: "Optional working directory override." })),
        initialMessage: Type.Optional(Type.String({ description: "Optional first message to send after spawn." }))
      }),
      async execute(_toolCallId, params) {
        const parsed = params as {
          agentId: string;
          archetypeId?: string;
          systemPrompt?: string;
          model?: unknown;
          cwd?: string;
          initialMessage?: string;
        };

        const spawned = await host.spawnAgent(descriptor.agentId, {
          agentId: parsed.agentId,
          archetypeId: parsed.archetypeId,
          systemPrompt: parsed.systemPrompt,
          model: parseSwarmModelPreset(parsed.model, "spawn_agent.model"),
          cwd: parsed.cwd,
          initialMessage: parsed.initialMessage
        });

        return {
          content: [
            {
              type: "text",
              text: `Spawned agent ${spawned.agentId} (${spawned.displayName})`
            }
          ],
          details: spawned
        };
      }
    },
    {
      name: "kill_agent",
      label: "Kill Agent",
      description: "Terminate a running worker agent. Manager cannot be terminated.",
      parameters: Type.Object({
        targetAgentId: Type.String({ description: "Agent id to terminate." })
      }),
      async execute(_toolCallId, params) {
        const parsed = params as { targetAgentId: string };
        await host.killAgent(descriptor.agentId, parsed.targetAgentId);
        return {
          content: [
            {
              type: "text",
              text: `Terminated agent ${parsed.targetAgentId}`
            }
          ],
          details: {
            targetAgentId: parsed.targetAgentId,
            terminated: true
          }
        };
      }
    },
    {
      name: "speak_to_user",
      label: "Speak To User",
      description:
        "Publish a user-visible manager message into the websocket conversation feed. If target is omitted, delivery defaults to web. For Slack/Telegram delivery, set target.channel and target.channelId explicitly.",
      parameters: Type.Object({
        text: Type.String({ description: "Message content to show to the user." }),
        target: Type.Optional(speakToUserTargetSchema)
      }),
      async execute(_toolCallId, params) {
        const parsed = params as {
          text: string;
          target?: {
            channel: MessageChannel;
            channelId?: string;
            userId?: string;
            threadTs?: string;
            integrationProfileId?: string;
          };
        };

        const published = await host.publishToUser(
          descriptor.agentId,
          parsed.text,
          "speak_to_user",
          parsed.target
        );

        return {
          content: [
            {
              type: "text",
              text: `Published message to user (${published.targetContext.channel}).`
            }
          ],
          details: {
            published: true,
            targetContext: published.targetContext
          }
        };
      }
    }
  ];

  const shuvdoClient = options?.shuvdoClient;
  if (!shuvdoClient) {
    return [...shared, ...managerOnly];
  }

  const shuvdoTools: ToolDefinition[] = [
    {
      name: "create_task",
      label: "Create Task",
      description: "Create a Shuvdo task in a list via POST /api/list/:name/add.",
      parameters: Type.Object({
        listName: Type.String({ description: "Target list name." }),
        payload: genericRecordSchema
      }),
      async execute(_toolCallId, params) {
        const parsed = params as { listName: string; payload: Record<string, unknown> };
        const response = await shuvdoClient.createTask({
          managerId: descriptor.agentId,
          listName: parsed.listName,
          body: parsed.payload
        });
        return shuvdoResult("create_task", response);
      }
    },
    {
      name: "complete_task",
      label: "Complete Task",
      description: "Toggle/complete a Shuvdo task via POST /api/list/:name/:id/done.",
      parameters: Type.Object({
        listName: Type.String(),
        itemId: Type.String(),
        payload: Type.Optional(genericRecordSchema)
      }),
      async execute(_toolCallId, params) {
        const parsed = params as {
          listName: string;
          itemId: string;
          payload?: Record<string, unknown>;
        };
        const response = await shuvdoClient.completeTask({
          managerId: descriptor.agentId,
          listName: parsed.listName,
          itemId: parsed.itemId,
          body: parsed.payload
        });
        return shuvdoResult("complete_task", response);
      }
    },
    {
      name: "list_tasks",
      label: "List Tasks",
      description: "List tasks/items in a Shuvdo list.",
      parameters: Type.Object({
        listName: Type.String()
      }),
      async execute(_toolCallId, params) {
        const parsed = params as { listName: string };
        const response = await shuvdoClient.listTasks({
          managerId: descriptor.agentId,
          listName: parsed.listName
        });
        return shuvdoResult("list_tasks", response);
      }
    },
    {
      name: "create_reminder",
      label: "Create Reminder",
      description: "Create reminder item in Shuvdo (requires dueAt).",
      parameters: Type.Object({
        listName: Type.String(),
        dueAt: Type.String({ description: "Required ISO datetime for reminder due time." }),
        text: Type.String(),
        repeatRule: Type.Optional(Type.String()),
        payload: Type.Optional(genericRecordSchema)
      }),
      async execute(_toolCallId, params) {
        const parsed = params as {
          listName: string;
          dueAt: string;
          text: string;
          repeatRule?: string;
          payload?: Record<string, unknown>;
        };

        const body = {
          ...(parsed.payload ?? {}),
          text: parsed.text,
          dueAt: parsed.dueAt,
          ...(parsed.repeatRule ? { repeatRule: parsed.repeatRule } : {})
        };

        const response = await shuvdoClient.createReminder({
          managerId: descriptor.agentId,
          listName: parsed.listName,
          body
        });
        return shuvdoResult("create_reminder", response);
      }
    },
    {
      name: "list_due_reminders",
      label: "List Due Reminders",
      description: "List due reminders via /api/reminders/next (consumer supports bot|signal).",
      parameters: Type.Object({
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
        consumer: Type.Optional(Type.Union([Type.Literal("bot"), Type.Literal("signal")]))
      }),
      async execute(_toolCallId, params) {
        const parsed = params as { limit?: number; consumer?: "bot" | "signal" };
        const response = await shuvdoClient.listDueReminders({
          managerId: descriptor.agentId,
          limit: parsed.limit,
          consumer: parsed.consumer
        });
        return shuvdoResult("list_due_reminders", response);
      }
    },
    {
      name: "complete_reminder",
      label: "Complete Reminder",
      description: "Complete reminder via /api/reminders/:id/complete with optional idempotency key.",
      parameters: Type.Object({
        reminderId: Type.String(),
        idempotencyKey: Type.Optional(Type.String()),
        payload: Type.Optional(genericRecordSchema)
      }),
      async execute(_toolCallId, params) {
        const parsed = params as {
          reminderId: string;
          idempotencyKey?: string;
          payload?: Record<string, unknown>;
        };

        const response = await shuvdoClient.completeReminder({
          managerId: descriptor.agentId,
          reminderId: parsed.reminderId,
          idempotencyKey: parsed.idempotencyKey,
          body: parsed.payload
        });
        return shuvdoResult("complete_reminder", response);
      }
    },
    {
      name: "list_projects",
      label: "List Projects",
      description: "List Shuvdo projects.",
      parameters: Type.Object({}),
      async execute() {
        const response = await shuvdoClient.listProjects({ managerId: descriptor.agentId });
        return shuvdoResult("list_projects", response);
      }
    },
    {
      name: "create_project",
      label: "Create Project",
      description: "Create Shuvdo project via POST /api/projects/add.",
      parameters: Type.Object({
        payload: genericRecordSchema
      }),
      async execute(_toolCallId, params) {
        const parsed = params as { payload: Record<string, unknown> };
        const response = await shuvdoClient.createProject({
          managerId: descriptor.agentId,
          body: parsed.payload
        });
        return shuvdoResult("create_project", response);
      }
    },
    {
      name: "show_project",
      label: "Show Project",
      description: "Show Shuvdo project details.",
      parameters: Type.Object({
        projectId: Type.String()
      }),
      async execute(_toolCallId, params) {
        const parsed = params as { projectId: string };
        const response = await shuvdoClient.showProject({
          managerId: descriptor.agentId,
          projectId: parsed.projectId
        });
        return shuvdoResult("show_project", response);
      }
    },
    {
      name: "update_project",
      label: "Update Project",
      description: "Update Shuvdo project via PATCH /api/projects/:id.",
      parameters: Type.Object({
        projectId: Type.String(),
        payload: genericRecordSchema
      }),
      async execute(_toolCallId, params) {
        const parsed = params as { projectId: string; payload: Record<string, unknown> };
        const response = await shuvdoClient.updateProject({
          managerId: descriptor.agentId,
          projectId: parsed.projectId,
          body: parsed.payload
        });
        return shuvdoResult("update_project", response);
      }
    },
    {
      name: "create_milestone",
      label: "Create Milestone",
      description: "Create Shuvdo milestone via POST /api/projects/:id/milestones/add.",
      parameters: Type.Object({
        projectId: Type.String(),
        payload: genericRecordSchema
      }),
      async execute(_toolCallId, params) {
        const parsed = params as { projectId: string; payload: Record<string, unknown> };
        const response = await shuvdoClient.createMilestone({
          managerId: descriptor.agentId,
          projectId: parsed.projectId,
          body: parsed.payload
        });
        return shuvdoResult("create_milestone", response);
      }
    },
    {
      name: "update_milestone",
      label: "Update Milestone",
      description: "Update Shuvdo milestone via PATCH /api/projects/:id/milestones/:milestoneId.",
      parameters: Type.Object({
        projectId: Type.String(),
        milestoneId: Type.String(),
        payload: genericRecordSchema
      }),
      async execute(_toolCallId, params) {
        const parsed = params as {
          projectId: string;
          milestoneId: string;
          payload: Record<string, unknown>;
        };

        const response = await shuvdoClient.updateMilestone({
          managerId: descriptor.agentId,
          projectId: parsed.projectId,
          milestoneId: parsed.milestoneId,
          body: parsed.payload
        });
        return shuvdoResult("update_milestone", response);
      }
    },
    {
      name: "get_agent_queue",
      label: "Get Agent Queue",
      description: "Fetch Shuvdo queue payload for an agent (tasks + reminders).",
      parameters: Type.Object({
        agentId: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 }))
      }),
      async execute(_toolCallId, params) {
        const parsed = params as { agentId?: string; limit?: number };
        const response = await shuvdoClient.getAgentQueue({
          managerId: descriptor.agentId,
          agentId: parsed.agentId?.trim() || descriptor.agentId,
          limit: parsed.limit
        });
        return shuvdoResult("get_agent_queue", response);
      }
    }
  ];

  return [...shared, ...managerOnly, ...shuvdoTools];
}

function shuvdoResult(toolName: string, payload: Record<string, unknown>) {
  return {
    content: [
      {
        type: "text" as const,
        text: `${toolName} succeeded.`
      }
    ],
    details: payload
  };
}
