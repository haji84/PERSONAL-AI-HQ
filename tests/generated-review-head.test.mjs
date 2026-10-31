import test from 'node:test';
import assert from 'node:assert/strict';
import {runActualGeneratedReview} from '../scripts/generated-review.mjs';

test('direct actual generated-review entry rejects a stale Git HEAD before artifact access',async()=>{
 await assert.rejects(runActualGeneratedReview({
  request:{baseSha:'0'.repeat(40),source:'def add(a,b): return a+b'},
  artifacts:null
 }),/HEAD mismatch/);
});
