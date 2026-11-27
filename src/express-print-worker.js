import {Worker} from 'node:worker_threads';

/** Native conversion and bounded pixel/deflate work stay off the HTTP event loop. */
export function renderExpressPrintInWorker(source,file,request) {
 return new Promise((resolve,reject)=>{
  const worker=new Worker(new URL('./express-print-thread.js',import.meta.url),{
   workerData:{source,request,file:{detectedContentType:file.detectedContentType,detected:file.detected?{widthMilli:file.detected.widthMilli,heightMilli:file.detected.heightMilli}:null}},
   env:{PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8'},execArgv:[],resourceLimits:{maxOldGenerationSizeMb:512},
  });
  let settled=false;
  const fail=code=>{if(!settled){settled=true;reject(Object.assign(new Error(code),{code,status:422}));}};
  worker.once('message',result=>{
   if(result.error)return fail(/^colour_[a-z_]+$/.test(result.error)?result.error:'colour_print_worker_failed');
   if(!Array.isArray(result.pages)||!(result.bytes instanceof Uint8Array)||result.bytes.length>64*1024*1024)return fail('colour_print_worker_failed');
   settled=true;resolve({pages:result.pages,bytes:Buffer.from(result.bytes)});
  });
  worker.once('error',()=>fail('colour_print_worker_failed'));
  worker.once('exit',()=>{if(!settled)fail('colour_print_worker_failed');});
 });
}
