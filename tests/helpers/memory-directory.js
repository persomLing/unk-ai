/** Binary-aware File System Access fixture with separate child directories. */
export function memoryDirectory(name = 'data', control = {}, path = '') {
  const children = new Map();
  const handle = {
    kind: 'directory', name, children, control,
    async queryPermission() { return control.permission || 'granted'; },
    async getDirectoryHandle(child, { create = false } = {}) {
      if (!children.has(child)) {
        if (!create) throw new DOMException('Missing directory', 'NotFoundError');
        children.set(child, memoryDirectory(child, control, `${path}${child}/`));
      }
      if (children.get(child).kind !== 'directory') throw new DOMException('Not directory', 'TypeMismatchError');
      return children.get(child);
    },
    async getFileHandle(filename, { create = false } = {}) {
      if (!children.has(filename)) {
        if (!create) throw new DOMException('Missing file', 'NotFoundError');
        children.set(filename, { kind: 'file', name: filename, blob: new Blob([]) });
      }
      const file = children.get(filename);
      file.getFile = async () => { await control.beforeRead?.(`${path}${filename}`); return file.blob; };
      file.createWritable = async () => {
        let next;
        return {
          async write(value) {
            await control.beforeWrite?.(`${path}${filename}`, value);
            if (control.failImages && path === 'images/') throw new Error('Image folder disconnected');
            next = new Blob([value]);
          },
          async close() {
            await control.beforeClose?.(`${path}${filename}`, next);
            file.blob = next;
            (control.writes ||= []).push(`${path}${filename}`);
          },
          async abort() {},
        };
      };
      return file;
    },
    async removeEntry(filename) {
      if (!children.delete(filename)) throw new DOMException('Missing file', 'NotFoundError');
    },
    async *entries() { for (const entry of children) yield entry; },
  };
  return handle;
}
