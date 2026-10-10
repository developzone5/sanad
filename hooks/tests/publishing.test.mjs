import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runCommand} from '../../skills/gate/scripts/evidence.mjs';

const hooks = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const msg = (role, content) => ({type: role, message: {role, content}});
const say = text => msg('assistant', [{type:'text',text}]);
// A completed independent reviewer run as this host records it: an Agent launch
// whose prompt carries the reviewer marker, its async result with the agent id,
// then the task-notification attachment when the agent finishes.
let reviewerCount = 0;
const reviewerRun = (id = 'reviewer' + (++reviewerCount), status = 'completed', prompt = 'You are the independent reviewer (read-only). Review the diff.') => [
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: id + '-call', name: 'Agent', input: { description: 'Independent review', prompt } }] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id + '-call', content: 'Async agent launched successfully.', is_error: false }] }, toolUseResult: { isAsync: true, status: 'async_launched', agentId: id } },
  { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: '<task-notification>\n<task-id>' + id + '</task-id>\n<status>' + status + '</status>\n<summary>Agent "Independent review" ' + status + '</summary>\n</task-notification>' } },
];

const call = (id, command) => msg('assistant', [{type:'tool_use',id,name:'Bash',input:{command}}]);
const result = (id, content) => msg('user', [{type:'tool_result',tool_use_id:id,content,is_error:false}]);

test('publishing regressions use real Git and hook processes, never a real push', async t => {
 const scratch = fs.mkdtempSync(path.join(os.tmpdir(),'workflow-publish-test-'));
 const repo = path.join(scratch,'repo'); fs.mkdirSync(repo);
 const git = args => execFileSync('git',args,{cwd:repo,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe'],timeout:15000});
 const transcript = path.join(scratch,'transcript.jsonl');
 try {
  git(['init','--initial-branch=staging']);git(['config','user.name','developzone5']);git(['config','user.email','65265330+developzone5@users.noreply.github.com']);
  fs.writeFileSync(path.join(repo,'README.md'),'Fixture only.\n');git(['add','--','README.md']);git(['commit','-m','test: baseline']);git(['update-ref','refs/remotes/origin/staging','HEAD']);
  const base=git(['rev-parse','HEAD']).trim();
  git(['switch','-c','fix/probe']);fs.mkdirSync(path.join(repo,'src'));fs.writeFileSync(path.join(repo,'src/App.ts'),'export const route = "/teacher/materials";\n');
  git(['add','--','src/App.ts']);git(['commit','-m','test: behavior change']);
  const head=git(['rev-parse','HEAD']).trim();
  const bareCheck=[call('check','dotnet test'),result('check','Passed: 1')];
  const claimed=[...reviewerRun(),say('REVIEW: PASS'),say('GATE: PASS')];
  const inspect=(command,entries=[],cwd=repo)=>{
   fs.writeFileSync(transcript,entries.map(JSON.stringify).join('\n'));
   const output=execFileSync(process.execPath,[path.join(hooks,'policy-guard.js')],{cwd,encoding:'utf8',windowsHide:true,timeout:20000,input:JSON.stringify({hook_event_name:'PreToolUse',tool_name:'Bash',cwd,transcript_path:transcript,tool_input:{command}})});
   return output?JSON.parse(output).hookSpecificOutput:{permissionDecision:'allow',permissionDecisionReason:''};
  };
  const decision=(...args)=>inspect(...args).permissionDecision;
  const scan=entries=>{
   fs.writeFileSync(transcript,entries.map(JSON.stringify).join('\n'));
   return JSON.parse(execFileSync(process.execPath,['-e','process.stdout.write(JSON.stringify(require(process.argv[1]).scanTranscript(process.argv[2],process.argv[3])))',path.join(hooks,'lib/transcript-scan.js'),transcript,repo],{cwd:repo,encoding:'utf8',windowsHide:true,timeout:20000}));
  };
  await t.test('a source-bound check needs a written review verdict before the gate',async()=>{
   const check=await runCommand({executable:process.execPath,args:['--check','src/App.ts'],cwd:repo,outputRoot:path.join(scratch,'checks')});
   assert.equal(check.status,'passed');
   assert.equal(check.source.treeBefore,git(['rev-parse','HEAD^{tree}']).trim());
   assert.equal(check.source.treeAfter,check.source.treeBefore);
   const bound=[call('bound','node C:/Users/Asus/.claude/skills/gate/scripts/evidence.mjs --spec fixture.json'),result('bound','CHECK_COMPLETED '+JSON.stringify(check))];
   const unreviewed=inspect('git push origin HEAD:fix/probe',[...bound,say('GATE: PASS')]);
   assert.equal(unreviewed.permissionDecision,'deny');
   assert.match(unreviewed.permissionDecisionReason,/REVIEW: PASS/);
   assert.equal(decision('git push origin HEAD:fix/probe',[...bound,...claimed]),'allow');
  });
  await t.test('draft PR creation needs evidence too',()=>{
   git(['remote','add','origin',path.join(scratch,'never-contacted.git')]);
   git(['config','branch.fix/probe.remote','origin']);git(['config','branch.fix/probe.merge','refs/heads/fix/probe']);
   git(['update-ref','refs/remotes/origin/fix/probe','HEAD']);
   assert.equal(git(['rev-parse','@{u}^{commit}']).trim(),head);
   const observed=inspect('gh pr create --draft --base staging --head fix/probe');
   assert.equal(observed.permissionDecision,'deny');
   assert.match(observed.permissionDecisionReason,/requires a completed evidence\.mjs check/);
  });
  await t.test('an explicit empty solution project is rejected',()=>{
   fs.writeFileSync(path.join(repo,'tsconfig.json'),JSON.stringify({files:[],references:[{path:'./tsconfig.app.json'}]}));
   git(['add','--','tsconfig.json']);git(['commit','-m','test: empty solution project']);
   assert.equal(decision('npx tsc --noEmit -p .'),'deny');
  });
  await t.test('a matching receipt cannot turn tsc -p . into verification',()=>{
   const tree=git(['rev-parse','HEAD^{tree}']).trim();
   const check={runId:crypto.randomUUID(),cwd:repo,executable:'npx',args:['tsc','--noEmit','-p','.'],status:'passed',nativeExitCode:0,source:{toplevel:repo,treeBefore:tree,treeAfter:tree}};
   // Relative paths intentionally avoid Temp-path exemptions in edit tracking.
   const edited=[msg('assistant',[{type:'tool_use',id:'edit',name:'Edit',input:{file_path:'src/App.ts',old_string:'materials',new_string:'materials'}}]),result('edit','File edited successfully.')];
   const checked=[call('bound','node C:/Users/Asus/.claude/skills/gate/scripts/evidence.mjs --spec fixture.json'),result('bound','CHECK_COMPLETED '+JSON.stringify(check))];
   const observed=scan([...edited,...checked]);
   assert.ok(observed.lastEdit>=0,'Relative application edit must advance chronology.');
   assert.ok(observed.lastFailedVerify>observed.lastEdit,'Empty project receipt must record a failed check after the edit.');
   assert.equal(observed.completedCheck,null);
   assert.equal(observed.lastBoundCheck,-1);
   const genuineShape={...check,executable:'node',args:['--test']};
   const control=scan([...edited,checked[0],result('bound','CHECK_COMPLETED '+JSON.stringify(genuineShape))]);
   assert.ok(control.lastBoundCheck>control.lastEdit,'The same receipt shape with a verifying command must be recognized.');
   assert.equal(control.completedCheck.runId,check.runId);
   assert.equal(decision('git push origin HEAD:fix/probe',[...edited,...checked,...claimed]),'deny');
  });
  await t.test('bare successful output is not source-bound publishing evidence',()=>assert.equal(decision('git push origin HEAD:fix/probe',[...bareCheck,...claimed]),'deny'));
  await t.test('code in specs is not documentation',()=>{
   git(['switch','-c','fix/specs',base]);fs.mkdirSync(path.join(repo,'specs'));fs.writeFileSync(path.join(repo,'specs/runtime.ts'),'export const unsafe = true;\n');
   git(['add','--','specs/runtime.ts']);git(['commit','-m','test: code under specs']);
   assert.equal(decision('git push origin HEAD:fix/specs'),'deny');
  });
  for (const [name,file] of [['memory','src/memory/x.cs'],['claude','.claude/hooks/x.js'],['resources','locale/messages.resx'],['json','locale/en.json']]) {
   await t.test(file+' requires verification and independent review',()=>{
    git(['switch','-c','fix/disguised-'+name,base]);
    fs.mkdirSync(path.dirname(path.join(repo,file)),{recursive:true});
    fs.writeFileSync(path.join(repo,file),file.endsWith('.json')?'{}\n':'Runtime fixture.\n');
    git(['add','--',file]);git(['commit','-m','test: runtime file in '+name]);
    assert.equal(decision('git push origin HEAD:fix/disguised-'+name),'deny');
    assert.equal(decision('git push origin HEAD:fix/disguised-'+name,[...bareCheck,...claimed]),'deny');
   });
  }
  await t.test('a genuine documentation-only diff remains allowed',()=>{
   git(['switch','-c','docs/probe',base]);fs.appendFileSync(path.join(repo,'README.md'),'More documentation.\n');git(['add','--','README.md']);git(['commit','-m','docs: fixture']);
   assert.equal(decision('git push origin HEAD:docs/probe'),'allow');
  });
  await t.test('even a documentation PR requires its upstream to match local HEAD',()=>{
   git(['config','branch.docs/probe.remote','origin']);git(['config','branch.docs/probe.merge','refs/heads/docs/probe']);
   git(['update-ref','refs/remotes/origin/docs/probe',base]);
   assert.equal(decision('gh pr create --draft --base staging --head docs/probe'),'deny');
   git(['update-ref','refs/remotes/origin/docs/probe','HEAD']);
   assert.equal(decision('gh pr create --draft --base staging --head docs/probe'),'allow');
  });
  await t.test('a saved or command-line push mapping cannot redirect a push to main',()=>{
   assert.equal(decision('git push origin docs/probe'),'allow','control: a docs-only named push is allowed');
   git(['config','remote.origin.push','refs/heads/docs/probe:refs/heads/main']);
   const mapped=inspect('git push origin docs/probe');
   assert.equal(mapped.permissionDecision,'deny');
   assert.match(mapped.permissionDecisionReason,/remote\.origin\.push/);
   assert.equal(decision('git push origin HEAD:refs/heads/docs/probe'),'allow','an explicit src:dst is not remapped');
   git(['config','--unset-all','remote.origin.push']);
   git(['config','push.default','upstream']);git(['config','branch.docs/probe.merge','refs/heads/main']);
   assert.equal(decision('git push origin docs/probe'),'deny','push.default=upstream sends the branch to main');
   git(['config','branch.docs/probe.merge','refs/heads/docs/probe']);git(['config','--unset','push.default']);
   assert.equal(decision('git -c push.default=upstream push origin docs/probe'),'deny');
   assert.equal(decision('git -c remote.origin.push=HEAD:refs/heads/main push origin docs/probe'),'deny');
   assert.equal(decision('git push -n --no-dry-run origin HEAD:refs/heads/docs/probe'),'deny','conflicting dry-run flags');
   assert.equal(decision('git push -n origin HEAD:refs/heads/main'),'allow','a real dry run publishes nothing');
  });
 } finally {
  const resolved=fs.realpathSync(scratch);
  assert.equal(path.dirname(resolved).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());assert.match(path.basename(resolved),/^workflow-publish-test-/);
  fs.rmSync(resolved,{recursive:true,force:true});
 }
});
