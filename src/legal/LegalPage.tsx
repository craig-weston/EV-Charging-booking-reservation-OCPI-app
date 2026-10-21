// Public legal pages (#/legal/<doc>): readable signed out, linked from sign-in, settings and passes.
import { useEffect } from "react";
import type { AppConfig } from "../../shared/model";
import { href } from "../app/router";
import { applyBrand } from "../app/brand";
import { BrandMark } from "../ui/ui";
import { LEGAL_DOCS, LEGAL_UPDATED, LegalDocument, type LegalDocId } from "./documents";

export function LegalPage({ config, doc }: { config: AppConfig; doc?: string }) {
  const id = (LEGAL_DOCS.find((d) => d.id === doc)?.id ?? "privacy") as LegalDocId;
  const meta = LEGAL_DOCS.find((d) => d.id === id)!;
  useEffect(() => {
    applyBrand(config.brand);
    document.title = `${meta.title} · ${config.brand.name}`;
    window.scrollTo(0, 0);
  }, [config.brand, meta.title]);
  return (
    <div className="legal">
      <header className="legal-head">
        <a href={href("/")} aria-label={`${config.brand.name} home`}><BrandMark brand={config.brand} /></a>
        <a className="btn ghost sm right" href={href("/")}>Back to {config.brand.name}</a>
      </header>
      <div className="legal-grid">
        <nav className="legal-nav" aria-label="Legal documents">
          {LEGAL_DOCS.map((d) => <a key={d.id} href={href(`/legal/${d.id}`)} aria-current={d.id === id ? "page" : undefined}>{d.title}</a>)}
        </nav>
        <article className="legal-doc">
          <h1>{meta.title}</h1>
          <p className="xs muted">Last updated {LEGAL_UPDATED}</p>
          <LegalDocument id={id} c={{ info: config.legal, brand: config.brand, certifications: config.certifications, version: config.terms_version }} />
        </article>
      </div>
      <LegalFooter config={config} />
    </div>
  );
}

/** Company disclosure line and legal links (Companies Act trading disclosures). */
export function LegalFooter({ config, compact }: { config: AppConfig; compact?: boolean }) {
  const i = config.legal;
  return (
    <footer className={`legal-foot${compact ? " compact" : ""}`}>
      <nav aria-label="Legal">
        {LEGAL_DOCS.filter((d) => !compact || ["privacy", "terms", "cookies", "security"].includes(d.id)).map((d) => <a key={d.id} href={href(`/legal/${d.id}`)}>{d.short}</a>)}
      </nav>
      {i.company_name && (
        <p>
          {config.brand.name} is provided by {i.company_name}{i.company_number ? `, registered in ${i.place_of_registration || "England and Wales"} no. ${i.company_number}` : ""}
          {i.registered_office ? `. Registered office: ${i.registered_office}` : ""}{i.vat_number ? `. VAT ${i.vat_number}` : ""}.
        </p>
      )}
    </footer>
  );
}
