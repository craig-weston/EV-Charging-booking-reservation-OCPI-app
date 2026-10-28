// Monthly charging statement: every charge that ended in the month, at the operator's price plus
// the platform's margin, with VAT. Download as CSV for accounting software, or print.
import { useCallback, useEffect, useState } from "react";
import type { FleetStatement } from "../../shared/model";
import { monthOf, previousMonth, statementCsv } from "../../shared/billing";
import { useApp } from "../app/state";
import { ApiFailure } from "../app/backend";
import { saveFile } from "../app/download";
import { href, navigate, useRoute } from "../app/router";
import { fmtMoney } from "../app/format";
import { Empty, Icon, Plate, Spinner } from "../ui/ui";

const MONTH = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
const KWH = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 });
const monthName = (m: string) => MONTH.format(new Date(`${m}-01T12:00:00Z`));
const nextMonth = (m: string) => {
  const y = Number(m.slice(0, 4)), n = Number(m.slice(5, 7));
  return n === 12 ? `${y + 1}-01` : `${y}-${String(n + 1).padStart(2, "0")}`;
};

export function StatementsPage() {
  const { api, fleetId, now, toast } = useApp();
  const route = useRoute();
  const thisMonth = monthOf(now);
  const month = /^\d{4}-\d{2}$/.test(route.params.get("month") ?? "") ? route.params.get("month")! : thisMonth;
  const [s, setS] = useState<FleetStatement | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!fleetId) return;
    setS(null);
    setError(null);
    try {
      setS(await api<FleetStatement>("GET", `/fleets/${fleetId}/statements/${month}`));
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : "Couldn't load the statement");
    }
  }, [api, fleetId, month]);
  useEffect(() => { void load(); }, [load]);

  const go = (m: string) => navigate("/statements", { month: m === thisMonth ? null : m }, { replace: true });
  const download = async () => {
    if (!s) return;
    try {
      const r = await saveFile(`${s.fleet.name.replace(/[^\w-]+/g, "-")}-charging-${s.month}.csv`, statementCsv(s, s.fleet.name), "text/csv");
      if (r === "saved") toast("Statement downloaded");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Download failed", "bad");
    }
  };
  const vatPct = s ? `${Math.round(s.vat_rate * 1000) / 10}%` : "";
  const isInvoice = !!s?.issuer.vat_number;

  return (
    <div className="page statements">
      <div className="page-head">
        <div>
          <a className="xs muted back-link no-print" href={href("/bookings")}><Icon name="chevronLeft" size="sm" />Bookings</a>
          <h1>Charging statement</h1>
          <div className="sub">Every charge that finished in the month, at the operator's price plus the platform margin.</div>
        </div>
        <div className="actions no-print">
          <button className="btn" disabled={!s || s.lines.length === 0} onClick={() => window.print()}><Icon name="fileText" size="sm" />Print</button>
          <button className="btn primary" disabled={!s || s.lines.length === 0} onClick={download}><Icon name="download" size="sm" />Download CSV</button>
        </div>
      </div>

      <div className="month-nav no-print" role="group" aria-label="Month">
        <button className="btn ghost icon-only" onClick={() => go(previousMonth(month))} aria-label="Previous month"><Icon name="chevronLeft" /></button>
        <b className="month-label">{monthName(month)}</b>
        <button className="btn ghost icon-only" disabled={month >= thisMonth} onClick={() => go(nextMonth(month))} aria-label="Next month"><Icon name="chevronRight" /></button>
        {month === thisMonth && <span className="tag">So far this month</span>}
      </div>

      {error ? (
        <div className="panel"><Empty icon="alert" title="Couldn't load the statement" action={<button className="btn" onClick={() => void load()}>Try again</button>}>{error}</Empty></div>
      ) : !s ? (
        <div className="panel"><div className="empty"><Spinner /></div></div>
      ) : (
        <>
          <section className="panel stmt-head">
            <div>
              <div className="xs muted label-caps">From</div>
              <b>{s.issuer.company_name}</b>
              {s.issuer.registered_office && <div className="small muted">{s.issuer.registered_office}</div>}
              <div className="xs muted">{[s.issuer.company_number && `Company no. ${s.issuer.company_number}`, s.issuer.vat_number && `VAT no. ${s.issuer.vat_number}`].filter(Boolean).join(" · ")}</div>
            </div>
            <div>
              <div className="xs muted label-caps">To</div>
              <b>{s.fleet.name}</b>
              <div className="small muted">{monthName(s.month)}</div>
            </div>
            <div className="stmt-total">
              <div className="xs muted label-caps">Total incl. VAT</div>
              <div className="stmt-big num">{fmtMoney(s.totals.gross, s.currency)}</div>
              <div className="xs muted">{s.totals.charges} {s.totals.charges === 1 ? "charge" : "charges"}, {KWH.format(s.totals.kwh)} kWh</div>
            </div>
          </section>

          {s.lines.length === 0 ? (
            <div className="panel section"><Empty icon="fileText" title={`No charges in ${monthName(s.month)}`}>Charges appear here once the operator sends the charge record, usually within minutes of unplugging.</Empty></div>
          ) : (
            <section className="panel section">
              <ul className="stmt-cards" aria-label="Charges">
                {s.lines.map((l) => (
                  <li key={l.cdr_id}>
                    <div className="stmt-card-top">
                      <Plate plate={l.plate} size="sm" />
                      <span className="grow xs muted">{DAY.format(new Date(l.ended_at))}</span>
                      <b className="num">{fmtMoney(l.net, s.currency)}</b>
                    </div>
                    <div className="small">{l.site}</div>
                    <div className="xs muted num">{KWH.format(l.kwh)} kWh · operator {fmtMoney(l.operator_cost, s.currency)} + margin {fmtMoney(l.margin, s.currency)}{l.booking_fee ? ` · incl. ${fmtMoney(l.booking_fee, s.currency)} booking fee` : ""}</div>
                  </li>
                ))}
                <li className="stmt-card-totals">
                  <div><span>Total ex VAT</span><b className="num">{fmtMoney(s.totals.net, s.currency)}</b></div>
                  <div className="xs muted"><span>Operator prices {fmtMoney(s.totals.operator_cost, s.currency)}, margin {fmtMoney(s.totals.margin, s.currency)}</span></div>
                  <div><span>VAT {vatPct}</span><span className="num">{fmtMoney(s.totals.vat, s.currency)}</span></div>
                  <div className="grand"><span>Total incl. VAT</span><b className="num">{fmtMoney(s.totals.gross, s.currency)}</b></div>
                </li>
              </ul>
              <div className="table-scroll">
                <table className="stmt-table">
                  <thead>
                    <tr>
                      <th scope="col">Finished</th>
                      <th scope="col">Truck</th>
                      <th scope="col">Site</th>
                      <th scope="col" className="num">kWh</th>
                      <th scope="col" className="num">Operator price</th>
                      <th scope="col" className="num">Margin{s.margin_percent != null ? ` ${s.margin_percent}%` : ""}</th>
                      <th scope="col" className="num">Total ex VAT</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.lines.map((l) => (
                      <tr key={l.cdr_id}>
                        <td className="nowrap">{DAY.format(new Date(l.ended_at))}</td>
                        <td><Plate plate={l.plate} size="sm" />{l.vehicle_name && <div className="xs muted">{l.vehicle_name}</div>}</td>
                        <td><div>{l.site}</div><div className="xs muted">{l.operator}{l.booking_fee ? `, incl. ${fmtMoney(l.booking_fee, s.currency)} booking fee` : ""}</div></td>
                        <td className="num">{KWH.format(l.kwh)}</td>
                        <td className="num">{fmtMoney(l.operator_cost, s.currency)}</td>
                        <td className="num muted">{fmtMoney(l.margin, s.currency)}{s.margin_percent == null && <div className="xs">{l.margin_percent}%</div>}</td>
                        <td className="num"><b>{fmtMoney(l.net, s.currency)}</b></td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr><th scope="row" colSpan={3}>Total ex VAT</th><td className="num">{KWH.format(s.totals.kwh)}</td><td className="num">{fmtMoney(s.totals.operator_cost, s.currency)}</td><td className="num">{fmtMoney(s.totals.margin, s.currency)}</td><td className="num"><b>{fmtMoney(s.totals.net, s.currency)}</b></td></tr>
                    <tr><th scope="row" colSpan={6}>VAT {vatPct}</th><td className="num">{fmtMoney(s.totals.vat, s.currency)}</td></tr>
                    <tr className="grand"><th scope="row" colSpan={6}>Total incl. VAT</th><td className="num"><b>{fmtMoney(s.totals.gross, s.currency)}</b></td></tr>
                  </tfoot>
                </table>
              </div>
            </section>
          )}
          <p className="xs muted stmt-note">
            {isInvoice ? "" : "This is a statement of charges, not a VAT invoice. "}
            Operator prices come from each operator's charge record and include any booking fee. {s.other_currencies.length > 0 && `Charges in ${s.other_currencies.join(", ")} are left out. `}
            Questions about a charge: {s.issuer.contact_email || "contact your platform"}.
          </p>
        </>
      )}
    </div>
  );
}
