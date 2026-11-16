"""Summarize isolated desktop metadata; never exports transcripts or credentials."""
import argparse
import collections
import json
import math
from pathlib import Path
import re
import statistics
import urllib.request


def stats(values):
    values = sorted(values)
    return {"n": len(values), "medianMs": statistics.median(values),
            "p95Ms": values[math.ceil(len(values) * .95) - 1], "maxMs": max(values)} if values else None


def summarize(root):
    focused = {kind: json.loads((root / 'project' / f'{kind}-report.json').read_text(encoding='utf-8-sig')) for kind in ['warm', 'cold']}
    reports = {kind: json.loads((root / f'{kind}-lifecycle-report.json').read_text(encoding='utf-8-sig')) if (root / f'{kind}-lifecycle-report.json').exists() else report for kind, report in focused.items()}
    timings = []
    for log in root.glob('app*.stderr.log'):
        for line in log.read_text(encoding='utf-8', errors='replace').splitlines():
            if '[prediction-timing] ' in line:
                timings.append(json.loads(line.split('[prediction-timing] ', 1)[1]))
    port = (root / 'provider.port').read_text().strip()
    provider = json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/control'))
    result = {"percentile": "nearest rank ceil(n*0.95), initial launch excluded from resume statistics", "runs": {}}
    for kind, report in reports.items():
        cycles = report.get('cycles', [])
        resumes = cycles[1:21]
        thread = cycles[0]['thread'] if cycles else None
        scoped = [t for t in timings if t['thread'] == thread]
        ack_latencies = []
        for cycle in resumes:
            started = report['timeOrigin'] + cycle['started']
            returned = report['timeOrigin'] + cycle['invokeReturned']
            ack = next((t for t in scoped if t['method'] == 'turn/start' and started <= t['completedUnixMs'] <= returned + 5), None)
            if ack:
                ack_latencies.append(ack['completedUnixMs'] - started)
        result['runs'][kind] = {
            "completedCycles": len(cycles), "error": report.get('error'),
            "businessDoneEvents": sum(s['status'] == 'done' for s in report.get('statuses', [])),
            "unexpectedInteractions": report.get('unexpected'),
            "submitToStartAck": stats(ack_latencies),
            "submitToFirstChannelFrame": stats([c['firstOutputAt'] - c['started'] for c in resumes]),
            "submitToFirstAssistantContent": stats([c['firstAssistantAt'] - c['started'] for c in focused[kind]['cycles'][1:] if c.get('firstAssistantAt')]),
            "readinessRpc": stats([t['elapsedMs'] for t in scoped if t['method'] == 'thread/read']),
            "cancelAcknowledgment": stats([t['elapsedMs'] for t in scoped if t['method'] == 'thread/sample/cancel']),
        }
        user_cycles = []
        parent_polluted = False
        matching_rollouts = []
        for path in (root / 'codex-home' / 'sessions').rglob('*.jsonl'):
            if thread and thread in path.name:
                matching_rollouts.append(path.name)
                for line in path.read_text(encoding='utf-8').splitlines():
                    parent_polluted |= 'This is an app-generated request for a suggested next user message.' in line
                    item = json.loads(line)
                    payload = item.get('payload', {})
                    if item.get('type') == 'response_item' and payload.get('type') == 'message' and payload.get('role') == 'user':
                        text = json.dumps(payload.get('content', []))
                        user_cycles.extend(int(n) for n in re.findall(r'Acceptance '+kind+r' cycle (\d+)', text))
        result['runs'][kind]['history'] = {"rolloutCount": len(matching_rollouts), "predictionPromptPresent": parent_polluted,
            "userCycleCounts": dict(sorted(collections.Counter(user_cycles).items())),
            "exactlyOneUserMessagePerCycle": collections.Counter(user_cycles) == collections.Counter(range(len(cycles)))}
    result['provider'] = {"parentRequests": sum(not r['sample'] for r in provider), "sampleRequests": sum(r['sample'] for r in provider),
        "parentEffortsObserved": sorted({u.get('reasoning', {}).get('effort') for r in provider if not r['sample'] for u in r.get('configuration_updates', [])}),
        "sampleFinalEffortsObserved": sorted({r.get('configuration_updates', [{}])[-1].get('reasoning', {}).get('effort') for r in provider if r['sample']})}
    result['geometry'] = [{"kind": kind, "cycle": c['index'], "pending": c.get('pendingGeometry'), "complete": c.get('completeGeometry')} for kind, report in focused.items() for c in report['cycles']]
    for name in ['global', 'live', 'ui']:
        path = root / 'project' / f'{name}-report.json'
        if path.exists():
            result[name] = json.loads(path.read_text(encoding='utf-8-sig'))
    (root / 'summary.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    (root / 'provider-metadata.json').write_text(json.dumps(provider, indent=2), encoding='utf-8')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('evidence_root', type=Path)
    summarize(parser.parse_args().evidence_root)
