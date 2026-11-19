export function createMessageArrival() {
  let previousId = null, previousCount = 0, previousTail = null;
  return function markArrival(list, conversation) {
    const messages = conversation?.messages || [];
    const id = conversation?.id;
    if (id && previousId === id && previousCount > 0 && messages.length > previousCount
      && messages[previousCount - 1]?.id === previousTail) {
      for (let index = Math.max(previousCount, messages.length - 2); index < messages.length; index++) {
        list.children[index]?.classList.add('message-arriving');
      }
    }
    previousId = id;
    previousCount = messages.length;
    previousTail = messages.at(-1)?.id;
  };
}
