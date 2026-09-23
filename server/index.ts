import 'dotenv/config';
import { createApp } from './app.js';
import { loadCatalog, type Catalog } from './catalog.js';

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT');
let catalog: Catalog | null = null;
try { catalog = loadCatalog(process.env.DATASET_PATH || 'data/vendors.csv'); }
catch { console.error('Dataset unavailable: check DATASET_PATH and CSV format.'); }
const server = createApp(catalog).listen(port, () => console.log(`Firebird server listening on port ${port}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { server.close(() => process.exit(0)); });
