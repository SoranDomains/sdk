import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {xdr,scValToNative} from '@stellar/stellar-sdk';
import {claimIntentFromNative,claimIntentToScVal,nativeIntentHash,claimAllowlistLeaf} from '../src/index.js';
const vector=JSON.parse(readFileSync(new URL('./fixtures/native-claim-v1.json',import.meta.url),'utf8'));
test('SDK exactly matches compiled Rust contract ToXdr, receipt hash and allowlist domain vector',()=>{
 const wire=xdr.ScVal.fromXDR(vector.claimIntentXdrHex,'hex');const intent=claimIntentFromNative(scValToNative(wire));
 assert.equal(claimIntentToScVal(intent).toXDR('hex'),vector.claimIntentXdrHex);
 assert.equal(nativeIntentHash('claim',claimIntentToScVal(intent)),vector.claimIntentHash);
 assert.equal(claimAllowlistLeaf({network:vector.network,registry:vector.registry,registrar:vector.registrar,namespace:vector.namespace},vector.claimant),vector.allowlistLeaf);
});
import {claimQuoteFromNative} from '../src/index.js';
const quoteVector=JSON.parse(readFileSync(new URL('./fixtures/native-quote-v1.json',import.meta.url),'utf8'));
test('SDK decodes actual compiled-Wasm configured/unconfigured ClaimConfigState quotes',()=>{
 const configured=claimQuoteFromNative(scValToNative(xdr.ScVal.fromXDR(quoteVector.claimQuoteConfiguredXdrHex,'hex')));
 const unconfigured=claimQuoteFromNative(scValToNative(xdr.ScVal.fromXDR(quoteVector.claimQuoteUnconfiguredXdrHex,'hex')));
 assert(configured.config);assert.equal(configured.config.settings.mode,'public');assert.equal(configured.config.settings.enabled,true);
 assert.equal(unconfigured.config,null);assert.equal(configured.network,unconfigured.network);assert.equal(configured.namespace,unconfigured.namespace);
 assert.equal(typeof configured.now,'bigint');assert.equal(typeof configured.config.policyVersion,'bigint');
});
