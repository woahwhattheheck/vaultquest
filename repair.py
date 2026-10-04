import hashlib, json, os, pathlib, shutil, subprocess, sys
ROOT=pathlib.Path(__file__).resolve().parent
S=pathlib.Path(sys.argv[1]).resolve(); O=pathlib.Path(sys.argv[2]).resolve(); O.mkdir(parents=True,exist_ok=True)
BASE='bc3ce9c1e33d3f2692b34a0cdcef42262e866dd2'
ADAPTER='lib/chain-fee-adapters.js'; UI='components/app/GasPrioritySelector.jsx'
TEST='lib/chain-fee-observation.test.jsx'; DOC='docs/FEE_OBSERVATION_VALIDITY.md'
PINS={ADAPTER:'cd2fd50c3070a626e2a49281e46c7d408965d3cf',UI:'fca387fab59497bf9d5f6e227c91e9194c635339'}
def git(*args): return subprocess.check_output(['git',*args],cwd=S,text=True).strip()
def blob(data): return hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()
def change(s,a,b):
 if s.count(a)!=1: raise RuntimeError('source anchor not unique: '+repr(a))
 return s.replace(a,b,1)
def execute(label):
 report=O/(label+'.json')
 cmd=['pnpm','exec','vitest','run','lib/chain-fee-adapters.test.js','components/app/GasPrioritySelector.test.jsx',TEST,'--reporter=json','--outputFile='+str(report)]
 with (O/(label+'.stdout')).open('wb') as out,(O/(label+'.stderr')).open('wb') as err:
  run=subprocess.run(cmd,cwd=S,stdout=out,stderr=err,timeout=180)
 raw=json.loads(report.read_text())
 return {'command':cmd,'exit_code':run.returncode,'passed':raw['numPassedTests'],'failed':raw['numFailedTests'],'pending':raw['numPendingTests']}
if git('rev-parse','HEAD')!=BASE or git('status','--porcelain'): raise RuntimeError('expected clean pinned source')
original={}
for p,h in PINS.items():
 d=(S/p).read_bytes()
 if blob(d)!=h: raise RuntimeError('source blob changed: '+p)
 original[p]=d.decode(); (O/('before-'+pathlib.Path(p).name)).write_bytes(d)
for p in [TEST,DOC]:
 if (S/p).exists(): raise RuntimeError('new output already exists: '+p)
shutil.copyfile(ROOT/'chain-fee-observation.test.jsx',S/TEST)
before=execute('before')
if before['failed']<3: raise RuntimeError('original defects not reproduced')
s=original[ADAPTER]
start=s.index('  const raw = Number(data?.last_ledger_base_fee);')
end=s.index('\n\n  return {\n    baseFeeStroops,',start)
s=s[:start]+'''  // A fallback is not a live observation. Reject malformed fields so the
  // caller's existing failure path keeps fallback pricing visibly stale.
  const baseFeeStroops = positiveFeeStatsInteger(data?.last_ledger_base_fee);
  const ledger = positiveFeeStatsInteger(data?.last_ledger);
  if (baseFeeStroops === null || ledger === null) {
    throw new Error("Invalid Horizon fee_stats base fee or source ledger");
  }
  const sourceLedger = String(ledger);'''+s[end:]
anchor='/**\n * Build a Stellar fee estimate from base fee + optional Soroban simulation resource fee.\n */'
helper='''// Horizon fields may be JSON numbers or decimal strings; JavaScript coercion
// must not turn booleans, arrays, fractions, or rounded integers into evidence.
function positiveFeeStatsInteger(value) {
  if (typeof value !== "number" &&
      (typeof value !== "string" || !/^[1-9]\\d*$/.test(value))) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

'''
s=change(s,anchor,helper+anchor)
s=change(s,'.toFixed(6)} ${STELLAR_FEE_CONFIG.nativeToken}', '.toFixed(7)} ${STELLAR_FEE_CONFIG.nativeToken}')
(S/ADAPTER).write_bytes(s.encode())
(S/UI).write_bytes(change(original[UI],'token === "XLM" ? 6 :','token === "XLM" ? 7 :').encode())
after=execute('after')
report={'base':BASE,'node':subprocess.check_output(['node','--version'],text=True).strip(),'before':before,'after':after,'before_blobs':PINS,'after_blobs':{p:blob((S/p).read_bytes()) for p in [ADAPTER,UI,TEST]}}
(O/'report.json').write_text(json.dumps(report,indent=2)+'\n')
for p in [ADAPTER,UI,TEST]: shutil.copyfile(S/p,O/('after-'+pathlib.Path(p).name))
(O/'source.patch').write_bytes(subprocess.check_output(['git','diff','--',ADAPTER,UI],cwd=S))
if after['exit_code'] or after['failed'] or after['pending']: raise RuntimeError('candidate focused checks did not pass')
if set(git('diff','--name-only').splitlines())!=set(PINS): raise RuntimeError('unexpected tracked changes')
run_url='https://github.com/woahwhattheheck/vaultquest/actions/runs/'+os.environ['GITHUB_RUN_ID']
doc='''# Stellar fee observation validity

The provider boundary accepts positive safe integers supplied as JSON numbers
or decimal digit strings for both `last_ledger_base_fee` and `last_ledger`.
Malformed, missing, fractional, boolean, container or unsafe-integer values
raise an error instead of being presented as observed pricing or provenance.
The selector's existing failure path supplies the same 100-stroop fallback
with no source ledger and both stale indicators set. HTTP failure handling,
priority multipliers, simulation fees and the existing network/expiry fixes
are unchanged. This does not prove that a provider's well-formed value is true.

The fee payload and visible XLM amount now use seven decimal places, matching
the existing 10,000,000-stroops-per-XLM conversion. For example, 101 stroops is
shown as `0.0000101 XLM`, not rounded to `0.000010 XLM`. Fee selection, account
balance checks, USD-rate assumptions and Avalanche rendering are unchanged.

## Focused execution

Original source: `'''+BASE+'''`. Run: ['''+os.environ['GITHUB_RUN_ID']+''']('''+run_url+''').
Node: `'''+report['node']+'''`; the existing locked pnpm/Vitest/React/jsdom setup.
No dependency or original test changed. Controlled HTTP results exercise the
actual adapter; component checks mount the actual selector and inspect its
visible amount and parent callback. No live Horizon or transaction is used.

```text
pnpm exec vitest run lib/chain-fee-adapters.test.js components/app/GasPrioritySelector.test.jsx lib/chain-fee-observation.test.jsx
```

Before: '''+str(before['passed'])+''' passed, '''+str(before['failed'])+''' failed.
After: '''+str(after['passed'])+''' passed, '''+str(after['failed'])+''' failed, '''+str(after['pending'])+''' pending.
The raw reports, exact source patch and changed source files are retained in
the run's `vq214-fee-observation-evidence` artifact. The validation workflow is
isolated outside this contribution branch. No application build, full browser
wallet session, live-chain, performance, award or payout result is claimed.
'''
(S/DOC).write_text(doc)
git('add','--',ADAPTER,UI,TEST,DOC)
git('-c','user.name=woahwhattheheck','-c','user.email=293286387+woahwhattheheck@users.noreply.github.com','commit','-m','fix: keep invalid fee observations stale and preserve XLM precision [skip ci]')
report['candidate_commit']=git('rev-parse','HEAD');report['candidate_tree']=git('rev-parse','HEAD^{tree}')
(O/'candidate.txt').write_text(report['candidate_commit']+'\n');(O/'report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
