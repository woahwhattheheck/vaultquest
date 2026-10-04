import hashlib, json, os, pathlib, shutil, subprocess, sys
ROOT=pathlib.Path(__file__).resolve().parent
S=pathlib.Path(sys.argv[1]).resolve(); O=pathlib.Path(sys.argv[2]).resolve(); O.mkdir(parents=True,exist_ok=True)
BASE='bc3ce9c1e33d3f2692b34a0cdcef42262e866dd2'
ADAPTER='lib/chain-fee-adapters.js'; UI='components/app/GasPrioritySelector.jsx'
EXISTING='components/app/GasPrioritySelector.test.jsx'
TEST='lib/chain-fee-observation.test.jsx'; DOC='docs/FEE_OBSERVATION_VALIDITY.md'
PINS={ADAPTER:'cd2fd50c3070a626e2a49281e46c7d408965d3cf',UI:'fca387fab59497bf9d5f6e227c91e9194c635339',EXISTING:'4a6efd733cd569dfcf6431ea4c400c57d5d2486e'}
EXECUTED={ADAPTER:'0d1c722179059f827330cf8d508de0675c2c2967',UI:'eb2dcee484afadc62a5849ee2969c15e88ac25a2',TEST:'5da83a2c1badbc748c77476c6df14040932d01f6'}
PRIOR_RUN='37194233211'
PRIOR_ARCHIVE='cb6b570a0c23b55305053fcb9afd5b1dfb7aea1362508c1703c173e8d9e2ee69'
def git(*args): return subprocess.check_output(['git',*args],cwd=S,text=True).strip()
def blob(data): return hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()
def change(s,a,b):
 if s.count(a)!=1: raise RuntimeError('source anchor not unique: '+repr(a))
 return s.replace(a,b,1)
def execute(label):
 report=O/(label+'.json')
 cmd=['pnpm','exec','vitest','run','lib/chain-fee-adapters.test.js',EXISTING,TEST,'--reporter=json','--outputFile='+str(report)]
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
# Reuse the already downloaded and hash-verified baseline, do not rerun it.
# Full per-test JSON is in prior run 37194233211 artifact 11299379959.
before={'reused_from_run':PRIOR_RUN,'artifact':11299379959,'archive_sha256':PRIOR_ARCHIVE,'passed':34,'failed':33,'pending':0,'exit_code':1}
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
for p,h in EXECUTED.items():
 if blob((S/p).read_bytes())!=h: raise RuntimeError('candidate differs from previously executed production or regressions: '+p)
# Only two exact display strings change; numeric fees, assertions, and all
# network/expiry tests are retained. Neither equality is weakened.
s=change(original[EXISTING],'.toBe("0.000500 XLM")','.toBe("0.0005000 XLM")')
s=change(s,'.toBe("0.000025 XLM")','.toBe("0.0000250 XLM")')
(S/EXISTING).write_bytes(s.encode())
after=execute('after')
report={'base':BASE,'node':subprocess.check_output(['node','--version'],text=True).strip(),'runner':{'vitest':'3.2.6','vite':'6.4.3','jsdom':'25.0.1'},'before':before,'prior_candidate':{'run':PRIOR_RUN,'passed':65,'failed':2,'remaining_failures':'two six-decimal string expectations'},'after':after,'before_blobs':PINS,'after_blobs':{p:blob((S/p).read_bytes()) for p in [ADAPTER,UI,EXISTING,TEST]}}
(O/'report.json').write_text(json.dumps(report,indent=2)+'\n')
for p in [ADAPTER,UI,EXISTING,TEST]: shutil.copyfile(S/p,O/('after-'+pathlib.Path(p).name))
(O/'source.patch').write_bytes(subprocess.check_output(['git','diff','--',*PINS],cwd=S))
if after['exit_code'] or after['failed'] or after['pending'] or after['passed']!=67: raise RuntimeError('candidate focused checks did not pass')
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

## Executed evidence and revision boundaries

Original source: `'''+BASE+'''`.
[Original and initial candidate run](https://github.com/woahwhattheheck/vaultquest/actions/runs/'''+PRIOR_RUN+'''):
34 passed / 33 failed before the repair; 65 passed / 2 failed afterward. All
33 new defect cases were repaired. The two remaining failures expected the
old six-decimal display strings for 5000 and 250 stroops.

This contribution updates those exact expectations to `0.0005000 XLM` and
`0.0000250 XLM`. Their numeric fee assertions and the equality checks remain;
no test is removed, skipped, or weakened. The production files and new
regression file are byte-identical to the first executed candidate.

[Final focused candidate run]('''+run_url+'''): '''+str(after['passed'])+''' passed,
0 failed, 0 pending. The baseline is reused, not rerun in the final job.
Node `'''+report['node']+'''`; isolated Vitest 3.2.6 / Vite 6.4.3 / jsdom 25.0.1.
Other frontend runtime dependencies retain their locked versions.

```text
pnpm exec vitest run lib/chain-fee-adapters.test.js components/app/GasPrioritySelector.test.jsx lib/chain-fee-observation.test.jsx
```

Controlled HTTP responses exercise the actual adapter. Component checks mount
the actual selector and inspect its visible amount, freshness and parent
callback. No live Horizon or transaction is used.

## Environment limits

Three earlier setup attempts did not execute tests: the full workspace's
backend lockfile disagreed with its manifest; the frontend's retained
Vitest/Vite pairing failed before collection; and the isolated runner setup
initially assumed Vite was a root dependency instead of transitive-only.
Frontend installation temporarily excludes the unrelated backend and restores
the workspace file before source checks. Vitest and Vite links are redirected
only in untracked node_modules to the isolated compatible runner.

No product dependency manifest, lockfile or workspace file is changed. This
does not claim that canonical full-workspace installation is repaired. Raw
reports, source patch and sources are in the runs' artifacts; the isolated
runner lock is retained too. The first executed archive, artifact 11299379959,
has SHA-256 `'''+PRIOR_ARCHIVE+'''`.
Validation workflows remain outside this contribution branch. No application
build, full browser-wallet session, live-chain, performance, award or payout
result is claimed.
'''
(S/DOC).write_text(doc)
git('add','--',ADAPTER,UI,EXISTING,TEST,DOC)
git('-c','user.name=woahwhattheheck','-c','user.email=293286387+woahwhattheheck@users.noreply.github.com','commit','-m','fix: keep invalid fee observations stale and preserve XLM precision [skip ci]')
report['candidate_commit']=git('rev-parse','HEAD');report['candidate_tree']=git('rev-parse','HEAD^{tree}')
(O/'candidate.txt').write_text(report['candidate_commit']+'\n');(O/'report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
