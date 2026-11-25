import { buildFlows } from '../extract/flows.mjs';
import { forgetActivity } from '../io/activity.mjs';
import { exactTargetsOf } from './model.mjs';

/** The flows, ranked with the git activity of their entry files; the activity is dropped once they are ranked. */
export function flowsOf(
  { model, selected, callStats },
  { flowEntryList, persist, deep, entFacts, activityOf, sec, joined },
) {
  const flows = buildFlows(model, {
    entries: flowEntryList,
    exactTargets: exactTargetsOf(callStats),
    stateWrites: persist.stateWrites,
    statusSets: deep.statusSets,
    outsideCalls: persist.outsideCalls,
    transactions: persist.transactions,
    entities: entFacts.entities,
    activityOf,
    selected,
    securityRules: sec.securityRules,
    frontendPaths: joined.filter((j) => j.path).map((j) => ({ path: j.path, file: j.file })),
  });
  // The flow rank needs git activity for entry files only; the history text is not needed after it.
  forgetActivity();
  return flows;
}
