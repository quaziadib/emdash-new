import { formatHostRef } from '@emdash/core/primitives/host/api';
import { Button, Dialog, Field, Switch } from '@emdash/ui/react/primitives';
import { X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useRef, useState } from 'react';
import { hostRefFromConnectionId } from '@core/features/agents/api/browser/client';
import { useAgents } from '@core/features/agents/api/browser/use-agents';
import { AgentSelector } from '@core/features/agents/contributions/browser/agent-selector';
import { getConversationsClient } from '@core/features/conversations/api/browser/client';
import { nextDefaultConversationTitle } from '@core/features/conversations/api/browser/conversation-title-utils';
import { readProviderSettings } from '@core/features/conversations/api/browser/provider-preferences';
import { conversationRegistry } from '@core/features/conversations/api/browser/stores/conversation-registry';
import { useConversationLaunchSettings } from '@core/features/conversations/api/browser/use-conversation-launch-settings';
import { useEffectiveProvider } from '@core/features/conversations/api/browser/use-effective-provider';
import { ConversationTransportToggle } from '@core/features/conversations/contributions/browser/conversation-transport-toggle';
import { getProjectSshConnectionId } from '@core/features/projects/api/browser/stores/project-selectors';
import { useModalController } from '@core/manifests/browser/modal-api';
import { projectAvailabilityUi } from '@core/manifests/browser/project-availability-ui';
import {
  agentSupportsAcp,
  agentSupportsAutoApprove,
  agentSupportsInitialPromptDelivery,
} from '@core/primitives/agents/api';
import type { ConversationTranscript, ConversationType } from '@core/primitives/conversations/api';
import { ConfirmButton } from '@core/primitives/keybindings/browser/confirm-button';
import { defineModal } from '@core/primitives/modals/react';
import { useCloseGuard } from '@core/primitives/modals/react/use-close-guard';
import {
  buildTranscriptContinuation,
  transcriptSelectionError,
  type TranscriptSelection,
} from './transcript-continuation';

export const CreateConversationModal = observer(function CreateConversationModal({
  projectId,
  taskId,
}: {
  projectId: string;
  taskId: string;
}) {
  const { complete } = useModalController('createConversationModal');
  const connectionId = getProjectSshConnectionId(projectId);
  const { providerId, setProviderOverride, createDisabled } = useEffectiveProvider(connectionId);
  const conversationMgr = conversationRegistry.get(taskId);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<TranscriptSelection[]>([]);
  const [availableTranscripts, setAvailableTranscripts] = useState<ConversationTranscript[]>([]);
  const transcriptInputRef = useRef<HTMLInputElement | null>(null);
  const liveActionDisabledReason = projectAvailabilityUi.getLiveActionDisabledReason(projectId);
  useCloseGuard(isSubmitting);

  useEffect(() => {
    let disposed = false;
    void getConversationsClient()
      .then((client) => client.listTranscripts({ projectId, taskId }))
      .then((items) => {
        if (!disposed) setAvailableTranscripts(items);
      })
      .catch(() => {
        if (!disposed) setAvailableTranscripts([]);
      });
    return () => {
      disposed = true;
    };
  }, [projectId, taskId]);

  const { data: agents } = useAgents(hostRefFromConnectionId(connectionId));
  const selectedAgent = agents?.find((a) => a.id === providerId);
  const host = formatHostRef(hostRefFromConnectionId(connectionId));
  const launchSettings = useConversationLaunchSettings(
    host,
    providerId,
    selectedAgent?.capabilities
  );
  const showAcpToggle = agentSupportsAcp(selectedAgent?.capabilities);
  const useAcp = showAcpToggle && launchSettings.useChatUi;
  const transport = useAcp ? 'acp' : 'pty';
  const showAutoApproveToggle = agentSupportsAutoApprove(selectedAgent?.capabilities, transport);
  const skipPermissions = showAutoApproveToggle && launchSettings.autoApprove;
  const canDeliverTranscript =
    useAcp || agentSupportsInitialPromptDelivery(selectedAgent?.capabilities);
  const transcriptBlocked = transcripts.length > 0 && !canDeliverTranscript;
  const title = providerId
    ? nextDefaultConversationTitle(
        providerId,
        Array.from(
          conversationMgr?.conversations.values() ?? [],
          (conversation) => conversation.data
        )
      )
    : 'Conversation';

  const handleProviderChange = useCallback(
    (next: typeof providerId) => {
      setProviderOverride(next);
    },
    [setProviderOverride]
  );

  const handleTranscriptChange = useCallback(async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    const selectionError = transcriptSelectionError(file.name, text);
    if (selectionError) {
      setTranscripts([]);
      setError(selectionError);
      return;
    }
    setError(null);
    setTranscripts((current) => [
      ...current.filter((selection) => selection.name !== file.name),
      { name: file.name, text: text.trim() },
    ]);
  }, []);

  const handleCreateConversation = useCallback(async () => {
    if (
      liveActionDisabledReason ||
      createDisabled ||
      !launchSettings.ready ||
      isSubmitting ||
      !conversationMgr ||
      !providerId ||
      transcriptBlocked
    ) {
      return;
    }
    const id = crypto.randomUUID();
    setIsSubmitting(true);
    setError(null);
    try {
      const settings = await readProviderSettings({ host, providerId });
      const conversationType: ConversationType = useAcp ? 'acp' : 'pty';
      const continuation = transcripts.length
        ? buildTranscriptContinuation(transcripts, conversationType)
        : null;
      await conversationMgr.createConversation({
        projectId,
        taskId,
        id,
        autoApprove: showAutoApproveToggle && settings.pty.autoApprove,
        provider: providerId,
        title,
        options: conversationType === 'acp' ? settings.acp.options : undefined,
        type: conversationType,
        ...(continuation?.type === 'acp' ? { initialQueue: continuation.initialQueue } : {}),
        ...(continuation?.type === 'pty' ? { initialPrompt: continuation.initialPrompt } : {}),
      });
      setIsSubmitting(false);
      complete({ conversationId: id, type: conversationType });
    } catch {
      setError('Failed to create conversation');
      setIsSubmitting(false);
    }
  }, [
    conversationMgr,
    liveActionDisabledReason,
    createDisabled,
    launchSettings.ready,
    isSubmitting,
    providerId,
    title,
    complete,
    projectId,
    taskId,
    showAutoApproveToggle,
    useAcp,
    host,
    transcripts,
    transcriptBlocked,
  ]);

  return (
    <>
      <Dialog.Header>
        <Dialog.Title>Create Conversation</Dialog.Title>
      </Dialog.Header>
      <Dialog.Body>
        <Field.Group>
          <Field.Root>
            <AgentSelector
              autoFocus
              value={providerId}
              onChange={handleProviderChange}
              connectionId={connectionId}
              trailingControl={
                showAcpToggle ? (
                  <ConversationTransportToggle
                    value={transport}
                    disabled={!launchSettings.ready || isSubmitting}
                    onValueChange={(value) => launchSettings.setUseChatUi(value === 'acp')}
                  />
                ) : null
              }
            />
          </Field.Root>
          {showAutoApproveToggle ? (
            <Field.Root>
              <div className="flex items-center gap-2">
                <Switch
                  checked={skipPermissions}
                  disabled={!providerId || !launchSettings.ready || isSubmitting}
                  onCheckedChange={launchSettings.setAutoApprove}
                />
                <Field.Label>Auto-approve permissions</Field.Label>
              </div>
            </Field.Root>
          ) : null}
          <Field.Root>
            <Field.Label>Previous transcript</Field.Label>
            {availableTranscripts.length ? (
              <div className="flex flex-col gap-1">
                {availableTranscripts.map((item) => {
                  const selected = transcripts.some((entry) => entry.name === item.title);
                  return (
                    <Button
                      key={item.conversationId}
                      type="button"
                      variant={selected ? 'primary' : 'secondary'}
                      size="sm"
                      disabled={isSubmitting}
                      onClick={() => {
                        void getConversationsClient()
                          .then((client) =>
                            client.getTranscript({
                              projectId,
                              taskId,
                              conversationId: item.conversationId,
                            })
                          )
                          .then((transcript) => {
                            if (!transcript?.content) {
                              setError(`Transcript unavailable: ${item.title}`);
                              return;
                            }
                            setTranscripts((current) =>
                              selected
                                ? current.filter((entry) => entry.name !== item.title)
                                : [...current, { name: item.title, text: transcript.content! }]
                            );
                          })
                          .catch(() => setError(`Transcript unavailable: ${item.title}`));
                      }}
                    >
                      {item.title}
                    </Button>
                  );
                })}
              </div>
            ) : null}
            <div className="flex min-w-0 items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={isSubmitting}
                onClick={() => transcriptInputRef.current?.click()}
              >
                <span className="max-w-64 truncate">
                  {transcripts.length
                    ? `${transcripts.length} transcript(s) selected`
                    : 'Select markdown'}
                </span>
              </Button>
              {transcripts.length ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  icon
                  aria-label="Clear transcript"
                  disabled={isSubmitting}
                  onClick={() => {
                    setTranscripts([]);
                    setError(null);
                  }}
                >
                  <X className="size-3.5" />
                </Button>
              ) : null}
            </div>
            <input
              ref={transcriptInputRef}
              type="file"
              accept=".md,.markdown,text/markdown"
              multiple
              className="hidden"
              disabled={isSubmitting}
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                event.target.value = '';
                void Promise.all(files.map((file) => handleTranscriptChange(file)));
              }}
            />
            <Field.Description>
              Optional. A markdown transcript gives this new chat or terminal the previous agent's
              context so it can continue that work.
            </Field.Description>
            {transcriptBlocked ? (
              <Field.Description>
                This agent cannot take an initial prompt in terminal mode. Switch to Chat UI, or
                clear the transcript.
              </Field.Description>
            ) : null}
          </Field.Root>
          {error && <p className="text-destructive text-xs">{error}</p>}
          {liveActionDisabledReason && (
            <p className="text-xs text-foreground-muted" role="note" tabIndex={0}>
              {liveActionDisabledReason}
            </p>
          )}
        </Field.Group>
      </Dialog.Body>
      <Dialog.Footer>
        <ConfirmButton
          variant="primary"
          onClick={() => void handleCreateConversation()}
          disabled={
            Boolean(liveActionDisabledReason) ||
            createDisabled ||
            !launchSettings.ready ||
            isSubmitting ||
            transcriptBlocked
          }
        >
          {isSubmitting ? 'Creating...' : 'Create'}
        </ConfirmButton>
      </Dialog.Footer>
    </>
  );
});

export const createConversationModal = defineModal<{
  conversationId: string;
  type: ConversationType;
}>()({
  id: 'createConversationModal',
  component: CreateConversationModal,
  ignoreOutsidePressAfterWindowBlur: true,
});
