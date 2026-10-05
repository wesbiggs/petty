import { parentPort, workerData } from 'node:worker_threads';
import { prepareJob } from './prepare.js';

try {
  const target = prepareJob(workerData.job, workerData.options);
  parentPort.postMessage({ target }, [target.buffer]);
} catch (e) {
  parentPort.postMessage({ error: e.message });
}
