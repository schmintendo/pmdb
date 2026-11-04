import React, { useCallback, useEffect, useRef, useState } from 'react';
import { appendRuns, DISK_BLOCKS, diskBlock, diskSpeed, endpointKey, networkEndpoints, networkMode } from './history-tables.mjs';

const format = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const size = (value, unit) => value == null ? '—' : `${format.format(value / 1024 ** (unit === 'TiB' ? 4 : 3))} ${unit}`;
const display = value => value == null || value === '' ? '—' : value;
function friendlyName(hostname) {
  return hostname.match(/^[^-]+-(?:\d+-)*\d+([a-z][a-z0-9-]*)(?:\..+)?$/i)?.[1] || hostname.split('.')[0] || 'Node';
}
function dateLabel(value) {
  if (!value) return 'Time not supplied';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Time not supplied' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
function Measurements({ rows }) {
  return <dl className="node-measurements">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{display(value)}</dd></div>)}</dl>;
}
function RunTime({ run }) {
  return <div className="run-time"><time dateTime={run.measuredAt || run.submittedAt}>{dateLabel(run.measuredAt || run.submittedAt)}</time></div>;
}
function SpeedHistory({ runs, hasRuns }) {
  const modes = [...new Set(runs.flatMap(run => (run.tests || []).map(test => networkMode(test.mode))))]
    .sort((a, b) => ({ IPv4: 0, IPv6: 1 }[a] ?? 2) - ({ IPv4: 0, IPv6: 1 }[b] ?? 2) || a.localeCompare(b));
  return <section className="node-panel network-panel" aria-labelledby="speed-history-heading">
    <div className="node-panel-heading"><h2 id="speed-history-heading">Historical speed tests</h2><p>One row per submission, newest first. Scroll sideways to compare every provider.</p></div>
    {modes.length ? modes.map(mode => {
      const endpoints = networkEndpoints(runs, mode);
      const modeRuns = runs.filter(run => (run.tests || []).some(test => networkMode(test.mode) === mode));
      return <div className="network-mode" key={mode}>
        <h3>{mode}</h3>
        <div className="history-table-scroll" role="region" aria-label={`${mode} speed test history`} tabIndex={0}>
          <table className="history-table speed-history-table">
            <caption className="sr-only">{mode} speed tests. Each provider lists send, receive, and latency in the reported units.</caption>
            <thead><tr><th scope="col" className="history-date">Date</th>{endpoints.map(endpoint => <th scope="col" key={endpoint.key}><span className="endpoint-provider">{endpoint.provider}</span>{endpoint.location && <span className="endpoint-location">{endpoint.location}</span>}</th>)}</tr></thead>
            <tbody>{modeRuns.map(run => <tr key={run.id}>
              <th scope="row" className="history-date"><RunTime run={run} /></th>
              {endpoints.map(endpoint => {
                const tests = (run.tests || []).filter(test => networkMode(test.mode) === mode && endpointKey(test) === endpoint.key);
                return <td key={endpoint.key}>{tests.length ? tests.map((test, index) => <dl className="history-metrics" key={index}>
                  <div><dt>Send</dt><dd>{display(test.send)}</dd></div>
                  <div><dt>Receive</dt><dd>{display(test.receive)}</dd></div>
                  <div><dt>Latency</dt><dd>{display(test.latency)}</dd></div>
                </dl>) : <span className="missing-measurement" aria-label="No measurement">—</span>}</td>;
              })}
            </tr>)}</tbody>
          </table>
        </div>
      </div>;
    }) : <p className="panel-empty">{hasRuns ? 'No network tests in these submissions.' : 'No speed tests submitted yet.'}</p>}
  </section>;
}
function ioValue(value, units, blockSize) {
  const speed = diskSpeed(value, units, blockSize);
  return speed == null ? '—' : `${format.format(speed.value)}${speed.units ? ` ${speed.units}` : ''}`;
}
function DiskHistory({ runs, hasRuns }) {
  const blocks = [...new Set([...DISK_BLOCKS, ...runs.flatMap(run => (run.tests || []).map(test => diskBlock(test.blockSize)))])];
  const diskRuns = runs.filter(run => run.tests?.length);
  return <section className="node-panel disk-panel" aria-labelledby="disk-history-heading">
    <div className="node-panel-heading"><h2 id="disk-history-heading">Historical disk I/O</h2><p>One row per submission, newest first.</p></div>
    {diskRuns.length ? <div className="history-table-scroll" role="region" aria-label="Disk I/O history" tabIndex={0}>
      <table className="history-table disk-history-table">
        <caption className="sr-only">Disk I/O by date and block size. Read, write, and total each show throughput and IOPS.</caption>
        <thead><tr><th scope="col" className="history-date">Date</th>{blocks.map(block => <th scope="col" key={block}>{block}</th>)}</tr></thead>
        <tbody>{diskRuns.map(run => <tr key={run.id}>
          <th scope="row" className="history-date"><RunTime run={run} /></th>
          {blocks.map(block => {
            const tests = (run.tests || []).filter(test => diskBlock(test.blockSize) === block);
            return <td key={block}>{tests.length ? tests.map((test, index) => <dl className="history-metrics disk-metrics" key={index}>
              {[["Read", 'read', 'readIops'], ["Write", 'write', 'writeIops'], ["Total", 'combined', 'combinedIops']].map(([label, speed, iops]) => <div key={label}><dt>{label}</dt><dd><span>{ioValue(test[speed], test.speedUnits, block)}</span><small>{test[iops] == null ? '—' : format.format(test[iops])} IOPS</small></dd></div>)}
            </dl>) : <span className="missing-measurement" aria-label="No measurement">—</span>}</td>;
          })}
        </tr>)}</tbody>
      </table>
    </div> : <p className="panel-empty">{hasRuns ? 'No disk tests in these submissions.' : 'No disk I/O submitted yet.'}</p>}
  </section>;
}

async function fetchNode(hostname, offset, signal) {
  if (!hostname) throw new Error('This node address is invalid.');
  const response = await fetch(`/api/nodes/${encodeURIComponent(hostname)}?limit=20&offset=${offset}`, { signal });
  let body;
  try { body = await response.json(); } catch { throw new Error('The server returned an unexpected response.'); }
  if (!response.ok) {
    const failure = new Error(body.error || 'Could not load this node.');
    failure.status = response.status;
    throw failure;
  }
  return body;
}

function nextHistoryOffset(page) {
  return (page.pagination?.offset || 0) + (page.pagination?.limit || 20);
}

export default function NodePage({ hostname }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notFound, setNotFound] = useState(false);
  const [reload, setReload] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const nextOffset = useRef(0);
  const historyBusy = useRef(false);
  const historyRequest = useRef(null);
  const revision = useRef(0);
  const sentinel = useRef(null);
  useEffect(() => {
    const controller = new AbortController();
    const currentRevision = ++revision.current;
    historyRequest.current?.abort();
    historyBusy.current = false;
    nextOffset.current = 0;
    setLoading(true); setData(null); setError(''); setNotFound(false);
    setHistoryError(''); setHistoryLoading(false); setHasMore(false);
    async function load() {
      try {
        const body = await fetchNode(hostname, 0, controller.signal);
        if (controller.signal.aborted || revision.current !== currentRevision) return;
        nextOffset.current = nextHistoryOffset(body);
        setHasMore(nextOffset.current < (body.pagination?.totalRuns || 0));
        setData(body);
      } catch (failure) { if (failure.name !== 'AbortError' && revision.current === currentRevision) { setNotFound(failure.status === 404); setError(failure.message); } }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }
    load();
    return () => { controller.abort(); historyRequest.current?.abort(); };
  }, [hostname, reload]);
  const loadOlder = useCallback(async (retry = false) => {
    if (loading || error || !hasMore || historyBusy.current || (historyError && !retry)) return;
    historyBusy.current = true;
    const currentRevision = revision.current;
    const controller = new AbortController();
    historyRequest.current = controller;
    setHistoryLoading(true); setHistoryError('');
    try {
      const body = await fetchNode(hostname, nextOffset.current, controller.signal);
      if (controller.signal.aborted || currentRevision !== revision.current) return;
      nextOffset.current = nextHistoryOffset(body);
      setData(previous => ({ ...previous, ...body, history: {
        speedTests: appendRuns(previous?.history?.speedTests, body.history?.speedTests),
        diskIo: appendRuns(previous?.history?.diskIo, body.history?.diskIo),
      } }));
      setHasMore(nextOffset.current < (body.pagination?.totalRuns || 0));
    } catch (failure) {
      if (failure.name !== 'AbortError' && currentRevision === revision.current) setHistoryError(failure.message);
    } finally {
      if (currentRevision === revision.current) {
        historyBusy.current = false;
        setHistoryLoading(false);
      }
    }
  }, [hostname, loading, error, hasMore, historyError]);
  useEffect(() => {
    const target = sentinel.current;
    if (!target || loading || error || !hasMore || historyError) return;
    const check = () => {
      if (target.getBoundingClientRect().top <= window.innerHeight + 500) loadOlder();
    };
    const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) loadOlder();
    }, { rootMargin: '500px' }) : null;
    observer?.observe(target);
    // The scroll check also covers browsers without IntersectionObserver.
    window.addEventListener('scroll', check, { passive: true });
    window.addEventListener('resize', check);
    if (!observer) check();
    return () => {
      observer?.disconnect();
      window.removeEventListener('scroll', check);
      window.removeEventListener('resize', check);
    };
  }, [loading, error, hasMore, historyError, loadOlder, data]);
  const server = data?.server;
  const system = data?.system || {};
  const total = data?.pagination?.totalRuns || 0;
  const planTotal = (data?.plans || []).reduce((sum, plan) => sum + plan.count, 0);
  return <div className="app node-page">
    <header className="topbar"><a className="brand" href="/"><span className="brand-mark" aria-hidden="true">▦</span>pmdb<span className="brand-dot">.</span>fyi</a><span className="demo-label">A DATABASE OF PULSEDMEDIA NODES</span></header>
    <main>
      <nav className="node-navigation" aria-label="Node navigation"><a className="back-link" href="/">← Back to all nodes</a><button type="button" onClick={() => setReload(value => value + 1)} disabled={loading}>Refresh node</button></nav>
      {loading && <p className="node-loading" role="status">Loading node details…</p>}
      {error && <div className="error-box" role="alert"><strong>{notFound ? 'Node not found' : 'Could not load node'}</strong><p>{error}</p>{!notFound && <button type="button" onClick={() => setReload(value => value + 1)}>Retry</button>}</div>}
      {!error && server && <div aria-busy={loading}>
        <section className="node-overview" aria-labelledby="node-name">
          <div className="node-heading"><div><span className="node-eyebrow">NODE DETAILS</span><h1 id="node-name">{data.friendlyName || friendlyName(server.serverName)}</h1><p className="node-hostname">{server.serverName}</p></div><div className="node-user-count"><span>Number of users</span><strong>{data.userCount == null ? '—' : format.format(data.userCount)}</strong></div></div>
          <div className="node-system-grid">
            <section aria-label="Hardware"><h2>System information</h2><Measurements rows={[
              ['Datacenter', server.datacenter], ['Processor', server.processorName],
              ['Core count', server.coreCount], ['KVM', server.kvm == null ? '— Unknown' : server.kvm ? '✓ KVM' : '× NONE'],
              ['Processor MHz', server.processorMhz == null ? '—' : format.format(server.processorMhz)],
              ['RAM', size(server.ramBytes, 'GiB')], ['SWAP', size(server.swapBytes, 'GiB')],
              ['Total storage', size(server.storageBytes, 'TiB')], ['Intel QuickSync', server.qsv ? 'Yes' : 'No'],
            ]} /></section>
            <section aria-label="Operating system"><h2>Operating system</h2><Measurements rows={[
              ['OS', system.distro], ['Kernel', system.kernel], ['Architecture', system.arch], ['Virtualization', system.vm],
            ]} /><p className="node-updated">Last submitted: {dateLabel(data.updatedAt)}</p><p className="node-data-note">Hardware, user count, plans, and benchmarks are reported by contributors.</p></section>
          </div>
        </section>
        <div className="node-columns">
          <section className="node-panel" aria-labelledby="plans-heading"><div className="node-panel-heading"><h2 id="plans-heading">Pulsed Media plans</h2><p>{planTotal ? `${format.format(planTotal)} submitted ${planTotal === 1 ? 'plan' : 'plans'}` : 'No plan submissions yet.'}</p></div>
            {data.plans?.length ? <ul className="node-plan-list">{data.plans.map(plan => <li key={plan.name}><span>{plan.name}</span><strong aria-label={`${plan.count} ${plan.count === 1 ? 'user' : 'users'}`}>{format.format(plan.count)}</strong></li>)}</ul> : <p className="panel-empty">Plans appear when contributors include one with a YABS upload.</p>}
            <p className="plan-note">One current plan per submission identifier on this node. Several contributors may have the same plan. These counts may cover only some of the node’s users.</p>
          </section>
          <SpeedHistory runs={data.history?.speedTests || []} hasRuns={total > 0} />
          <DiskHistory runs={data.history?.diskIo || []} hasRuns={total > 0} />
        </div>
        <div ref={sentinel} className="history-sentinel" aria-live="polite">
          {historyLoading && <p role="status">Loading older benchmark results…</p>}
          {historyError && <div className="error-box" role="alert">Could not load older results: {historyError} <button type="button" onClick={() => loadOlder(true)}>Retry</button></div>}
        </div>
      </div>}
    </main>
  </div>;
}
