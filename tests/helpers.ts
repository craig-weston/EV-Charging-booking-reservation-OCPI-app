import { MemoryStore } from "../server/store/memory";
import { createLocalCtx, dispatch, type LocalCtx } from "../server/dispatch";

export interface Harness {
  ctx: LocalCtx;
  store: MemoryStore;
  clock: { now: Date };
  api<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T; error?: { message: string } }>;
  ocpi<T = unknown>(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; json: { data?: T; status_code: number; status_message?: string }; headers: Headers }>;
  fleetId: string;
  userId: string;
}

export async function harness(start = "2026-10-21T07:00:00Z"): Promise<Harness> {
  const store = new MemoryStore();
  const clock = { now: new Date(start) };
  const userId = "user-1";
  const ctx = createLocalCtx({ store, simDelayMs: 0, now: () => clock.now, user: { id: userId, email: "planner@example.com" }, env: { OCPI_COUNTRY_CODE: "GB", OCPI_PARTY_ID: "DPC", OCPI_BUSINESS_NAME: "Depotcharge", ENABLE_CPO_SIMULATOR: "true" } });
  store.data.admins.push(userId);
  const base = ctx.baseUrl;
  const api: Harness["api"] = async (method, path, body) => {
    const res = await dispatch(new Request(base + path, { method, headers: { "Content-Type": "application/json", Authorization: "Bearer test" }, body: body === undefined ? undefined : JSON.stringify(body) }), ctx);
    const json = (await res.json()) as { data: never; error?: { message: string } };
    return { status: res.status, data: json.data, error: json.error };
  };
  const ocpi: Harness["ocpi"] = async (method, path, token, body) => {
    const { authHeader } = await import("../server/ocpi/http");
    const res = await dispatch(new Request(base + path, { method, headers: { "Content-Type": "application/json", Authorization: authHeader(token), "X-Request-ID": "r1", "X-Correlation-ID": "c1", "OCPI-from-country-code": "GB", "OCPI-from-party-id": "VHL" }, body: body === undefined ? undefined : JSON.stringify(body) }), ctx);
    return { status: res.status, json: (await res.json()) as never, headers: res.headers };
  };
  const fleet = await api<{ id: string }>("POST", "/api/fleets", { name: "Demo Haulage", sample: true, accept_terms: true });
  return { ctx, store, clock, api, ocpi, fleetId: fleet.data.id, userId };
}
