"use client";
import { useState, useRef, useCallback } from "react";
import * as XLSX from "xlsx";

// ── Types ──────────────────────────────────────────────────────────
interface InputRow {
  img_url: string;
  length_cm?: number;
  breadth_cm?: number;
  height_cm?: number;
  dead_weight_kg?: number;
  [key: string]: unknown;
}

interface Prediction {
  url: string;
  label: string;
  confidence: number;
  package_type: string;
  send_to_client: boolean;
  scores: Record<string, number>;
  status: string;
  reason: string;
  length_cm?: number;
  breadth_cm?: number;
  height_cm?: number;
  dead_weight_kg?: number;
  vol_weight_kg?: number;
  chargeable_weight_kg?: number;
  awb_no?: string;
  location?: string;
}

type ResultMap = Record<number, Prediction>;

// ── Config ─────────────────────────────────────────────────────────
const API = process.env.NEXT_PUBLIC_API_URL || "https://your-space.hf.space";
const BATCH_SIZE = 25;

// ── Label styling ──────────────────────────────────────────────────
const LABELS: Record<string, { bg: string; color: string; border: string; icon: string }> = {
  good:          { bg: "#dcfce7", color: "#15803d", border: "#86efac", icon: "✓" },
  half_cut:      { bg: "#fef3c7", color: "#b45309", border: "#fcd34d", icon: "✂" },
  hand_issue:    { bg: "#fee2e2", color: "#b91c1c", border: "#fca5a5", icon: "✋" },
  multi_parcel:  { bg: "#ede9fe", color: "#6d28d9", border: "#c4b5fd", icon: "⊞" },
  flyer:         { bg: "#dbeafe", color: "#1d4ed8", border: "#93c5fd", icon: "✉" },
  box:           { bg: "#f1f5f9", color: "#475569", border: "#cbd5e1", icon: "📦" },
  access_denied: { bg: "#f8fafc", color: "#64748b", border: "#cbd5e1", icon: "🔒" },
  error:         { bg: "#fee2e2", color: "#b91c1c", border: "#fca5a5", icon: "!" },
};

function LabelChip({ label }: { label: string }) {
  const m = LABELS[label] || LABELS.error;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      padding: "3px 10px", borderRadius: 20,
      fontSize: 12, fontWeight: 600,
      background: m.bg, color: m.color, border: `1px solid ${m.border}`,
    }}>
      {m.icon} {label.replace(/_/g, " ").toUpperCase()}
    </span>
  );
}

function ConfBar({ value }: { value: number }) {
  const color = value >= 85 ? "#16a34a" : value >= 60 ? "#d97706" : "#dc2626";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ fontFamily: "var(--mono)", fontSize: 13, fontWeight: 600, color, minWidth: 44 }}>{value}%</span>
      <div style={{ flex: 1, height: 6, background: "#e2e8f0", borderRadius: 3, minWidth: 60 }}>
        <div style={{ height: "100%", width: `${value}%`, background: color, borderRadius: 3, transition: "width .4s" }} />
      </div>
    </div>
  );
}

function calcVolWeight(l?: number, b?: number, h?: number) {
  if (!l || !b || !h) return null;
  return Math.round((l * b * h) / 5000 * 100) / 100;
}

// ── Main component ─────────────────────────────────────────────────
export default function SorterApp() {
  const [rows, setRows]       = useState<InputRow[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [urlCol, setUrlCol]   = useState("img_url");
  const [results, setResults] = useState<ResultMap>({});
  const [running, setRunning] = useState(false);
  const [done, setDone]       = useState(0);
  const [tab, setTab]         = useState<"predictions" | "data">("predictions");
  const [filter, setFilter]   = useState("all");
  const [modelStatus, setModelStatus] = useState<string>("");
  const stopRef = useRef(false);

  // ── Parse Excel ──────────────────────────────────────────────────
  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      const wb = XLSX.read(evt.target!.result, { type: "binary" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const data = XLSX.utils.sheet_to_json<InputRow>(ws, { defval: "" });
      if (!data.length) return;
      const cols = Object.keys(data[0]);
      setColumns(cols);
      const guessed = cols.find(c => /url|link|img|image|photo/i.test(c)) || cols[0];
      setUrlCol(guessed);
      setRows(data);
      setResults({});
      setDone(0);
      setFilter("all");
    };
    reader.readAsBinaryString(f);
  };

  // ── Run classification ────────────────────────────────────────────
  const run = useCallback(async () => {
    if (!rows.length || running) return;
    setRunning(true); stopRef.current = false;
    setResults({}); setDone(0);

    const urls = rows.map(r => String(r[urlCol] || ""));
    let processed = 0;

    for (let i = 0; i < urls.length; i += BATCH_SIZE) {
      if (stopRef.current) break;
      const batch = urls.slice(i, i + BATCH_SIZE);
      try {
        const res = await fetch(`${API}/predict/batch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items: batch.map(url => ({ img_url: url })),
          }),
        });
        const data = await res.json();
        // New backend wraps results in data.results
        const predictions: Record<string, unknown>[] = data.results ?? data;
        const update: ResultMap = {};
        predictions.forEach((p, j) => {
          update[i + j] = {
            url:            batch[j],
            label:          String(p.predicted_label ?? p.label ?? "error"),
            confidence:     Number(p["confidence_%"] ?? p.confidence ?? 0),
            package_type:   String(p.parcel_type ?? p.package_type ?? "unknown"),
            send_to_client: p.send_to_client === "YES" || p.send_to_client === true,
            scores:         (p.shipment_scores ?? p.scores ?? {}) as Record<string, number>,
            status:         String(p.status ?? "success"),
            reason:         String(p.pipeline ?? p.reason ?? ""),
            length_cm:            p.length   as number | undefined,
            breadth_cm:           p.breadth  as number | undefined,
            height_cm:            p.height   as number | undefined,
            dead_weight_kg:       p.dead_weight        as number | undefined,
            vol_weight_kg:        p.vol_weight         as number | undefined,
            chargeable_weight_kg: p.chargeable_weight  as number | undefined,
            awb_no:               p.awb_no   as string | undefined,
            location:             p.location as string | undefined,
          };
        });
        processed += batch.length;
        setResults(prev => ({ ...prev, ...update }));
        setDone(processed);
      } catch {
        const update: ResultMap = {};
        batch.forEach((url, j) => {
          update[i + j] = {
            url, label: "error", confidence: 0,
            package_type: "unknown", send_to_client: false,
            scores: {}, status: "network_error", reason: "Network error",
          };
        });
        processed += batch.length;
        setResults(prev => ({ ...prev, ...update }));
        setDone(processed);
      }
    }
    setRunning(false);
  }, [rows, urlCol, running]);

  // ── Reload model ──────────────────────────────────────────────────
  const reloadModel = async () => {
    try {
      setModelStatus("Triggering reload…");
      const r = await fetch(`${API}/reload-model`, { method: "POST" });
      const d = await r.json();
      setModelStatus(d.message || "Reload triggered");
    } catch {
      setModelStatus("Failed to reach API");
    }
    setTimeout(() => setModelStatus(""), 6000);
  };

  // ── Export Excel ──────────────────────────────────────────────────
  const exportXlsx = () => {
    const predData = rows.map((r, i) => {
      const res: Partial<Prediction> = results[i] || {};
      return {
        img_url:         String(r[urlCol] || ""),
        parcel_type:     res.package_type || "",
        predicted_label: res.label || "",
        confidence_pct:  res.confidence ?? "",
        send_to_client:  res.send_to_client ? "YES" : "NO",
        pipeline:        res.reason || "",
        ...(res.scores || {}),
      };
    });

    const dataSheet = rows.map((r, i) => {
      const res = results[i];
      const L  = res?.length_cm  || Number(r.length_cm)  || undefined;
      const B  = res?.breadth_cm || Number(r.breadth_cm) || undefined;
      const H  = res?.height_cm  || Number(r.height_cm)  || undefined;
      const DW = res?.dead_weight_kg || Number(r.dead_weight_kg) || undefined;
      const VW = res?.vol_weight_kg  || calcVolWeight(L, B, H);
      const CW = res?.chargeable_weight_kg || ((DW && VW) ? Math.max(DW, VW) : DW || VW || "");
      return {
        img_url:              String(r[urlCol] || ""),
        predicted_label:      res?.label || "",
        parcel_type:          res?.package_type || "",
        length_cm:            L || "",
        breadth_cm:           B || "",
        height_cm:            H || "",
        dead_weight_kg:       DW || "",
        vol_weight_kg:        VW || "",
        chargeable_weight_kg: CW,
      };
    });

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(predData), "Predictions");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(dataSheet), "Data");
    XLSX.writeFile(wb, "sorter_results.xlsx");
  };

  // ── Derived stats ─────────────────────────────────────────────────
  const total     = rows.length;
  const doneCount = Object.keys(results).length;
  const sendN     = Object.values(results).filter(r => r.send_to_client).length;
  const flagN     = doneCount - sendN;
  const pct       = total ? Math.round((doneCount / total) * 100) : 0;

  const labelCounts: Record<string, number> = {};
  Object.values(results).forEach(r => {
    labelCounts[r.label] = (labelCounts[r.label] || 0) + 1;
  });

  const flyers = Object.values(results).filter(r => r.package_type === "flyer").length;
  const boxes  = Object.values(results).filter(r => r.package_type === "box").length;

  // ── Filtered rows ─────────────────────────────────────────────────
  const visibleRows = rows.map((r, i) => ({
    ...r, _i: i,
    _url: String(r[urlCol] || ""),
    _res: results[i] as Prediction | undefined,
  })).filter(r => {
    if (filter === "all")     return true;
    if (filter === "send")    return r._res?.send_to_client === true;
    if (filter === "flag")    return r._res && !r._res.send_to_client;
    if (filter === "pending") return !r._res;
    if (filter === "flyer")   return r._res?.package_type === "flyer";
    if (filter === "box")     return r._res?.package_type === "box";
    return r._res?.label === filter;
  });

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)" }}>

      {/* ── Header ── */}
      <header style={{
        background: "var(--surface)", borderBottom: "1px solid var(--border)",
        padding: "0 28px", display: "flex", alignItems: "center",
        height: 60, gap: 16, position: "sticky", top: 0, zIndex: 100,
        boxShadow: "0 1px 3px rgba(0,0,0,.06)",
      }}>
        <div style={{
          width: 36, height: 36, background: "#2563eb", borderRadius: 9,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 18, flexShrink: 0,
        }}>📦</div>
        <div>
          <div style={{ fontSize: 16, fontWeight: 800, color: "var(--text)", letterSpacing: "-0.02em" }}>Sorter</div>
          <div style={{ fontSize: 11, color: "var(--text3)", fontWeight: 500, letterSpacing: "0.05em" }}>IMAGE ANALYSIS TOOL</div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
          {modelStatus && (
            <span style={{ fontSize: 12, color: "#2563eb", background: "#dbeafe", padding: "4px 10px", borderRadius: 6 }}>
              {modelStatus}
            </span>
          )}
          <button onClick={reloadModel} style={{
            background: "var(--surface2)", border: "1px solid var(--border)",
            borderRadius: 8, padding: "7px 14px", fontSize: 12, fontWeight: 600,
            color: "var(--text2)", display: "flex", alignItems: "center", gap: 6, cursor: "pointer",
          }}>↻ Reload Model</button>
          {doneCount > 0 && (
            <span style={{ fontSize: 12, color: "var(--text3)" }}>
              <span style={{ color: "#2563eb", fontWeight: 700 }}>{doneCount}</span>/{total}
            </span>
          )}
        </div>
      </header>

      <main style={{ padding: "24px 28px", maxWidth: 1440, margin: "0 auto" }}>

        {/* ── Upload ── */}
        <div style={{
          background: "var(--surface)", border: "1px solid var(--border)",
          borderRadius: 12, padding: "20px 24px", marginBottom: 20,
          boxShadow: "0 1px 3px rgba(0,0,0,.05)",
        }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text3)", letterSpacing: "0.1em", marginBottom: 14 }}>
            UPLOAD EXCEL
          </div>
          <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
            <input type="file" accept=".xlsx,.xls,.csv" onChange={handleFile} style={{
              flex: 1, minWidth: 260,
              background: "var(--surface2)", border: "1px solid var(--border)",
              borderRadius: 8, padding: "9px 14px", color: "var(--text)", fontSize: 13,
            }} />
            {columns.length > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                <span style={{ fontSize: 12, color: "var(--text3)", fontWeight: 600 }}>URL column:</span>
                <select value={urlCol} onChange={e => setUrlCol(e.target.value)}>
                  {columns.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <span style={{ fontSize: 12, color: "var(--text3)", fontFamily: "var(--mono)" }}>{rows.length} rows</span>
              </div>
            )}
          </div>
          {rows.length > 0 && (
            <div style={{ marginTop: 12, fontSize: 12, color: "var(--text3)", padding: "8px 12px", background: "#f0f9ff", borderRadius: 6, border: "1px solid #bae6fd" }}>
              💡 Include <code style={{ fontFamily: "var(--mono)", background: "#e0f2fe", padding: "1px 5px", borderRadius: 3 }}>length_cm</code>, <code style={{ fontFamily: "var(--mono)", background: "#e0f2fe", padding: "1px 5px", borderRadius: 3 }}>breadth_cm</code>, <code style={{ fontFamily: "var(--mono)", background: "#e0f2fe", padding: "1px 5px", borderRadius: 3 }}>height_cm</code>, <code style={{ fontFamily: "var(--mono)", background: "#e0f2fe", padding: "1px 5px", borderRadius: 3 }}>dead_weight_kg</code> for the Data tab.
            </div>
          )}
        </div>

        {/* ── Action buttons ── */}
        {rows.length > 0 && (
          <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap", alignItems: "center" }}>
            <button onClick={run} disabled={running} style={{
              background: running ? "#93c5fd" : "#2563eb", color: "white", border: "none",
              borderRadius: 9, padding: "10px 24px", fontSize: 14, fontWeight: 700,
              boxShadow: running ? "none" : "0 2px 8px rgba(37,99,235,.3)",
              cursor: running ? "not-allowed" : "pointer",
            }}>
              {running ? `⟳  ${doneCount} / ${total} — ${pct}%` : "▶  Run Classification"}
            </button>
            {running && (
              <button onClick={() => { stopRef.current = true; }} style={{
                background: "#fee2e2", color: "#b91c1c",
                border: "1px solid #fca5a5", borderRadius: 9,
                padding: "10px 18px", fontSize: 13, fontWeight: 600, cursor: "pointer",
              }}>■ Stop</button>
            )}
            {doneCount > 0 && !running && (
              <button onClick={exportXlsx} style={{
                background: "#dcfce7", color: "#15803d",
                border: "1px solid #86efac", borderRadius: 9,
                padding: "10px 18px", fontSize: 13, fontWeight: 600, cursor: "pointer",
              }}>↓ Export Excel (2 sheets)</button>
            )}
          </div>
        )}

        {/* ── Progress bar ── */}
        {(running || (doneCount > 0 && doneCount < total)) && (
          <div style={{ height: 4, background: "#e2e8f0", borderRadius: 2, marginBottom: 20, overflow: "hidden" }}>
            <div style={{
              height: "100%", width: `${pct}%`,
              background: "linear-gradient(90deg, #2563eb, #60a5fa)",
              transition: "width .3s", borderRadius: 2,
            }} />
          </div>
        )}

        {/* ── Stats cards ── */}
        {doneCount > 0 && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(130px,1fr))", gap: 12, marginBottom: 24 }}>
            {[
              { label: "Total",     value: total,  color: "#2563eb", bg: "#dbeafe" },
              { label: "✓ Send",    value: sendN,  color: "#15803d", bg: "#dcfce7" },
              { label: "✗ Flagged", value: flagN,  color: "#b91c1c", bg: "#fee2e2" },
              { label: "📦 Box",    value: boxes,  color: "#475569", bg: "#f1f5f9" },
              { label: "✉ Flyer",  value: flyers, color: "#1d4ed8", bg: "#dbeafe" },
              ...Object.entries(labelCounts).map(([k, v]) => ({
                label: k.replace(/_/g, " "), value: v,
                color: LABELS[k]?.color || "#475569",
                bg:    LABELS[k]?.bg    || "#f1f5f9",
              }))
            ].map((s, i) => (
              <div key={i} style={{
                background: "var(--surface)", border: "1px solid var(--border)",
                borderRadius: 10, padding: "14px 16px",
                boxShadow: "0 1px 3px rgba(0,0,0,.04)",
              }}>
                <div style={{ fontSize: 24, fontWeight: 800, color: s.color, letterSpacing: "-0.02em" }}>{s.value}</div>
                <div style={{ fontSize: 11, color: "var(--text3)", fontWeight: 600, marginTop: 3, textTransform: "uppercase", letterSpacing: "0.08em" }}>{s.label}</div>
              </div>
            ))}
          </div>
        )}

        {/* ── Tabs ── */}
        <div style={{ display: "flex", borderBottom: "2px solid var(--border)", marginBottom: 20 }}>
          {(["predictions", "data"] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              background: "none", border: "none", padding: "10px 20px",
              fontSize: 14, fontWeight: 600,
              color: tab === t ? "#2563eb" : "var(--text3)",
              borderBottom: tab === t ? "2px solid #2563eb" : "2px solid transparent",
              marginBottom: -2, cursor: "pointer", textTransform: "capitalize",
            }}>
              {t === "predictions" ? "📋  Predictions" : "📐  Data (L/B/H + Weights)"}
            </button>
          ))}
        </div>

        {/* ── PREDICTIONS TAB ── */}
        {tab === "predictions" && (
          <>
            {doneCount > 0 && (
              <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
                {[
                  ["all","All"], ["send","✓ Send"], ["flag","✗ Flagged"], ["pending","⏳ Pending"],
                  ["flyer","✉ Flyer"], ["box","📦 Box"],
                  ["good","Good"], ["half_cut","Half Cut"], ["hand_issue","Hand"],
                  ["access_denied","Blocked"],
                ].map(([v, l]) => (
                  <button key={v} onClick={() => setFilter(v)} style={{
                    background: filter === v ? "#dbeafe" : "var(--surface2)",
                    border: `1px solid ${filter === v ? "#93c5fd" : "var(--border)"}`,
                    color: filter === v ? "#1d4ed8" : "var(--text2)",
                    borderRadius: 20, padding: "5px 12px",
                    fontSize: 12, fontWeight: 600, cursor: "pointer",
                  }}>{l}</button>
                ))}
                <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--text3)" }}>{visibleRows.length} shown</span>
              </div>
            )}

            <div style={{
              background: "var(--surface)", border: "1px solid var(--border)",
              borderRadius: 12, overflow: "hidden",
              boxShadow: "0 1px 3px rgba(0,0,0,.05)",
            }}>
              {rows.length === 0 ? (
                <div style={{ padding: "80px 40px", textAlign: "center" }}>
                  <div style={{ fontSize: 48, marginBottom: 16 }}>📦</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text2)", marginBottom: 8 }}>Upload an Excel file to begin</div>
                  <div style={{ fontSize: 13, color: "var(--text3)", lineHeight: 1.9 }}>
                    Pipeline: BoxFlyer model → Shipment quality model<br />
                    Classes: box · flyer · good · half_cut · hand_issue<br />
                    Send to client = box + good + confidence ≥ 85%
                  </div>
                </div>
              ) : (
                <div style={{ overflowX: "auto", maxHeight: "55vh", overflowY: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead style={{ position: "sticky", top: 0, zIndex: 2, background: "#f8fafc" }}>
                      <tr>
                        {["#", "Preview", "URL", "Type", "Quality", "Confidence", "Pipeline", "Decision"].map(h => (
                          <th key={h} style={{
                            padding: "10px 14px", fontSize: 11, fontWeight: 700,
                            color: "var(--text3)", letterSpacing: "0.08em",
                            borderBottom: "1px solid var(--border)", textTransform: "uppercase",
                            textAlign: "left",
                          }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {visibleRows.map((row, vi) => {
                        const res = row._res;
                        return (
                          <tr key={row._i} style={{ borderBottom: "1px solid #f1f5f9", background: vi % 2 === 0 ? "white" : "#fafafa" }}>
                            <td style={{ padding: "8px 14px", color: "var(--text3)", fontFamily: "var(--mono)", fontSize: 12, width: 42 }}>{row._i + 1}</td>

                            {/* Thumb */}
                            <td style={{ padding: "8px 14px", width: 68 }}>
                              {row._url && (
                                <div style={{ position: "relative", width: 52, height: 40 }}>
                                  <img src={row._url} alt="" style={{
                                    width: 52, height: 40, objectFit: "cover",
                                    borderRadius: 6, border: "1px solid var(--border)", display: "block",
                                  }}
                                    onError={e => {
                                      (e.target as HTMLImageElement).style.display = "none";
                                      ((e.target as HTMLImageElement).nextSibling as HTMLElement).style.display = "flex";
                                    }}
                                  />
                                  <div style={{
                                    display: "none", width: 52, height: 40,
                                    background: "#f1f5f9", border: "1px solid var(--border)",
                                    borderRadius: 6, alignItems: "center", justifyContent: "center",
                                    fontSize: 18, position: "absolute", top: 0, left: 0,
                                  }}>🔒</div>
                                </div>
                              )}
                            </td>

                            {/* URL */}
                            <td style={{ padding: "8px 14px", maxWidth: 200 }}>
                              <a href={row._url} target="_blank" rel="noreferrer" style={{
                                color: "#3b82f6", textDecoration: "none", fontSize: 11,
                                fontFamily: "var(--mono)", display: "block",
                                overflow: "hidden", textOverflow: "ellipsis", maxWidth: 200,
                              }} title={row._url}>{row._url}</a>
                            </td>

                            {/* Parcel type */}
                            <td style={{ padding: "8px 14px" }}>
                              {res && (
                                <span style={{
                                  display: "inline-flex", alignItems: "center", gap: 4,
                                  padding: "2px 8px", borderRadius: 12, fontSize: 11, fontWeight: 600,
                                  background: res.package_type === "flyer" ? "#dbeafe" : "#f1f5f9",
                                  color: res.package_type === "flyer" ? "#1d4ed8" : "#475569",
                                  border: res.package_type === "flyer" ? "1px solid #93c5fd" : "1px solid #cbd5e1",
                                }}>
                                  {res.package_type === "flyer" ? "✉" : "📦"} {res.package_type?.toUpperCase()}
                                </span>
                              )}
                            </td>

                            {/* Quality label */}
                            <td style={{ padding: "8px 14px" }}>
                              {!res && running ? (
                                <span style={{ color: "var(--text3)", fontSize: 12, animation: "pulse 1.5s infinite" }}>analyzing…</span>
                              ) : res ? (
                                <LabelChip label={res.label} />
                              ) : null}
                            </td>

                            {/* Confidence */}
                            <td style={{ padding: "8px 14px", minWidth: 130 }}>
                              {res && <ConfBar value={res.confidence} />}
                            </td>

                            {/* Pipeline */}
                            <td style={{ padding: "8px 14px", fontSize: 12, color: "var(--text2)", whiteSpace: "nowrap" }}>
                              {res?.reason || "—"}
                            </td>

                            {/* Decision */}
                            <td style={{ padding: "8px 14px", width: 90 }}>
                              {res && (
                                <span style={{ fontWeight: 700, fontSize: 13, color: res.send_to_client ? "#15803d" : "#b91c1c" }}>
                                  {res.send_to_client ? "✓ SEND" : "✗ FLAG"}
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}

        {/* ── DATA TAB ── */}
        {tab === "data" && (
          <div style={{
            background: "var(--surface)", border: "1px solid var(--border)",
            borderRadius: 12, overflow: "hidden",
            boxShadow: "0 1px 3px rgba(0,0,0,.05)",
          }}>
            {rows.length === 0 ? (
              <div style={{ padding: "80px 40px", textAlign: "center", color: "var(--text3)" }}>
                Upload an Excel file to see dimensional data.
              </div>
            ) : (
              <>
                <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border)", background: "#f8fafc", fontSize: 12, color: "var(--text3)" }}>
                  Vol. weight = L × B × H ÷ 5000 &nbsp;·&nbsp; Chargeable = max(dead weight, vol. weight)
                </div>
                <div style={{ overflowX: "auto", maxHeight: "55vh", overflowY: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead style={{ position: "sticky", top: 0, background: "#f8fafc" }}>
                      <tr>
                        {["#", "URL", "Quality", "Type", "L (cm)", "B (cm)", "H (cm)", "Dead Wt (kg)", "Vol Wt (kg)", "Chargeable (kg)"].map(h => (
                          <th key={h} style={{
                            padding: "10px 14px", fontSize: 11, fontWeight: 700,
                            color: "var(--text3)", letterSpacing: "0.08em",
                            borderBottom: "1px solid var(--border)", textTransform: "uppercase",
                            textAlign: "left",
                          }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, i) => {
                        const res = results[i];
                        const L  = res?.length_cm  || Number(row.length_cm)  || undefined;
                        const B  = res?.breadth_cm || Number(row.breadth_cm) || undefined;
                        const H  = res?.height_cm  || Number(row.height_cm)  || undefined;
                        const DW = res?.dead_weight_kg || Number(row.dead_weight_kg) || undefined;
                        const VW = res?.vol_weight_kg  || calcVolWeight(L, B, H);
                        const CW = res?.chargeable_weight_kg || ((DW && VW) ? Math.max(DW, VW) : DW || VW);
                        const url = String(row[urlCol] || "");
                        return (
                          <tr key={i} style={{ borderBottom: "1px solid #f1f5f9", background: i % 2 === 0 ? "white" : "#fafafa" }}>
                            <td style={{ padding: "8px 14px", color: "var(--text3)", fontFamily: "var(--mono)", fontSize: 12, width: 42 }}>{i + 1}</td>
                            <td style={{ padding: "8px 14px", maxWidth: 180 }}>
                              <a href={url} target="_blank" rel="noreferrer" style={{
                                color: "#3b82f6", textDecoration: "none", fontSize: 11,
                                fontFamily: "var(--mono)", display: "block",
                                overflow: "hidden", textOverflow: "ellipsis", maxWidth: 180,
                              }} title={url}>{url}</a>
                            </td>
                            <td style={{ padding: "8px 14px" }}>
                              {res ? <LabelChip label={res.label} /> : <span style={{ color: "var(--text3)" }}>—</span>}
                            </td>
                            <td style={{ padding: "8px 14px", fontSize: 12, color: "var(--text2)" }}>
                              {res?.package_type || "—"}
                            </td>
                            {[L, B, H, DW].map((v, j) => (
                              <td key={j} style={{ padding: "8px 14px", fontFamily: "var(--mono)", fontSize: 13, color: v ? "var(--text)" : "var(--text3)", textAlign: "right" }}>
                                {v ?? "—"}
                              </td>
                            ))}
                            <td style={{ padding: "8px 14px", fontFamily: "var(--mono)", fontSize: 13, color: VW ? "#2563eb" : "var(--text3)", textAlign: "right", fontWeight: VW ? 600 : 400 }}>
                              {VW ?? "—"}
                            </td>
                            <td style={{ padding: "8px 14px", fontFamily: "var(--mono)", fontSize: 13, fontWeight: 700, color: CW ? "#15803d" : "var(--text3)", textAlign: "right" }}>
                              {CW ?? "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}

        <div style={{ marginTop: 24, textAlign: "center", fontSize: 11, color: "var(--text3)" }}>
          Sorter v3 · Pipeline: BoxFlyer → Shipment Quality · Batches of {BATCH_SIZE}
        </div>
      </main>

      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
        table { width: 100%; border-collapse: collapse; }
        select { background: var(--surface2); border: 1px solid var(--border); border-radius: 6px; padding: 5px 8px; font-size: 12px; color: var(--text); }
      `}</style>
    </div>
  );
}
