let token='';let identity=null;
const $=id=>document.getElementById(id);
function el(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
function notice(text){$('notice').textContent=text;$('notice').style.display='block';}
async function api(path,method='GET',payload){const response=await fetch('/api'+path,{method,headers:{authorization:'Bearer '+token,...(payload!==undefined?{'content-type':'application/json'}:{})},...(payload!==undefined?{body:JSON.stringify(payload)}:{})});const data=await response.json();if(!response.ok)throw Error(data.message??JSON.stringify(data.errors??data));return data;}
function button(label,action,cls=''){const b=el('button',label,cls);b.onclick=async()=>{b.disabled=true;try{await action();}catch(e){notice(e.message);}finally{b.disabled=false;}};return b;}
function jsonDetails(title,value){const d=el('details');d.append(el('summary',title),el('pre',JSON.stringify(value,null,2)));return d;}
async function connect(){token=$('token').value.trim();identity=await api('/me');$('token').value='';$('identity').textContent=`企业：${identity.tenantId} · 用户：${identity.userId} · 角色：${identity.role}`;await refresh();}
$('connect').onclick=()=>connect().catch(e=>notice(e.message));
$('logout').onclick=()=>{token='';identity=null;location.reload();};
async function doCompile(useModel){
 const request=$('request').value.trim(),split=v=>v.split(/[,，]/).map(s=>s.trim()).filter(Boolean);
 const budget=Number($('budget').value);if(!Number.isFinite(budget)||budget<0)throw Error('请填写有效预算');
 const input={request,context:{companyName:$('company').value.trim(),products:split($('products').value),targetMarkets:split($('markets').value),goal:request,budgetMicros:Math.round(budget*1000000),currency:'USD',facts:JSON.parse($('facts').value)}};
 if($('playbook').value)input.playbook=$('playbook').value;
 const data=await api(useModel?'/plan':'/compile','POST',input),root=$('result');root.replaceChildren();
 root.append(el('strong',data.status==='blocked'?'暂不能发布':'已通过静态校验，等待独立审批'));
 for(const p of data.errors)root.append(el('div',`${p.code}：${p.message}`,'issue'));
 for(const n of data.workflow?.nodes??[]){const s=el('div',n.label,'step');s.append(el('small',`${n.id} · ${n.type} → ${n.next}`));root.append(s);}
 root.append(jsonDetails('完整编译结果',data));await refresh();
}
$('compile').onclick=()=>doCompile(false).catch(e=>notice(e.message));$('plan').onclick=()=>doCompile(true).catch(e=>notice(e.message));
async function refresh(){
 if(!token)return;
 const [defs,runs,approvals,caps,batches,events]=await Promise.all([api('/workflows'),api('/runs'),api('/approvals'),api('/capabilities'),api('/batches'),api('/events')]);
 const wf=$('workflows');wf.replaceChildren();
 if(!defs.length)wf.append(el('p','还没有流程草稿。','empty'));
 for(const d of defs){const c=el('div',undefined,'card');c.append(el('strong',`${d.spec.title} · v${d.spec.version}`),el('span',`${d.status} · ${d.spec.id}`,'tag'));c.append(jsonDetails('核对完整流程与授权预算',d.spec));
  if(d.status==='draft'&&identity.role==='approver')c.append(button('批准发布此版本',async()=>{if(!confirm('已核对流程范围、预算、接入工具和审批路径？此操作不批准具体邮件内容。'))return;await api(`/workflows/${d.spec.id}/${d.spec.version}/publish`,'POST',{hash:d.hash});await refresh();}));
  if(d.status==='published'&&['admin','operator'].includes(identity.role))c.append(button('启动一次执行',async()=>{if(!confirm('启动该已发布流程？研究与模型调用可能产生费用，外发内容仍需审批。'))return;await api('/runs','POST',{workflowId:d.spec.id,version:d.spec.version,idempotencyKey:crypto.randomUUID()});await refresh();}));wf.append(c);
 }
 const ap=$('approvals');ap.replaceChildren();const pending=approvals.filter(a=>a.state==='pending'&&a.expiresAt>Date.now()&&!runs.some(r=>r.id===a.runId&&['COMPLETED','CANCELLED','FAILED','REJECTED','TIMED_OUT','NEEDS_RECONCILIATION'].includes(r.status)));if(!pending.length)ap.append(el('p','当前没有待审批内容。','empty'));
 for(const a of pending){const c=el('div',undefined,'card');c.append(el('strong',`操作 ${a.actionId} · 到期 ${new Date(a.expiresAt).toLocaleString()}`),el('pre',JSON.stringify(a.payload,null,2)),el('span',`内容 SHA-256：${a.payloadHash}`,'muted'));
 if(identity.role==='approver'){c.append(button('批准这些具体内容',async()=>{if(!confirm('确认收件人、商业承诺及内容准确，允许执行这一操作？'))return;await api(`/approvals/${a.id}/decision`,'POST',{hash:a.payloadHash,approved:true});await refresh();}),button('拒绝',async()=>{await api(`/approvals/${a.id}/decision`,'POST',{hash:a.payloadHash,approved:false});await refresh();},'danger'));}ap.append(c);}
 const rr=$('runs');rr.replaceChildren();if(!runs.length)rr.append(el('p','还没有真实运行记录。','empty'));
 for(const r of runs){const c=el('div',undefined,'card');c.append(el('strong',`${r.spec.title} · ${r.status}`),el('p',`当前节点：${r.current} · 授权预留 $${(r.reservedMicros/1e6).toFixed(2)} · 已报告成本 $${(r.actualMicros/1e6).toFixed(2)}`,'muted'));if(r.targetEmail)c.append(el('p',`本任务只允许联系：${r.targetEmail}`));if(r.error)c.append(el('div',r.error,'issue'));
 if(r.status==='BATCH_READY'&&['admin','operator'].includes(identity.role))c.append(button('选择客户并创建批次',()=>showBatchPreview(r.id,c),'secondary'));
 if(r.status==='NEEDS_RECONCILIATION'&&identity.role==='approver')c.append(reconciliationForm(r));c.append(jsonDetails('节点结果与证据',r));
 if(['admin','operator'].includes(identity.role)&&!['COMPLETED','CANCELLED','FAILED','REJECTED','TIMED_OUT','NEEDS_RECONCILIATION'].includes(r.status))c.append(button('停止后续调度',async()=>{await api(`/runs/${r.id}/cancel`,'POST');await refresh();},'secondary'));rr.append(c);}
 renderBatches(batches);renderEvents(events);
 const cc=$('capabilities');cc.replaceChildren();for(const c of caps)cc.append(el('p',`${c.enabled&&c.bound?'已配置（仍需 doctor 验证）':'未接通 / 执行阻断'} · ${c.id} · ${c.description}`));
}
$('refresh').onclick=()=>refresh().catch(e=>notice(e.message));

async function showBatchPreview(runId,card){
 const preview=await api(`/runs/${runId}/batch-preview`);card.querySelector('.batch-selector')?.remove();
 const box=el('div',undefined,'batch-selector'),selection=[];
 box.append(el('h4','核对研究结果，手动选择本批次客户'),el('p',`共享预算 $${(preview.budgetMicros/1e6).toFixed(2)} · 研究已预留 $${(preview.alreadyReservedMicros/1e6).toFixed(2)} · 每位客户后续最坏预留 $${(preview.perRecipientMicros/1e6).toFixed(2)}`,'muted'));
 for(const candidate of preview.buyers){const row=el('label',undefined,'check-row'),input=el('input');input.type='checkbox';input.disabled=!candidate.eligible;selection.push({input,email:candidate.email});row.append(input,el('span',`${candidate.companyName} · ${candidate.email??'无邮箱'}${candidate.reason?' · '+candidate.reason:''}`));box.append(row);}
 const key=crypto.randomUUID();box.append(button('为所选客户创建独立任务',async()=>{
  const recipients=selection.filter(x=>x.input.checked).map(x=>x.email);if(!recipients.length)throw Error('请至少选择一个可联系客户。');
  if(recipients.length>preview.maxAffordableRecipients)throw Error('当前授权预算不足，请减少客户数。');
  if(!confirm(`创建 ${recipients.length} 个独立客户任务，并停止原任务？此操作不批准任何外发内容。`))return;
  await api('/batches','POST',{sourceRunId:runId,recipients,idempotencyKey:key});await refresh();
 }));card.append(box);
}
function renderBatches(items){
 const root=$('batches');root.replaceChildren();if(!items.length)root.append(el('p','尚未创建客户批次。筛选出多个买家后，运行会停在 BATCH_READY 等待选择。','empty'));
 for(const item of items){const b=item.batch,c=el('div',undefined,'card');c.append(el('strong',`${item.status} · ${item.total} 位客户`),el('p',`共享授权 $${(b.budgetMicros/1e6).toFixed(2)} · 累计预留 $${(b.reservedMicros/1e6).toFixed(2)} · 已报告成本 $${(b.actualMicros/1e6).toFixed(2)}`,'muted'),el('p',Object.entries(item.counts).map(([k,v])=>`${k}: ${v}`).join(' · ')));
 c.append(button('查看逐客户进度',async()=>{const v=await api(`/batches/${b.id}`);c.querySelector('.batch-detail')?.remove();const d=el('div',undefined,'batch-detail');for(const r of v.runs)d.append(el('p',`${r.targetEmail} · ${r.status} · ${r.current}`));c.append(d);},'secondary'));
 if(['admin','operator'].includes(identity.role)&&b.state!=='cancelled'){
  const action=b.state==='active'?'pause':'resume';c.append(button(action==='pause'?'暂停后续调度':'恢复调度',async()=>{await api(`/batches/${b.id}/${action}`,'POST');await refresh();},'secondary'));
  c.append(button('取消整个批次',async()=>{if(!confirm('取消所有尚未完成的客户任务？已经派发的远程动作不能撤销，结果不明时仍需对账。'))return;await api(`/batches/${b.id}/cancel`,'POST');await refresh();},'danger'));
 }root.append(c);}
}
function renderEvents(page,append=false){
 const root=$('events');if(!append)root.replaceChildren();root.querySelector('.load-more')?.remove();
 if(!page.items.length&&!append)root.append(el('p','尚未收到业务事件。需要接入受信任的邮件或样品事件网关。','empty'));
 for(const item of page.items){const c=el('div',undefined,'card');c.append(el('strong',`${item.state} · ${item.event.type}`),el('p',`${item.event.id} · ${new Date(item.event.receivedAt).toLocaleString()}`,'muted'));
 if(item.reason)c.append(el('p',item.reason,'issue'));if(item.runId)c.append(el('p',`关联任务：${item.runId}`,'muted'));c.append(jsonDetails('原始业务事件',item.event));
 if(item.state!=='consumed'&&['admin','operator'].includes(identity.role))c.append(button('重新校验归属',async()=>{await api(`/events/${encodeURIComponent(item.event.id)}/recheck`,'POST');await refresh();},'secondary'));root.append(c);}
 if(page.nextCursor)root.append(button('加载较早事件',async()=>renderEvents(await api(`/events?before=${page.nextCursor}`),true),'secondary load-more'));
}
function reconciliationForm(run){
 const d=el('details');d.append(el('summary','人工对账：仅提交已核实的服务商回执，不重新发送'));
 const receipt=el('textarea');receipt.rows=6;receipt.placeholder='粘贴符合该动作输出契约的真实回执 JSON';
 const evidence=el('textarea');evidence.rows=2;evidence.placeholder='服务商回执、事件编号或核验记录（至少 10 字符）';
 d.append(receipt,evidence,button('确认真实回执并恢复后续流程',async()=>{const output=JSON.parse(receipt.value);if(!confirm('已独立核验此操作真实发生，且回执收件人与原审批一致？'))return;await api(`/runs/${run.id}/reconcile`,'POST',{output,providerEvidence:evidence.value});await refresh();}));return d;
}
