import { loadConfig, secrets } from './config.ts';
import { createProvider } from './adapters/index.ts';
import { createGateway } from './server.ts';
import { State } from './state.ts';
import { resolve } from 'node:path';
const index = process.argv.indexOf('--config');
const file = index >= 0 ? process.argv[index + 1] : 'config.local.json';
if (!file) {
  console.error('--config requires a path');
  process.exitCode = 1;
} else {
  try {
    const config = await loadConfig(resolve(file));
    const keys = secrets(config);
    const providers = config.providers.map(createProvider);
    const state = new State(config.statePath);
    const server = createGateway({ ...config, ...keys, providers, state });
    server.on('error', () => {
      console.error('Gateway listener failed; check host and port');
      state.close();
      process.exitCode = 1;
    });
    server.listen(config.port, config.host, () => {
      console.log(
        'Gateway listening on http://' +
          (config.host.includes(':') ? '[' + config.host + ']' : config.host) +
          ':' +
          config.port +
          '/v1',
      );
      console.log(
        'Mode: ' +
          (config.demoMode
            ? 'demo fixtures'
            : 'subscriptions; account-level verification required'),
      );
    });
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      server.close(() => {
        state.close();
      });
      server.closeIdleConnections();
      setTimeout(() => server.closeAllConnections(), 2000).unref();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Gateway startup failed');
    process.exitCode = 1;
  }
}
