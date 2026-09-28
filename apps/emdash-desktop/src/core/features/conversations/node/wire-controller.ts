import { formatHostRef } from '@emdash/core/primitives/host/api';
import {
  LOCAL_HOST_REF,
  parseHostRef,
  type HostRef,
  type SerializedHostRef,
} from '@emdash/core/primitives/host/api';
import { acpErr, providerOptionValuesSchema } from '@emdash/core/runtimes/acp/api/client';
import { err, ok, type Result } from '@emdash/shared';
import { createKeyedLanes } from '@emdash/shared/concurrency';
import type { Logger } from '@emdash/shared/logger';
import type { LiveSource } from '@emdash/wire/rpc';
import { createController, type CallMeta, type Controller } from '@emdash/wire/rpc';
import { and, eq } from 'drizzle-orm';
import { conversationRegistryTable as conversations } from '@core/features/conversations/api/node/registry';
import { createConversationOperations } from '@core/features/conversations/node/controller';
import type { CompensationRunner } from '@core/features/conversations/node/createConversation';
import type { ProjectAttachmentError } from '@core/features/projects/api';
import {
  requireAttachedProjectOrThrow,
  withAttachedProject,
} from '@core/features/projects/api/node/attached-project';
import type { ProjectAttachmentManager } from '@core/features/projects/api/node/project-attachment-manager';
import type { TaskSessionLaunchContextResolver } from '@core/features/tasks/api/node/task-session-launch-context';
import type { TaskSessionManager } from '@core/features/tasks/api/node/task-session-manager';
import type { TelemetryService } from '@core/primitives/telemetry/api/telemetry';
import type { AppDb } from '@core/services/app-db/node/db';
import { tasks } from '@core/services/app-db/node/schema';
import {
  prepareTerminalFiles,
  type TerminalFileSources,
} from '@core/services/attachments/node/prepare-terminal-files';
import { forwardLiveModel } from '@core/services/runtime-clients/node/forward-live-model';
import { conversationsContract } from '../api';
import {
  throwConversationsRuntimeResolveError,
  type ConversationsAcpStartInput,
  type ConversationsHostRuntimesClient,
  type ConversationsRuntimeBroker,
  type ConversationsRuntimeResolveError as RuntimeResolveError,
} from '../api/runtime-adapter';
import { conversationWireEvents } from './event-host';
import { getProviderSettingsService } from './provider-settings-service';
import { acpTranscriptMarkdown, ptyTranscriptMarkdown } from './transcript-markdown';
import { loadTranscript, saveTranscript } from './transcript-store';

type ConversationRuntimeTarget = Readonly<{
  conversationId: string;
  projectId: string;
  taskId: string;
  conversationType: 'pty' | 'acp';
  providerId: string | null;
  sessionId: string | null;
  workspacePath?: string;
  title?: string;
  host: HostRef;
  acpInput?: ConversationsAcpStartInput;
}>;

type WorkspaceIdentityResolver = Readonly<{
  resolve(workspaceId: string): Promise<{ host: HostRef; path: string } | null>;
}>;

type ConversationRuntimeHooks = Readonly<{
  recordTuiInput(target: ConversationRuntimeTarget): Promise<void>;
}>;

export type CreateConversationsWireControllerOptions = Readonly<{
  db: AppDb;
  terminalFileSources: TerminalFileSources;
  runtimes: ConversationsRuntimeBroker;
  workspaceIdentity: WorkspaceIdentityResolver;
  resolveTarget?: (conversationId: string) => Promise<ConversationRuntimeTarget>;
  hooks?: ConversationRuntimeHooks;
  getProviderEnv?: (providerId: string) => Promise<Record<string, string> | undefined>;
  sessionLaunchContexts: Pick<TaskSessionLaunchContextResolver, 'resolve'>;
  logger: Logger;
  projects: Pick<ProjectAttachmentManager, 'requireAttached'>;
  telemetry: TelemetryService;
  taskSessions: Pick<TaskSessionManager, 'getTask'>;
  withCompensation: CompensationRunner;
  hostIsReachable: (hostRef: SerializedHostRef) => boolean;
}>;

export function createConversationsWireController(
  options: CreateConversationsWireControllerOptions
): Controller {
  const resolveTarget =
    options.resolveTarget ??
    ((conversationId) =>
      resolveConversationRuntimeTarget(
        conversationId,
        options.workspaceIdentity,
        options.db,
        options.getProviderEnv,
        options.sessionLaunchContexts
      ));
  const hooks = options.hooks ?? createDefaultRuntimeHooks(options);
  const configurationChanges = createKeyedLanes();
  const conversationOperations = createConversationOperations({
    db: options.db,
    taskSessions: options.taskSessions,
    telemetry: options.telemetry,
    withCompensation: options.withCompensation,
    runtimes: options.runtimes,
    hostIsReachable: options.hostIsReachable,
    workspaceIdentity: options.workspaceIdentity,
  });
  const target = (conversationId: string) => resolveTarget(conversationId);
  const pendingTranscriptWrites = new Map<string, Promise<void>>();
  const persist = (runtimeTarget: ConversationRuntimeTarget, content: string): void => {
    if (!runtimeTarget.workspacePath || !content.trim()) return;
    const previous = pendingTranscriptWrites.get(runtimeTarget.conversationId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() =>
        saveTranscript(
          options.db,
          options.runtimes,
          {
            conversationId: runtimeTarget.conversationId,
            projectId: runtimeTarget.projectId,
            workspacePath: runtimeTarget.workspacePath!,
            title: runtimeTarget.title ?? runtimeTarget.conversationId,
            host: runtimeTarget.host,
          },
          content
        )
      )
      .catch((error) => {
        options.logger.warn('Could not save conversation transcript', { error });
      });
    pendingTranscriptWrites.set(runtimeTarget.conversationId, next);
    void next.finally(() => {
      if (pendingTranscriptWrites.get(runtimeTarget.conversationId) === next)
        pendingTranscriptWrites.delete(runtimeTarget.conversationId);
    });
  };
  const captureAcp = async (runtimeTarget: ConversationRuntimeTarget): Promise<void> => {
    const resolved = await options.runtimes.client(runtimeTarget.host);
    if (!resolved.success) return;
    const exported = await resolved.data.acp.exportAcpTranscript({
      conversationId: runtimeTarget.conversationId,
    });
    if (exported.success) persist(runtimeTarget, acpTranscriptMarkdown(exported.data.transcript));
  };
  const transcriptObservers = new Map<string, () => void>();
  const observeAcp = async (
    runtimeTarget: ConversationRuntimeTarget,
    client: ConversationsHostRuntimesClient
  ): Promise<void> => {
    if (transcriptObservers.has(runtimeTarget.conversationId)) return;
    const source = client.acp.session
      .state({ conversationId: runtimeTarget.conversationId }, 'state')
      .asLiveSource();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void captureAcp(runtimeTarget).catch((error) =>
          options.logger.warn('Could not capture ACP transcript', { error })
        );
      }, 400);
    };
    const unsubscribe = await source.subscribe(schedule);
    const stop = () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
      transcriptObservers.delete(runtimeTarget.conversationId);
    };
    transcriptObservers.set(runtimeTarget.conversationId, stop);
    schedule();
  };
  const observePty = async (
    runtimeTarget: ConversationRuntimeTarget,
    client: ConversationsHostRuntimesClient
  ): Promise<void> => {
    if (transcriptObservers.has(runtimeTarget.conversationId)) return;
    const source = client.tuiAgents.output
      .handle({ conversationId: runtimeTarget.conversationId })
      .asLiveSource();
    let generation = -1;
    let sequence = -1;
    let output = '';
    let previousContent = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        persist(runtimeTarget, previousContent + ptyTranscriptMarkdown(output));
      }, 400);
    };
    if (runtimeTarget.workspacePath) {
      try {
        const existing = await loadTranscript(options.db, options.runtimes, {
          conversationId: runtimeTarget.conversationId,
          projectId: runtimeTarget.projectId,
          workspacePath: runtimeTarget.workspacePath,
          title: runtimeTarget.title ?? runtimeTarget.conversationId,
          host: runtimeTarget.host,
        });
        previousContent = existing ? `${existing.trimEnd()}\n\n` : '';
      } catch (error) {
        options.logger.warn('Could not read previous terminal transcript', { error });
      }
    }
    const unsubscribe = await source.subscribe((update) => {
      const delta = update.delta as { chunk?: unknown };
      if (
        update.generation === generation &&
        update.sequence > sequence &&
        typeof delta.chunk === 'string'
      ) {
        output += delta.chunk;
        sequence = update.sequence;
        schedule();
      } else if (update.generation !== generation) {
        void Promise.resolve(source.snapshot()).then((snapshot) => {
          const data = snapshot.data as { text: string; truncated: boolean };
          generation = snapshot.generation;
          sequence = snapshot.sequence;
          output += `${output ? '\n\n' : ''}${data.truncated ? '[Earlier output unavailable]\n' : ''}${data.text}`;
          schedule();
        });
      }
    });
    const snapshot = await source.snapshot();
    const data = snapshot.data as { text: string; truncated: boolean };
    generation = snapshot.generation;
    sequence = snapshot.sequence;
    output += `${data.truncated ? '[Earlier output unavailable]\n' : ''}${data.text}`;
    if (output) schedule();
    const stop = () => {
      if (timer) {
        clearTimeout(timer);
        persist(runtimeTarget, previousContent + ptyTranscriptMarkdown(output));
      }
      unsubscribe();
      transcriptObservers.delete(runtimeTarget.conversationId);
    };
    transcriptObservers.set(runtimeTarget.conversationId, stop);
  };
  const logCaptureError = (error: unknown) =>
    options.logger.warn('Could not observe conversation transcript', { error });
  const run = <T, E>(
    conversationId: string,
    work: (
      client: ConversationsHostRuntimesClient,
      target: ConversationRuntimeTarget
    ) => Promise<Result<T, E>>
  ) => withConversationRuntime(options, target(conversationId), work);

  const acpSessions = forwardLiveModel(conversationsContract.acp.sessions, (key, name) =>
    resolveProjectRuntimeSource(
      options,
      key.projectId,
      Promise.resolve(parseHostRef(key.host)),
      (client) => client.acp.sessions.state(undefined, name).asLiveSource()
    )
  );
  const acpSession = forwardLiveModel(conversationsContract.acp.session, (key, name) =>
    resolveConversationRuntimeSource(options, target(key.conversationId), (client) =>
      client.acp.session.state(key, name).asLiveSource()
    )
  );
  const tuiSessions = forwardLiveModel(conversationsContract.tui.sessions, (key, name) =>
    resolveProjectRuntimeSource(
      options,
      key.projectId,
      Promise.resolve(parseHostRef(key.host)),
      (client) => client.tuiAgents.sessions.state(undefined, name).asLiveSource()
    )
  );

  const settings = getProviderSettingsService(options.db);
  return createController(conversationsContract, {
    providerSettings: {
      model: settings.model,
      patch: ({ patch, ...key }) => settings.patch(key, patch),
    },
    attachments: {
      prepareLocalFiles: ({ conversationId, sources }, meta) =>
        run(conversationId, (client, target) =>
          prepareTerminalFiles({
            host: target.host,
            sources,
            localFiles: options.terminalFileSources,
            upload: (file) =>
              client.conversations.attachments.upload({ conversationId }, file, callOptions(meta)),
            remove: (attachmentId) =>
              client.conversations.attachments.delete({ conversationId, attachmentId }),
            signal: meta.signal,
            logger: options.logger,
          })
        ),
      upload: ({ conversationId }, file, meta) =>
        run(conversationId, (client) =>
          client.conversations.attachments.upload({ conversationId }, file, callOptions(meta))
        ),
      download: ({ conversationId, attachmentId }, meta) =>
        openAttachmentDownload(options, target(conversationId), attachmentId, callOptions(meta)),
      delete: ({ conversationId, attachmentId }, meta) =>
        run(conversationId, (client) =>
          client.conversations.attachments.delete(
            { conversationId, attachmentId },
            callOptions(meta)
          )
        ),
    },
    getConversations: () => conversationOperations.getConversations(),
    createConversation: (input) =>
      withAttachedProject(options.projects, input.projectId, async () =>
        ok(await conversationOperations.createConversation(input))
      ),
    deleteConversation: async ({ projectId, taskId, conversationId }) => {
      transcriptObservers.get(conversationId)?.();
      await pendingTranscriptWrites.get(conversationId);
      return conversationOperations.deleteConversation(projectId, taskId, conversationId);
    },
    hydrateConversation: ({ projectId, taskId, conversationId, initialSize }) =>
      withAttachedProject(options.projects, projectId, async () => {
        await conversationOperations.hydrateConversation(
          projectId,
          taskId,
          conversationId,
          initialSize
        );
        return ok<void>();
      }),
    dehydrateConversation: ({ projectId, taskId, conversationId }) =>
      withAttachedProject(options.projects, projectId, async () => {
        await conversationOperations.dehydrateConversation(projectId, taskId, conversationId);
        return ok<void>();
      }),
    renameConversation: ({ conversationId, name }) =>
      conversationOperations.renameConversation(conversationId, name),
    getConversationsForTask: ({ projectId, taskId }) =>
      conversationOperations.getConversationsForTask(projectId, taskId),
    getConversationsForProject: ({ projectId }) =>
      conversationOperations.getConversationsForProject(projectId),
    listTranscripts: async ({ projectId, taskId }) => {
      const [task] = await options.db
        .select({ workspaceId: tasks.workspaceId })
        .from(tasks)
        .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)))
        .limit(1);
      const identity = task?.workspaceId
        ? await options.workspaceIdentity.resolve(task.workspaceId)
        : null;
      if (!identity) return [];
      return conversationOperations
        .listTranscripts(projectId)
        .filter((item) => item.workspacePath === identity.path);
    },
    getTranscript: async ({ projectId, taskId, conversationId }) => {
      const metadata = conversationOperations.getTranscript(projectId, conversationId);
      if (!metadata) return null;
      const [task] = await options.db
        .select({ workspaceId: tasks.workspaceId })
        .from(tasks)
        .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)))
        .limit(1);
      const identity = task?.workspaceId
        ? await options.workspaceIdentity.resolve(task.workspaceId)
        : null;
      if (!identity || metadata.workspacePath !== identity.path) return null;
      const runtimeTarget = await target(conversationId);
      if (runtimeTarget.projectId !== projectId || !runtimeTarget.workspacePath) return null;
      const content = await loadTranscript(options.db, options.runtimes, {
        conversationId,
        projectId,
        workspacePath: runtimeTarget.workspacePath,
        title: metadata.title,
        host: runtimeTarget.host,
      });
      return content === null ? metadata : { ...metadata, content };
    },
    markConversationSeen: ({ conversationId }) =>
      conversationOperations.markConversationSeen(conversationId),
    listHostConversations: (scope) => conversationOperations.listHostConversations(scope),
    linkConversationToTask: (input) => conversationOperations.linkConversationToTask(input),
    deleteHostConversation: async ({ conversationId }) => {
      transcriptObservers.get(conversationId)?.();
      await pendingTranscriptWrites.get(conversationId);
      return conversationOperations.deleteHostConversation(conversationId);
    },
    events: conversationWireEvents,
    acp: {
      setOption: (input, meta) =>
        configurationChanges.run(
          input.conversationId,
          meta.signal ?? new AbortController().signal,
          async () => {
            const runtimeTarget = await target(input.conversationId);
            return withConversationRuntime(
              options,
              Promise.resolve(runtimeTarget),
              async (client): ReturnType<ConversationsHostRuntimesClient['acp']['setOption']> => {
                const records = await client.conversations.records
                  .state(undefined, 'list')
                  .snapshot();
                const record = records.data[input.conversationId];
                if (!record) return acpErr.conversationNotFound(input.conversationId);
                const previous = providerOptionValuesSchema.parse(record.config.options ?? {})[
                  input.configId
                ];
                const persisted = await client.conversations.patchConfig({
                  conversationId: input.conversationId,
                  patch: {},
                  mapPatch: {
                    field: 'options',
                    entries: { [input.configId]: input.value },
                    expected: { [input.configId]: previous },
                  },
                });
                if (!persisted.success)
                  return acpErr.setConfigFailed({
                    name: 'PersistenceError',
                    message: persisted.error.message,
                  });
                if (persisted.data.skippedKeys.includes(input.configId))
                  return acpErr.setConfigFailed({
                    name: 'ConfigurationConflict',
                    message:
                      'This setting changed elsewhere. Select it again to apply your choice.',
                  });
                const restorePreviousOption = async () => {
                  const restored = await client.conversations.patchConfig({
                    conversationId: input.conversationId,
                    patch: {},
                    mapPatch: {
                      field: 'options',
                      entries: { [input.configId]: previous ?? null },
                      expected: { [input.configId]: input.value },
                    },
                  });
                  if (!restored.success)
                    throw new Error(
                      `Could not restore previous conversation setting: ${restored.error.message}`
                    );
                };
                let result: Awaited<ReturnType<typeof client.acp.setOption>>;
                try {
                  result = await client.acp.setOption(input, callOptions(meta));
                } catch (error) {
                  await restorePreviousOption();
                  throw error;
                }
                if (!result.success) {
                  await restorePreviousOption();
                  return result;
                }
                if (runtimeTarget.providerId) {
                  try {
                    await settings.patch(
                      {
                        host: formatHostRef(runtimeTarget.host),
                        providerId: runtimeTarget.providerId,
                      },
                      { transport: 'acp', options: { [input.configId]: input.value } }
                    );
                  } catch (error) {
                    return ok({
                      ...result.data,
                      preferenceSaveError: error instanceof Error ? error.message : String(error),
                    });
                  }
                }
                return result;
              }
            );
          }
        ),
      attach: async ({ conversationId }, meta) => {
        const runtimeTarget = await target(conversationId);
        const input = runtimeTarget.acpInput;
        if (!input) throw missingAcpInputError(runtimeTarget);
        return withConversationRuntime(options, Promise.resolve(runtimeTarget), async (client) => {
          const result = await client.acp.attach(input, callOptions(meta));
          if (result.success) void observeAcp(runtimeTarget, client).catch(logCaptureError);
          return result;
        });
      },
      startSession: async ({ conversationId, mode }, meta) => {
        const runtimeTarget = await target(conversationId);
        const input = runtimeTarget.acpInput;
        if (!input) throw missingAcpInputError(runtimeTarget);
        return withConversationRuntime(options, Promise.resolve(runtimeTarget), async (client) => {
          const result = await client.acp.startSession(
            { ...input, mode },
            { ...callOptions(meta), timeoutMs: 0 }
          );
          if (result.success) void observeAcp(runtimeTarget, client).catch(logCaptureError);
          return result;
        });
      },
      loadHistory: (input, meta) =>
        run(input.conversationId, async (client, runtimeTarget) => {
          const result = await client.acp.loadHistory(input, callOptions(meta));
          if (result.success && result.data.kind === 'available') {
            void captureAcp(runtimeTarget).catch((error) =>
              options.logger.warn('Could not capture ACP transcript', { error })
            );
          }
          return result;
        }),
      terminate: (input, meta) =>
        run(input.conversationId, async (client) => {
          const result = await client.acp.terminate(input, callOptions(meta));
          if (result.success) transcriptObservers.get(input.conversationId)?.();
          return result;
        }),
      sendPrompt: (input, meta) =>
        run(input.conversationId, (client) =>
          client.acp.sendPrompt(input, { ...callOptions(meta), timeoutMs: 0 })
        ),
      editQueuedPrompt: (input, meta) =>
        run(input.conversationId, (client) =>
          client.acp.editQueuedPrompt(input, callOptions(meta))
        ),
      deleteQueuedPrompt: (input, meta) =>
        run(input.conversationId, (client) =>
          client.acp.deleteQueuedPrompt(input, callOptions(meta))
        ),
      changeQueuePromptOrder: (input, meta) =>
        run(input.conversationId, (client) =>
          client.acp.changeQueuePromptOrder(input, callOptions(meta))
        ),
      cancelTurn: (input, meta) =>
        run(input.conversationId, (client) => client.acp.cancelTurn(input, callOptions(meta))),
      resolvePermission: (input, meta) =>
        run(input.conversationId, (client) =>
          client.acp.resolvePermission(input, callOptions(meta))
        ),
      exportAcpTranscript: (input, meta) =>
        run(input.conversationId, (client) =>
          client.acp.exportAcpTranscript(input, callOptions(meta))
        ),
      exportRawAcpLog: (input, meta) =>
        run(input.conversationId, (client) => client.acp.exportRawAcpLog(input, callOptions(meta))),
      sessions: acpSessions,
      session: acpSession,
      terminalOutput: async ({ conversationId, terminalId }) =>
        resolveConversationRuntimeSource(options, target(conversationId), (client) =>
          client.acp.terminalOutput.handle({ terminalId }).asLiveSource()
        ),
    },
    tui: {
      startSession: (input, meta) =>
        run(input.conversationId, async (client, runtimeTarget) => {
          const result = await client.tuiAgents.startSession(input, callOptions(meta));
          if (result.success) void observePty(runtimeTarget, client).catch(logCaptureError);
          return result;
        }),
      resume: (input, meta) =>
        run(input.conversationId, async (client, runtimeTarget) => {
          const result = await client.tuiAgents.resume(input, callOptions(meta));
          if (result.success) void observePty(runtimeTarget, client).catch(logCaptureError);
          return result;
        }),
      stop: (input, meta) =>
        run(input.conversationId, (client) => client.tuiAgents.stop(input, callOptions(meta))),
      delete: (input, meta) =>
        run(input.conversationId, async (client) => {
          const result = await client.tuiAgents.delete(input, callOptions(meta));
          if (result.success) transcriptObservers.get(input.conversationId)?.();
          return result;
        }),
      kill: (input, meta) =>
        run(input.conversationId, (client) => client.tuiAgents.kill(input, callOptions(meta))),
      sendInput: async (input, meta) => {
        const runtimeTarget = await target(input.conversationId);
        return withConversationRuntime(options, Promise.resolve(runtimeTarget), async (client) => {
          const result = await client.tuiAgents.sendInput(input, callOptions(meta));
          if (result.success && input.data.includes('\r')) {
            await hooks.recordTuiInput(runtimeTarget);
          }
          return result;
        });
      },
      resize: (input, meta) =>
        run(input.conversationId, (client) => client.tuiAgents.resize(input, callOptions(meta))),
      output: async ({ conversationId }) => {
        const runtimeTarget = await target(conversationId);
        return resolveConversationRuntimeSource(
          options,
          Promise.resolve(runtimeTarget),
          (client) => {
            void observePty(runtimeTarget, client).catch(logCaptureError);
            return client.tuiAgents.output.handle({ conversationId }).asLiveSource();
          }
        );
      },
      sessions: tuiSessions,
    },
  });
}

function createDefaultRuntimeHooks(
  options: Pick<CreateConversationsWireControllerOptions, 'telemetry'>
): ConversationRuntimeHooks {
  const { telemetry } = options;
  return {
    // Recency is a host fact now: the runtime's activity report feeds
    // `lastSessionActivityAt` and convergence caches it — only telemetry stays client-side.
    async recordTuiInput(target) {
      if (target.providerId) {
        telemetry.capture('agent_run_started', {
          provider: target.providerId,
          project_id: target.projectId,
          task_id: target.taskId,
          conversation_id: target.conversationId,
        });
      }
    },
  };
}

function missingAcpInputError(target: ConversationRuntimeTarget): Error {
  if (target.conversationType === 'acp' && !target.workspacePath) {
    return new Error(
      `Workspace for conversation '${target.conversationId}' is not provisioned yet`
    );
  }
  return new Error(`Conversation '${target.conversationId}' is not an ACP conversation`);
}

async function resolveConversationRuntimeTarget(
  conversationId: string,
  workspaceIdentity: WorkspaceIdentityResolver,
  db: AppDb,
  getProviderEnv: ((providerId: string) => Promise<Record<string, string> | undefined>) | undefined,
  sessionLaunchContexts: Pick<TaskSessionLaunchContextResolver, 'resolve'>
): Promise<ConversationRuntimeTarget> {
  const [row] = await db
    .select({
      projectId: conversations.projectId,
      taskId: conversations.taskId,
      providerId: conversations.provider,
      sessionId: conversations.providerSessionId,
      config: conversations.config,
      title: conversations.title,
      type: conversations.type,
      workspaceId: tasks.workspaceId,
    })
    .from(conversations)
    .leftJoin(
      tasks,
      and(eq(tasks.id, conversations.taskId), eq(tasks.projectId, conversations.projectId))
    )
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!row) throw new Error(`Conversation '${conversationId}' was not found`);
  if (row.projectId === null || row.taskId === null) {
    // Sessions run inside task surfaces; unlinked mirror rows have no runtime target.
    throw new Error(`Conversation '${conversationId}' has no task link`);
  }

  const identity = row.workspaceId ? await workspaceIdentity.resolve(row.workspaceId) : null;
  const acpConfig = row.config?.type === 'acp' ? row.config : undefined;
  // The runtime owns consumption. A provider pointer alone does not prove dispatch.
  const initialQueue = acpConfig?.initialQueue?.length ? acpConfig.initialQueue : undefined;
  const workspacePath = identity?.path;
  // Resolve the ACP agent environment in main from provider and project/task settings. The
  // renderer supplies only a conversation id and cannot inject spawn variables.
  const [providerEnv, launchContext] = await Promise.all([
    row.providerId && getProviderEnv ? getProviderEnv(row.providerId) : undefined,
    row.type === 'acp' && workspacePath
      ? sessionLaunchContexts.resolve({
          projectId: row.projectId,
          taskId: row.taskId,
          ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
        })
      : undefined,
  ]);
  if (launchContext && !launchContext.success) {
    throw new Error(`Could not resolve task session launch context: ${launchContext.error.type}`);
  }
  const processEnv = {
    ...(providerEnv ?? {}),
    ...(launchContext?.success ? launchContext.data.env : {}),
  };
  const acpInput =
    row.type === 'acp' && workspacePath && row.providerId
      ? {
          conversationId,
          providerId: row.providerId,
          cwd: workspacePath,
          sessionId: row.sessionId,
          options: acpConfig?.options,
          ...(initialQueue && { initialQueue }),
          ...(Object.keys(processEnv).length > 0 ? { env: processEnv } : {}),
        }
      : undefined;

  return {
    conversationId,
    projectId: row.projectId,
    taskId: row.taskId,
    conversationType: row.type === 'acp' ? 'acp' : 'pty',
    title: row.title,
    providerId: row.providerId,
    sessionId: row.sessionId,
    workspacePath,
    host: identity?.host ?? LOCAL_HOST_REF,
    acpInput,
  };
}

async function withConversationRuntime<T, E>(
  options: Pick<CreateConversationsWireControllerOptions, 'projects' | 'runtimes'>,
  targetPromise: Promise<ConversationRuntimeTarget>,
  work: (
    client: ConversationsHostRuntimesClient,
    target: ConversationRuntimeTarget
  ) => Promise<Result<T, E>>
): Promise<Result<T, E | RuntimeResolveError | ProjectAttachmentError>> {
  const target = await targetPromise;
  return withAttachedProject(options.projects, target.projectId, async () => {
    const result = await options.runtimes.client(target.host);
    if (!result.success) return err(result.error);
    return await work(result.data, target);
  });
}

function callOptions(meta: CallMeta): { signal?: AbortSignal } {
  return meta.signal ? { signal: meta.signal } : {};
}

async function resolveConversationRuntimeSource(
  options: Pick<CreateConversationsWireControllerOptions, 'projects' | 'runtimes'>,
  targetPromise: Promise<ConversationRuntimeTarget>,
  source: (client: ConversationsHostRuntimesClient) => LiveSource
): Promise<LiveSource> {
  const target = await targetPromise;
  return resolveProjectRuntimeSource(
    options,
    target.projectId,
    Promise.resolve(target.host),
    source
  );
}

async function resolveProjectRuntimeSource(
  options: Pick<CreateConversationsWireControllerOptions, 'projects' | 'runtimes'>,
  projectId: string,
  hostPromise: Promise<HostRef>,
  source: (client: ConversationsHostRuntimesClient) => LiveSource
): Promise<LiveSource> {
  requireAttachedProjectOrThrow(options.projects, projectId);
  return resolveRuntimeSource(options.runtimes, hostPromise, source);
}

async function resolveRuntimeSource(
  runtimes: ConversationsRuntimeBroker,
  hostPromise: Promise<HostRef>,
  source: (client: ConversationsHostRuntimesClient) => LiveSource
): Promise<LiveSource> {
  const result = await runtimes.client(await hostPromise);
  if (!result.success) throwConversationsRuntimeResolveError(result.error);
  return source(result.data);
}

async function openAttachmentDownload(
  options: Pick<CreateConversationsWireControllerOptions, 'projects' | 'runtimes'>,
  targetPromise: Promise<ConversationRuntimeTarget>,
  attachmentId: string,
  call: { signal?: AbortSignal }
) {
  const target = await targetPromise;
  return withAttachedProject(options.projects, target.projectId, async () => {
    const runtime = await options.runtimes.client(target.host);
    if (!runtime.success) return err(runtime.error);
    const result = await runtime.data.conversations.attachments.download(
      { conversationId: target.conversationId, attachmentId },
      call
    );
    if (!result.success) return result;
    return {
      success: true as const,
      data: { meta: result.data.meta, source: result.data.chunks() },
    };
  });
}
