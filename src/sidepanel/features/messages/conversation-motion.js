import { allowsMotion, playMotion, reveal } from '../../core/motion.js';

export function conversationMotion(previous, conversation) {
  const messages = conversation?.messages || [];
  const next = { id: conversation?.id ?? null, count: messages.length, tail: messages.at(-1)?.id };
  if (!previous) return { next, scene: '', arrivals: [] };
  if (previous.id !== next.id) {
    return { next, scene: previous.count || next.count ? 'history' : '', arrivals: [] };
  }
  const first = previous.count === 0 && messages[0]?.role === 'user';
  const appended = previous.count > 0 && messages.length > previous.count
    && messages[previous.count - 1]?.id === previous.tail;
  const arrivals = first || appended ? messages.slice(Math.max(previous.count, messages.length - 2)) : [];
  return { next, scene: first ? 'first' : '', arrivals };
}

export function createConversationMotion({ view, messages, welcome }) {
  let previous;
  let outgoing;
  let outgoingLayer;
  let incoming;

  function clear() {
    outgoing?.cancel();
    outgoingLayer?.remove();
    incoming?.cancel();
    outgoing = incoming = null;
    outgoingLayer = null;
  }

  function begin(conversation) {
    const result = conversationMotion(previous, conversation);
    const fromMessages = previous?.count > 0;
    previous = result.next;
    if (!result.scene) return result;
    clear();
    const source = fromMessages ? messages : welcome;
    if (!allowsMotion(source)) return result;
    const document = view.ownerDocument;
    const bounds = view.getBoundingClientRect();
    const rect = source.getBoundingClientRect();
    if (!rect.width || !bounds.height) return result;
    const layer = document.createElement('div');
    layer.className = 'conversation-scene-exit';
    layer.inert = true;
    layer.setAttribute('aria-hidden', 'true');
    Object.assign(layer.style, { left: `${bounds.left}px`, top: `${bounds.top}px`, width: `${bounds.width}px`, height: `${bounds.height}px` });
    const snapshot = source.cloneNode(!fromMessages);
    snapshot.removeAttribute('id');
    snapshot.removeAttribute('aria-live');
    for (const node of snapshot.querySelectorAll('[id]:not(svg *)')) node.removeAttribute('id');
    const gradient = snapshot.querySelector('radialGradient[id]');
    if (gradient) {
      const fill = snapshot.querySelector('.planet-outline');
      gradient.id += '-exit';
      fill?.setAttribute('fill', `url(#${gradient.id})`);
    }
    Object.assign(snapshot.style, { position: 'absolute', left: `${rect.left - bounds.left}px`,
      top: `${rect.top - bounds.top}px`, width: `${rect.width}px`, margin: '0' });
    layer.append(snapshot);
    view.after(layer);
    outgoing = playMotion(layer, result.scene === 'first' ? 'welcome-exit' : 'history-exit',
      [{ opacity: 1, translate: '0 0' }, { opacity: 0, translate: '0 -6px' }], { duration: 160 });
    if (!outgoing) layer.remove();
    else {
      outgoingLayer = layer;
      if (fromMessages) snapshot.append(...messages.children);
      const remove = () => { layer.remove(); if (outgoingLayer === layer) outgoingLayer = null; };
      outgoing.finished.then(remove, remove);
    }
    return result;
  }

  function finish({ scene, arrivals, next }) {
    if (scene === 'history') {
      incoming = reveal(next.count ? messages : welcome, 'history-enter', { distance: 7, delay: 42, duration: 220 });
    }
    const hasUser = arrivals.some(message => message.role === 'user');
    for (const message of arrivals) {
      const article = messages.querySelector(`:scope > [data-message-id="${CSS.escape(message.id)}"]`);
      const assistant = message.role === 'assistant';
      reveal(article, assistant ? 'assistant-enter' : 'user-enter', {
        distance: assistant ? 6 : 10, scale: assistant ? 1 : 0.98,
        delay: (scene === 'first' ? 76 : 0) + (assistant && hasUser ? 100 : 0), duration: 220,
      });
    }
    return hasUser;
  }

  return { begin, finish, dispose: clear };
}
