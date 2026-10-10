import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayError } from '../errors.ts';
import type { ChatRequest, ProviderEvent } from '../types.ts';
import type { ProviderConfig } from './index.ts';
import { checkAbort } from './http.ts';
import { processLines, validateBootstrap, cleanupTemporaryDirectory } from './subprocess.ts';
import { printCliInvoke, printCliArgs } from './cli-stream.ts';

// CodeBuddy 2.161.0 emits a default-agent init before selecting the text agent,
// then injects collaboration tools even for tools:[]. Deny the observed catalog
// by separate names; its whole-tool parser does not expand '*' or commas.
const codeBuddyDeniedTools =
  'Agent Read Write Edit Bash PowerShell Glob Grep EnterPlanMode ExitPlanMode TaskCreate TaskGet TaskUpdate TaskList WebFetch WebSearch TaskStop TaskOutput Skill SkillManage AskUserQuestion AskUserForStructuredInput StructuredOutput ToolSearch DeferExecuteTool SendMessage SendUserMessage TeamCreate TeamDelete NotebookEdit LSP ImageGen LibraryUpload VideoGen AudioTranscribe Artifact ArtifactControl EnterWorktree LeaveWorktree CronCreate CronDelete CronList WeChatReply WeComReply PushNotification ReportFindings ComputerUse ListMcpResources ReadMcpResource WaitForMcpServers Workflow Monitor REPL A2AGetAgentCard A2ASendMessage A2AGetTask A2ACancelTask MessageColleague SpeakInChannel ChannelTasks CreateColleague CreateChannel ListColleagues'.split(
    ' ',
  );
export function codeBuddyTextFlags(system?: string): string[] {
  return [
    '--agents',
    JSON.stringify({
      'gateway-text': {
        description: 'Text-only gateway',
        prompt: system ?? 'You are a helpful assistant. Answer the user directly.',
        tools: [],
        mcpServers: [],
      },
    }),
    '--agent',
    'gateway-text',
    '--disallowedTools',
    ...codeBuddyDeniedTools,
  ];
}
export async function codebuddyHealth(config: ProviderConfig, signal: AbortSignal) {
  validateBootstrap(config);
  checkAbort(signal);
  const directory = await mkdtemp(join(tmpdir(), 'gateway-health-'));
  let healthBytes = 0;
  const addHealth = (line: string) => {
    healthBytes += Buffer.byteLength(line, 'utf8') + 1;
    if (healthBytes > 65536)
      throw new GatewayError('transient', 'CLI health output limit exceeded');
  };
  try {
    for await (const _line of processLines(
      config.command ?? 'codebuddy',
      [...(config.args ?? []), '--version'],
      '',
      directory,
      signal,
    )) {
      addHealth(_line);
    }
    return {
      available: true,
      detail: 'CodeBuddy CLI executable present; subscription login and billing must be verified',
    };
  } catch (e) {
    checkAbort(signal);
    return {
      available: false,
      detail:
        e instanceof GatewayError && e.message === 'CLI health output limit exceeded'
          ? e.message
          : 'Official CLI authentication status unavailable',
    };
  } finally {
    await cleanupTemporaryDirectory(directory);
  }
}

export async function* codebuddyInvoke(
  config: ProviderConfig,
  request: ChatRequest,
  signal: AbortSignal,
): AsyncGenerator<ProviderEvent> {
  yield* printCliInvoke(config, request, signal, {
    command: config.command ?? 'codebuddy',
    args: (system) => [
      ...(config.args ?? []),
      ...printCliArgs(request.model),
      '--setting-sources',
      '',
      '--settings',
      '{"disableAllHooks":true}',
      ...codeBuddyTextFlags(system),
    ],
  });
}
