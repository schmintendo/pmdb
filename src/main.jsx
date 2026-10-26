import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flexRender, getCoreRowModel, getFilteredRowModel, getPaginationRowModel, getSortedRowModel, useReactTable } from '@tanstack/react-table';
import './styles.css';
import './upload.css';

const displayNumber = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const gib = value => `${displayNumber.format(value / 1024 ** 3)} GiB`;
const tib = value => `${displayNumber.format(value / 1024 ** 4)} TiB`;
const columns = [
  { accessorKey: 'serverName', header: 'Server Name', cell: info => <strong className="server-name">{info.getValue()}</strong> },
  { accessorKey: 'processorName', header: 'Processor name' },
  { accessorKey: 'coreCount', header: 'Core count' },
  { accessorKey: 'processorMhz', header: 'Processor MHz', sortUndefined: 'last', cell: info => info.getValue() == null ? '—' : displayNumber.format(info.getValue()) },
  { accessorKey: 'ramBytes', header: 'RAM', cell: info => gib(info.getValue()) },
  { accessorKey: 'swapBytes', header: 'SWAP', cell: info => info.getValue() == null ? '—' : gib(info.getValue()) },
  { accessorKey: 'storageBytes', header: 'Total storage', cell: info => tib(info.getValue()) },
  { accessorKey: 'datacenter', header: 'Datacenter', filterFn: 'equalsString', cell: info => <span className="category">{info.getValue()}</span> },
  { id: 'kvm', accessorFn: row => row.kvm ?? undefined, header: 'KVM', sortingFn: 'basic', sortUndefined: 'last', cell: info => {
    const value = info.getValue();
    const description = value == null ? 'Unknown KVM status' : value ? 'KVM virtual machine' : 'No virtualization reported';
    return <span className={`kvm-marker ${value == null ? 'kvm-unknown' : value ? 'kvm-yes' : 'kvm-no'}`} role="img" aria-label={description} title={description}>{value == null ? '—' : value ? '✓' : '×'}</span>;
  } },
  { accessorKey: 'qsv', header: 'Intel QuickSync', filterFn: (row, id, value) => value === '' || row.getValue(id) === (value === 'yes'), cell: info => <span className={`status ${info.getValue() ? 'available' : 'neutral'}`}><i aria-hidden="true" />{info.getValue() ? 'Yes' : 'No'}</span> },
];
const searchServers = (row, _id, query) => {
  const haystack = [row.original.serverName, row.original.processorName, row.original.datacenter].join(' ').toLowerCase();
  return String(query).trim().toLowerCase().split(/\s+/).every(term => haystack.includes(term));
};
async function api(url, options) {
  const response = await fetch(url, options);
  let body;
  try { body = await response.json(); } catch { throw new Error('The server returned an unexpected response.'); }
  if (!response.ok) throw new Error(body.error || 'The request failed.');
  return body;
}

function UploadDialog({ onClose, onSaved }) {
  const ref = useRef(null);
  const fileInputRef = useRef(null);
  const [serverName, setServerName] = useState('');
  const [qsv, setQsv] = useState('');
  const [uploadKey, setUploadKey] = useState('');
  const [file, setFile] = useState(null);
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { ref.current.showModal(); }, []);
  const dc = serverName.trim().includes('-') ? serverName.trim().split('-')[0].toLowerCase() : 'Unknown';
  async function submit(event) {
    event.preventDefault();
    if (!file) return setError('Choose a YABS JSON or text file.');
    if (file.size > 800 * 1024) return setError('The file must be smaller than 800 KiB.');
    if (qsv === '') return setError('Choose Yes or No for Intel QuickSync.');
    setBusy(true); setError('');
    try {
      const result = await api('/api/servers', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${uploadKey}` },
        body: JSON.stringify({ serverName, qsv: qsv === 'yes', yabsText: await file.text(), replace }),
      });
      setUploadKey('');
      onSaved(result);
    } catch (error) { setError(error.message); }
    finally { setBusy(false); }
  }
  return <dialog ref={ref} className="upload-dialog" aria-labelledby="upload-title" onCancel={event => { if (busy) event.preventDefault(); else onClose(); }}>
    <form onSubmit={submit}>
      <div className="dialog-heading"><div><h2 id="upload-title">Upload a server</h2><p>Import hardware details from a YABS result.</p></div><button type="button" aria-label="Close upload" onClick={onClose} disabled={busy}>×</button></div>
      <label className="form-field">Server Name<input autoFocus required maxLength={253} value={serverName} onChange={e => setServerName(e.target.value)} placeholder="le0-000-000name.pulsedmedia.com" autoComplete="off" disabled={busy} /><small>Use the hostname. Datacenter: <strong>{dc}</strong></small></label>
      <div className="form-field" role="group" aria-labelledby="yabs-results-label">
        <span id="yabs-results-label">YABS results</span>
        <input ref={fileInputRef} id="yabs-file" hidden type="file" accept=".json,.txt,.log,application/json,text/plain" aria-label="YABS results file" onChange={e => setFile(e.target.files[0] || null)} disabled={busy} />
        <div className="yabs-file-row">
          <button type="button" aria-controls="yabs-file" aria-describedby="yabs-file-name" onClick={() => fileInputRef.current?.click()} disabled={busy}>Browse…</button>
          <span id="yabs-file-name" className="yabs-file-name" role="status">{file?.name || 'No file selected'}</span>
        </div>
        <small>YABS JSON:<code className="yabs-command">curl -sL yabs.sh | bash -s -- -figw yabs.json</code></small>
      </div>
      <label className="form-field">Intel QuickSync<select required value={qsv} onChange={e => setQsv(e.target.value)} disabled={busy}><option value="">Choose manually…</option><option value="yes">Yes</option><option value="no">No</option></select><small>Provided by you; this is not inferred from the processor name.</small></label>
      <label className="form-field">Upload key<input type="password" required value={uploadKey} onChange={e => setUploadKey(e.target.value)} autoComplete="off" disabled={busy} /><small>Ask the site administrator for the upload key.</small></label>
      <label className="checkbox-row"><input type="checkbox" checked={replace} onChange={e => setReplace(e.target.checked)} disabled={busy} />Replace existing server with this name</label>
      {error && <p className="error-box" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" onClick={onClose} disabled={busy}>Cancel</button><button className="primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save server'}</button></div>
    </form>
  </dialog>;
}

function App() {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadsEnabled, setUploadsEnabled] = useState(false);
  const [globalFilter, setGlobalFilter] = useState('');
  const [columnFilters, setColumnFilters] = useState([]);
  const [sorting, setSorting] = useState([{ id: 'serverName', desc: false }]);
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 10 });
  async function load() {
    setError(''); setLoading(true);
    try {
      const [records, config] = await Promise.all([api('/api/servers'), api('/api/config')]);
      setData(records); setUploadsEnabled(config.uploadsEnabled);
    } catch (error) { setError(error.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);
  async function saved(result) {
    setUploadOpen(false);
    setGlobalFilter(''); setColumnFilters([]); setPagination(p => ({ ...p, pageIndex: 0 }));
    setNotice(`${result.serverName} ${result.replaced ? 'updated' : 'added'}.`);
    await load();
  }
  const table = useReactTable({
    data, columns, state: { globalFilter, columnFilters, sorting, pagination },
    onGlobalFilterChange: setGlobalFilter, onColumnFiltersChange: setColumnFilters,
    onSortingChange: setSorting, onPaginationChange: setPagination,
    globalFilterFn: searchServers, getRowId: row => row.serverName,
    getCoreRowModel: getCoreRowModel(), getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(), getPaginationRowModel: getPaginationRowModel(),
  });
  const datacenters = [...new Set(data.map(row => row.datacenter))].sort();
  const count = table.getFilteredRowModel().rows.length;
  const rows = table.getRowModel().rows;
  const activeFilters = Boolean(globalFilter || columnFilters.length);
  function reset() { setGlobalFilter(''); setColumnFilters([]); table.setPageIndex(0); }
  return <div className="app">
    <header className="topbar"><a className="brand" href="./"><span className="brand-mark" aria-hidden="true">▦</span>pmdb<span className="brand-dot">.</span>fyi</a><span className="demo-label">A DATABASE OF PULSEDMEDIA NODES</span></header>
    <main>
      <section className="stats" aria-label="Catalog overview">
        <div><span>Servers</span><strong>{data.length}<small>in the catalog</small></strong></div>
        <div><span>Datacenters</span><strong>{datacenters.filter(dc => dc !== 'Unknown').length}<small>from hostnames</small></strong></div>
        <div><span>Intel QuickSync enabled</span><strong>{data.filter(row => row.qsv).length}<small>manually reported</small></strong></div>
        <button className="primary upload-button" onClick={() => { setNotice(''); setUploadOpen(true); }} disabled={!uploadsEnabled}>＋ Upload YABS</button>
      </section>
      {notice && <p className="success-box" role="status">{notice}</p>}
      {error && <div className="error-box" role="alert">{error} <button onClick={load}>Retry</button></div>}
      <section className="catalog" aria-labelledby="catalog-heading" aria-busy={loading}>
        <div className="catalog-title"><h2 id="catalog-heading">All servers <span>{data.length}</span></h2></div>
        <div className="toolbar">
          <label className="search"><span className="sr-only">Search servers</span><span aria-hidden="true">⌕</span><input type="search" placeholder="Search name, processor, datacenter…" value={globalFilter} onChange={e => table.setGlobalFilter(e.target.value)} /></label>
          <label className="sr-only" htmlFor="datacenter-filter">Filter by datacenter</label><select id="datacenter-filter" value={table.getColumn('datacenter').getFilterValue() ?? ''} onChange={e => table.getColumn('datacenter').setFilterValue(e.target.value || undefined)}><option value="">All datacenters</option>{datacenters.map(dc => <option key={dc}>{dc}</option>)}</select>
          <label className="sr-only" htmlFor="qsv-filter">Filter by Intel QuickSync</label><select id="qsv-filter" value={table.getColumn('qsv').getFilterValue() ?? ''} onChange={e => table.getColumn('qsv').setFilterValue(e.target.value || undefined)}><option value="">Any Intel QuickSync</option><option value="yes">Intel QuickSync: Yes</option><option value="no">Intel QuickSync: No</option></select>
          {activeFilters && <button className="reset" onClick={reset}>Reset filters</button>}
          <button className="refresh-button" onClick={load} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
        </div>
        <div className="table-scroll" role="region" aria-label="Server table" tabIndex={0}>
          <table><caption className="sr-only">Server hardware. Use the column headers to sort.</caption>
            <thead>{table.getHeaderGroups().map(group => <tr key={group.id}>{group.headers.map(header => <th scope="col" key={header.id} aria-sort={header.column.getIsSorted() === 'asc' ? 'ascending' : header.column.getIsSorted() === 'desc' ? 'descending' : 'none'}><button onClick={header.column.getToggleSortingHandler()}>{flexRender(header.column.columnDef.header, header.getContext())}<span aria-hidden="true" className={header.column.getIsSorted() ? 'sort active' : 'sort'}>{header.column.getIsSorted() === 'asc' ? '↑' : header.column.getIsSorted() === 'desc' ? '↓' : '↕'}</span></button></th>)}</tr>)}</thead>
            <tbody>{rows.length ? rows.map(row => <tr key={row.id}>{row.getVisibleCells().map(cell => <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>)}</tr>) : <tr><td colSpan={columns.length}><div className="empty"><strong>{loading ? 'Loading servers…' : error ? 'Could not load the catalog' : data.length ? 'No matching servers' : 'Your catalog is ready'}</strong><p>{loading ? 'Fetching the latest catalog.' : error ? 'Use Retry above to reconnect.' : data.length ? 'Try a different search or clear your filters.' : 'Upload a YABS file to add your first server.'}</p>{activeFilters && <button onClick={reset}>Clear filters</button>}</div></td></tr>}</tbody>
          </table>
        </div>
        <footer className="pagination"><span role="status">{count ? `${pagination.pageIndex * pagination.pageSize + 1}–${pagination.pageIndex * pagination.pageSize + rows.length}` : '0'} of {count} servers</span><div className="page-controls"><label htmlFor="page-size">Rows per page</label><select id="page-size" value={pagination.pageSize} onChange={e => table.setPageSize(Number(e.target.value))}>{[10, 25, 50, 100].map(size => <option key={size} value={size}>{size}</option>)}</select><span>Page {count ? pagination.pageIndex + 1 : 0} of {table.getPageCount()}</span><button aria-label="Previous page" disabled={!table.getCanPreviousPage()} onClick={() => table.previousPage()}>←</button><button aria-label="Next page" disabled={!table.getCanNextPage()} onClick={() => table.nextPage()}>→</button></div></footer>
      </section>
      <footer className="page-footer"><span>All values, except for Intel QuickSync, as reported by YABS</span><span>{!loading && !uploadsEnabled ? 'Uploads are currently unavailable.' : 'Blatantly vibe-coded by schmintendo.'}</span></footer>
    </main>
    {uploadOpen && <UploadDialog onClose={() => setUploadOpen(false)} onSaved={saved} />}
  </div>;
}
createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
