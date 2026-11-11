import test from 'node:test';
import assert from 'node:assert/strict';
import { scannerDom } from './helpers/agent-scanner-dom.js';

test('scanner reports omitted visible controls when its 80-element result budget is exhausted', () => {
  const fixture = scannerDom();
  for (let index = 0; index < 90; index++) fixture.body.appendChild(fixture.element('button', `Button ${index}`));
  const observation = fixture.scan();
  assert.equal(observation.elements.length, 80);
  assert.equal(observation.metrics.candidateTruncated, true);
  assert.equal(observation.metrics.omittedCount, 10);
  assert.equal(observation.metrics.scanTruncated, true);
});

test('caller result limits contribute to coverage while complete observations report zero omissions', () => {
  const fixture = scannerDom();
  for (let index = 0; index < 8; index++) fixture.body.appendChild(fixture.element('button', `Button ${index}`));
  const limited = fixture.scan({ maxElements: 5 });
  assert.equal(limited.elements.length, 5);
  assert.equal(limited.metrics.omittedCount, 3);
  assert.equal(limited.metrics.candidateTruncated, true);
  assert.equal(limited.metrics.scanTruncated, true);
  const complete = fixture.scan();
  assert.equal(complete.elements.length, 8);
  assert.equal(complete.metrics.omittedCount, 0);
  assert.equal(complete.metrics.candidateTruncated, false);
  assert.equal(complete.metrics.scanTruncated, false);
});

test('known scroll candidates beyond the eight-container quota are counted without returning more targets', () => {
  const fixture = scannerDom();
  for (let index = 0; index < 9; index++) fixture.body.appendChild(fixture.element('div', '', {
    clientHeight: 100, clientWidth: 100, scrollHeight: 1000, style: { opacity: '1', overflowY: 'auto' },
  }));
  const observation = fixture.scan();
  assert.equal(observation.elements.length, 8);
  assert.equal(observation.metrics.candidateCount, 9);
  assert.equal(observation.metrics.omittedCount, 1);
  assert.equal(observation.metrics.candidateTruncated, true);
  assert.equal(observation.metrics.scanTruncated, true);
});

test('known regions beyond the collection quota are included in coverage', () => {
  const fixture = scannerDom();
  for (let index = 0; index < 33; index++) fixture.body.appendChild(fixture.element('table'));
  const observation = fixture.scan();
  assert.equal(observation.elements.length, 6);
  assert.equal(observation.metrics.candidateCount, 33);
  assert.equal(observation.metrics.omittedCount, 27);
  assert.equal(observation.metrics.candidateTruncated, true);
  assert.equal(observation.metrics.scanTruncated, true);
});

test('a candidate matching scroll and readable quotas contributes only one omitted node', () => {
  const fixture = scannerDom();
  for (let index = 0; index < 9; index++) fixture.body.appendChild(fixture.element('table', '', {
    clientHeight: 100, clientWidth: 100, scrollHeight: 1000, style: { opacity: '1', overflowY: 'auto' },
  }));
  const observation = fixture.scan();
  assert.equal(observation.elements.length, 8);
  assert.equal(observation.metrics.candidateCount, 9);
  assert.equal(observation.metrics.omittedCount, 1);
  assert.equal(observation.metrics.candidateTruncated, true);
});

test('coverage counting respects the existing traversal ceiling and does not invent unseen omissions', () => {
  const fixture = scannerDom();
  for (let index = 0; index < 6100; index++) fixture.body.appendChild(fixture.element('div'));
  let unseenReads = 0;
  fixture.body.appendChild(fixture.element('button', 'Beyond traversal limit', {
    getBoundingClientRect() { unseenReads++; return { top: 100, bottom: 130, left: 100, right: 220, width: 120, height: 30 }; },
  }));
  const observation = fixture.scan();
  assert.equal(observation.elements.length, 0);
  assert.equal(observation.metrics.layoutNodeCount, 6000);
  assert.equal(observation.metrics.scanTruncated, true);
  assert.equal(observation.metrics.candidateTruncated, false);
  assert.equal(observation.metrics.omittedCount, 0);
  assert.equal(unseenReads, 0);
});

function shadowButton(depth = 1) {
  const fixture = scannerDom();
  let scope = fixture.document, parent = fixture.body;
  const roots = [];
  for (let index = 0; index < depth; index++) {
    const host = fixture.element('custom-control');
    parent.appendChild(host);
    scope.hit = host;
    scope = fixture.attachShadow(host);
    roots.push(scope);
    parent = scope;
  }
  const button = fixture.element('button', 'Expand details');
  parent.appendChild(button);
  scope.hit = button;
  fixture.scan();
  return { ...fixture, button, roots };
}

for (const depth of [1, 2]) test(`a visible button inside ${depth} open shadow root(s) passes deep hit testing`, () => {
  const fixture = shadowButton(depth);
  const result = fixture.perform(fixture.button);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(fixture.button.clicks, 1);
});

test('deep hit testing also preserves a clickable host with decorative shadow content', () => {
  const fixture = scannerDom();
  const host = fixture.body.appendChild(fixture.element('custom-button', 'Open', { attributes: { role: 'button' } }));
  const shadow = fixture.attachShadow(host);
  shadow.hit = shadow.appendChild(fixture.element('span', 'Open'));
  fixture.document.hit = host;
  fixture.scan();
  const result = fixture.perform(host);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(host.clicks, 1);
});

test('a visible native input inside an open shadow root receives one verified write', () => {
  const fixture = scannerDom();
  const host = fixture.body.appendChild(fixture.element('custom-input'));
  const shadow = fixture.attachShadow(host);
  const input = shadow.appendChild(fixture.element('input', '', { type: 'text', value: '', attributes: { 'aria-label': 'Search query' } }));
  const events = [];
  input.dispatchEvent = event => { events.push(event.type); return true; };
  fixture.document.hit = host;
  shadow.hit = input;
  fixture.scan();
  const result = fixture.perform(input, 'type_text', { text: 'Local test query' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(input.value, 'Local test query');
  assert.deepEqual(events, ['input', 'change']);
  assert.ok(result.diagnostics.stages.some(stage => stage.stage === 'check' && stage.valueMatched === true));
});

for (const layer of ['document', 'shadow']) test(`a real ${layer} overlay still blocks a shadow button`, () => {
  const fixture = shadowButton();
  const overlay = fixture.element('div', 'Blocking overlay');
  if (layer === 'document') { fixture.body.appendChild(overlay); fixture.document.hit = overlay; }
  else { fixture.roots[0].appendChild(overlay); fixture.roots[0].hit = overlay; }
  const result = fixture.perform(fixture.button);
  assert.equal(result.error, 'ERR_ELEMENT_OCCLUDED');
  assert.equal(fixture.button.clicks, 0);
});

test('a missing or empty shadow hit test cannot authorize its hidden inner target', () => {
  for (const missing of [true, false]) {
    const fixture = shadowButton();
    if (missing) delete fixture.roots[0].elementFromPoint;
    else fixture.roots[0].hit = null;
    const result = fixture.perform(fixture.button);
    assert.equal(result.error, 'ERR_ELEMENT_OCCLUDED');
    assert.equal(fixture.button.clicks, 0);
  }
});

test('an observed shadow button remains bound to its original meaning and task', () => {
  for (const change of ['meaning', 'disabled', 'cancelled']) {
    const fixture = shadowButton();
    if (change === 'meaning') { fixture.button.innerText = 'Delete everything'; fixture.button.textContent = 'Delete everything'; }
    else if (change === 'disabled') fixture.button.disabled = true;
    else fixture.context.__unkAiAgentScanner.cancelTask('task', 1);
    const result = change === 'cancelled'
      ? fixture.context.__unkAiAgentScanner.perform('revoked', 'e1', 'click_element', {}, { taskId: 'task', epoch: 1 })
      : fixture.perform(fixture.button);
    assert.ok(result.error);
    assert.equal(fixture.button.clicks, 0);
  }
});

function shadowChoice() {
  const fixture = scannerDom();
  const host = fixture.body.appendChild(fixture.element('custom-checkbox'));
  const shadow = fixture.attachShadow(host);
  const input = fixture.element('input', '', { type: 'checkbox', checked: false,
    style: { opacity: '0', pointerEvents: 'none' },
    getBoundingClientRect: () => ({ top: 110, bottom: 111, left: 110, right: 111, width: 1, height: 1 }),
    click() { this.clicks++; this.checked = !this.checked; },
  });
  const label = shadow.appendChild(fixture.element('label', 'Enable animation', { control: input,
    click() { this.clicks++; input.click(); },
  }));
  label.appendChild(input);
  input.labels = [label];
  fixture.document.hit = host;
  shadow.hit = label;
  fixture.scan();
  return { ...fixture, input, label, shadow };
}

test('transparent native choices in shadow DOM still use the verified visible label', () => {
  const fixture = shadowChoice();
  const result = fixture.perform(fixture.input);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(fixture.label.clicks, 1);
  assert.equal(fixture.input.checked, true);
});

test('relinked or covered native labels never authorize their former shadow choices', () => {
  for (const changed of ['link', 'cover']) {
    const fixture = shadowChoice();
    if (changed === 'link') fixture.label.control = fixture.element('input', '', { type: 'checkbox' });
    else fixture.shadow.hit = fixture.shadow.appendChild(fixture.element('div', 'Blocking overlay'));
    const result = fixture.perform(fixture.input);
    assert.ok(result.error);
    assert.equal(fixture.label.clicks, 0);
    assert.equal(fixture.input.checked, false);
  }
});

test('transparent native upload areas use deep hits without accepting a shadow sibling overlay', () => {
  const fixture = scannerDom();
  const host = fixture.body.appendChild(fixture.element('custom-upload'));
  const shadow = fixture.attachShadow(host);
  const area = shadow.appendChild(fixture.element('div', 'Upload image'));
  const input = area.appendChild(fixture.element('input', '', { type: 'file', labels: [],
    style: { opacity: '0', pointerEvents: 'auto' }, attributes: { 'aria-label': 'Upload image' },
  }));
  fixture.document.hit = host;
  shadow.hit = input;
  const visible = fixture.scan().elements.find(element => element.domId === input.id);
  assert.equal(visible?.fileInput?.viaOverlay, true);
  shadow.hit = shadow.appendChild(fixture.element('div', 'Cover'));
  assert.equal(fixture.scan().elements.some(element => element.domId === input.id), false);
});
