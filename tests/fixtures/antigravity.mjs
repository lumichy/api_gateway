import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log(process.env.GATEWAY_FIXTURE_AGY_VERSION ?? '1.3.2');
  process.exit(0);
}
const value = (name) => args[args.indexOf(name) + 1];
const agent = value('--agent');
const definition = await readFile(join(process.cwd(), '.agents/agents', agent, 'agent.md'), 'utf8');
if (
  !definition.includes('tools: []\n') ||
  !definition.includes('mcpServers: []\n') ||
  !args.includes('--disable-slash-commands') ||
  args.includes('--dangerously-skip-permissions') ||
  args.includes('--continue')
)
  process.exit(2);
let input = '';
for await (const chunk of process.stdin) input += chunk;
const user = JSON.parse(input).message.content;
const emit = (e) => console.log(JSON.stringify(e));
if (user === 'WAIT') {
  setTimeout(() => {}, 10000);
} else {
  if (user !== 'NO_INIT')
    emit({
      event: 'init',
      init: {
        model: user === 'WRONG_MODEL' ? 'other' : value('--model'),
        agent,
        cwd: process.cwd(),
        tools: ['view_file', 'run_command'],
        permission_mode: 'request-review',
      },
    });
  if (user === 'TOOL')
    emit({ event: 'step_update', step_update: { step_type: 'tool', tool_name: 'view_file' } });
  if (user === 'SUBAGENT')
    emit({
      event: 'step_update',
      step_update: { step_type: 'checkpoint', subagent_info: { subagents: [] } },
    });
  if (user === 'OVERSIZE') console.log('x'.repeat(1048577));
  let text = user === 'SYSTEM_REPORT' ? definition.split('\n---\n').slice(1).join('\n---\n') : user;
  if (user === 'EMPTY') text = '';
  if (user === 'STREAM' || user === 'DIVERGE') {
    text = '你好\n';
    emit({
      event: 'step_update',
      step_update: {
        step_type: 'agent_response',
        text_delta: user === 'DIVERGE' ? 'wrong' : '你',
        state: 'ACTIVE',
      },
    });
  }
  const status = ['QUOTA', 'AUTH', 'RATE', 'FAILED'].includes(user) ? 'ERROR' : 'SUCCESS';
  emit({
    event: 'result',
    result: {
      status,
      response: text,
      num_turns: 1,
      error:
        status === 'ERROR'
          ? {
              QUOTA: 'quota exhausted',
              AUTH: 'authentication required',
              RATE: 'rate limit reached',
              FAILED: 'secret-token-123 transport failed',
            }[user]
          : undefined,
      usage:
        user === 'BAD_USAGE'
          ? { input_tokens: -1, output_tokens: 1, total_tokens: 0 }
          : { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    },
  });
  if (user === 'TRAILING') emit({ event: 'step_update', step_update: { step_type: 'tool' } });
  if (user === 'EXIT_BAD') {
    console.error('quota exhausted');
    process.exitCode = 1;
  }
}
