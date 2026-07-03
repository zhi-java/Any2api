import { startServer } from './server.js';

const DESKTOP_HOST = '127.0.0.1';
const READY_PREFIX = 'ZHI2API_READY:';

startServer({
  port: Number(process.env.PORT || 0),
  host: process.env.HOST || DESKTOP_HOST,
  startupLogs: true,
})
  .then(service => {
    process.stdout.write(`${READY_PREFIX}${service.port}\n`);
  })
  .catch(error => {
    console.error('Failed to start zhi2Api desktop service:', error);
    process.exit(1);
  });
