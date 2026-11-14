import { parentPort, workerData } from 'node:worker_threads';
import { createLogger } from '../logger.ts';
import { serveIngest } from './core.ts';
import type { IngestBoot, Port } from './protocol.ts';

/*
 * Entry point of the ingest worker thread. Upstream feeds, the pipeline and
 * the detectors run here, so a burst of BGP updates (or a 50x replay) uses
 * this thread's CPU and never delays the main thread's HTTP and Socket.IO work.
 */
if (!parentPort) throw new Error('worker.ts must run as a worker thread');

const { config } = workerData as IngestBoot;
const log = createLogger(config).child({ thread: 'ingest' });
serveIngest(parentPort as unknown as Port, { config, log });
