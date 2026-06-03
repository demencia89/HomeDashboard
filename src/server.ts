import { HOST, PORT } from './config.js';
import { buildApp } from './app.js';

const app = await buildApp();

try {
  await app.listen({ host: HOST, port: PORT });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
