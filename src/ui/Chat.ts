// Chat + player list overlays (multiplayer, but chat also echoes locally in
// single player). The log sits bottom-left above the hotbar: new lines show
// for 10 s then fade; while the chat is open the whole recent history shows
// and a text line takes the keyboard. The player list is shown while the
// player-list key is held.

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  parent?.appendChild(e);
  return e;
}

interface Line { el: HTMLElement; t: number }

export interface ListRow { name: string; you?: boolean; note?: string }

export class Chat {
  private root: HTMLElement;
  private log: HTMLElement;
  private inputWrap: HTMLElement;
  private input: HTMLInputElement;
  private lines: Line[] = [];
  private list: HTMLElement;
  private history: string[] = [];
  private histIdx = -1;
  private onSend: ((text: string) => void) | null = null;
  private onClose: (() => void) | null = null;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'chat-root', parent);
    this.log = el('div', 'chat-log', this.root);
    this.log.setAttribute('role', 'log');
    this.log.setAttribute('aria-live', 'polite');
    this.inputWrap = el('div', 'chat-input hidden', this.root);
    this.input = el('input', '', this.inputWrap);
    this.input.type = 'text';
    this.input.maxLength = 256;
    this.input.placeholder = 'Say something… (/list, /help)';
    this.input.setAttribute('aria-label', 'Chat message');
    // send / close buttons: a phone keyboard has no Esc (and Enter may say "Go")
    const send = el('button', 'chat-btn chat-send', this.inputWrap);
    send.type = 'button'; send.textContent = '➤'; send.title = 'Send'; send.setAttribute('aria-label', 'Send');
    send.addEventListener('pointerdown', (e) => { e.preventDefault(); this.submit(); });
    const x = el('button', 'chat-btn chat-close', this.inputWrap);
    x.type = 'button'; x.textContent = '✕'; x.title = 'Close'; x.setAttribute('aria-label', 'Close chat');
    x.addEventListener('pointerdown', (e) => { e.preventDefault(); this.close(); });
    this.input.enterKeyHint = 'send';
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        this.submit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const n = this.history.length;
        if (!n) return;
        this.histIdx = Math.max(-1, Math.min(n - 1, this.histIdx + (e.key === 'ArrowUp' ? 1 : -1)));
        this.input.value = this.histIdx >= 0 ? this.history[this.histIdx] : '';
      }
    });
    this.list = el('div', 'player-list hidden', parent);
  }

  private submit(): void {
    const text = this.input.value.trim();
    if (text) {
      this.history.unshift(text);
      if (this.history.length > 50) this.history.pop();
      this.onSend?.(text);
    }
    this.close();
  }

  get isOpen(): boolean { return !this.inputWrap.classList.contains('hidden'); }

  /** Add a line: `from` null = a system message (yellow). */
  add(from: string | null, text: string): void {
    const line = el('div', `chat-line${from === null ? ' sys' : ''}`, this.log);
    if (from !== null) {
      el('span', 'chat-name', line).textContent = `<${from}> `;
      line.appendChild(document.createTextNode(text));
    } else line.textContent = text;
    this.lines.push({ el: line, t: 0 });
    while (this.lines.length > 100) this.lines.shift()!.el.remove();
  }

  /** `focusNow`: focus inside the opening tap (a phone only raises its
   *  keyboard during a user gesture); a key-opened chat waits a tick instead. */
  open(onSend: (text: string) => void, onClose: () => void, prefill = '', focusNow = false): void {
    this.onSend = onSend;
    this.onClose = onClose;
    this.histIdx = -1;
    this.inputWrap.classList.remove('hidden');
    this.root.classList.add('open');
    this.input.value = prefill;
    // after the key that opened chat has been handled, so it isn't typed in
    if (focusNow) this.input.focus({ preventScroll: true });
    else setTimeout(() => this.input.focus({ preventScroll: true }), 0);
  }

  close(): void {
    if (!this.isOpen) return;
    this.inputWrap.classList.add('hidden');
    this.root.classList.remove('open');
    this.input.blur();
    const cb = this.onClose;
    this.onClose = null;
    this.onSend = null;
    cb?.();
  }

  /** Age the lines: each shows 10 s, then fades over 1 s (all show while open). */
  update(dt: number): void {
    const open = this.isOpen;
    for (const l of this.lines) {
      l.t += dt;
      const a = open ? 1 : l.t < 10 ? 1 : Math.max(0, 11 - l.t);
      l.el.style.opacity = String(a);
      l.el.style.display = a <= 0 ? 'none' : '';
    }
  }

  showPlayers(title: string, rows: ListRow[]): void {
    this.list.innerHTML = '';
    el('div', 'pl-title', this.list).textContent = title;
    for (const r of rows) {
      const row = el('div', `pl-row${r.you ? ' you' : ''}`, this.list);
      el('span', 'pl-name', row).textContent = r.name;
      if (r.note) el('span', 'pl-note', row).textContent = r.note;
    }
    this.list.classList.remove('hidden');
  }

  hidePlayers(): void { this.list.classList.add('hidden'); }
  get playersShown(): boolean { return !this.list.classList.contains('hidden'); }

  setVisible(v: boolean): void { this.root.style.display = v ? '' : 'none'; if (!v) this.hidePlayers(); }

  dispose(): void {
    this.root.remove();
    this.list.remove();
  }
}
