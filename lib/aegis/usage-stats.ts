/**
 * Pure derivations over the usage telemetry, shared by the API/panel and unit
 * tested in isolation (no DB).
 */

export type ExitReasonRow = {
  exitReason: string;
  requests: number;
  costCents: number;
};

export type ExitReasonSplit = {
  doneRequests: number;
  doneCostCents: number;
  nonDoneRequests: number;
  nonDoneCostCents: number;
  /** Share of spend (cents) that ended in a clean `done`, 0–100. */
  donePct: number;
};

/**
 * Split exit-reason rows into clean (`done`) vs everything else — cost-capped,
 * verify-exhausted, errored, aborted, or legacy "unknown". This is the
 * "failed vs successful spend" insight: how much money ended in a non-`done`
 * run despite being billed.
 */
export function exitReasonSplit(rows: ExitReasonRow[]): ExitReasonSplit {
  let doneRequests = 0;
  let doneCostCents = 0;
  let nonDoneRequests = 0;
  let nonDoneCostCents = 0;

  for (const r of rows) {
    if (r.exitReason === 'done') {
      doneRequests += r.requests;
      doneCostCents += r.costCents;
    } else {
      nonDoneRequests += r.requests;
      nonDoneCostCents += r.costCents;
    }
  }

  const totalCost = doneCostCents + nonDoneCostCents;
  const donePct = totalCost > 0 ? (doneCostCents / totalCost) * 100 : 0;

  return { doneRequests, doneCostCents, nonDoneRequests, nonDoneCostCents, donePct };
}
