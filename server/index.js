import { loadConfig } from './config.js';
import { RunaiClient } from './runai-client.js';
import { createMockRunai } from './mock-runai.js';
import { ClusterManager } from './service.js';
import { createApp } from './server.js';

const log = (o) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));

const config = loadConfig();
let client;
if (config.mock) {
  const mock = createMockRunai();
  client = new RunaiClient({ baseUrl: 'http://mock.runai.local', ...mock.credentials, fetchImpl: mock.fetch });
  log({ event: 'mock_mode', note: 'Using the built-in fake Run:ai API; no real cluster is contacted' });
} else {
  client = new RunaiClient({
    baseUrl: `https://${config.controlPlane}`,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    timeoutMs: config.requestTimeoutMs,
  });
}

const manager = new ClusterManager({ client, config, log });
const server = createApp({ manager, config, log });
server.listen(config.port, () => log({ event: 'listening', port: config.port, controlPlane: config.controlPlane || 'mock', auth: config.uiUser ? 'basic' : 'none' }));

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
