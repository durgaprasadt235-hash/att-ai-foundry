// Data view — bring your own dataset.
//
// The first call with a director runs on a sample file, not on live
// company data: nobody connects a live system into someone else's working
// environment on a first call, and a live connection takes days to weeks.
// Here the director's team uploads a sample file, sees the validation
// report, and tests with it in minutes.
//
// Privacy: files are read with FileReader in this browser only. Nothing
// is uploaded to any server — the dataset never leaves this device, and
// the built-in seed files are never touched. Loading a dataset replaces
// the working caseload in browser state (localStorage, like everything
// else in this app); "Reset to original dataset" restores the built-in
// seed.
import { useRef, useState } from 'react';
import type { AppState } from '../lib/types';
import {
  CSV_HEADERS,
  DATASET_MAX_BYTES,
  datasetFromCsvFiles,
  datasetToState,
  templateCsv,
  templateDatasetJson,
  validateDatasetJson,
  type DatasetTables,
  type DatasetValidation,
} from '../lib/dataset';

function download(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function DataView({ state, onLoadDataset, onReset, audit }: {
  state: AppState;
  onLoadDataset: (next: AppState, name: string) => void;
  onReset: () => void;
  audit: (actor: 'agent' | 'human' | 'system', action: string, detail: string) => void;
}) {
  const [validation, setValidation] = useState<DatasetValidation | null>(null);
  const [tables, setTables] = useState<DatasetTables | null>(null);
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const datasetName = state.datasetName ?? 'Built-in dataset';
  const datasetSource = state.datasetSource ?? 'builtin';

  const readFiles = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setError('');
    setValidation(null);
    setTables(null);
    const picked: { name: string; text: string }[] = [];
    for (const f of Array.from(list)) {
      const lower = f.name.toLowerCase();
      if (!lower.endsWith('.json') && !lower.endsWith('.csv')) {
        setError(`"${f.name}" is not a .json or .csv file. Upload a dataset JSON file, or one CSV per table.`);
        return;
      }
      if (f.size > DATASET_MAX_BYTES) {
        setError(`"${f.name}" is ${(f.size / 1_000_000).toFixed(1)} MB — datasets over 5 MB are rejected. Bring an anonymised sample, not a production dump.`);
        return;
      }
      picked.push({ name: f.name, text: await f.text() });
    }
    // picked files are validated below; only the names are kept for display.
    setFileName(picked.map((p) => p.name).join(', '));

    const jsonFile = picked.find((p) => p.name.toLowerCase().endsWith('.json'));
    if (jsonFile) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonFile.text);
      } catch (e) {
        setValidation(null);
        setError(`"${jsonFile.name}" is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      const { validation: v, tables: t } = validateDatasetJson(parsed);
      setValidation(v);
      setTables(t);
      return;
    }
    const csvs = picked.filter((p) => p.name.toLowerCase().endsWith('.csv'));
    if (csvs.length > 0) {
      const { validation: v, tables: t } = datasetFromCsvFiles(csvs);
      setValidation(v);
      setTables(t);
      return;
    }
    setError('No .json or .csv file was selected.');
  };

  const load = () => {
    if (!validation || !validation.valid || !tables) return;
    const name = fileName || 'Uploaded dataset';
    const next = datasetToState(tables, name);
    onLoadDataset(next, name);
    audit('human', 'dataset_loaded', `Loaded dataset "${name}": ${validation.counts.customers} customers, ${validation.counts.ledger} ledger entries, ${validation.counts.cases} cases. ${validation.warnings.length} warning(s) shown at load.`);
    // selection cleared after load
    setValidation(null);
    setTables(null);
    setFileName('');
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <section>
      <h1>Data — bring your own dataset</h1>
      <p className="muted">
        No live connection is needed for a first call. Bring an anonymised sample file, upload it here,
        check the validation report, and test with it in minutes. A live connection to AT&amp;T systems
        is a separate step that takes days to weeks — see <code>docs/DATASET_GUIDE.md</code>.
      </p>

      <div className="panel">
        <h2>Current dataset</h2>
        <p>
          <strong>{datasetName}</strong> ({datasetSource === 'uploaded' ? 'uploaded by you' : 'built-in seed'})
        </p>
        <p className="small muted">
          {state.customers.length} customers · {state.ledger.length} ledger entries · {state.usage.length} usage records ·{' '}
          {state.cases.length} cases · {state.docs.length} policy docs · {state.stairTrees.length} STAIR trees
        </p>
        <p className="small muted">
          Uploaded datasets stay in this browser only — they are stored in localStorage like the rest of the
          app state, never sent to a server, and never written into the built-in seed files.
        </p>
        {datasetSource === 'uploaded' && (
          confirmReset ? (
            <span className="row">
              <button className="btn small danger" onClick={() => { setConfirmReset(false); onReset(); }}>Confirm reset to original dataset</button>
              <button className="btn small secondary" onClick={() => setConfirmReset(false)}>Cancel</button>
            </span>
          ) : (
            <button className="btn small secondary" onClick={() => setConfirmReset(true)}>Reset to original dataset</button>
          )
        )}
      </div>

      <div className="panel mt">
        <h2>Upload a dataset</h2>
        <p className="small muted">
          One <strong>.json</strong> file (same shape as <code>test-data.json</code>), or one <strong>.csv</strong> per
          table: <code>customers.csv</code>, <code>ledger.csv</code>, <code>usage.csv</code>, <code>cases.csv</code>{' '}
          (required) and <code>tickets.csv</code> (optional). Policy docs and STAIR trees are JSON-only.
        </p>
        <input
          ref={inputRef}
          type="file"
          accept=".json,.csv"
          multiple
          onChange={(e) => void readFiles(e.target.files)}
        />
        {fileName && <p className="small">Selected: {fileName}</p>}
        {error && <p role="alert"><strong>Could not read file:</strong> {error}</p>}

        {validation && (
          <div className="mt">
            <h3>Validation report — {validation.valid ? 'valid, ready to load' : 'rejected, fix the errors first'}</h3>
            <p className="small">
              {validation.counts.customers} customers · {validation.counts.ledger} ledger entries ·{' '}
              {validation.counts.usage} usage records · {validation.counts.tickets} tickets ·{' '}
              {validation.counts.cases} cases · {validation.counts.docs} policy docs ·{' '}
              {validation.counts.stairTrees} STAIR trees
            </p>
            {validation.errors.length > 0 && (
              <div>
                <p><strong>{validation.errors.length} error(s) — these block the load:</strong></p>
                <ul>{validation.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
              </div>
            )}
            {validation.warnings.length > 0 && (
              <div>
                <p><strong>{validation.warnings.length} warning(s) — shown, but they do not block the load:</strong></p>
                <ul>{validation.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
              </div>
            )}
            {validation.filled.length > 0 && (
              <div>
                <p className="small muted"><strong>Auto-filled (listed, never silent):</strong></p>
                <ul>{validation.filled.map((f, i) => <li key={i} className="small muted">{f}</li>)}</ul>
              </div>
            )}
            {validation.valid && validation.errors.length === 0 && validation.warnings.length === 0 && (
              <p>No errors, no warnings. Balances reconcile to the cent and every reference resolves.</p>
            )}
            <button className="btn mt" disabled={!validation.valid || !tables} onClick={load}>
              Load this dataset
            </button>
            {!validation.valid && <p className="small muted">Nothing was loaded — fix the errors above and upload again.</p>}
          </div>
        )}
      </div>

      <div className="panel mt">
        <h2>Download a template</h2>
        <p className="small muted">
          Start from a small example that already passes validation (3 customers, 1 duplicate charge,
          1 case) and replace the rows with your own anonymised sample.
        </p>
        <div className="row">
          <button className="btn small secondary" onClick={() => download('dataset-template.json', templateDatasetJson(), 'application/json')}>dataset-template.json</button>
          {(Object.keys(CSV_HEADERS) as (keyof typeof CSV_HEADERS)[]).map((t) => (
            <button key={t} className="btn small secondary" onClick={() => download(`${t}.csv`, templateCsv(t), 'text/csv')}>{t}.csv</button>
          ))}
        </div>
        <p className="small muted">
          How to prepare a sample: <code>docs/DATASET_GUIDE.md</code> — what columns to export, how to
          anonymise names and phones, and what a good first-call sample looks like.
        </p>
      </div>
    </section>
  );
}
