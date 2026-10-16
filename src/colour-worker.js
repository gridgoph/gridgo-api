import { artworkFileIdsFor } from './artwork-attachments.js';
import { lockCartFeeSchedules } from './order-match-routes.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DOMAIN_MUTATION_LOCK } from './database.js';
import { renderColourAnalysis, COLOUR_MAX_SOURCE } from './colour-renderer.js';
import { colourPriceChecks } from './colour-analysis.js';
import { privilegedAdminMemberships, queueInvalidate } from './notifications.js';

// One bounded job at a time across replicas; renderer lock is independent of
// the domain lock, so uploads, orders and payments proceed during conversion.
// Pending records survive crashes and are picked up at startup/lifecycle tick.
export function createColourWorker({database,load,save,storage,render=renderColourAnalysis,now=()=>new Date().toISOString(),id=()=>crypto.randomUUID()}) {
  let busy = false;
  return async function drain() {
    if (busy) return;
    busy = true;
    try {
      await database.transaction(async () => {
        if (!(await database.query("SELECT pg_try_advisory_xact_lock(hashtext('gridgo-colour-renderer')) AS locked")).rows[0].locked) return;
        const store = await load();
        const file = store.files.find(file => file.state === 'ready' && !file.deleteRequestedAt && file.colourAnalyses?.some(job => job.status === 'pending'));
        const job = file?.colourAnalyses.find(job => job.status === 'pending');
        if (!job) return;
        const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(),'gridgo-colour-source-'));
        let pages, errorCode;
        try {
          if (file.size > COLOUR_MAX_SOURCE) throw Object.assign(new Error(),{code:'colour_source_too_large'});
          if ((await storage.statObject(file.objectKey)).size !== file.size) throw Object.assign(new Error(),{code:'colour_source_mismatch'});
          const input = path.join(directory,'source');
          let size = 0;
          const limit = new Transform({transform(chunk,encoding,callback) {size+=chunk.length;callback(size > file.size || size > COLOUR_MAX_SOURCE ? new Error('source_limit') : null,chunk);}});
          await pipeline(await storage.getObject(file.objectKey),limit,fs.createWriteStream(input,{mode:0o600}),{signal:AbortSignal.timeout(30000)});
          if (size !== file.size) throw Object.assign(new Error(),{code:'colour_source_mismatch'});
          pages = await render(input,file,job.request);
        } catch (error) {errorCode = /^colour_[a-z_]+$/.test(error.code || '') ? error.code : 'colour_detection_failed';}
        finally {await fs.promises.rm(directory,{recursive:true,force:true});}
        await database.query('SELECT pg_advisory_xact_lock(hashtext($1))',[DOMAIN_MUTATION_LOCK]);
        const latest = await load();
        const current = latest.files.find(row => row.fileId === file.fileId && row.state === 'ready' && !row.deleteRequestedAt && row.objectKey === file.objectKey);
        const pending = current?.colourAnalyses.find(row => row.key === job.key && row.status === 'pending');
        if (!pending) return;
        Object.assign(pending,{status:errorCode?'failed':'ready',completedAt:now(),...(errorCode?{error:errorCode}:{pages})});
        if (!errorCode && current.detected && job.request.layout === 'source') current.detected.pageCount = pages.length;
        const checks = colourPriceChecks(latest).filter(check => check.colourPricing.pages.some(page => page.fileId === current.fileId && page.analysisKey === job.key));
        if (checks.length && !pending.opsNoticeQueuedAt) {
          pending.opsNoticeQueuedAt = now();
          for (const recipient of privilegedAdminMemberships(latest)) {
            latest.notifications.push({id:id('ntf'),userId:recipient.userId,appRole:recipient.role,type:'colour_price_check',title:'Artwork needs a shop price',body:'A document page has no shop-set colour tier price. Review the colour price check queue.',read:false,at:now()});
            queueInvalidate(latest,{resource:'notifications',userIds:[recipient.userId]});
          }
        }
        for (const cart of latest.carts.filter(cart => cart.state === 'draft' && latest.cartLines.some(line => line.cartId === cart.id && artworkFileIdsFor(line).includes(current.fileId)))) {
          lockCartFeeSchedules(latest,cart,now());
          queueInvalidate(latest,{resource:'carts',id:cart.id,clientId:cart.clientId});
        }
        await save(latest);
      },{lockKey:'gridgo-colour-drain'});
    } finally {busy=false;}
  };
}
