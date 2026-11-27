import {parentPort,workerData} from 'node:worker_threads';
import {renderExpressPrint} from './express-print-renderer.js';

try {
 const result=await renderExpressPrint(workerData.source,workerData.file,workerData.request);
 parentPort.postMessage(result);
} catch(error) {
 parentPort.postMessage({error:/^colour_[a-z_]+$/.test(error.code||'')?error.code:'colour_print_worker_failed'});
} finally {parentPort.close();}
