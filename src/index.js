import { startServer } from './server.js';

startServer().catch(error => {
  console.error('Failed to start zhi2Api:', error);
  process.exit(1);
});
