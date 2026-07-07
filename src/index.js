import { startServer } from './server.js';

startServer().catch(error => {
  console.error('Failed to start OmniAPI:', error);
  process.exit(1);
});
