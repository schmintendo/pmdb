import React, { useEffect, useState } from 'react';

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
  return <div className="run-time"><time dateTime={run.measuredAt || run.submittedAt}>{dateLabel(run.measuredAt || run.submittedAt)}</time><span>{run.measuredAt ? 'YABS run' : 'Submitted'}</span></div>;
}
function SpeedHistory({ runs, hasRuns }) {
  return <section className="node-panel" aria-labelledby="speed-history-heading">
    <div className="node-panel-heading"><h2 id="speed-history-heading">Historical speed tests</h2><p>YABS results vary with time and node activity.</p></div>
    {runs.length ? runs.map(run => <article className="benchmark-run" key={run.id}>
      <RunTime run={run} />
      {run.tests.map((test, index) => <div className="benchmark-test" key={index}>
        <h3>{test.provider || 'Test endpoint'} <span>{test.mode}</span></h3>
        {test.location && <p className="test-location">{test.location}</p>}
        <Measurements rows={[
          ['Send', test.send], ['Receive', test.receive], ['Latency', test.latency],
        ]} />
      </div>)}
    </article>) : <p className="panel-empty">{hasRuns ? 'No network tests in these submissions.' : 'No speed tests submitted yet.'}</p>}
  </section>;
}
function ioValue(value, units) {
  return value == null ? '—' : `${format.format(value)}${units ? ` ${units}` : ''}`;
}
function DiskHistory({ runs, hasRuns }) {
  return <section className="node-panel" aria-labelledby="disk-history-heading">
    <div className="node-panel-heading"><h2 id="disk-history-heading">Historical disk I/O</h2><p>Measurements retain their original YABS units.</p></div>
    {runs.length ? runs.map(run => <article className="benchmark-run" key={run.id}>
      <RunTime run={run} />
      {run.tests.map((test, index) => <div className="benchmark-test" key={index}>
        <h3>{test.blockSize || 'Disk test'}</h3>
        <Measurements rows={[
          ['Read', ioValue(test.read, test.speedUnits)],
          ['Write', ioValue(test.write, test.speedUnits)],
          ['Combined', ioValue(test.combined, test.speedUnits)],
          ['Read IOPS', test.readIops == null ? '—' : format.format(test.readIops)],
          ['Write IOPS', test.writeIops == null ? '—' : format.format(test.writeIops)],
          ['Combined IOPS', test.combinedIops == null ? '—' : format.format(test.combinedIops)],
        ]} />
      </div>)}
    </article>) : <p className="panel-empty">{hasRuns ? 'No disk tests in these submissions.' : 'No disk I/O submitted yet.'}</p>}
  </section>;
}

export default function NodePage({ hostname }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notFound, setNotFound] = useState(false);
  const [offset, setOffset] = useState(0);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setNotFound(false);
    async function load() {
      try {
        if (!hostname) throw new Error('This node address is invalid.');
        const response = await fetch(`/api/nodes/${encodeURIComponent(hostname)}?limit=20&offset=${offset}`, { signal: controller.signal });
        let body;
        try { body = await response.json(); } catch { throw new Error('The server returned an unexpected response.'); }
        if (!response.ok) {
          if (response.status === 404) setNotFound(true);
          throw new Error(body.error || 'Could not load this node.');
        }
        setData(body);
      } catch (failure) { if (failure.name !== 'AbortError') setError(failure.message); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }
    load();
    return () => controller.abort();
  }, [hostname, offset, reload]);
  const server = data?.server;
  const system = data?.system || {};
  const pagination = data?.pagination || { limit: 20, offset: 0, totalRuns: 0 };
  const total = pagination.totalRuns;
  const planTotal = (data?.plans || []).reduce((sum, plan) => sum + plan.count, 0);
  return <div className="app node-page">
    <header className="topbar"><a className="brand" href="/"><span className="brand-mark" aria-hidden="true">▦</span>pmdb<span className="brand-dot">.</span>fyi</a><span className="demo-label">A DATABASE OF PULSEDMEDIA NODES</span></header>
    <main>
      <nav className="node-navigation" aria-label="Node navigation"><a className="back-link" href="/">← Back to all nodes</a><button type="button" onClick={() => setReload(value => value + 1)} disabled={loading}>Refresh node</button></nav>
      {loading && <p className="node-loading" role="status">Loading node details…</p>}
      {error && <div className="error-box" role="alert"><strong>{notFound ? 'Node not found' : 'Could not load node'}</strong><p>{error}</p>{!notFound && <button type="button" onClick={() => setReload(value => value + 1)}>Retry</button>}</div>}
      {!error && server && <div aria-busy={loading}>
        <section className="node-overview" aria-labelledby="node-name">
          <div className="node-heading"><div><span className="node-eyebrow">NODE DETAILS</span><h1 id="node-name">{data.friendlyName || friendlyName(server.serverName)}</h1><p className="node-hostname">{server.serverName}</p></div><div className="node-user-count"><span>Number of users</span><strong>{data.userCount == null ? '—' : format.format(data.userCount)}</strong><small>Latest submitted count of UIDs &gt; 1000</small></div></div>
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
            {data.plans?.length ? <ul className="node-plan-list">{data.plans.map(plan => <li key={plan.name}><span>{plan.name}</span><strong aria-label={`${plan.count} ${plan.count === 1 ? 'user' : 'users'}`}>{format.format(plan.count)}</strong></li>)}</ul> : <p className="panel-empty">Plans appear when users upload a YABS result.</p>}
            <p className="plan-note">One current plan per submission identifier on this node. Several contributors may have the same plan. These counts may cover only some of the node’s users.</p>
          </section>
          <SpeedHistory runs={data.history?.speedTests || []} hasRuns={total > 0} />
          <DiskHistory runs={data.history?.diskIo || []} hasRuns={total > 0} />
        </div>
        <nav className="history-pagination" aria-label="Benchmark history pages"><span role="status">{total ? `Benchmark submissions ${pagination.offset + 1}–${Math.min(pagination.offset + pagination.limit, total)} of ${format.format(total)}` : 'No benchmark history yet'}</span><div><button type="button" disabled={loading || offset === 0} onClick={() => setOffset(Math.max(0, offset - pagination.limit))}>← Newer</button><button type="button" disabled={loading || pagination.offset + pagination.limit >= total} onClick={() => setOffset(offset + pagination.limit)}>Older →</button></div></nav>
      </div>}
    </main>
  </div>;
}
