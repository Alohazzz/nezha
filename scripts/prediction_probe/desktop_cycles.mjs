// Drives genuine Tauri commands, ownership, forwarder, prediction scheduler/cache.
// Usage: node desktop_cycles.mjs PROJECT_PATH PROVIDER_PORT REPORT_PATH warm|cold
import { writeFile } from 'node:fs/promises';
import { connect } from './desktop_cdp.mjs';

const [project, providerPort, output, kind = 'warm'] = process.argv.slice(2);
if (!project || !providerPort || !output) throw new Error('Missing fixture arguments');
const cdp = await connect(Number(process.env.NEZHA_CDP_PORT || 9222));
const control = async mode => fetch(`http://127.0.0.1:${providerPort}/control`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }),
});
const requests = () => fetch(`http://127.0.0.1:${providerPort}/control`).then(r => r.json());
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 20000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) { const value = await check(); if (value) return value; await pause(10); }
  throw new Error(`Timeout: ${label}`);
}
const task = `acceptance-${kind}-${Date.now()}`;
const report = { kind, task, cycles: [], started: new Date().toISOString() };
try {
  await cdp.evaluate(`(async () => {
    const {invoke,Channel}=await import('/node_modules/@tauri-apps/api/core.js');
    const {listen}=await import('/node_modules/@tauri-apps/api/event.js');
    const h={invoke,Channel,status:[],predictions:[],frames:[],sessions:[],unexpected:[]};
    window.__predictionAcceptance=h;
    for(const name of ['task-status','task-session','codex-prompt-prediction','codex-approval-requested','codex-user-input-requested'])
      await listen(name,e=>{const p=e.payload;if((p.task_id||p.taskId)!==${JSON.stringify(task)})return;
        const entry={at:performance.now(),...p};
        if(name==='task-status')h.status.push(entry);else if(name==='task-session')h.sessions.push(entry);
        else if(name==='codex-prompt-prediction')h.predictions.push(entry);else h.unexpected.push({name,at:performance.now()});});
    await invoke('save_codex_prompt_predictions_enabled',{enabled:${kind === 'warm'}});
  })()`);
  for (let index = 0; index < (kind === 'warm' ? 30 : 21); index++) {
    const phase = index < 21 || index % 3 === 0 ? 'returned' : index % 3 === 1 ? 'during' : 'before';
    await control(phase === 'during' ? 'hold' : 'ready');
    const before = await requests();
    const result = await cdp.evaluate(`(async()=>{
      const h=window.__predictionAcceptance;const channel=new h.Channel();
      channel.onmessage=data=>h.frames.push({at:performance.now(),data:JSON.parse(data)});
      const started=performance.now();const doneBefore=h.status.filter(x=>x.status==='done').length;
      const args={taskId:${JSON.stringify(task)},projectPath:${JSON.stringify(project)},permissionMode:'auto_edit',
        prompt:${JSON.stringify(`Acceptance ${kind} cycle ${index}. Reply briefly without tools.`)},onOutput:channel,model:'gpt-6-astra'};
      if(${index === 0})await h.invoke('run_task',{...args,taskName:'Prediction acceptance',realProjectPath:args.projectPath,
        agent:'codex',runMode:'structured',reasoningEffort:'medium',requireSediment:false});
      else await h.invoke('resume_codex_structured',{...args,threadId:h.sessions.at(-1).session_id,effort:'medium'});
      return {started,invokeReturned:performance.now(),doneBefore};
    })()`);
    const done = await until(() => cdp.evaluate(`window.__predictionAcceptance.status.filter(x=>x.status==='done')[${result.doneBefore}]`), 'business done');
    const thread = await cdp.evaluate('window.__predictionAcceptance.sessions.at(-1).session_id');
    if (kind === 'warm' && phase === 'returned') {
      await until(() => cdp.evaluate(`window.__predictionAcceptance.predictions.findLast(x=>x.status==='complete'&&x.at>=${done.at})`), 'prediction complete');
    } else if (kind === 'warm' && phase === 'during') {
      await until(async () => (await requests()).slice(before.length).some(r => r.sample), 'sample request');
    }
    const state = await cdp.evaluate(`(async()=>{const h=window.__predictionAcceptance;return {
      prediction:await h.invoke('get_codex_prompt_prediction',{taskId:${JSON.stringify(task)},threadId:${JSON.stringify(thread)}}),
      active:await h.invoke('get_active_task_ids'),firstFrame:h.frames.find(x=>x.at>=${result.started})?.at,
      unexpected:h.unexpected.length};})()`);
    if (state.unexpected || state.active.includes(task)) throw new Error('Warm task emitted interaction or stayed active');
    report.cycles.push({ index, phase, ...result, doneAt: done.at, firstOutputAt: state.firstFrame,
      thread, predictionStatus: state.prediction?.status, generation: state.prediction?.sessionGeneration });
    await writeFile(output, JSON.stringify(report, null, 2));
  }
  await cdp.evaluate(`window.__predictionAcceptance.invoke('save_codex_prompt_predictions_enabled',{enabled:false})`);
  report.provider = await requests();
  report.final = await cdp.evaluate(`({statuses:window.__predictionAcceptance.status,unexpected:window.__predictionAcceptance.unexpected})`);
  report.finished = new Date().toISOString();
  await writeFile(output, JSON.stringify(report, null, 2));
} finally { cdp.close(); }
