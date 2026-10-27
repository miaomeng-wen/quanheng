'use strict';
const seed = require('../data/seed.json');
const stores = new WeakMap();
function createState(input = seed) {
  const data = structuredClone(input);
  Object.assign(data, { plans: [], steps: [], authGrants: [], notifications: [], riskAssessment: null });
  const state = Object.freeze({ snapshot: () => structuredClone(data) });
  stores.set(state, data);
  return state;
}
// A one-time capability is claimed by the tool layer; consumers receive snapshots only.
function claimToolState(state) { const data = stores.get(state); if (!data) throw new Error('State already bound or unknown'); stores.delete(state); return data; }
module.exports = { createState, claimToolState };
