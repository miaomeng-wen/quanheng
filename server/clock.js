'use strict';
function createClock(initial = Date.now()) {
  let current = typeof initial === 'function' ? initial : () => new Date(initial).getTime();
  return Object.freeze({ now: () => new Date(current()).toISOString(), set(value) { const n = new Date(value).getTime(); if (!Number.isFinite(n)) throw new Error('Invalid time'); current = () => n; }, advance(ms) { const n = current() + ms; current = () => n; } });
}
let source = () => Date.now();
module.exports = { createClock, now: () => new Date(source()).toISOString(), setNow(fn) { source = fn; } };
