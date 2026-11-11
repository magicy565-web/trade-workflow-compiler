#!/usr/bin/env node
// Delivers an ACTUAL event file to a configured trusted gateway ingress. No sample event is created.
import { readFileSync } from 'node:fs';
import { webhookSignature, eventInputSchema, validateEvent } from '../dist/events.js';
import { assertSchema } from '../dist/schema.js';
import { secureUrl, boundedJson } from '../dist/util.js';
const [endpoint,file,secretEnv]=process.argv.slice(2);
try {
  if(!endpoint||!file||!secretEnv||process.argv.length!==5) throw Error('Usage: node --env-file-if-exists=.env scripts/send-event.mjs https://host/api/webhooks/SOURCE actual-event.json SECRET_ENV_NAME');
  if(!/^[A-Z][A-Z0-9_]*$/.test(secretEnv)) throw Error('Invalid secret environment variable name');
  const url=secureUrl(endpoint),source=url.pathname.match(/^\/api\/webhooks\/([a-zA-Z0-9_-]{1,80})$/)?.[1];
  if(!source||url.search)throw Error('Use the exact webhook URL, without a query string');
  const secret=process.env[secretEnv];if(!secret||Buffer.byteLength(secret)<32)throw Error('Missing or too-short webhook secret');
  const raw=readFileSync(file);if(raw.length>1048576)throw Error('Event exceeds 1 MB');const event=JSON.parse(raw.toString('utf8'));assertSchema(eventInputSchema,event);validateEvent(event);
  const timestamp=String(Math.floor(Date.now()/1000));
  const response=await fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'content-type':'application/json','x-twc-timestamp':timestamp,'x-twc-signature':'sha256='+webhookSignature(secret,source,timestamp,raw)},body:raw});
  const result=await boundedJson(response);console.log(JSON.stringify({httpStatus:response.status,result},null,2));if(!response.ok)process.exitCode=1;
} catch(error) {console.error(error instanceof Error?error.message:'Event delivery failed');process.exitCode=1;}
