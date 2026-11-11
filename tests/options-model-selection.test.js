import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelSelection } from '../src/options/model-selection.js';

function fixture() {
  let profiles = [{id:'a',name:'A',contextLength:32000,maxOutputTokens:2000,temperature:0.1},
    {id:'b',name:'B',contextLength:64000,maxOutputTokens:4000,temperature:0.7}];
  let fields = {};
  const selection = createModelSelection({getProfiles:()=>profiles,setProfiles:value=>{profiles=value;},readGeneration:()=>fields});
  return {selection, get profiles(){return profiles;}, set profiles(value){profiles=value;}, set fields(value){fields=value;}};
}

test('switching models remembers generation fields on the original model', () => {
  const f=fixture(); f.selection.reset('a');
  f.fields={contextLength:48000,maxOutputTokens:3000,temperature:0.3,reasoningEnabled:true,visionEnabled:false,reasoningEffort:'high'};
  assert.equal(f.selection.select('b').maxOutputTokens,4000);
  assert.equal(f.profiles[0].maxOutputTokens,3000);
  assert.equal(f.profiles[0].reasoningDefaultEffort,'high');
  f.fields={contextLength:96000,maxOutputTokens:6000,temperature:0.8};
  assert.equal(f.selection.select('a').contextLength,48000);
  assert.equal(f.profiles[1].maxOutputTokens,6000);
});

test('a discovered model cannot change the editing owner until added to the library', () => {
  const f=fixture(); f.selection.reset('b'); f.fields={contextLength:80000,maxOutputTokens:5000};
  assert.equal(f.selection.select('discovered'),null);
  assert.equal(f.selection.current().id,'b');
  f.selection.remember();
  assert.equal(f.profiles[1].contextLength,80000);
  assert.equal(f.profiles[0].contextLength,32000);
});

test('removing a model retains another selected model and empty libraries have no selection', () => {
  const f=fixture(); f.selection.reset('b');
  f.profiles=f.profiles.filter(profile=>profile.id!=='a');
  assert.equal(f.selection.reset('b').id,'b');
  f.profiles=[]; assert.equal(f.selection.reset('b'),null);
  f.selection.remember(); assert.deepEqual(f.profiles,[]);
});

test('reselecting the current model returns the remembered draft and reset does not overwrite it', () => {
  const f=fixture(); f.selection.reset('a'); f.fields={contextLength:72000,maxOutputTokens:7000,temperature:0};
  assert.equal(f.selection.select('a').temperature,0);
  f.fields={contextLength:100};
  assert.equal(f.selection.reset('a').contextLength,72000);
});

test('invalid numeric drafts stay visible for validation instead of becoming model defaults', () => {
  const f=fixture(); f.selection.reset('a'); f.fields={contextLength:0,maxOutputTokens:NaN,temperature:4};
  f.selection.select('b');
  assert.equal(f.profiles[0].contextLength,0);
  assert.ok(Number.isNaN(f.profiles[0].maxOutputTokens));
  assert.equal(f.profiles[0].temperature,4);
});
