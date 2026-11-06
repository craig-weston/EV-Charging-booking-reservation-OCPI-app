// Keys for the store's live records (Store.listLive / putLive): one row per charger fact or truck
// reading, so updates that arrive together never overwrite each other. Every key starts with the
// fleet id, so deleting a fleet removes them all.
//
//   {fleet}/telemetry/{vehicle}                     the truck's latest battery reading
//   {fleet}/chargers/{depot}/{charger}/{fact}       status | problem | answer
//   {fleet}/stations/{depot}/{station}              connected to the charging system or not
//   {fleet}/hook/{depot}/                           the sealed token in the depot's report address
//   {fleet}/subscribed/{depot}/{station}            CitrineOS is sending us this station's messages
//   {fleet}/sim/{depot}/                            the charger simulator's pending fault
//
// Segments are encoded, so "/" only ever separates them, and a key ending in "/" never starts
// another depot's key.

/** One key segment: ids may contain anything, keys only letters, digits, "-" and %XX. */
export const seg = (s: string) => encodeURIComponent(s).replace(/[!'()*._~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
export const unseg = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

export const telemetryPrefix = (fleet: string) => `${seg(fleet)}/telemetry/`;
export const telemetryKey = (fleet: string, vehicle: string) => telemetryPrefix(fleet) + seg(vehicle);

export type ChargerFact = "status" | "problem" | "answer";
export const chargersPrefix = (fleet: string, depot: string) => `${seg(fleet)}/chargers/${seg(depot)}/`;
export const chargerKey = (fleet: string, depot: string, charger: string, fact: ChargerFact) => `${chargersPrefix(fleet, depot)}${seg(charger)}/${fact}`;
export const stationsPrefix = (fleet: string, depot: string) => `${seg(fleet)}/stations/${seg(depot)}/`;
export const stationKey = (fleet: string, depot: string, station: string) => stationsPrefix(fleet, depot) + seg(station);
export const hookKey = (fleet: string, depot: string) => `${seg(fleet)}/hook/${seg(depot)}/`;
export const subscribedPrefix = (fleet: string, depot: string) => `${seg(fleet)}/subscribed/${seg(depot)}/`;
export const simKey = (fleet: string, depot: string) => `${seg(fleet)}/sim/${seg(depot)}/`;

/** The record stored at exactly this key. */
export async function getLive<T>(store: { listLive<U>(prefix: string): Promise<Record<string, U>> }, key: string): Promise<T | null> {
  return (await store.listLive<T>(key))[""] ?? null;
}
